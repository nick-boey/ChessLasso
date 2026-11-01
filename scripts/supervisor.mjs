import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, realpath, lstat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function protectedChanges(files) {
  return files.filter(
    (file) =>
      !/^(src\/|server\/|tests\/|public\/)/.test(file) ||
      /^server\/(auth|archive|app|runtime|backup|coach|store|jobs|sandbox|telemetry|index)\./.test(
        file,
      ) ||
      /(^|\/)(\.env|AGENTS\.md|CLAUDE\.md)(\.|$)/.test(file),
  );
}

async function command(executable, args, cwd, timeoutMs, environment = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...environment },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    let output = '';
    const append = (chunk) => {
      if (output.length < 512_000) output += chunk.toString().slice(0, 512_000 - output.length);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const timer = setTimeout(kill, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new Error(`Command failed (${code}): ${executable}`));
    });
  });
}

/** This file is copied outside the application; the isolated runner cannot replace it. */
export async function runCandidate(policyFile, requestFile) {
  const policy = JSON.parse(await readFile(policyFile, 'utf8'));
  const request = JSON.parse(await readFile(requestFile, 'utf8'));
  const runtime = await realpath(policy.runtime);
  const source = await realpath(policy.source);
  if (!path.relative(source, runtime).startsWith('..'))
    throw new Error('Runtime must be outside source');
  if ((await lstat(policyFile)).isSymbolicLink())
    throw new Error('Supervisor policy cannot be a symlink');
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const directory = path.join(runtime, 'releases', id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const recordFile = path.join(directory, 'record.json');
  const record = {
    id,
    status: 'pending',
    reason: '',
    sourceCommit: '',
    checks: [],
    protected: [],
    timestamp: new Date().toISOString(),
  };
  const save = async () => {
    const temporary = `${recordFile}.tmp`;
    await writeFile(temporary, JSON.stringify(record, null, 2), { mode: 0o600 });
    await rename(temporary, recordFile);
  };
  if (!Array.isArray(policy.runner) || !policy.runner.length || policy.runnerVerified !== true) {
    record.reason = 'An independently isolated Codex runner has not been verified';
    await save();
    return record;
  }
  const timeout = Math.max(60_000, Math.min(60 * 60_000, Number(policy.timeoutMs) || 30 * 60_000));
  const worktree = path.join(directory, 'candidate');
  try {
    record.sourceCommit = (await command('git', ['rev-parse', 'HEAD'], source, 10_000)).trim();
    await command(
      'git',
      ['worktree', 'add', '--detach', worktree, record.sourceCommit],
      source,
      30_000,
    );
    // The request contains selected accepted backlog only; no environment or archive is copied.
    const requestTarget = path.join(directory, 'request.json');
    await writeFile(
      requestTarget,
      JSON.stringify({
        backlog: request.backlog,
        prompt: request.prompt,
        retrospective: request.retrospective,
      }),
      { mode: 0o600 },
    );
    await command(
      policy.runner[0],
      [...policy.runner.slice(1), 'develop', worktree, requestTarget],
      runtime,
      timeout,
    );
    const files = (
      await command('git', ['diff', '--name-only', record.sourceCommit], worktree, 10_000)
    )
      .trim()
      .split('\n')
      .filter(Boolean);
    files.push(
      ...(await command('git', ['ls-files', '--others', '--exclude-standard'], worktree, 10_000))
        .trim()
        .split('\n')
        .filter(Boolean),
    );
    record.protected = protectedChanges(files);
    record.policyHash = createHash('sha256')
      .update(await readFile(policyFile))
      .digest('hex');
    if (record.protected.length) {
      record.reason = 'Protected changes require approval';
      await save();
      return record;
    }
    // Tests execute in the same isolation boundary; never run candidate code on the supervisor host.
    for (const check of ['verify', 'browser', 'recovery']) {
      await command(
        policy.runner[0],
        [...policy.runner.slice(1), check, worktree, requestTarget],
        runtime,
        timeout,
      );
      record.checks.push(check);
      await save();
    }
    record.status = 'validated';
    record.reason = 'Candidate validated; external release adapter required';
    if (
      policy.automaticDeployment &&
      policy.recoveryVerified &&
      policy.backupVerified &&
      Array.isArray(policy.releaseAdapter)
    ) {
      // The independently installed adapter owns active-use gating, checkpoint, atomic release switch,
      // health check and executable rollback; candidate code cannot supply these commands.
      await command(
        policy.releaseAdapter[0],
        [...policy.releaseAdapter.slice(1), worktree, recordFile],
        runtime,
        120_000,
      );
      record.status = 'deployed';
      record.reason = '';
    }
    await save();
    return record;
  } catch (error) {
    record.status = 'failed';
    record.reason = error instanceof Error ? error.message : 'Development failed';
    await save();
    return record;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [policyFile, requestFile] = process.argv.slice(2);
  if (!policyFile || !requestFile)
    throw new Error('Usage: node supervisor.mjs /external/policy.json /external/request.json');
  console.log(JSON.stringify(await runCandidate(policyFile, requestFile)));
}
