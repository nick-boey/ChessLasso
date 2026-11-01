import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime } from '../server/runtime.js';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';
function runtime() {
  return new Runtime(mkdtempSync(join(tmpdir(), 'lasso-runtime-')));
}
void test('accepted move, immutable conversations and archive survive restart', async () => {
  const app = runtime();
  const state = app.store.workspace();
  await app.move('Nc3', state.version, 'first');
  const current = app.store.workspace();
  assert.equal(current.conversations.length, 2);
  assert.equal(current.conversations[0].fen, state.game.fen);
  const index = app.store.get<{ path: string }[]>('game-index')!;
  assert.equal(index.length, 1);
  assert.match(app.store.read(index[0].path), /Nc3/);
  const directory = app.store.directory;
  app.store.close();
  const recovered = new Runtime(directory);
  assert.deepEqual(recovered.store.workspace(), current);
  assert.equal(recovered.store.workspace().conversations.length, 2);
  recovered.store.close();
});
void test('archive traversal, symlink and mutation ownership boundaries', async () => {
  const app = runtime();
  const text = 'range '.repeat(5000);
  app.store.write('research/range.md', text);
  const first = app.store.readChunk('research/range.md', 0, 16000);
  assert.equal(first.nextOffset, 16000);
  const rest = app.store.readChunk('research/range.md', first.nextOffset!, 32000);
  assert.equal(first.text + rest.text, text);
  assert.equal(rest.nextOffset, null);
  assert.throws(() => app.store.readChunk('research/range.md', -1));
  assert.throws(() => app.store.write('../escape.md', 'no'));
  symlinkSync(tmpdir(), join(app.store.archive, 'escape'));
  assert.throws(() => app.store.read('escape/secret'));
  await assert.rejects(app.tool('start_activity', { version: -1, heading: 'bad' }));
  await assert.rejects(app.tool('play_move', { version: 0, san: 'Nc3' }), /player controls/);
  await assert.rejects(app.tool('read_history', { path: '.git/config' }));
  await assert.rejects(app.tool('revise_prompt', { target: 'permissions', text: 'allowall' }));
  const workspace = app.store.workspace();
  await app.tool('start_activity', {
    version: workspace.version,
    heading: 'Calculation',
    subtitle: 'Compare two candidates',
  });
  assert.equal(app.store.workspace().game.fen, workspace.game.fen);
  app.store.close();
});
void test('budget reservations serialize hard caps for foreground and background alike', () => {
  const app = runtime();
  const state = app.store.workspace();
  state.budget = { mode: 'hard', amount: 0.3 };
  app.store.save(state);
  const first = app.store.reserve(0.25);
  assert.throws(() => app.store.reserve(0.25), /hard cap/);
  app.store.settle(first, 0.01);
  const next = app.store.reserve(0.25);
  assert.ok(next);
  state.budget = { mode: 'none', amount: 1 };
  app.store.save(state);
  assert.ok(app.store.reserve(100));
  app.store.close();
});
void test('PGN imports retain original bytes, deduplicate and preserve active board', () => {
  const app = runtime();
  const before = app.store.workspace();
  const pgn = '[Event "Imported"]\n\n1. e4 e5 2. Nf3 *';
  const result = app.importPgn(pgn);
  assert.equal(result.length, 1);
  assert.equal(app.importPgn(pgn).length, 0);
  assert.equal(app.store.workspace().game.fen, before.game.fen);
  const id = (result[0] as { id: string }).id;
  assert.equal(readFileSync(app.store.path(`games/originals/${id}.pgn`), 'utf8'), pgn);
  app.store.close();
});
void test('remote auth, Origin and move-control lease reject unauthorized callers', async () => {
  const app = runtime();
  const web = createApp(app);
  const response = await web.request('http://untrusted.example/api/state');
  assert.equal(response.status, 403);
  const origin = await web.request('http://127.0.0.1:3001/api/settings', {
    method: 'POST',
    headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(origin.status, 403);
  app.store.put('control-lease', { clientId: 'phone', until: Date.now() + 10000 });
  await assert.rejects(app.move('Nc3', 0, 'blocked', 'desktop'), /Another device/);
  app.store.close();
});
void test('archive is forbidden inside the public code checkout', () => {
  assert.throws(
    () =>
      new Store(mkdtempSync(join(tmpdir(), 'lasso-store-')), join(process.cwd(), 'private-data')),
    /outside/,
  );
});

void test('private checkpoint restores board, conversations, usage and archived event identity into a new runtime database', async () => {
  const app = runtime();
  await app.move('Nc3', 0, 'restore-game');
  const reservation = app.store.reserve(0.25);
  app.store.settle(reservation, 0.05);
  app.store.flushEvents();
  app.store.checkpoint();
  const before = app.store.workspace();
  const archive = app.store.archive;
  app.store.close();
  const replacement = new Runtime(mkdtempSync(join(tmpdir(), 'lasso-recovery-')), archive);
  const state = replacement.store.workspace();
  assert.equal(state.game.fen, before.game.fen);
  assert.deepEqual(state.conversations, before.conversations);
  assert.equal(state.version, before.version + 1);
  assert.equal(replacement.store.stats().moves, 1);
  assert.equal(
    Number(
      (
        replacement.store.db.prepare('SELECT SUM(amount) AS amount FROM usage').get() as {
          amount: number;
        }
      ).amount,
    ),
    0.05,
  );
  replacement.store.close();
});
void test('daily proposed changes cannot mutate profile before independent acceptance', async () => {
  const app = runtime();
  const before = app.store.read('profile/current.md');
  const result = await app.tool(
    'propose_record_update',
    { target: 'profile', text: 'Unsupported conclusion', evidence: [] },
    'consolidation',
  );
  assert.deepEqual(result, { staged: true, reviewRequired: true });
  assert.equal(app.store.read('profile/current.md'), before);
  app.store.close();
});

void test('runtime budget and pause updates survive an engine reply in flight', async () => {
  const app = runtime();
  const state = app.store.workspace();
  state.mode = 'live';
  state.quiet = true;
  app.store.save(state);
  let complete: (move: string) => void = () => {};
  let started: () => void = () => {};
  const ready = new Promise<void>((resolve) => (started = resolve));
  app.engine = {
    play: async () => {
      started();
      return new Promise<string>((resolve) => (complete = resolve));
    },
    analyze: async () => ({}),
  };
  const pending = app.move('Nc3', 0, 'race');
  await ready;
  const web = createApp(app, { authentication: false });
  const settings = await web.request('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paused: true, budget: { mode: 'hard', amount: 1 } }),
  });
  assert.equal(settings.status, 200);
  complete('g8f6');
  await pending;
  assert.equal(app.store.workspace().paused, true);
  assert.equal(app.store.workspace().budget.mode, 'hard');
  app.store.close();
});
void test('plain coach advice remains assistance during an observation activity', async () => {
  const app = runtime();
  const state = app.store.workspace();
  state.quiet = true;
  app.store.save(state);
  await app.chat('I am considering a piece move', 0, 'advice');
  const before = app.store.workspace();
  assert.ok(app.interventions(before.version) > 0);
  await app.move('Nc3', before.version, 'after-advice');
  const moves = app.store.events().filter((event) => event.kind === 'move');
  assert.equal((moves[0].value as { assistanceStatus: string }).assistanceStatus, 'assisted');
  app.store.close();
});

void test('question answers are server validated, durable, idempotent and leave the main game unchanged', async () => {
  const app = runtime();
  await app.chat('I am considering a piece move', 0, 'question');
  const before = app.store.workspace();
  const result = await app.answer(
    before.game.fen,
    'Nc3',
    'candidate',
    before.conversations.at(-1)!.messages.at(-1)!.id,
  );
  assert.match(result.text, /Nc3 is a legal candidate/);
  assert.equal(app.store.workspace().game.fen, before.game.fen);
  assert.deepEqual(
    await app.answer(
      before.game.fen,
      'Nc3',
      'candidate',
      before.conversations.at(-1)!.messages.at(-1)!.id,
    ),
    result,
  );
  await assert.rejects(app.answer(before.game.fen, 'e2e4', 'invalid'));
  assert.ok(app.store.events().some((event) => event.kind === 'question_answer'));
  app.store.close();
});

void test('runtime paths linked into the public source checkout are rejected before creating SQLite', () => {
  const directory = mkdtempSync(join(tmpdir(), 'lasso-linked-runtime-'));
  symlinkSync(process.cwd(), join(directory, 'source'));
  assert.throws(() => new Store(join(directory, 'source'), join(directory, 'archive')), /outside/);
});
