import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { searchArchive } from '../server/sandbox.js';
import { DailyJobs, coachingDay, type DailyCallbacks, type Meeting } from '../server/jobs.js';
import { createTelemetry, initTelemetry } from '../server/telemetry.js';
import { createSignals } from '../src/lib/telemetry.js';

void test('QuickJS search sees only supplied immutable files and rejects host access/output/time abuse', async () => {
  const files = [{ path: 'games/index.md', text: 'fork lesson' }];
  assert.deepEqual(
    await searchArchive(
      'return files.filter(f => f.text.includes("fork")).map(f => f.path)',
      files,
    ),
    ['games/index.md'],
  );
  for (const script of [
    'return process.env',
    'return require("node:fs")',
    'return fetch("https://example.com")',
    'return "x".repeat(70000)',
    'while(true) {}',
    'return new Array(50000000).fill("overflow")',
  ]) {
    await assert.rejects(searchArchive(script, files));
  }
  await assert.rejects(searchArchive('return files', [{ path: '../.env', text: '' }]));
  assert.equal(
    await searchArchive('return typeof process + ":" + typeof fetch', files),
    'undefined:undefined',
  );
});

void test('coaching day uses Sydney 04:00 calendar boundary across DST', () => {
  assert.equal(coachingDay(new Date('2026-10-03T16:59:00Z')), '2026-10-03');
  assert.equal(coachingDay(new Date('2026-10-03T17:00:00Z')), '2026-10-04');
  assert.equal(coachingDay(new Date('2026-04-04T17:59:00Z')), '2026-04-04');
  assert.equal(coachingDay(new Date('2026-04-04T18:00:00Z')), '2026-04-05');
});

void test('daily meeting resumes checkpoints, critiques independently twice and commits once', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chesslasso-jobs-'));
  let proposals = 0,
    critiques = 0,
    commits = 0,
    fail = true;
  const callbacks: DailyCallbacks = {
    snapshot: async () => ({ events: ['move-1'] }),
    propose: async () => {
      proposals++;
      return 'First proposal';
    },
    critique: async (_day, evidence, _proposal, round) => {
      assert.deepEqual(evidence, { events: ['move-1'] });
      critiques++;
      return { accepted: false, text: `Counterexample ${round}` };
    },
    revise: async (_day, _evidence, proposal) => {
      if (fail) {
        fail = false;
        throw new Error('Provider offline');
      }
      return `${proposal} revised`;
    },
    commit: async (meeting: Meeting) => {
      assert.equal(meeting.rounds.length, 2);
      commits++;
    },
  };
  try {
    await assert.rejects(new DailyJobs(directory, callbacks).runDay('2026-10-31'));
    const recovered = await new DailyJobs(directory, callbacks).runDay('2026-10-31');
    assert.equal(recovered?.status, 'complete');
    await new DailyJobs(directory, callbacks).runDay('2026-10-31');
    assert.equal(proposals, 1);
    assert.equal(critiques, 2);
    assert.equal(commits, 1);
    assert.equal(recovered?.rounds[1].critique.accepted, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('wake catch-up continues beyond a month and development retries independently', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chesslasso-wake-'));
  const committed: string[] = [];
  let development = 0;
  const jobs = new DailyJobs(directory, {
    snapshot: async () => ({}),
    propose: async () => 'Retain plan',
    critique: async () => ({ accepted: true, text: 'No new evidence' }),
    revise: async () => 'Unused',
    commit: async (meeting) => {
      committed.push(meeting.day);
    },
    develop: async () => {
      development++;
      return false;
    },
  });
  try {
    const now = new Date('2026-03-01T12:00:00Z');
    await jobs.tick(now, '2026-01-01');
    assert.equal(committed.length, 31);
    await jobs.tick(now, '2026-01-01');
    assert.equal(committed.length, 59);
    assert.equal(committed.at(-1), '2026-02-28');
    assert.equal(development, 59);
    await jobs.tick(now, '2026-01-01');
    assert.equal(development, 59);
    await jobs.tick(new Date(now.getTime() + 60 * 60_000), '2026-01-01');
    assert.equal(development, 118);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('OTel SDK exports all three signals, safe dimensions and continuous W3C request context', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chesslasso-otel-'));
  const store = await createTelemetry({ directory, excludedRoots: [process.cwd()] });
  const server = initTelemetry(store);
  const browser = createSignals('chesslasso.web', (signal, records) => {
    store.ingest(signal, records);
  });
  try {
    const webSpan = browser.tracer.startSpan('move');
    const parent = webSpan.spanContext();
    await server.withTrace(`00-${parent.traceId}-${parent.spanId}-01`, () =>
      server.operation('move', async () => {
        server.event('notation', {
          outcome: 'rejected',
          secret: 'DO-NOT-STORE',
          fen: 'private-position',
          playerId: 'unbounded',
        });
        return true;
      }),
    );
    webSpan.end();
    browser.event('load');
    await Promise.all([server.flush(), browser.flush()]);
    const traces = (await store.query('traces')).flatMap((entry) => entry.records);
    assert.ok(
      traces.some(
        (record) =>
          record.service === 'chesslasso.server' &&
          record.traceId === parent.traceId &&
          record.parentSpanId === parent.spanId,
      ),
    );
    for (const signal of ['traces', 'logs', 'metrics'] as const) {
      const records = (await store.query(signal)).flatMap((entry) => entry.records);
      assert.ok(
        records.some((record) => record.service === 'chesslasso.web'),
        `${signal} browser`,
      );
      assert.ok(
        records.some((record) => record.service === 'chesslasso.server'),
        `${signal} server`,
      );
    }
    const content = (
      await Promise.all(
        (await readdir(directory)).map((name) => readFile(path.join(directory, name), 'utf8')),
      )
    ).join('');
    assert.ok(!content.includes('DO-NOT-STORE'));
    assert.ok(!content.includes('private-position'));
    assert.ok(!content.includes('playerId'));
  } finally {
    await Promise.all([server.close(), browser.close()]);
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

void test('telemetry expires exact cutoff including idle/restart, ignores client time and preserves recent records', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chesslasso-ttl-'));
  let now = Date.parse('2026-01-01T00:00:00Z');
  const options = { directory, excludedRoots: [process.cwd()], now: () => now };
  let store = await createTelemetry(options);
  const record = {
    service: 'chesslasso.web',
    name: 'move',
    attributes: { outcome: 'ok', token: 'hidden' },
    receivedAt: 9e15,
  };
  try {
    assert.equal(store.ingest('logs', [record]), true);
    await store.close();
    now += 90 * 24 * 60 * 60_000 - 1;
    store = await createTelemetry(options);
    assert.equal((await store.query('logs')).length, 1);
    store.ingest('logs', [record]);
    await store.cleanup();
    now++;
    assert.equal((await store.query('logs')).length, 1);
    await store.cleanup();
    const remaining = (await store.query('logs')).flatMap((entry) => entry.records);
    assert.equal(remaining.length, 1);
    await store.close();
    store = await createTelemetry(options);
    assert.equal((await store.query('logs')).length, 1);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

void test('full telemetry store drops diagnostics without throwing and rejects repository paths', async () => {
  await assert.rejects(
    createTelemetry({
      directory: path.join(process.cwd(), 'telemetry-test'),
      excludedRoots: [process.cwd()],
    }),
  );
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chesslasso-full-'));
  const store = await createTelemetry({ directory, excludedRoots: [process.cwd()], maxBytes: 1 });
  try {
    store.ingest('traces', [{ service: 'chesslasso.server', name: 'move', attributes: {} }]);
    await store.cleanup();
    assert.ok(store.status().dropped > 0);
    assert.equal((await store.query('traces')).length, 0);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

void test('external supervisor leaves code untouched without a verified isolation runner', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chesslasso-supervisor-'));
  try {
    await mkdir(path.join(root, 'source'));
    await mkdir(path.join(root, 'runtime'));
    await writeFile(
      path.join(root, 'policy.json'),
      JSON.stringify({
        source: path.join(root, 'source'),
        runtime: path.join(root, 'runtime'),
        runner: null,
      }),
    );
    await writeFile(path.join(root, 'request.json'), JSON.stringify({ backlog: [] }));
    const result = await promisify(execFile)(process.execPath, [
      'scripts/supervisor.mjs',
      path.join(root, 'policy.json'),
      path.join(root, 'request.json'),
    ]);
    const record = JSON.parse(result.stdout);
    assert.equal(record.status, 'pending');
    assert.match(record.reason, /isolated/);
    assert.deepEqual(await readdir(path.join(root, 'source')), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('supervisor catches protected changes even when the coding runner commits them', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chesslasso-gate-'));
  const execute = promisify(execFile);
  try {
    const source = path.join(root, 'source');
    const runtime = path.join(root, 'runtime');
    await mkdir(path.join(source, 'server'), { recursive: true });
    await mkdir(runtime);
    await writeFile(
      path.join(source, 'server', 'app.ts'),
      'export const permissions = "restricted";\n',
    );
    for (const args of [
      ['init', '-b', 'main'],
      ['config', 'user.name', 'Fixture'],
      ['config', 'user.email', 'fixture@example.invalid'],
      ['add', '.'],
      ['commit', '-m', 'Fixture'],
    ])
      await execute('git', args, { cwd: source });
    const runner = path.join(root, 'runner.mjs');
    await writeFile(
      runner,
      `import {writeFile} from 'node:fs/promises'; import {execFileSync} from 'node:child_process'; import path from 'node:path';
      const [stage,worktree] = process.argv.slice(2); if(stage !== 'develop') throw Error('Gate bypassed');
      await writeFile(path.join(worktree,'server/app.ts'),'export const permissions = "expanded";');
      execFileSync('git',['add','.'],{cwd:worktree}); execFileSync('git',['commit','-m','Protected change'],{cwd:worktree});`,
    );
    const policy = path.join(root, 'policy.json'),
      request = path.join(root, 'request.json');
    await writeFile(
      policy,
      JSON.stringify({ source, runtime, runner: [process.execPath, runner], runnerVerified: true }),
    );
    await writeFile(request, JSON.stringify({ backlog: ['Change UI'] }));
    const result = JSON.parse(
      (await execute(process.execPath, ['scripts/supervisor.mjs', policy, request])).stdout,
    );
    assert.equal(result.status, 'pending');
    assert.deepEqual(result.protected, ['server/app.ts']);
    assert.match(result.reason, /approval/);
    assert.match(await readFile(path.join(source, 'server/app.ts'), 'utf8'), /restricted/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('runtime setup preserves existing supervisor policy and executable on repeat', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chesslasso-setup-'));
  const execute = promisify(execFile);
  try {
    await execute(process.execPath, ['scripts/setup-runtime.mjs', root]);
    await writeFile(path.join(root, 'policy.json'), '{"operator":"preserved"}');
    await writeFile(path.join(root, 'supervisor.mjs'), '// independently verified\n');
    await execute(process.execPath, ['scripts/setup-runtime.mjs', root]);
    assert.equal(
      await readFile(path.join(root, 'policy.json'), 'utf8'),
      '{"operator":"preserved"}',
    );
    assert.equal(
      await readFile(path.join(root, 'supervisor.mjs'), 'utf8'),
      '// independently verified\n',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('daily failure checkpoint identifies redacted stage and request-budget cause', async () => {
  const { CoachFailure } = await import('../server/coach.js');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lasso-failure-stage-'));
  let proposals = 0,
    critiques = 0,
    commits = 0;
  const callbacks: DailyCallbacks = {
    snapshot: async () => ({ frozen: true }),
    propose: async () => {
      proposals++;
      return 'Retain plan';
    },
    critique: async () => {
      critiques++;
      if (critiques === 1)
        throw new CoachFailure('request_budget', 'Coach turn exhausted its model request budget.');
      return { accepted: true, text: 'Supported' };
    },
    revise: async () => 'Unused',
    commit: async () => {
      commits++;
    },
  };
  try {
    await assert.rejects(new DailyJobs(directory, callbacks).runDay('2026-10-31'));
    const checkpoint = JSON.parse(await readFile(path.join(directory, '2026-10-31.json'), 'utf8'));
    assert.deepEqual(checkpoint.failure, {
      stage: 'critique:1',
      code: 'request_budget',
      message: 'Coach turn exhausted its model request budget.',
    });
    const result = await new DailyJobs(directory, callbacks).runDay('2026-10-31');
    assert.equal(result?.failure, undefined);
    assert.equal(proposals, 1);
    assert.equal(critiques, 2);
    assert.equal(commits, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
