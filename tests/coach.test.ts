import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Chess } from 'chess.js';
import { CoachRuntime, redactCoachText, type CoachContext } from '../server/coach.js';
import { analysePosition, enginePosition, legalUci } from '../server/engine.js';

void test('engine receives complete history, rejects mismatches and validates returned moves', async () => {
  const chess = new Chess();
  for (const move of ['Nf3', 'Nf6', 'Ng1', 'Ng8']) chess.move(move);
  assert.match(
    enginePosition({ fen: chess.fen(), pgn: chess.pgn() }).command,
    /moves g1f3 g8f6 f3g1 f6g8$/,
  );
  assert.throws(() => enginePosition({ fen: chess.fen(), pgn: '1. e4' }), /does not match/);
  assert.throws(() => legalUci(chess, 'e2e5'), /illegal/);
  await assert.rejects(analysePosition({ fen: chess.fen(), milliseconds: 50000 }), /out of range/);
  const result = await analysePosition({
    fen: chess.fen(),
    pgn: chess.pgn(),
    milliseconds: 80,
    variations: 2,
  });
  assert.match(result.engine, /Stockfish/);
  assert.ok(result.bestmove);
  assert.equal(legalUci(chess, result.bestmove).san, result.san);
  assert.ok(result.network.length > 0);
  assert.ok(result.variations.length > 0);
  assert.equal(result.variations[0]?.score.perspective, 'white');
  await assert.rejects(
    analysePosition({ fen: chess.fen(), signal: AbortSignal.abort() }),
    /cancelled/,
  );
  const controller = new AbortController();
  const cancelled = analysePosition({
    fen: chess.fen(),
    milliseconds: 3000,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(cancelled, /cancelled/);
});

void test('restricted Pi mock executes the real tool boundary and preserves native JSONL history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chesslasso-pi-'));
  const context: CoachContext = { fen: new Chess().fen(), pgn: '', version: 4 };
  const calls: string[] = [];
  let paid = 0;
  const runtime = new CoachRuntime({
    sessionsDir: directory,
    getSettings: () => ({ mode: 'mock', provider: 'google', model: 'gemini-3.8-flash' }),
    getPrompt: async (role) => ({
      text: await readFile(`config/prompts/${role}.md`, 'utf8'),
      version: 'test-v1',
    }),
    invokeTool: async (name, args) => {
      calls.push(name);
      return name === 'inspect_board' ? context : { ok: true, version: context.version, ...args };
    },
    beforePaidCall: () => {
      paid++;
    },
  });
  try {
    const fakeKey = `AIza${'x'.repeat(35)}`;
    assert.equal(redactCoachText(`key=${fakeKey}`), 'key=[REDACTED]');
    const lesson = await runtime.run(`Show me an example ${fakeKey}`, context);
    assert.ok(lesson.text.length > 0);
    assert.equal(lesson.actions[0]?.name, 'show_demonstration');
    assert.equal(lesson.actions[0]?.args.title, 'Explore a legal continuation');
    const quiet = await runtime.run('Please observe quietly', context);
    assert.equal(quiet.sessionId, lesson.sessionId);
    assert.equal(quiet.actions[0]?.args.quiet, true);
    assert.deepEqual(calls, [
      'show_demonstration',
      'inspect_board',
      'record_verified_assistance',
      'start_activity',
      'inspect_board',
      'record_verified_assistance',
    ]);
    assert.equal(paid, 0);
    const dateDir = join(directory, new Date().toISOString().slice(0, 10), 'coach');
    const filename = (await readdir(dateDir)).find((file) => file.endsWith('.jsonl'));
    assert.ok(filename);
    const entries = (await readFile(join(dateDir, filename), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.ok(
      entries.some(
        (entry) =>
          entry.type === 'message' && (entry.message as { role?: string })?.role === 'toolResult',
      ),
    );
    assert.ok(entries.some((entry) => typeof entry.parentId === 'string'));
    assert.match(JSON.stringify(entries), /effectivePrompt/);
    assert.ok(!JSON.stringify(entries).includes(fakeKey));
    assert.match(JSON.stringify(entries), /REDACTED/);
    const review = await runtime.run('Critique the proposed plan', context, 'assistant-coach');
    assert.notEqual(review.sessionId, lesson.sessionId);
    const reviewDir = join(directory, new Date().toISOString().slice(0, 10), 'assistant-coach');
    const reviewFile = (await readdir(reviewDir)).find((file) => file.endsWith('.jsonl'));
    const recorded = await readFile(join(reviewDir, reviewFile!), 'utf8');
    assert.doesNotMatch(recorded, /"name":"(?:bash|write|edit|play_move|revise_prompt)"/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('finite request budget reserves terminal output, caches duplicate reads and preserves exhaustion cause', async () => {
  const { fauxAssistantMessage, fauxToolCall } =
    await import('@earendil-works/pi-ai/providers/faux');
  const { CoachFailure } = await import('../server/coach.js');
  const directory = await mkdtemp(join(tmpdir(), 'lasso-budget-'));
  let reads = 0;
  let budget = 3;
  const runtime = new CoachRuntime({
    sessionsDir: directory,
    getSettings: () => ({ mode: 'mock', provider: 'google', model: 'unused', maxRequests: budget }),
    getPrompt: async () => ({ text: 'Review frozen evidence and finish.', version: 'test' }),
    invokeTool: async () => {
      reads++;
      return { text: 'synthetic page', nextOffset: null };
    },
    mockResponses: () => [
      fauxAssistantMessage(fauxToolCall('read_history', { path: 'meetings/day/teaching.jsonl' })),
      fauxAssistantMessage(fauxToolCall('read_history', { path: 'meetings/day/teaching.jsonl' })),
      (transcript) => {
        const final = transcript.messages.at(-1);
        assert.equal(final?.role, 'system');
        assert.ok(
          final?.role === 'system' &&
            final.toolsRemoved?.some((tool) => tool.name === 'read_history'),
        );
        assert.ok(
          final?.role === 'system' &&
            typeof final.content === 'string' &&
            final.content.includes('"finalRequest":true'),
        );
        return fauxAssistantMessage('Evidence reviewed; preserve the plan. ACCEPT');
      },
    ],
  });
  const context = { fen: new Chess().fen(), pgn: '', version: 0 };
  try {
    const result = await runtime.run('Read frozen meeting pages', context, 'consolidation');
    assert.match(result.text, /ACCEPT/);
    assert.equal(reads, 1);
    budget = 1;
    await assert.rejects(
      runtime.run('Read frozen pages', context, 'assistant-coach'),
      (error: unknown) =>
        error instanceof CoachFailure &&
        error.code === 'request_budget' &&
        !/credentials/.test(error.message),
    );
    await assert.rejects(
      runtime.run('x'.repeat(48001), context),
      (error: unknown) => error instanceof CoachFailure && error.code === 'input_size',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('provider failures remain distinguishable and access-token redaction uses the deployed environment name', async () => {
  const { fauxAssistantMessage } = await import('@earendil-works/pi-ai/providers/faux');
  const { CoachFailure } = await import('../server/coach.js');
  const directory = await mkdtemp(join(tmpdir(), 'lasso-provider-'));
  const old = process.env.CHESSLASSO_ACCESS_TOKEN;
  process.env.CHESSLASSO_ACCESS_TOKEN = 'synthetic-access-token-for-redaction';
  try {
    assert.equal(redactCoachText(process.env.CHESSLASSO_ACCESS_TOKEN), '[REDACTED]');
    const runtime = new CoachRuntime({
      sessionsDir: directory,
      getSettings: () => ({ mode: 'mock', provider: 'google', model: 'unused' }),
      getPrompt: async () => ({ text: 'Review evidence.', version: 'test' }),
      invokeTool: async () => ({}),
      mockResponses: () => [
        fauxAssistantMessage('', {
          stopReason: 'error',
          errorMessage: 'synthetic provider rejected request synthetic-access-token-for-redaction',
        }),
      ],
    });
    await assert.rejects(
      runtime.run('Review', { fen: new Chess().fen(), pgn: '', version: 0 }, 'assistant-coach'),
      (error: unknown) =>
        error instanceof CoachFailure &&
        error.code === 'provider_failure' &&
        !error.message.includes('synthetic-access-token'),
    );
  } finally {
    if (old === undefined) delete process.env.CHESSLASSO_ACCESS_TOKEN;
    else process.env.CHESSLASSO_ACCESS_TOKEN = old;
    await rm(directory, { recursive: true, force: true });
  }
});
