import { copyFile, mkdir, writeFile, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destination = path.resolve(
  process.argv[2] ?? path.join(source, '..', 'chesslasso-runtime', 'supervisor'),
);
if (!path.relative(source, destination).startsWith('..'))
  throw new Error('Supervisor must live outside the source repository');
await mkdir(destination, { recursive: true, mode: 0o700 });
if (!path.relative(await realpath(source), await realpath(destination)).startsWith('..'))
  throw new Error('Supervisor cannot be linked into the source repository');
try {
  await copyFile(
    new URL('./supervisor.mjs', import.meta.url),
    path.join(destination, 'supervisor.mjs'),
    constants.COPYFILE_EXCL,
  );
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
}
try {
  await writeFile(
    path.join(destination, 'policy.json'),
    JSON.stringify(
      {
        source,
        runtime: path.dirname(destination),
        runner: null,
        runnerVerified: false,
        automaticDeployment: false,
        recoveryVerified: false,
        backupVerified: false,
        timeoutMs: 30 * 60_000,
        instructions:
          'Configure an independently isolated runner, then verify denial of archive, .env, credentials and supervisor access before enabling. runner argv receives candidate and request paths. Keep this policy outside its mounts. Never invoke a host Codex workspace-write session as the isolation boundary.',
      },
      null,
      2,
    ),
    { flag: 'wx', mode: 0o600 },
  );
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
}
console.log(
  `External supervisor prepared at ${destination}; existing policy is never overwritten.`,
);
