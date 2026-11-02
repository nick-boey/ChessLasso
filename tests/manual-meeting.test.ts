import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';
import { registerManualMeeting } from '../server/manual-meeting.js';
import { DailyJobs, validCoachingDay } from '../server/jobs.js';
import { Runtime } from '../server/runtime.js';
import { createMeetingCallbacks } from '../server/meeting.js';
import { isFrozenEvidence } from '../server/evidence.js';
import { Chess } from 'chess.js';
import { snapshot } from '../src/lib/chess.js';
import { meetingFacts } from '../server/meeting-facts.js';

void test('manual current-day includes just-finished cross-day game and repeats the immutable completion', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lasso-manual-'));
  const runtime = new Runtime(directory);
  runtime.backup.checkpoint = async () => {};
  try {
    const now = new Date('2026-11-02T05:00:00Z');
    const state = runtime.store.workspace();
    runtime.store.put('game-start:' + state.gameId, '2026-11-01T12:00:00Z');
    runtime.store.archiveGame(state, 'Just-completed game');
    const before = runtime.store.event('move', { gameId: state.gameId, san: 'e4' });
    const current = runtime.store.event('game_complete', { gameId: state.gameId });
    runtime.store.db
      .prepare('UPDATE events SET at=? WHERE id=?')
      .run('2026-11-01T12:00:00Z', before.id);
    runtime.store.db
      .prepare('UPDATE events SET at=? WHERE id=?')
      .run('2026-11-02T04:59:00Z', current.id);
    const jobs = new DailyJobs(join(directory, 'jobs'), createMeetingCallbacks(runtime, directory));
    const app = new Hono();
    registerManualMeeting(app, jobs, () => now);
    const request = (body: string) => app.request('/api/meeting', { method: 'POST', body });
    const first = await request('{"day":"current"}');
    assert.equal(first.status, 200);
    const result = await first.json();
    assert.equal(result.day, '2026-11-02');
    assert.equal(result.status, 'complete');
    assert.ok(result.rounds.length > 0);
    assert.equal(typeof result.cutoff, 'string');
    const meeting = await jobs.runDay('2026-11-02');
    assert.ok(isFrozenEvidence(meeting?.evidence));
    if (!isFrozenEvidence(meeting?.evidence)) throw new Error('Missing frozen evidence');
    const raw = JSON.parse(runtime.store.read(meeting.evidence.records.raw.path));
    assert.deepEqual(
      raw.events.map((event: { id: number }) => event.id),
      [current.id],
    );
    assert.equal(raw.games[0].id, state.gameId);
    const frozenGame = runtime.store.read(raw.games[0].frozen.path);
    assert.match(frozenGame, /GameId/);
    runtime.store.event('move', { later: true });
    assert.deepEqual(await (await request('{"day":"2026-11-02"}')).json(), result);
    assert.equal((runtime.store.get<string[]>('journal') ?? []).length, 1);
    assert.equal(runtime.store.workspace().game.fen, state.game.fen);
    assert.equal((await (await request('{}')).json()).day, '2026-11-01');
    assert.equal((await (await request('{"day":"previous"}')).json()).day, '2026-11-01');
  } finally {
    runtime.store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

void test('manual date selection validates real dates and Sydney 04:00 across both DST changes', async () => {
  for (const day of [
    '2026-02-29',
    '2026-02-30',
    '2026-13-01',
    '2026-00-01',
    '2026-01-00',
    'not-a-date',
  ])
    assert.equal(validCoachingDay(day), false);
  assert.equal(validCoachingDay('2028-02-29'), true);
  for (const [now, expected] of [
    ['2026-10-03T16:59:00Z', '2026-10-03'],
    ['2026-10-03T17:00:00Z', '2026-10-04'],
    ['2026-04-04T17:59:00Z', '2026-04-04'],
    ['2026-04-04T18:00:00Z', '2026-04-05'],
  ]) {
    const app = new Hono();
    registerManualMeeting(
      app,
      { runDay: async (day) => ({ day, rounds: [], status: 'complete' }) },
      () => new Date(now),
    );
    const response = await app.request('/api/meeting', {
      method: 'POST',
      body: '{"day":"current"}',
    });
    assert.equal((await response.json()).day, expected);
    for (const body of ['{"day":"2026-02-30"}', '{"day":"2999-01-01"}', '{"day":null}', '[]', '{'])
      assert.equal((await app.request('/api/meeting', { method: 'POST', body })).status, 400);
  }
});

void test('manual lock contention returns 409 while completed meetings return 200', async () => {
  const app = new Hono();
  registerManualMeeting(app, { runDay: async () => null }, () => new Date('2026-11-02T05:00:00Z'));
  const response = await app.request('/api/meeting', { method: 'POST', body: '{"day":"current"}' });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    day: '2026-11-02',
    status: 'locked',
    kind: 'lock_contention',
    error: 'A daily meeting is already running; retry after it finishes.',
  });
});

void test('an actual opponent checkmate across 04:00 stays in current-day context without importing prior-day attempts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lasso-boundary-mate-'));
  const runtime = new Runtime(directory);
  runtime.backup.checkpoint = async () => {};
  try {
    const state = runtime.store.workspace();
    const board = new Chess();
    board.move('f3');
    board.move('e5');
    state.game = snapshot(board);
    state.mode = 'live';
    state.quiet = true;
    runtime.store.save(state);
    runtime.store.put('game-start:' + state.gameId, '2026-11-01T16:50:00Z');
    const originalEvent = runtime.store.event.bind(runtime.store);
    runtime.store.event = (kind, value) => {
      const result = originalEvent(kind, value);
      const at = kind === 'move' ? '2026-11-01T16:59:59Z' : '2026-11-01T17:00:01Z';
      runtime.store.db.prepare('UPDATE events SET at=? WHERE id=?').run(at, result.id);
      return { ...result, at };
    };
    runtime.engine = { play: async () => 'd8h4', analyze: async () => ({}) };
    await runtime.move('g4', state.version, 'boundary-mate');
    assert.equal(runtime.store.workspace().game.over, true);
    const callbacks = createMeetingCallbacks(runtime, directory);
    const evidence = await callbacks.snapshot('2026-11-02');
    const facts = meetingFacts(runtime.store, '2026-11-02', evidence);
    assert.equal(facts.games[0].gameId, state.gameId);
    assert.equal(facts.games[0].totalGamePliesAtSnapshot, 4);
    assert.equal(facts.counts.loggedPlayerMoves, 0);
    assert.equal(facts.boardFacts[0].checkmate, true);
    const previous = meetingFacts(runtime.store, '2026-11-01');
    assert.equal(previous.counts.loggedPlayerMoves, 1);
  } finally {
    runtime.store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
