import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime } from '../server/runtime.js';
import { DailyJobs } from '../server/jobs.js';
import { createMeetingCallbacks } from '../server/meeting.js';
import {
  freezeEvidence,
  makeMeetingRequest,
  type FrozenEvidence,
  type EvidenceRecord,
} from '../server/evidence.js';

function readAll(runtime: Runtime, record: EvidenceRecord) {
  let text = '',
    offset: number | null = 0;
  while (offset !== null) {
    const page = runtime.store.readChunk(record.path, offset, 12000);
    text += page.text;
    offset = page.nextOffset;
  }
  assert.equal(Buffer.byteLength(text), record.totalBytes);
  return text;
}

void test('large frozen day and growing proposals remain paginated through proposal, critique, revision and restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lasso-evidence-'));
  const runtime = new Runtime(directory);
  runtime.backup.checkpoint = async () => {};
  const day = '2026-10-31';
  try {
    const insert = runtime.store.db.prepare('INSERT INTO events(at,kind,value) VALUES(?,?,?)');
    runtime.store.transaction(() => {
      for (let i = 0; i < 51000; i++)
        insert.run(
          '2026-10-31T12:00:00Z',
          i % 10 === 0 ? 'move' : 'presence',
          JSON.stringify({
            observedExposureMs: 10000,
            detail: 'synthetic teaching evidence '.repeat(4),
            i,
          }),
        );
    });
    const frozen = freezeEvidence(runtime.store, day);
    assert.equal(frozen.counts.teaching + frozen.counts.presence, 51000);
    assert.equal(frozen.truncated, false);
    assert.equal(JSON.parse(readAll(runtime, frozen.records.raw)).events.length, 51000);
    assert.equal(readAll(runtime, frozen.records.teaching).split('\n').length, 5100);
    assert.match(frozen.presence.interpretation, /not measured attention/);
    const hugeProposal = JSON.stringify({ text: 'proposal '.repeat(10000), actions: [] });
    for (const stage of ['proposal', 'critique', 'revision'] as const) {
      const request = makeMeetingRequest(runtime.store, day, frozen, {
        stage,
        proposal: hugeProposal,
        critique: { text: 'objection '.repeat(10000) },
      });
      assert.ok(request.length < 48000);
      const parsed = JSON.parse(request);
      const facts = JSON.parse(readAll(runtime, parsed.hostFacts));
      assert.equal(facts.counts.loggedPlayerMoves, 5100);
      assert.equal(facts.counts.unknownAssistanceAttempts, 5100);
      assert.equal(readAll(runtime, parsed.proposal), hugeProposal);
      assert.match(readAll(runtime, parsed.critique), /objection/);
    }
    const callbacks = createMeetingCallbacks(runtime, directory);
    let calls = 0,
      fail = true;
    runtime.paid = async (request) => {
      calls++;
      assert.ok(request.length < 48000);
      const input = JSON.parse(request);
      assert.equal(input.evidence.watermark, frozen.watermark);
      if (input.stage === 'revision' && fail) {
        fail = false;
        throw new Error('Synthetic interruption');
      }
      return {
        text: input.stage === 'critique' ? 'Please revise' : hugeProposal,
        actions: [],
        usage: { input: 0, output: 0, cost: 0 },
        sessionId: 'mock',
      };
    };
    const workspace = runtime.store.workspace();
    workspace.mode = 'live';
    runtime.store.save(workspace);
    const jobsDir = join(directory, 'jobs');
    await assert.rejects(new DailyJobs(jobsDir, callbacks).runDay(day), /Synthetic interruption/);
    const saved = JSON.parse(
      await (await import('node:fs/promises')).readFile(join(jobsDir, `${day}.json`), 'utf8'),
    );
    runtime.store.event('move', { later: true });
    const result = await new DailyJobs(jobsDir, callbacks).runDay(day);
    assert.equal(result?.status, 'complete');
    assert.deepEqual(result?.evidence, saved.evidence);
    assert.equal(calls, 6);
    await new DailyJobs(jobsDir, callbacks).runDay(day);
    assert.equal(calls, 6);
  } finally {
    runtime.store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

void test('legacy oversized checkpoint migration preserves original events, watermark and truncation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lasso-legacy-'));
  const runtime = new Runtime(directory);
  runtime.backup.checkpoint = async () => {};
  try {
    const legacy = {
      day: '2026-10-31',
      watermark: 77,
      truncated: true,
      events: Array.from({ length: 1000 }, (_, id) => ({
        id,
        at: '2026-10-31T12:00:00Z',
        kind: 'presence',
        value: { text: 'old'.repeat(100) },
      })),
    };
    const frozen = freezeEvidence(runtime.store, legacy.day, legacy);
    assert.equal(frozen.watermark, 77);
    assert.equal(frozen.truncated, true);
    assert.deepEqual(JSON.parse(readAll(runtime, frozen.records.raw)), legacy);
    const callbacks = createMeetingCallbacks(runtime, directory);
    const jobsDir = join(directory, 'jobs');
    await (await import('node:fs/promises')).mkdir(jobsDir);
    await writeFile(
      join(jobsDir, `${legacy.day}.json`),
      JSON.stringify({ day: legacy.day, evidence: legacy, rounds: [], status: 'pending' }),
    );
    const result = await new DailyJobs(jobsDir, callbacks).runDay(legacy.day);
    const evidence = result!.evidence as FrozenEvidence;
    assert.equal(evidence.watermark, 77);
    assert.deepEqual(JSON.parse(readAll(runtime, evidence.records.raw)), legacy);
  } finally {
    runtime.store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

void test('frozen cross-day game context and UTF-8 record pages stay stable after continuation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lasso-frozen-game-'));
  const runtime = new Runtime(directory);
  runtime.backup.checkpoint = async () => {};
  try {
    const workspace = runtime.store.workspace();
    runtime.store.put('game-start:' + workspace.gameId, '2026-10-30T12:00:00Z');
    const game = runtime.store.archiveGame(workspace);
    const event = runtime.store.event('move', { gameId: workspace.gameId, san: 'Nc3' });
    runtime.store.db
      .prepare('UPDATE events SET at=? WHERE id=?')
      .run('2026-10-31T12:00:00Z', event.id);
    const frozen = freezeEvidence(runtime.store, '2026-10-31');
    const context = JSON.parse(readAll(runtime, frozen.records.context));
    assert.equal(context.games[0].id, workspace.gameId);
    const original = readAll(runtime, context.games[0].frozen);
    runtime.store.write(game.path, 'new mutable game');
    assert.equal(readAll(runtime, context.games[0].frozen), original);
    const request = JSON.parse(
      makeMeetingRequest(runtime.store, '2026-10-31', frozen, { stage: 'critique' }),
    );
    const facts = JSON.parse(readAll(runtime, request.hostFacts));
    assert.equal(facts.games[0].totalGamePliesAtSnapshot, workspace.game.moves.length);
    const unicode = '♟🙂é'.repeat(5000);
    runtime.store.write('research/unicode.md', unicode);
    assert.equal(
      readAll(runtime, {
        path: 'research/unicode.md',
        totalBytes: Buffer.byteLength(unicode),
        sha256: '',
      }),
      unicode,
    );
  } finally {
    runtime.store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

void test('paginated meeting proposal and independent critique finish within three requests per stage', async () => {
  const { CoachRuntime } = await import('../server/coach.js');
  const { fauxAssistantMessage, fauxToolCall } =
    await import('@earendil-works/pi-ai/providers/faux');
  const directory = await mkdtemp(join(tmpdir(), 'lasso-finite-meeting-'));
  const runtime = new Runtime(directory);
  runtime.backup.checkpoint = async () => {};
  let stages = 0,
    modelRequests = 0;
  try {
    const workspace = runtime.store.workspace();
    workspace.mode = 'live';
    runtime.store.save(workspace);
    const event = runtime.store.event('move', { detail: 'evidence '.repeat(2000) });
    runtime.store.db
      .prepare('UPDATE events SET at=? WHERE id=?')
      .run('2026-10-31T12:00:00Z', event.id);
    runtime.coach = new CoachRuntime({
      sessionsDir: join(directory, 'sessions'),
      getSettings: () => ({ mode: 'mock', provider: 'google', model: 'unused', maxRequests: 3 }),
      getPrompt: async () => ({
        text: 'Review frozen evidence; preserve unsupported decisions.',
        version: 'test',
      }),
      invokeTool: (name, args) => runtime.tool(name, args),
      mockResponses: (message) => {
        stages++;
        const request = JSON.parse(message);
        const first = [
          fauxToolCall('read_history', {
            path: request.evidence.records.teaching.path,
            offset: 0,
            limit: 12000,
          }),
        ];
        if (request.proposal)
          first.push(
            fauxToolCall('read_history', { path: request.proposal.path, offset: 0, limit: 12000 }),
          );
        return [
          () => {
            modelRequests++;
            return fauxAssistantMessage(first);
          },
          () => {
            modelRequests++;
            return fauxAssistantMessage(
              fauxToolCall('read_history', {
                path: request.evidence.records.teaching.path,
                offset: 12000,
                limit: 12000,
              }),
            );
          },
          () => {
            modelRequests++;
            return fauxAssistantMessage(
              request.stage === 'critique'
                ? 'Retain the baseline; insufficient independent evidence. ACCEPT'
                : 'Retain baseline pending a delayed independent retest.',
            );
          },
        ];
      },
    });
    const result = await new DailyJobs(
      join(directory, 'jobs'),
      createMeetingCallbacks(runtime, directory),
    ).runDay('2026-10-31');
    assert.equal(result?.status, 'complete');
    assert.equal(result?.rounds[0]?.critique.accepted, true);
    assert.equal(stages, 2);
    assert.equal(modelRequests, 6);
  } finally {
    runtime.store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
