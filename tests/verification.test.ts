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

for (const quiet of [true, false]) {
  void test(`a coach board reset gives relevant opening guidance (quiet=${quiet})`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'lasso-reset-'));
    const host = new Runtime(directory);
    try {
      const workspace = host.store.workspace();
      workspace.game = snapshot(new Chess('7k/6Q1/5K2/8/8/8/8/8 b - - 0 1'));
      workspace.mode = 'live';
      host.store.save(workspace);
      let claimId = '';
      host.coach = new CoachRuntime({
        sessionsDir: host.sessionDirectory(),
        getSettings: () => ({ mode: 'mock', provider: 'google', model: 'gemini-3.8-flash' }),
        getPrompt: async () => ({ text: 'Use checked coaching.', version: 'test' }),
        invokeTool: (name, args, current) => host.tool(name, args, 'coach', current),
        mockResponses: () => [
          fauxAssistantMessage(
            fauxToolCall('start_activity', {
              version: workspace.version,
              fen: new Chess().fen(),
              quiet,
            }),
          ),
          fauxAssistantMessage(fauxToolCall('inspect_board', {})),
          () => {
            const context = host.coachContext();
            return fauxAssistantMessage(
              fauxToolCall('verify_claims', {
                version: context.version,
                referenceId: context.boardFacts.reference.id,
                claims: [{ kind: 'attack', from: 'e2', to: 'd3' }],
              }),
            );
          },
          (transcript) => {
            const last = transcript.messages.at(-1);
            assert.equal(last?.role, 'toolResult');
            const encoded = last?.content.find((part) => part.type === 'text');
            assert.equal(encoded?.type, 'text');
            claimId = (JSON.parse(encoded!.text) as { id: string }).id;
            const context = host.coachContext();
            return fauxAssistantMessage(
              fauxToolCall('publish_coaching', {
                version: context.version,
                referenceId: context.boardFacts.reference.id,
                verificationIds: [claimId],
                prompt: 'candidate',
              }),
            );
          },
          fauxAssistantMessage('Invented tactical instructions must remain hidden.'),
        ],
      });
      const response = await host.chat('Let’s continue', workspace.version, 'continue-after-mate');
      const saved = host.store.workspace();
      const text = saved.conversations.at(-1)?.messages.at(-1)?.text;
      assert.ok(text);
      assert.equal(saved.game.fen, new Chess().fen());
      assert.match(text, /reset.*standard starting position/i);
      assert.match(text, /White to move/);
      assert.match(text, /first move|opening/i);
      assert.doesNotMatch(text, /geometrically attacks|could not verify/);
      if (quiet) {
        assert.match(text, /observe until you ask for help/);
        assert.doesNotMatch(text, /controlling the center/);
      } else assert.match(text, /controlling the center/);
      assert.doesNotMatch(text, /Invented tactical/);
      assert.ok(typeof response === 'object' && response !== null && 'text' in response);
      assert.equal(response.text, text);
    } finally {
      host.store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

void test('game-over publication requires an actually finished board', async () => {
  const current = setup();
  await assert.rejects(
    current.verifier.publish(
      { ...current.args, verificationIds: [], prompt: 'game-over' },
      async () => {},
    ),
    /has not ended/,
  );
  const finished = setup('7k/6Q1/5K2/8/8/8/8/8 b - - 0 1');
  const response = await finished.verifier.publish(
    { ...finished.args, verificationIds: [], prompt: 'game-over' },
    async () => {},
  );
  assert.match(response.text, /White won by checkmate/);
  assert.match(response.text, /review.*next activity/);
  const defaultReply = await finished.verifier.publish(
    { ...finished.args, verificationIds: [], prompt: 'candidate' },
    async () => {},
  );
  assert.match(defaultReply.text, /White won by checkmate/);
  assert.doesNotMatch(defaultReply.text, /Which legal move/);
  const unpublished = setup('7k/6Q1/5K2/8/8/8/8/8 b - - 0 1');
  assert.match(unpublished.verifier.finalText('invented advice'), /White won by checkmate/);
});

void test('a board change invalidates a reply published for the previous position', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lasso-stale-publication-'));
  const host = new Runtime(directory);
  try {
    const workspace = host.store.workspace();
    workspace.game = snapshot(new Chess('7k/6Q1/5K2/8/8/8/8/8 b - - 0 1'));
    host.store.save(workspace);
    const context = host.coachContext();
    const args = { version: context.version, referenceId: context.boardFacts.reference.id };
    const coach = new CoachRuntime({
      sessionsDir: host.sessionDirectory(),
      getSettings: () => ({ mode: 'mock', provider: 'google', model: 'gemini-3.8-flash' }),
      getPrompt: async () => ({ text: 'Use checked coaching.', version: 'test' }),
      invokeTool: (name, raw, current) => host.tool(name, raw, 'coach', current),
      mockResponses: () => [
        fauxAssistantMessage(
          fauxToolCall('verify_claims', {
            ...args,
            claims: [{ kind: 'checkmate' }],
          }),
        ),
        (transcript) => {
          const last = transcript.messages.at(-1);
          assert.equal(last?.role, 'toolResult');
          const encoded = last?.content.find((part) => part.type === 'text');
          assert.equal(encoded?.type, 'text');
          const { id } = JSON.parse(encoded!.text) as { id: string };
          return fauxAssistantMessage(
            fauxToolCall('publish_coaching', {
              ...args,
              verificationIds: [id],
            }),
          );
        },
        fauxAssistantMessage(
          fauxToolCall('start_activity', {
            version: context.version,
            fen: new Chess().fen(),
            quiet: true,
          }),
        ),
        fauxAssistantMessage('Carry on.'),
      ],
    });
    const response = await coach.run('Let’s continue', context);
    assert.doesNotMatch(response.text, /checkmated/);
    assert.match(response.text, /reset.*standard starting position/i);
  } finally {
    host.store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

void test('position clarification describes the actual board without requiring an unrelated attack claim', async () => {
  const { verifier, args } = setup();
  const result = await verifier.publish(
    { ...args, verificationIds: [], prompt: 'position' },
    async () => {},
  );
  assert.match(result.text, /standard starting position/);
  assert.match(result.text, /White to move/);
  assert.doesNotMatch(result.text, /geometrically|could not verify/);
  const custom = setup('8/7k/8/8/8/4K3/4P3/8 w - - 0 1');
  const explanation = await custom.verifier.publish(
    { ...custom.args, verificationIds: [], prompt: 'position' },
    async () => {},
  );
  assert.match(explanation.text, /training position/);
  assert.match(explanation.text, /king on e3/);
  assert.match(explanation.text, /pawn on e2/);
  assert.match(explanation.text, /king on h7/);
});

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

void test('publication omits appended invented prose and requires durable assistance before exposure', async () => {
  const { verifier, args } = setup('7k/8/8/5N2/8/8/7P/K7 w - - 0 1');
  const claim = verifier.verify({ ...args, claims: [{ kind: 'attack', from: 'f5', to: 'g7' }] });
  const publication = { ...args, verificationIds: [claim.id], prompt: 'candidate' };
  assert.match(
    verifier.finalText('The knight attacks f6 and mate is unstoppable.'),
    /could not verify/,
  );
  await assert.rejects(
    verifier.publish(publication, async () => {
      throw new Error('disk full');
    }),
    /disk full/,
  );
  assert.match(verifier.finalText('mate'), /could not verify/);
  let assistance: unknown;
  await verifier.publish(publication, async (evidence) => {
    assistance = evidence;
  });
  const visible = verifier.finalText('Also Qxe5# wins immediately and f5 attacks f6.');
  assert.match(visible, /f5 geometrically attacks g7/);
  assert.doesNotMatch(visible, /Qxe5|f6|wins immediately/);
  assert.deepEqual(assistance, { reference: verifier.root, verificationIds: [claim.id] });
  await assert.rejects(
    verifier.publish({ ...publication, text: 'Then Qxe5#' }, async () => {}),
    /Free-form/,
  );
  const prior = setup();
  await assert.rejects(
    prior.verifier.publish({ ...prior.args, verificationIds: [claim.id] }, async () => {}),
    /Unknown or stale/,
  );
});

void test('visible activity instructions and auxiliary text cannot smuggle unsupported mate claims', () => {
  const { verifier } = setup();
  const activity = verifier.visibleTool('start_activity', {
    version: 3,
    activityType: 'calculation',
    heading: 'Qxe5 is checkmate',
    subtitle: 'The knight attacks f6',
    goal: 'Unstoppable mate',
  });
  assert.equal(activity.heading, 'Compare candidate moves');
  assert.doesNotMatch(JSON.stringify(activity), /checkmate|f6|Unstoppable/);
  for (const name of ['ask_question', 'write_player_note', 'record_intervention'])
    assert.doesNotMatch(
      String(verifier.visibleTool(name, { text: 'Qxe5# wins' }).text),
      /Qxe5|wins/,
    );
  const demo = verifier.visibleTool('show_demonstration', {
    title: 'e4 checkmates',
    steps: [{ title: 'Forced mate', note: 'e4 checkmates', moves: ['e4'] }],
  });
  assert.doesNotMatch(JSON.stringify(demo), /checkmates|Forced mate/);
  assert.match(JSON.stringify(demo), /not an engine recommendation/);
});

void test('real coach boundary withholds invented text after successful engine verification and keeps activity labels safe', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lasso-verify-'));
  const host = new Runtime(directory);
  try {
    const workspace = host.store.workspace();
    workspace.game = snapshot(new Chess());
    workspace.quiet = true;
    host.store.save(workspace);
    const before = host.store.workspace().game;
    const context = { ...host.coachContext(), runRole: 'coach' };
    const args = { version: context.version, referenceId: context.boardFacts.reference.id };
    const coach = new CoachRuntime({
      sessionsDir: host.sessionDirectory(),
      getSettings: () => ({ mode: 'mock', provider: 'google', model: 'gemini-3.8-flash' }),
      getPrompt: async () => ({ text: 'Use checked coaching.', version: 'test' }),
      invokeTool: (name, raw, current) => host.tool(name, raw, 'coach', current),
      beforePaidCall: () => {
        throw new Error('No paid calls allowed');
      },
    });
    const steps: FauxResponseStep[] = [
      fauxAssistantMessage(fauxToolCall('analyse_position', { ...args, milliseconds: 80 })),
      (transcript) => {
        const last = transcript.messages.at(-1);
        assert.equal(last?.role, 'toolResult');
        const encoded = last?.content.find((part) => part.type === 'text');
        assert.equal(encoded?.type, 'text');
        const result = JSON.parse(encoded!.text) as {
          evidence: { id: string };
          variations: { san: string[] }[];
        };
        return fauxAssistantMessage(
          fauxToolCall('verify_claims', {
            ...args,
            analysisId: result.evidence.id,
            moves: result.variations[0].san.slice(0, 1),
            claims: [{ kind: 'engine-line' }],
          }),
        );
      },
      (transcript) => {
        const last = transcript.messages.at(-1);
        assert.equal(last?.role, 'toolResult');
        const encoded = last?.content.find((part) => part.type === 'text');
        assert.equal(encoded?.type, 'text');
        const result = JSON.parse(encoded!.text) as { id: string };
        return fauxAssistantMessage(
          fauxToolCall('publish_coaching', { ...args, verificationIds: [result.id] }),
        );
      },
      fauxAssistantMessage(
        fauxToolCall('start_activity', { version: context.version, activityType: 'calculation' }),
      ),
      fauxAssistantMessage(
        'Then Qxe5# wins and the knight on f5 attacks f6. The mate is unstoppable.',
      ),
    ];
    Object.defineProperty(coach, 'mockResponses', { value: () => steps });
    const response = await coach.run('Review my idea', context);
    assert.match(response.text, /matches a returned Stockfish variation/);
    assert.doesNotMatch(response.text, /Qxe5|f6|unstoppable/);
    assert.equal(host.store.workspace().activity.heading, 'Compare candidate moves');
    assert.deepEqual(host.store.workspace().game, before);
    const events = host.store.db
      .prepare("SELECT value FROM events WHERE kind='assistance'")
      .all() as { value: string }[];
    assert.ok(events.some((event) => JSON.parse(event.value).kind === 'verified_coaching'));
    assert.ok(events.some((event) => JSON.parse(event.value).reference.id === args.referenceId));
  } finally {
    host.store.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
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
          fauxToolCall('publish_coaching', { ...args, verificationIds: [result.id] }),
        );
      },
      fauxAssistantMessage('The knight attacks f6.'),
    ];
    Object.defineProperty(coach, 'mockResponses', { value: () => steps });
    const response = await coach.run(
      'Check the separate question board',
      context,
      'question-feedback',
    );
    assert.match(response.text, /f5 geometrically attacks g7/);
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
  assert.doesNotMatch(String(neutral.text), /mate/);
  const note = verifier.visibleTool('write_player_note', { verificationId: claim.id });
  assert.ok(String(note.text).includes(claim.reference.fen));
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
      await verifier.publish({ ...args, verificationIds: [claim.id] }, async (evidence) => {
        await host.tool(
          'record_verified_assistance',
          { ...evidence, kind: 'verified_coaching' },
          scope === 'current' ? 'coach' : 'question-feedback',
          context,
        );
      });
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
