import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime } from '../server/runtime.js';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';
import { Chess } from 'chess.js';
import { gameAtPly, snapshot } from '../src/lib/chess.js';
function runtime() {
  return new Runtime(mkdtempSync(join(tmpdir(), 'lasso-runtime-')));
}
void test('tool activity updates one durable row per call without colliding with chat IDs', async () => {
  const app = runtime();
  try {
    let notifications = 0;
    app.listeners.add(() => notifications++);
    app.recordToolActivity({ id: 'read-1', name: 'inspect_board', status: 'running' });
    app.recordToolActivity({ id: 'read-1', name: 'inspect_board', status: 'complete' });
    app.recordToolActivity({ id: 'read-2', name: 'read_history', status: 'error' });
    await app.chat('Hello coach', app.store.workspace().version, 'chat-with-tools');
    const messages = app.state().conversations.flatMap((item) => item.messages);
    assert.equal(new Set(messages.map((item) => item.id)).size, messages.length);
    assert.deepEqual(
      messages.filter((item) => item.role === 'tool').map((item) => item.tool),
      [
        { id: 'read-1', name: 'inspect_board', status: 'complete' },
        { id: 'read-2', name: 'read_history', status: 'error' },
      ],
    );
    assert.ok(notifications >= 3);
    const reopened = new Store(app.store.directory);
    assert.deepEqual(reopened.workspace().conversations, app.state().conversations);
    reopened.close();
  } finally {
    app.store.close();
  }
});
void test('a loss during observation gets a game-over handoff without resetting the final board', async () => {
  const app = runtime();
  try {
    const board = new Chess();
    board.move('f3');
    board.move('e5');
    const workspace = app.store.workspace();
    workspace.game = snapshot(board);
    workspace.mode = 'live';
    workspace.quiet = true;
    app.store.save(workspace);
    app.engine = { play: async () => 'd8h4', analyze: async () => ({}) };
    await app.move('g4', workspace.version, 'losing-move');
    const saved = app.store.workspace();
    const text = saved.conversations.at(-1)?.messages.at(-1)?.text ?? '';
    assert.match(text, /Black won by checkmate/);
    assert.doesNotMatch(text, /Would you like/);
    assert.equal(saved.game.over, true);
    assert.equal(saved.gameId, workspace.gameId);
    assert.equal(saved.game.moves.at(-1), 'Qh4#');
    assert.equal(saved.activity.heading, 'Game complete');
    const messageCount = saved.conversations.flatMap((entry) => entry.messages).length;
    await app.move('g4', workspace.version, 'losing-move');
    assert.equal(
      app.store.workspace().conversations.flatMap((entry) => entry.messages).length,
      messageCount,
    );
    await app.chat('Resume coaching and help again', saved.version, 'resume-after-loss');
    const resumed = app.store.workspace();
    assert.equal(resumed.quiet, false);
    assert.equal(resumed.gameId, saved.gameId);
    assert.deepEqual(resumed.game, saved.game);
    assert.match(
      resumed.conversations.at(-1)?.messages.at(-1)?.text ?? '',
      /Black won by checkmate/,
    );
    const directory = app.store.directory;
    app.store.close();
    const restored = new Runtime(directory);
    try {
      assert.equal(restored.store.workspace().game.over, true);
      assert.deepEqual(restored.store.workspace(), resumed);
    } finally {
      restored.store.close();
    }
  } finally {
    // The successful path closes before the restart assertion.
    if (app.store.db.isOpen) app.store.close();
  }
});
for (const scenario of [
  {
    name: 'a player win',
    fen: undefined,
    moves: ['f3', 'e5', 'g4'],
    side: 'b',
    move: 'Qh4#',
    result: /Black won by checkmate/,
  },
  {
    name: 'an insufficient-material draw',
    fen: '7k/8/8/8/8/8/2r5/KB6 w - - 0 1',
    moves: [],
    side: 'w',
    move: 'Bxc2',
    result: /drawn by insufficient material/,
  },
] as const) {
  void test(`${scenario.name} gets a terminal handoff without requiring a model call`, async () => {
    const app = runtime();
    try {
      const board = new Chess(scenario.fen);
      for (const move of scenario.moves) board.move(move);
      const workspace = app.store.workspace();
      workspace.game = snapshot(board);
      workspace.mode = 'live';
      workspace.quiet = false;
      workspace.playerSide = scenario.side;
      app.store.save(workspace);
      await app.move(scenario.move, workspace.version, 'terminal-move');
      const saved = app.store.workspace();
      assert.equal(saved.game.over, true);
      assert.match(saved.conversations.at(-1)?.messages.at(-1)?.text ?? '', scenario.result);
    } finally {
      app.store.close();
    }
  });
}
void test('journal exposes saved Markdown and complete diary files newest first', async () => {
  const app = runtime();
  try {
    const api = createApp(app, { authentication: false });
    const empty = await (await api.request('/api/journal')).json();
    assert.equal(empty.notes, '');
    assert.deepEqual(empty.entries, []);
    app.store.write('games/coach-notes.md', '## Development\n\n**Check king safety.**');
    app.store.write('diary/2026-11-01.md', '# Reflection\n\n- Compare candidates');
    app.store.write(
      'diary/2026-11-02.md',
      '# Meeting\n\nAccepted diary updates:\nKeep calculating.',
    );
    app.store.write('diary/draft.md', 'Not a dated diary entry');
    const response = await api.request('/api/journal');
    assert.equal(response.status, 200);
    const journal = await response.json();
    assert.equal(journal.notes, app.store.read('games/coach-notes.md'));
    assert.equal(journal.profile, app.store.read('profile/current.md'));
    assert.equal(journal.plan, app.store.read('plans/current.md'));
    assert.deepEqual(
      journal.entries.map((entry: { day: string }) => entry.day),
      ['2026-11-02', '2026-11-01'],
    );
    assert.match(journal.entries[0].text, /Accepted diary updates/);
  } finally {
    app.store.close();
  }
});
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

void test('historical chat uses the selected current-game position without changing play', async () => {
  const app = runtime();
  const before = app.store.workspace();
  const result = await app.chat('Set up an endgame', before.version, 'review', 2);
  assert.equal(app.store.workspace().game.pgn, before.game.pgn);
  assert.equal(app.store.workspace().gameId, before.gameId);
  assert.equal(app.store.workspace().version, before.version);
  assert.equal(
    app.store.workspace().conversations.at(-1)!.messages.at(-1)!.fen,
    gameAtPly(before.game.pgn, 2).fen,
  );
  assert.deepEqual(await app.chat('Set up an endgame', before.version, 'review', 2), result);
  await assert.rejects(app.chat('Invalid position', before.version, 'invalid-review', 99));
  const live = app.store.workspace();
  live.mode = 'live';
  app.store.save(live);
  app.paid = async (_message, context, role) => {
    assert.equal(role, 'question-feedback');
    assert.equal(context.game.fen, gameAtPly(before.game.pgn, 1).fen);
    assert.equal(context.game.moves.length, 1);
    return {
      text: 'Review feedback',
      actions: [],
      usage: { input: 0, output: 0, cost: 0 },
      sessionId: 'review-test',
    };
  };
  await app.chat('Why this move?', before.version, 'live-review', 1);
  assert.equal(app.store.workspace().game.pgn, before.game.pgn);
  const web = createApp(app, { authentication: false });
  const response = await web.request('/api/coach', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: 'Question',
      version: before.version,
      commandId: 'bad-review',
      reviewPly: -1,
    }),
  });
  assert.equal(response.status, 400);
  app.store.close();
});

void test('history review exposure is recorded separately from live-position exposure', async () => {
  const app = runtime();
  const web = createApp(app, { authentication: false });
  const observe = async (reviewPly?: number) => {
    app.store.put('presence:review-device', {
      at: Date.now() - 1000,
      seq: 1,
      visible: true,
      focused: true,
      reviewPly,
    });
    const response = await web.request('/api/presence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: 'review-device',
        seq: 2,
        visible: true,
        focused: true,
        reviewPly,
      }),
    });
    assert.equal(response.status, 200);
    return app.store
      .events()
      .filter((event) => event.kind === 'presence')
      .at(-1)!.value as { observedExposureMs: number; reviewExposureMs: number };
  };
  const reviewing = await observe(1);
  assert.equal(reviewing.observedExposureMs, 0);
  assert.ok(reviewing.reviewExposureMs >= 1000);
  const live = await observe();
  assert.ok(live.observedExposureMs >= 1000);
  assert.equal(live.reviewExposureMs, 0);
  app.store.close();
});

void test('runtime paths linked into the public source checkout are rejected before creating SQLite', () => {
  const directory = mkdtempSync(join(tmpdir(), 'lasso-linked-runtime-'));
  symlinkSync(process.cwd(), join(directory, 'source'));
  assert.throws(() => new Store(join(directory, 'source'), join(directory, 'archive')), /outside/);
});
