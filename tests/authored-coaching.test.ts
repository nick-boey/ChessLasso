import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Chess } from 'chess.js';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { Runtime } from '../server/runtime.js';
import { CoachRuntime } from '../server/coach.js';
import { CoachingVerification } from '../server/verification.js';
import { teachingPromptNames } from '../server/prompts.js';
import { snapshot } from '../src/lib/chess.js';

void test('a rejected chess claim is recoverable and the corrected agent response is shown verbatim', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lasso-authored-'));
  const host = new Runtime(directory);
  try {
    const state = host.store.workspace();
    state.game = snapshot(
      new Chess('rnbqkbnr/p4ppp/1pp1p3/3p4/3P1B2/2P1P3/PP3PPP/RN1QKBNR w KQkq - 0 5'),
    );
    host.store.save(state);
    const context = host.coachContext();
    const text =
      'I had the bishop’s starting square wrong. It is on f4. You’ve prepared the center; how would you bring another piece into play?';
    const coach = new CoachRuntime({
      sessionsDir: host.sessionDirectory(),
      getSettings: () => ({ mode: 'mock', provider: 'google', model: 'gemini-3.8-flash' }),
      getPrompt: async () => ({ text: host.prompts('coach'), version: 'default' }),
      invokeTool: (name, args, current) => host.tool(name, args, 'coach', current),
      mockResponses: () => [
        fauxAssistantMessage(
          fauxToolCall('verify_claims', {
            version: context.version,
            referenceId: context.boardFacts.reference.id,
            claims: [{ kind: 'attack', from: 'c1', to: 'a6' }],
          }),
        ),
        (transcript) => {
          const result = transcript.messages.at(-1);
          assert.equal(result?.role, 'toolResult');
          assert.equal(result?.role === 'toolResult' && result.isError, true);
          return fauxAssistantMessage(text);
        },
      ],
    });
    const result = await coach.run('Help me think about development', context);
    assert.equal(result.text, text);
    assert.equal(
      result.actions.some((action) => action.name === 'publish_coaching'),
      false,
    );
    const failure = host.store.db
      .prepare("SELECT value FROM events WHERE kind='coach_verification'")
      .get() as { value: string };
    assert.equal(JSON.parse(failure.value).category, 'false-claim');
    const evidence = host.store.db
      .prepare("SELECT value FROM events WHERE kind='assistance'")
      .get() as { value: string };
    assert.equal(JSON.parse(evidence.value).classification, 'agent-authored');
    assert.deepEqual(JSON.parse(evidence.value).verificationIds, []);
    assert.deepEqual(host.store.workspace().game, state.game);
  } finally {
    host.store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

void test('publication preserves authored prose while validating only the attached claim references', async () => {
  const board = new Chess();
  const context = { fen: board.fen(), pgn: board.pgn(), version: 3 };
  const verifier = new CoachingVerification(context);
  const args = { version: 3, referenceId: verifier.root.id };
  const claim = verifier.verify({ ...args, claims: [{ kind: 'attack', from: 'g1', to: 'f3' }] });
  let recorded = false;
  await assert.rejects(
    verifier.publish(
      { ...args, text: 'My own explanation.', verificationIds: [claim.id] },
      async () => {
        throw new Error('disk full');
      },
    ),
    /disk full/,
  );
  assert.throws(() => verifier.finalText(''), /did not provide/);
  const message =
    'Developing a knight can help your pieces work together. What is your plan for the center?';
  const result = await verifier.publish(
    { ...args, text: message, verificationIds: [claim.id] },
    async () => {
      recorded = true;
    },
  );
  assert.equal(recorded, true);
  assert.equal(result.text, message);
  assert.equal(result.classification, 'agent-authored');
  assert.equal(verifier.finalText(''), message);
  assert.equal(
    verifier.finalText('A different final explanation.'),
    'A different final explanation.',
  );
  const next = new CoachingVerification({ ...context, version: 4 });
  await assert.rejects(
    next.publish(
      { version: 4, referenceId: next.root.id, text: message, verificationIds: [claim.id] },
      async () => {},
    ),
    /Unknown or stale/,
  );
  await assert.rejects(
    verifier.publish({ ...args, text: '' }, async () => {}),
    /nonempty/,
  );
});

void test('agent-owned captions remain intact and demonstration move legality is still checked', () => {
  const board = new Chess();
  const verifier = new CoachingVerification({ fen: board.fen(), pgn: board.pgn(), version: 1 });
  assert.equal(
    verifier.visibleTool('start_activity', {
      heading: 'Making room for your bishop',
      subtitle: 'Compare two development plans.',
    }).heading,
    'Making room for your bishop',
  );
  assert.equal(
    verifier.visibleTool('ask_question', {
      text: 'What is your plan for this piece?',
      fen: board.fen(),
    }).text,
    'What is your plan for this piece?',
  );
  const demo = verifier.visibleTool('show_demonstration', {
    title: 'Preparing development',
    steps: [{ title: 'Make space', note: 'Notice the opened diagonal.', moves: ['e4'] }],
  });
  assert.equal(demo.title, 'Preparing development');
  assert.throws(
    () => verifier.visibleTool('show_demonstration', { steps: [{ moves: ['Qxe5#'] }] }),
    /Illegal demonstration/,
  );
});

void test('all teaching configurations can be read, versioned, rolled back and recovered after restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lasso-prompts-'));
  const host = new Runtime(directory);
  try {
    for (const target of teachingPromptNames) {
      const initial = (await host.tool('read_prompt', { target })) as {
        text: string;
        version: string;
        source: string;
      };
      assert.equal(initial.source, 'default');
      const text = `Agent-owned ${target} configuration: ask about intentions and adapt to observed learning.`;
      const revision = (await host.tool('revise_prompt', {
        target,
        text,
        reason: 'Player feedback on repetitive coaching.',
        parentVersion: initial.version,
      })) as { id: string };
      assert.equal(host.prompts(target), text);
      assert.equal(host.state().promptVersions[target], revision.id);
      await assert.rejects(
        host.tool('revise_prompt', {
          target,
          text: 'stale edit',
          reason: 'test',
          parentVersion: initial.version,
        }),
        /version changed/,
      );
      host.undoPrompt(target);
      assert.equal(host.prompts(target), initial.text);
    }
    await assert.rejects(
      host.tool('revise_prompt', {
        target: 'tools',
        text: 'Change permissions',
        reason: 'test',
        parentVersion: 'default',
      }),
      /Invalid prompt/,
    );
    const versions = host.state().promptVersions;
    host.store.close();
    const restored = new Runtime(directory);
    try {
      assert.deepEqual(restored.state().promptVersions, versions);
    } finally {
      restored.store.close();
    }
  } finally {
    if (host.store.db.isOpen) host.store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
