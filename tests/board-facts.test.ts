import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Chess } from 'chess.js';
import { boardFacts, positionReference } from '../server/board-facts.js';
import { Runtime } from '../server/runtime.js';
import { gameAtPly, snapshot } from '../src/lib/chess.js';

void test('facts distinguish knight geometry, defenders and blocked sliding attacks', () => {
  const facts = boardFacts('5r1k/8/8/5N2/4B3/8/8/K7 w - - 0 1', 7);
  const knight = facts.pieces.find((piece) => piece.square === 'f5')!;
  assert.ok(knight.attacks.includes('g7'));
  assert.ok(!knight.attacks.includes('f6'));
  assert.deepEqual(knight.defenders, ['e4']);
  assert.deepEqual(knight.attackers, ['f8']);
  const queen = boardFacts('7k/8/8/4r3/8/2P5/8/Q6K w - - 0 1', 2).pieces.find(
    (piece) => piece.square === 'a1',
  )!;
  assert.ok(queen.attacks.includes('b2'));
  assert.ok(queen.attacks.includes('c3')); // Friendly occupants are defended.
  assert.ok(!queen.attacks.includes('e5'));
  assert.ok(queen.blockers.includes('c3'));
});

void test('absolute and relative pins do not masquerade as legal moves or remove geometric attacks', () => {
  const absolute = boardFacts('k3r3/8/8/8/8/8/4N3/4K3 w - - 0 1', 1);
  assert.deepEqual(absolute.pins, [
    { kind: 'absolute', piece: 'e2', attacker: 'e8', target: 'e1' },
  ]);
  assert.ok(absolute.pieces.find((piece) => piece.square === 'e2')!.attacks.includes('f4'));
  assert.ok(!absolute.legalMoves.some((move) => move.from === 'e2'));
  const relative = boardFacts('k2r4/8/8/8/8/8/3N4/3Q3K w - - 0 1', 1);
  assert.deepEqual(relative.pins, [
    { kind: 'relative', piece: 'd2', attacker: 'd8', target: 'd1' },
  ]);
  assert.ok(relative.legalMoves.some((move) => move.from === 'd2'));
});

void test('king escapes are legal moves for the referenced turn, including escape from check', () => {
  const facts = boardFacts('7k/8/8/8/8/8/8/K6R b - - 0 1', 3);
  assert.equal(facts.check, true);
  assert.equal(facts.checkmate, false);
  assert.ok(facts.kingEscapes.some((move) => move.to === 'g8'));
  assert.ok(!facts.kingEscapes.some((move) => move.to === 'h7'));
  const castle = boardFacts('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', 4);
  assert.ok(!castle.kingEscapes.some((move) => move.san.startsWith('O-')));
});

void test('inspection binds historical/question facts to exact FEN/version and never changes the live game', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lasso-facts-'));
  const runtime = new Runtime(directory);
  try {
    const workspace = runtime.store.workspace();
    workspace.quiet = true;
    runtime.store.save(workspace);
    const before = runtime.state();
    const historical = runtime.coachContext({
      ...workspace,
      game: gameAtPly(workspace.game.pgn, 0),
    });
    const inspected = (await runtime.tool(
      'inspect_board',
      { version: workspace.version },
      'question-feedback',
      historical,
    )) as ReturnType<Runtime['coachContext']>;
    assert.equal(inspected.boardFacts.reference.fen, historical.fen);
    assert.notEqual(
      inspected.boardFacts.reference.id,
      positionReference(workspace.game.fen, workspace.version).id,
    );
    const question = runtime.coachContext({
      ...workspace,
      game: snapshot(new Chess('7k/8/8/8/8/8/8/K6R b - - 0 1')),
    });
    const questionFacts = (await runtime.tool(
      'inspect_board',
      {},
      'question-feedback',
      question,
    )) as ReturnType<Runtime['coachContext']>;
    assert.equal(questionFacts.boardFacts.check, true);
    assert.deepEqual(runtime.state(), before);
    workspace.version++;
    runtime.store.save(workspace);
    await assert.rejects(
      runtime.tool('inspect_board', {}, 'question-feedback', historical),
      /changed|stale/i,
    );
    await assert.rejects(runtime.tool('inspect_board', { version: 999 }), /changed|stale/i);
  } finally {
    runtime.store.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
