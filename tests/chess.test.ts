import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Chess } from 'chess.js';
import {
  loadGame,
  playNotation,
  practiceGame,
  playMockOpponent,
  validBudget,
  snapshot,
  NotationError,
} from '../src/lib/chess.js';
import { app } from '../server/app.js';

test('rejected notation and illegal moves preserve the position', () => {
  const board = new Chess();
  const before = board.fen();
  for (const move of ['e2e4', 'nf3', 'e5', 'hello', '', 'Nf3+']) {
    assert.throws(() => playNotation(board, move), NotationError);
    assert.equal(board.fen(), before);
  }
  assert.equal(playNotation(board, 'e4').san, 'e4');
});

test('ambiguous moves require a starting file, castling accepts zeros, checks can be omitted', () => {
  const ambiguous = new Chess('4k3/8/8/8/8/8/8/1N2KN2 w - - 0 1');
  assert.throws(
    () => playNotation(ambiguous, 'Nd2'),
    (error: unknown) => error instanceof NotationError && error.kind === 'ambiguous',
  );
  assert.equal(playNotation(ambiguous, 'Nbd2').san, 'Nbd2');
  const castle = new Chess('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  assert.equal(playNotation(castle, '0-0').san, 'O-O');
  const promotion = new Chess('8/4P2k/8/8/8/8/8/K7 w - - 0 1');
  assert.equal(playNotation(promotion, 'e8=Q').san, 'e8=Q');
  const check = new Chess('7k/8/8/8/8/8/8/K6R w - - 0 1');
  assert.equal(playNotation(check, 'Rh7').san, 'Rh7+');
});

test('PGN retains setup and history; mock opponent makes legal moves', () => {
  const board = loadGame(practiceGame().pgn);
  playNotation(board, 'Nc3');
  playMockOpponent(board);
  const state = snapshot(board);
  assert.equal(state.moves.length, 8);
  assert.equal(loadGame(state.pgn).fen(), state.fen);
  const ending = new Chess('8/7k/8/8/8/4K3/4P3/8 w - - 0 1');
  playNotation(ending, 'Kd3');
  assert.equal(loadGame(ending.pgn()).fen(), ending.fen());
});

test('budgets accept no cap, warning and hard limits and reject invalid amounts', () => {
  for (const mode of ['none', 'warning', 'hard'])
    assert.equal(validBudget({ mode, amount: 50 }), true);
  for (const amount of [0, -1, NaN, Infinity, '50', undefined])
    assert.equal(validBudget({ mode: 'hard', amount }), false);
  assert.equal(validBudget({ mode: 'bypass', amount: 50 }), false);
});

test('move API validates inputs and plays a full legal turn', async () => {
  const post = (body: unknown) =>
    app.request('/api/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  assert.equal((await post({ pgn: '', notation: 'e2e4' })).status, 422);
  assert.equal((await post({ pgn: 10, notation: 'e4' })).status, 400);
  const response = await post({ pgn: '', notation: 'e4' });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.played, 'e4');
  assert.equal(result.game.moves.length, 2);
  assert.equal(result.game.turn, 'w');
  assert.equal(typeof result.note, 'string');
  assert.ok(!result.note.includes('{reply}'));
  const next = await (await post({ pgn: result.game.pgn, notation: 'Nf3' })).json();
  assert.equal(typeof next.note, 'string');
  assert.notEqual(next.note, result.note);
  assert.equal((await app.request('/api/move', { method: 'POST', body: '{' })).status, 400);
  assert.equal((await post({ pgn: 'x'.repeat(70000), notation: 'e4' })).status, 413);
});

test('mock coach returns deterministic actions and rejects invalid positions', async () => {
  const post = (message: string, fen = new Chess().fen()) =>
    app.request('/api/coach', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, fen }),
    });
  const demo = await (await post('Show me an example')).json();
  assert.equal(demo.action, 'demonstrate');
  for (const step of demo.demonstration.steps) {
    const board = new Chess();
    for (const move of step.moves) assert.ok(board.move(move));
  }
  assert.equal((await (await post('Give me a hint')).json()).action, 'hint');
  const endgame = await (await post('Set up an endgame')).json();
  assert.equal(endgame.action, 'set_position');
  assert.equal(endgame.activity.heading, 'Activate your king');
  const activity = await (await post('Focus on calculation')).json();
  assert.equal(activity.action, 'set_activity');
  assert.equal(activity.activity.heading, 'Compare candidate moves');
  assert.equal(activity.game, undefined);
  assert.equal((await post('help', 'invalid')).status, 400);
});
