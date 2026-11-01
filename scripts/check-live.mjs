import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const directory = await mkdtemp(join(tmpdir(), 'chesslasso-integration-'));
const url = 'http://127.0.0.1:4176';
let server;
const start = async () => {
  server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    env: {
      ...process.env,
      PORT: '4176',
      CHESSLASSO_RUNTIME_DIR: join(directory, 'runtime'),
      CHESSLASSO_ARCHIVE_DIR: join(directory, 'archive'),
      CHESSLASSO_ORIGINS: url,
    },
    stdio: 'ignore',
  });
  for (let count = 0; count < 100; count++) {
    try {
      if ((await fetch(url + '/api/health')).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Synthetic live server did not start.');
};
const stop = async () => {
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await new Promise((resolve) => server.once('exit', resolve));
  }
};
const request = async (path, body) => {
  const response = await fetch(
    url + path,
    body
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      : undefined,
  );
  const result = await response.json();
  assert.equal(response.status, 200, `Unexpected API status ${response.status}`);
  return result;
};
try {
  await start();
  await request('/api/settings', {
    mode: 'live',
    provider: 'google',
    model: process.env.CHESSLASSO_MODEL ?? 'gemini-3-flash-preview',
    budget: { mode: 'hard', amount: 3 },
  });
  const before = await request('/api/state');
  const command = {
    notation: 'Nc3',
    version: before.version,
    commandId: crypto.randomUUID(),
    clientId: 'synthetic-live-check',
  };
  const played = await request('/api/move', command);
  assert.equal(played.game.moves.length, 8);
  assert.ok(played.note.trim());
  assert.ok(played.usage?.input > 0, 'Paid coach turn did not return provider usage');
  assert.ok(played.workspace.conversations.length === 2);
  const repeated = await request('/api/move', command);
  assert.deepEqual(repeated.game, played.game);
  const stats = played.workspace.stats;
  assert.equal(stats.moves, 1);
  assert.equal(stats.games, 1);
  const meeting = await request('/api/meeting', {});
  assert.equal(meeting.status, 'complete');
  assert.ok(meeting.rounds.length >= 1 && meeting.rounds.length <= 2);
  assert.match(meeting.rounds[0].critique.text, /\b(?:ACCEPT|REVISE)\s*$/);
  const afterMeeting = await request('/api/state');
  assert.equal(afterMeeting.game.fen, played.game.fen);
  assert.equal(afterMeeting.journal.length, 1);
  const pgn = played.game.pgn;
  await stop();
  await start();
  const restored = await request('/api/state');
  assert.equal(restored.game.pgn, pgn);
  assert.equal(restored.conversations.length, 2);
  const sessions = await readdir(join(directory, 'archive', 'sessions'), { recursive: true });
  assert.ok(sessions.some((path) => path.endsWith('.jsonl')));
  console.log(
    JSON.stringify({
      ok: true,
      provider: 'google',
      model: restored.model,
      moves: restored.game.moves.length,
      restored: true,
      nativePiLogs: true,
      independentDailyMeeting: true,
      usage: played.usage,
    }),
  );
} finally {
  await stop();
  await rm(directory, { recursive: true, force: true });
}
