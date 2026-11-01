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
import { createApp } from '../server/app.js';
import { Runtime } from '../server/runtime.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const app = createApp(new Runtime(mkdtempSync(join(tmpdir(), 'lasso-api-'))), {
  authentication: false,
});

void test('rejected notation and illegal moves preserve the position', () => {
  const board = new Chess();
  const before = board.fen();
  for (const move of ['e2e4', 'nf3', 'e5', 'hello', '', 'Nf3+']) {
    assert.throws(() => playNotation(board, move), NotationError);
    assert.equal(board.fen(), before);
  }
  assert.equal(playNotation(board, 'e4').san, 'e4');
});

void test('ambiguous moves require a starting file, castling accepts zeros, checks can be omitted', () => {
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

void test('PGN retains setup and history; mock opponent makes legal moves', () => {
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

void test('budgets accept no cap, warning and hard limits and reject invalid amounts', () => {
  for (const mode of ['none', 'warning', 'hard'])
    assert.equal(validBudget({ mode, amount: 50 }), true);
  for (const amount of [0, -1, NaN, Infinity, '50', undefined])
    assert.equal(validBudget({ mode: 'hard', amount }), false);
  assert.equal(validBudget({ mode: 'bypass', amount: 50 }), false);
});

void test('move API is authoritative, idempotent and rejects stale commands', async () => {
  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const state = await (await app.request('/api/state')).json();
  assert.equal(
    (await post('/api/move', { notation: 'e2e4', version: state.version, commandId: 'invalid' }))
      .status,
    422,
  );
  assert.equal(
    (await post('/api/move', { notation: 10, version: 0, commandId: 'bad' })).status,
    400,
  );
  const body = { notation: 'Nc3', version: state.version, commandId: 'accepted-1' };
  const response = await post('/api/move', body);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.played, 'Nc3');
  assert.equal(result.game.moves.length, 8);
  assert.deepEqual(await (await post('/api/move', body)).json(), result);
  assert.equal((await post('/api/move', { ...body, commandId: 'stale' })).status, 409);
  assert.equal((await app.request('/api/move', { method: 'POST', body: '{' })).status, 400);
  assert.equal((await post('/api/move', { notation: 'x'.repeat(2_200_000) })).status, 413);
});

void test('mock coach actions use durable current board versions', async () => {
  const post = async (message: string) => {
    const state = await (await app.request('/api/state')).json();
    return app.request('/api/coach', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, version: state.version, commandId: crypto.randomUUID() }),
    });
  };
  const demo = await (await post('Show me an example')).json();
  assert.equal(demo.action, 'demonstrate');
  for (const step of demo.demonstration.steps) {
    const board = new Chess();
    for (const move of step.moves) assert.ok(board.move(move));
  }
  const ending = await (await post('Set up an endgame')).json();
  assert.equal(ending.workspace.activity.heading, 'Activate your king');
  const activity = await (await post('Focus on calculation')).json();
  assert.equal(activity.workspace.activity.heading, 'Compare candidate moves');
  assert.equal(activity.workspace.game.fen, ending.workspace.game.fen);
});
