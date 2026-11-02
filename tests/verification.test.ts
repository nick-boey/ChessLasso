import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Chess } from 'chess.js';
import {
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseStep,
} from '@earendil-works/pi-ai/providers/faux';
import { CoachingVerification } from '../server/verification.js';
import { CoachRuntime } from '../server/coach.js';
import { Runtime } from '../server/runtime.js';
import type { EngineRequest, EngineResult } from '../server/engine.js';
import { snapshot } from '../src/lib/chess.js';

function setup(fen = new Chess().fen(), version = 3) {
  const context = { fen, version, pgn: new Chess(fen).pgn() };
  const engine = async (request: EngineRequest): Promise<EngineResult> => {
    const board = new Chess(request.fen);
    const choices = request.fen === new Chess().fen() ? ['e4', 'e5', 'Nf3'] : [board.moves()[0]];
    const uci: string[] = [];
    const san: string[] = [];
    for (const choice of choices) {
      const move = board.move(choice);
      uci.push(`${move.from}${move.to}${move.promotion ?? ''}`);
      san.push(move.san);
    }
    return {
      bestmove: uci[0],
      san: san[0],
      engine: 'synthetic engine',
      build: 'test',
      network: [],
      limits: { milliseconds: 80, depth: 12, variations: 1, skill: 20 },
      variations: [
        {
          depth: 12,
          score: { type: 'cp', value: 0, perspective: 'white', bound: 'exact' },
          uci,
          san,
        },
      ],
    };
  };
  const verifier = new CoachingVerification(context, engine);
  return { verifier, args: { version, referenceId: verifier.root.id } };
}

void test('tactical regressions reject blocked captures, false knight attacks and false mating assertions', () => {
  const blocked = setup('7k/8/8/4r3/8/2P5/8/Q6K w - - 0 1');
  assert.throws(
    () =>
      blocked.verifier.verify({
        ...blocked.args,
        moves: ['Qxe5'],
        claims: [{ kind: 'checkmate' }],
      }),
    /not legal/,
  );
  const knight = setup('7k/8/8/5N2/8/8/8/K7 w - - 0 1');
  assert.throws(
    () =>
      knight.verifier.verify({
        ...knight.args,
        claims: [{ kind: 'attack', from: 'f5', to: 'f6' }],
      }),
    /does not.*attack/,
  );
  const escape = setup('7k/8/8/8/8/8/8/K6R b - - 0 1');
  assert.throws(
    () => escape.verifier.verify({ ...escape.args, claims: [{ kind: 'checkmate' }] }),
    /not checkmate/,
  );
  const noncheck = setup('7k/8/8/8/8/8/8/K6R w - - 0 1');
  assert.throws(
    () =>
      noncheck.verifier.verify({
        ...noncheck.args,
        moves: ['Rg1'],
        claims: [{ kind: 'checkmate' }],
      }),
    /not checkmate/,
  );
  assert.throws(
    () =>
      noncheck.verifier.verify({ ...noncheck.args, moves: ['Rg1'], claims: [{ kind: 'check' }] }),
    /not in check/,
  );
  const valid = setup();
  const mate = valid.verifier.verify({
    ...valid.args,
    moves: ['f3', 'e5', 'g4', 'Qh4#'],
    claims: [{ kind: 'checkmate' }],
  });
  assert.match(mate.text, /checkmated/);
});

void test('engine receipts support only their exact legally derived continuation in this turn', async () => {
  const { verifier, args } = setup();
  const analysis = await verifier.analyse(args);
  const supported = verifier.verify({
    ...args,
    analysisId: analysis.evidence.id,
    moves: ['e4', 'e5'],
    claims: [{ kind: 'engine-line' }],
  });
  assert.equal(supported.analysisId, analysis.evidence.id);
  assert.throws(
    () =>
      verifier.verify({
        ...args,
        analysisId: analysis.evidence.id,
        moves: ['d4'],
        claims: [{ kind: 'engine-line' }],
      }),
    /not supported/,
  );
  const unrelated = await verifier.analyse({ ...args, moves: ['d4'] });
  assert.throws(
    () =>
      verifier.verify({
        ...args,
        analysisId: unrelated.evidence.id,
        moves: ['e4'],
        claims: [{ kind: 'engine-line' }],
      }),
    /not supported/,
  );
  assert.throws(
    () =>
      verifier.verify({
        ...args,
        analysisId: analysis.evidence.id,
        moves: ['e4', 'e5', 'Nc3'],
        claims: [{ kind: 'engine-line' }],
      }),
    /not supported/,
  );
  const nextTurn = setup();
  assert.throws(
    () =>
      nextTurn.verifier.verify({
        ...nextTurn.args,
        analysisId: analysis.evidence.id,
        moves: ['e4'],
        claims: [{ kind: 'engine-line' }],
      }),
    /not supported/,
  );
  await assert.rejects(
    verifier.analyse({ ...args, fen: new Chess().fen(), moves: ['e4'] }),
    /must be reached/,
  );
  await assert.rejects(verifier.analyse({ ...args, moves: ['e5'] }), /not legal/);
  assert.throws(
    () => verifier.verify({ ...args, version: 4, claims: [{ kind: 'check' }] }),
    /exact position/,
  );
});

void test('question and historical coaching verifies the referenced board and records its provenance without changing play', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lasso-question-verify-'));
  const host = new Runtime(directory);
  try {
    const workspace = host.store.workspace();
    const before = host.store.workspace().game;
    const question = snapshot(new Chess('7k/8/8/5N2/8/8/8/K7 w - - 0 1'));
    const context = {
      ...host.coachContext({ ...workspace, game: question }),
      runRole: 'question-feedback',
    };
    const args = { version: context.version, referenceId: context.boardFacts.reference.id };
    const coach = new CoachRuntime({
      sessionsDir: host.sessionDirectory(),
      getSettings: () => ({ mode: 'mock', provider: 'google', model: 'gemini-3.8-flash' }),
      getPrompt: async () => ({ text: 'Use checked feedback.', version: 'test' }),
      invokeTool: (name, raw, current) => host.tool(name, raw, 'question-feedback', current),
    });
    const steps: FauxResponseStep[] = [
      fauxAssistantMessage(
        fauxToolCall('verify_claims', {
          ...args,
          claims: [{ kind: 'attack', from: 'f5', to: 'g7' }],
        }),
      ),
      (transcript) => {
        const last = transcript.messages.at(-1);
        assert.equal(last?.role, 'toolResult');
        const encoded = last?.content.find((part) => part.type === 'text');
        assert.equal(encoded?.type, 'text');
        const result = JSON.parse(encoded!.text) as { id: string };
        return fauxAssistantMessage(
          fauxToolCall('publish_coaching', {
            ...args,
            verificationIds: [result.id],
            text: 'Let’s compare your knight’s activity with the opponent’s reply.',
          }),
        );
      },
      fauxAssistantMessage('Your knight controls g7. What reply are you considering?'),
    ];
    Object.defineProperty(coach, 'mockResponses', { value: () => steps });
    const response = await coach.run(
      'Check the separate question board',
      context,
      'question-feedback',
    );
    assert.equal(response.text, 'Your knight controls g7. What reply are you considering?');
    assert.doesNotMatch(response.text, /f6/);
    assert.deepEqual(host.store.workspace().game, before);
    const evidence = host.store.db
      .prepare("SELECT value FROM events WHERE kind='assistance'")
      .all() as { value: string }[];
    assert.ok(evidence.some((event) => JSON.parse(event.value).fen === question.fen));
    assert.ok(evidence.every((event) => JSON.parse(event.value).reference.id === args.referenceId));
  } finally {
    host.store.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

void test('verified questions bind their displayed board and notes retain exact position provenance', () => {
  const { verifier, args } = setup('7k/8/8/5N2/8/8/8/K7 w - - 0 1');
  const claim = verifier.verify({ ...args, claims: [{ kind: 'attack', from: 'f5', to: 'g7' }] });
  assert.throws(
    () =>
      verifier.visibleTool('ask_question', {
        verificationId: claim.id,
        fen: new Chess().fen(),
        text: 'Claim next to an unrelated board',
      }),
    /exact evidence position/,
  );
  const question = verifier.visibleTool('ask_question', { verificationId: claim.id });
  assert.equal(question.fen, claim.reference.fen);
  assert.deepEqual(question.reference, claim.reference);
  const neutral = verifier.visibleTool('ask_question', { fen: new Chess().fen(), text: 'mate' });
  assert.equal(neutral.fen, new Chess().fen());
  assert.equal(neutral.text, 'mate');
  const note = verifier.visibleTool('write_player_note', { verificationId: claim.id });
  assert.equal(note.text, claim.text);
  assert.deepEqual(note.reference, claim.reference);
});

void test('verified historical and question publications do not assist the next live observation move', async () => {
  for (const scope of ['historical', 'question', 'current'] as const) {
    const directory = mkdtempSync(join(tmpdir(), `lasso-assistance-${scope}-`));
    const host = new Runtime(directory);
    try {
      const workspace = host.store.workspace();
      workspace.quiet = true;
      host.store.save(workspace);
      const board =
        scope === 'historical'
          ? snapshot(new Chess())
          : scope === 'question'
            ? snapshot(new Chess('7k/8/8/5N2/8/8/8/K7 w - - 0 1'))
            : workspace.game;
      const context = host.coachContext({ ...workspace, game: board });
      const verifier = new CoachingVerification(context);
      const args = { version: context.version, referenceId: verifier.root.id };
      const claim = verifier.verify({
        ...args,
        claims: [
          {
            kind: 'attack',
            from: scope === 'historical' ? 'g1' : scope === 'question' ? 'f5' : 'f3',
            to: scope === 'historical' ? 'f3' : scope === 'question' ? 'g7' : 'g5',
          },
        ],
      });
      await verifier.publish(
        { ...args, verificationIds: [claim.id], text: 'Consider this piece relationship.' },
        async (evidence) => {
          await host.tool(
            'record_verified_assistance',
            { ...evidence, kind: 'verified_coaching' },
            scope === 'current' ? 'coach' : 'question-feedback',
            context,
          );
        },
      );
      const recorded = host.store.db
        .prepare("SELECT value FROM events WHERE kind='assistance'")
        .get() as { value: string };
      const assistance = JSON.parse(recorded.value) as {
        scope: string;
        fen: string;
        reference: { id: string };
        gameId: string;
      };
      assert.equal(assistance.scope, scope === 'current' ? 'live' : 'review');
      assert.equal(assistance.fen, context.fen);
      assert.equal(assistance.reference.id, verifier.root.id);
      assert.equal(assistance.gameId, workspace.gameId);
      await host.move('Nc3', workspace.version, `after-${scope}-publication`);
      const moved = host.store.db.prepare("SELECT value FROM events WHERE kind='move'").get() as {
        value: string;
      };
      const move = JSON.parse(moved.value) as { assistanceStatus: string };
      assert.equal(
        move.assistanceStatus,
        scope === 'current' ? 'assisted' : 'independent-observation',
      );
    } finally {
      host.store.db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

void test('historical chat assistance keeps review scope and leaves the next live observation independent', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lasso-review-chat-assistance-'));
  const host = new Runtime(directory);
  try {
    const workspace = host.store.workspace();
    workspace.quiet = true;
    host.store.save(workspace);
    await host.chat('Review the opening position', workspace.version, 'review-opening', 0);
    await host.move('Nc3', workspace.version, 'after-reviewed-chat');
    const moved = host.store.db.prepare("SELECT value FROM events WHERE kind='move'").get() as {
      value: string;
    };
    assert.equal(JSON.parse(moved.value).assistanceStatus, 'independent-observation');
    const assisted = host.store.db
      .prepare("SELECT value FROM events WHERE kind='assistance'")
      .get() as { value: string };
    assert.equal(JSON.parse(assisted.value).scope, 'review');
  } finally {
    host.store.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
