import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Chess } from 'chess.js';
import { snapshot } from '../src/lib/chess.js';
import { Runtime } from '../server/runtime.js';
import { createMeetingCallbacks } from '../server/meeting.js';
import {
  meetingFacts,
  meetingSource,
  provenanceObjections,
  countObjections,
  factsReport,
} from '../server/meeting-facts.js';
import { qualityProposal } from '../server/meeting-quality.js';
import { positionReference } from '../server/board-facts.js';

const day = '2026-10-31';
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'lasso-facts-'));
  const runtime = new Runtime(directory);
  runtime.backup.checkpoint = async () => {};
  return { runtime, callbacks: createMeetingCallbacks(runtime, directory) };
}
function event(runtime: Runtime, at: string, kind: string, value: unknown) {
  runtime.store.db
    .prepare('INSERT INTO events(at,kind,value) VALUES(?,?,?)')
    .run(at, kind, JSON.stringify(value));
}
void test('opening history, total PGN plies, per-day player moves and each assistance class remain distinct across days', () => {
  const { runtime } = setup();
  try {
    const state = runtime.store.workspace();
    const board = new Chess();
    board.loadPgn(state.game.pgn);
    for (const san of ['Nc3', 'Nf6', 'd3', 'd6', 'Bg5', 'Bg4']) board.move(san);
    state.game = snapshot(board);
    runtime.store.put('game-start:' + state.gameId, '2026-10-30T08:00:00Z');
    runtime.store.archiveGame(state);
    const put = (at: string, assistanceStatus?: string) =>
      event(runtime, at, 'move', { gameId: state.gameId, assistanceStatus });
    put('2026-10-30T08:00:01Z', 'assisted');
    put('2026-10-31T08:00:01Z', 'assisted');
    put('2026-10-31T08:01:01Z', 'independent-observation');
    put('2026-10-31T08:02:01Z');
    const facts = meetingFacts(runtime.store, day);
    assert.equal(runtime.store.stats().moves, 4);
    assert.deepEqual(facts.counts, {
      loggedPlayerMoves: 3,
      assistedAttempts: 1,
      independentAttempts: 1,
      unknownAssistanceAttempts: 1,
    });
    assert.equal(facts.games[0].totalGamePliesAtSnapshot, 12);
    assert.equal(facts.games[0].loggedPlayerMoves, 3);
    assert.equal(
      'gameStartedOutsideWindow' in facts.games[0] && facts.games[0].gameStartedOutsideWindow,
      true,
    );
    assert.equal(facts.games[0].evidenceWindow, day);
    assert.equal(facts.evidenceWindow.boundary, '04:00');
    assert.match(countObjections('12 moves, all assisted.', facts).join(' '), /Ambiguous/);
    assert.match(
      countObjections('There were 3 assisted attempts.', facts).join(' '),
      /contradicts/,
    );
    assert.deepEqual(
      countObjections(
        '3 logged player moves; 1 assisted attempts; 1 independent attempts; 1 unknown assistance attempts.',
        facts,
      ),
      [],
    );
  } finally {
    runtime.store.close();
  }
});

void test('frozen manifests reuse captured failures and counts and reject altered raw evidence', () => {
  const { runtime } = setup();
  try {
    const raw = JSON.stringify({
      day,
      events: [
        {
          id: 1,
          at: day + 'T08:00:00Z',
          kind: 'coach_verification',
          value: { valid: false, category: 'false-claim' },
        },
        {
          id: 2,
          at: day + 'T08:01:00Z',
          kind: 'coach_verification',
          value: { valid: false, category: 'false-claim' },
        },
        { id: 3, at: day + 'T08:02:00Z', kind: 'move', value: { assistanceStatus: 'assisted' } },
      ],
    });
    const path = 'meetings/' + day + '/evidence/raw.json';
    runtime.store.write(path, raw);
    const manifest = {
      version: 2,
      records: { raw: { path, sha256: createHash('sha256').update(raw).digest('hex') } },
    };
    event(runtime, day + 'T08:03:00Z', 'move', { assistanceStatus: 'independent-observation' });
    assert.equal(meetingFacts(runtime.store, day, manifest).counts.loggedPlayerMoves, 1);
    assert.equal(
      qualityProposal({ text: 'baseline', actions: [] }, meetingSource(runtime.store, manifest))
        .actions.length,
      1,
    );
    runtime.store.write(path, raw + ' ');
    assert.throws(() => meetingSource(runtime.store, manifest), /hash mismatch/);
  } finally {
    runtime.store.close();
  }
});

void test('reviewer challenges wrong mate assertion and incomplete supplied board facts even when model accepts', async () => {
  const { runtime, callbacks } = setup();
  try {
    const state = runtime.store.workspace();
    state.mode = 'live';
    runtime.store.save(state);
    runtime.paid = async () => ({
      text: 'The lead coach agrees. ACCEPT',
      actions: [],
      usage: { input: 0, output: 0, cost: 0 },
      sessionId: 'synthetic',
    });
    const evidence = {
      day,
      events: [],
      boardFacts: [{ fen: state.game.fen, checkmate: true, pieces: { e1: 'wk' } }],
    };
    const critique = await callbacks.critique(
      day,
      evidence,
      JSON.stringify({ text: 'Use more baseline play.', actions: [] }),
      1,
    );
    assert.equal(critique.accepted, false);
    assert.match(critique.text, /checkmate claim contradicts chess.js/);
    assert.match(critique.text, /piece list is incomplete or wrong/);
  } finally {
    runtime.store.close();
  }
});

void test('archive and rule checks cannot become engine checks or reviewer-performed checks', async () => {
  const { runtime, callbacks } = setup();
  try {
    const state = runtime.store.workspace();
    state.mode = 'live';
    runtime.store.save(state);
    runtime.paid = async () => ({
      text: 'I independently verified the board. Stockfish checked the mate. ACCEPT',
      actions: [
        {
          name: 'read_history',
          args: { path: 'synthetic.md' },
          result: { text: 'Old coach claimed engine verification.' },
        },
      ],
      usage: { input: 0, output: 0, cost: 0 },
      sessionId: 'synthetic',
    });
    const proposal = JSON.stringify({ text: 'Stockfish checked the mate.', actions: [] });
    const critique = await callbacks.critique(day, { events: [] }, proposal, 1);
    assert.equal(critique.accepted, false);
    assert.match(critique.text, /engine verification declarations require host-rendered/);
    assert.match(
      critique.text,
      /self-performed board verification declarations require host-rendered/,
    );
    await callbacks.commit({
      day,
      evidence: { events: [] },
      proposal,
      rounds: [{ critique }],
      status: 'complete',
    });
    const report = runtime.store.read(`meetings/${day}/decision.md`);
    assert.doesNotMatch(report, /Stockfish checked the mate/);
    assert.match(report, /host chess.js rule checks; host engine checks: 0/);
    assert.match(report, /Reviewer tool receipts: read_history/);
  } finally {
    runtime.store.close();
  }
});

void test('repeating or calling a numeric estimate official does not manufacture strength evidence', async () => {
  const { runtime, callbacks } = setup();
  try {
    const state = runtime.store.workspace();
    state.mode = 'live';
    runtime.store.save(state);
    runtime.paid = async () => ({
      text: 'The lead coach repeats the official rating of 1600 FIDE. ACCEPT',
      actions: [],
      usage: { input: 0, output: 0, cost: 0 },
      sessionId: 'synthetic',
    });
    const proposal = JSON.stringify({
      text: 'Player is 1600 FIDE.',
      actions: [
        {
          name: 'propose_record_update',
          args: { target: 'profile', text: 'Player is 1600 FIDE.', evidence: [] },
        },
      ],
    });
    const before = runtime.store.read('profile/current.md');
    const critique = await callbacks.critique(day, { events: [] }, proposal, 1);
    assert.equal(critique.accepted, false);
    assert.match(critique.text, /unsupported numeric strength estimate/);
    await callbacks.commit({
      day,
      evidence: { events: [] },
      proposal,
      rounds: [{ critique }],
      status: 'complete',
    });
    assert.equal(runtime.store.read('profile/current.md'), before);
    assert.doesNotMatch(runtime.store.read(`diary/${day}.md`), /1600 FIDE/);
    assert.deepEqual(
      provenanceObjections(
        'No engine check was performed. The archived coach claim is unsupported.',
        [],
        'reviewer',
      ),
      [],
    );
  } finally {
    runtime.store.close();
  }
});

void test('a cited active-board receipt cannot endorse an archived position in narrative', () => {
  const root = positionReference(new Chess().fen(), 7);
  const receipts = [
    {
      tool: 'analyse_position',
      args: {},
      result: {
        engine: 'Stockfish',
        evidence: { id: 'engine-proof-1', reference: root, root, moves: [] },
      },
    },
  ];
  for (const actor of ['lead', 'reviewer'] as const) {
    for (const text of [
      'Stockfish checked this mate.',
      'Stockfish checked the archived mating position (engine-proof-1).',
      `Stockfish checked this position ${root.fen} (engine-proof-1).`,
    ])
      assert.match(
        provenanceObjections(text, receipts, actor).join(' '),
        /engine verification declarations require host-rendered/,
      );
    assert.match(
      provenanceObjections(
        'I independently verified the archived mating position (engine-proof-1).',
        receipts,
        actor,
      ).join(' '),
      /self-performed board verification declarations require host-rendered/,
    );
  }
  assert.match(
    provenanceObjections('No activity today, player is 1600 FIDE.', [], 'lead').join(' '),
    /unsupported numeric/,
  );
});

void test('host report preserves exact structured check provenance and labels malformed receipts unknown', () => {
  const { runtime } = setup();
  try {
    const board = new Chess();
    const root = positionReference(board.fen(), 7);
    board.move('e4');
    const reference = positionReference(board.fen(), 7);
    const limits = { milliseconds: 80, depth: 12, variations: 1, skill: 20 };
    const report = factsReport(
      meetingFacts(runtime.store, day),
      [
        {
          tool: 'analyse_position',
          args: {},
          result: {
            engine: 'Synthetic Stockfish',
            build: 'synthetic-build',
            limits,
            evidence: { id: 'engine-proof-1', reference, root, moves: ['e4'] },
            text: 'Stockfish checked the unrelated archived mate.',
          },
        },
      ],
      [
        {
          tool: 'verify_claims',
          args: {},
          result: { id: 'rule-proof-1', reference, root, moves: ['e4'] },
        },
        {
          tool: 'analyse_position',
          args: {},
          result: { engine: 'Stockfish', evidence: { id: 'malformed-proof' } },
        },
      ],
    );
    const structured = JSON.parse(
      report.split('Structured tool provenance: ')[1].split('\n\nScoped host facts: ')[0],
    );
    assert.equal(structured.lead[0].id, 'engine-proof-1');
    assert.equal(structured.lead[0].exactFen, reference.fen);
    assert.deepEqual(structured.lead[0].root, root);
    assert.deepEqual(structured.lead[0].legalContinuation, ['e4']);
    assert.deepEqual(structured.lead[0].engine, {
      name: 'Synthetic Stockfish',
      build: 'synthetic-build',
      limits,
    });
    assert.equal(structured.reviewer[0].id, 'rule-proof-1');
    assert.equal(structured.reviewer[0].ruleLibrary, 'chess.js');
    assert.equal(structured.reviewer[1].status, 'unknown');
    assert.doesNotMatch(report, /unrelated archived mate/);
    const wrongPosition = factsReport(
      meetingFacts(runtime.store, day),
      [
        {
          tool: 'verify_claims',
          args: {},
          result: { id: 'wrong-path', reference: root, root, moves: ['e4'] },
        },
      ],
      [],
    );
    assert.match(wrongPosition, /"status":"unknown"/);
  } finally {
    runtime.store.close();
  }
});
