import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime } from '../server/runtime.js';
import { DailyJobs, type Meeting } from '../server/jobs.js';
import { createMeetingCallbacks } from '../server/meeting.js';
import { qualityProposal } from '../server/meeting-quality.js';

const evidence = {
  day: '2026-10-31',
  events: [
    {
      id: 10,
      kind: 'coach_verification',
      value: { valid: false, category: 'false-claim', reason: 'False mate claim' },
    },
    {
      id: 11,
      kind: 'coach_verification',
      value: { valid: false, category: 'false-claim', reason: 'False attack geometry' },
    },
  ],
};
const baseline = { text: 'Use unassisted baseline play.', actions: [] };
void test('repeated host-confirmed coaching errors stage actionable engineering work, not only independent play', () => {
  const result = qualityProposal(baseline, evidence);
  assert.equal(result.actions.length, 1);
  const action = result.actions[0];
  assert.equal(action.name, 'propose_app_change');
  assert.deepEqual(Object.keys(action.args).sort(), [
    'acceptance',
    'desiredBehavior',
    'evidence',
    'priority',
    'problem',
  ]);
  assert.match(String(action.args.evidence), /event:10, event:11/);
  assert.match(String(action.args.acceptance), /regressions/);
  assert.match(String(action.args.desiredBehavior), /Independent baseline play does not repair/);
  assert.equal(action.args.priority, 'high');
  assert.equal(qualityProposal(baseline, { events: [] }).actions.length, 0);
  assert.equal(
    qualityProposal(baseline, { events: [evidence.events[0], evidence.events[0]] }).actions.length,
    0,
  );
  assert.equal(
    qualityProposal(baseline, { events: [{ id: 12, kind: 'player', value: 'Coach wrong twice' }] })
      .actions.length,
    0,
  );
});

void test('an evidence-linked prompt response reuses existing tools without an invented extra feature', () => {
  const result = qualityProposal(
    {
      ...baseline,
      actions: [
        {
          name: 'revise_prompt',
          args: {
            target: 'coach',
            text: 'Verify claims before speaking.',
            reason: 'event:10, event:11',
            parentVersion: 'default',
          },
          result: { staged: true },
        },
      ],
    },
    evidence,
  );
  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].name, 'revise_prompt');
});

void test('independent reviewer receives engineering proposal and acceptance queues durable backlog', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lasso-quality-'));
  const runtime = new Runtime(directory);
  runtime.backup.checkpoint = async () => {};
  const state = runtime.store.workspace();
  state.mode = 'live';
  runtime.store.save(state);
  let reviewed = false;
  runtime.paid = async (message, _workspace, role) => {
    if (role === 'assistant-coach') {
      const request = JSON.parse(message) as { proposal: string };
      const staged = JSON.parse(request.proposal) as { actions: { name: string }[] };
      assert.equal(staged.actions[0].name, 'propose_app_change');
      reviewed = true;
    }
    return {
      ...baseline,
      text:
        role === 'assistant-coach'
          ? 'Engineering response and plan are supported. ACCEPT'
          : baseline.text,
      usage: { input: 0, output: 0, cost: 0 },
      sessionId: 'synthetic',
    };
  };
  const callbacks = createMeetingCallbacks(runtime, directory);
  callbacks.snapshot = async () => evidence;
  try {
    await new DailyJobs(join(directory, 'jobs'), callbacks).runDay(evidence.day);
    assert.equal(reviewed, true);
    assert.match(runtime.store.read('backlog/app-improvements.md'), /event:10, event:11/);
    assert.match(
      runtime.store.read(`meetings/${evidence.day}/decision.md`),
      /Engineering review \(accepted\)/,
    );
    assert.match(
      runtime.store.read(`diary/${evidence.day}.md`),
      /defects remain open until their acceptance checks pass/,
    );
  } finally {
    runtime.store.close();
  }
});

void test('rejected engineering proposal cannot change backlog, profile, plan or active prompts; operator sees deferral', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lasso-rejected-'));
  const runtime = new Runtime(directory);
  runtime.backup.checkpoint = async () => {};
  const callbacks = createMeetingCallbacks(runtime, directory);
  const paths = ['backlog/app-improvements.md', 'profile/current.md', 'plans/current.md'];
  const before = paths.map((path) => runtime.store.read(path));
  const proposal = qualityProposal(
    {
      ...baseline,
      actions: [
        {
          name: 'propose_record_update',
          args: { target: 'profile', text: 'Unsupported', evidence: [] },
          result: {},
        },
        {
          name: 'propose_record_update',
          args: { target: 'plan', text: 'Unsupported', evidence: [] },
          result: {},
        },
        {
          name: 'revise_prompt',
          args: { target: 'coach', text: 'Unsupported', reason: 'None', parentVersion: 'default' },
          result: {},
        },
      ],
    },
    evidence,
  );
  const meeting: Meeting = {
    day: evidence.day,
    evidence,
    proposal: JSON.stringify(proposal),
    status: 'complete',
    rounds: [
      {
        critique: {
          accepted: false,
          text: 'Engineering remedy and strength claims unsupported. REVISE',
        },
      },
    ],
  };
  try {
    await callbacks.commit(meeting);
    assert.deepEqual(
      paths.map((path) => runtime.store.read(path)),
      before,
    );
    assert.equal(runtime.store.get('prompt:coach'), undefined);
    assert.match(
      runtime.store.read(`meetings/${evidence.day}/decision.md`),
      /Intentionally deferred/,
    );
    assert.match(runtime.store.read(`meetings/${evidence.day}/decision.md`), /event:10, event:11/);
  } finally {
    runtime.store.close();
  }
});
