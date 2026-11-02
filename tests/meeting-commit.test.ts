import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime } from '../server/runtime.js';
import { createMeetingCallbacks } from '../server/meeting.js';
import type { Meeting } from '../server/jobs.js';

const day = '2026-10-31';
const actions = [
  {
    name: 'propose_record_update',
    args: { target: 'plan', text: 'Accepted plan response', evidence: ['synthetic:plan'] },
  },
  {
    name: 'propose_record_update',
    args: {
      target: 'profile',
      text: 'Accepted profile correction',
      evidence: ['synthetic:profile'],
    },
  },
  {
    name: 'propose_app_change',
    args: {
      problem: 'Synthetic recurring coach defect',
      evidence: 'synthetic:coach',
      desiredBehavior: 'Verify the stated board claim',
      acceptance: 'Replay synthetic rejection',
      priority: 'high',
    },
  },
  {
    name: 'revise_prompt',
    args: {
      target: 'coach',
      text: 'Accepted prompt correction',
      reason: 'Synthetic verified defect',
      parentVersion: 'default',
    },
  },
];
function fixture(accepted = true): Meeting {
  return {
    day,
    evidence: { day, events: [] },
    proposal: JSON.stringify({
      text: 'Supported synthetic training and engineering response.',
      actions,
    }),
    rounds: [
      { critique: { accepted, text: accepted ? 'Supported. ACCEPT' : 'Unsupported. REVISE' } },
    ],
    status: 'complete',
  };
}
function open(directory: string) {
  const runtime = new Runtime(directory);
  runtime.backup.checkpoint = async () => {};
  return runtime;
}
function count(text: string, value: string) {
  return text.split(value).length - 1;
}
function assertAppliedOnce(runtime: Runtime) {
  assert.equal(count(runtime.store.read('plans/current.md'), 'Accepted plan response'), 1);
  assert.equal(count(runtime.store.read('profile/current.md'), 'Accepted profile correction'), 1);
  assert.equal(
    count(runtime.store.read('backlog/app-improvements.md'), 'Synthetic recurring coach defect'),
    1,
  );
  assert.equal(runtime.prompts('coach'), 'Accepted prompt correction');
  const history = readdirSync(runtime.store.path('prompts/history'));
  assert.equal(history.length, 1);
  const revision = JSON.parse(runtime.store.read('prompts/history/' + history[0])) as {
    parent: string;
    previousText: string;
  };
  assert.equal(revision.parent, 'default');
  assert.notEqual(revision.previousText, 'Accepted prompt correction');
  assert.equal(
    runtime.store.events().filter((event) => event.kind === 'record_revision').length,
    2,
  );
  assert.equal(runtime.store.events().filter((event) => event.kind === 'meeting').length, 1);
}

for (let crashAfter = 0; crashAfter < actions.length; crashAfter++) {
  void test(`accepted meeting retries once after ${actions[crashAfter].name} ${String(actions[crashAfter].args.target ?? 'backlog')} side effect and before the action marker`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'lasso-meeting-commit-'));
    let runtime = open(directory);
    const original = runtime.tool.bind(runtime);
    let calls = 0;
    runtime.tool = async (...args) => {
      const result = await original(...args);
      if (calls++ === crashAfter) throw new Error('Injected process death after tool side effect');
      return result;
    };
    try {
      await assert.rejects(
        createMeetingCallbacks(runtime, directory).commit(fixture()),
        /Injected process death/,
      );
      assert.equal(runtime.store.get(`meeting-action:${day}:${crashAfter}`), undefined);
      const previousPromptId = runtime.store.get<string>('prompt:coach');
      runtime.store.close();
      runtime = open(directory);
      await createMeetingCallbacks(runtime, directory).commit(fixture());
      await createMeetingCallbacks(runtime, directory).commit(fixture());
      assertAppliedOnce(runtime);
      if (previousPromptId) assert.equal(runtime.store.get('prompt:coach'), previousPromptId);
    } finally {
      runtime.store.close();
    }
  });
}

for (const target of [
  'plans/current.md',
  'backlog/app-improvements.md',
  'prompts/current/coach.md',
]) {
  void test(`accepted meeting recovers a crash inside the tool after atomic write of ${target}`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'lasso-meeting-write-'));
    let runtime = open(directory);
    const write = runtime.store.write.bind(runtime.store);
    runtime.store.write = (path, text) => {
      write(path, text);
      if (path === target) throw new Error('Injected process death after file replacement');
    };
    try {
      await assert.rejects(
        createMeetingCallbacks(runtime, directory).commit(fixture()),
        /Injected process death/,
      );
      runtime.store.close();
      runtime = open(directory);
      if (target === 'plans/current.md')
        runtime.store.write(target, runtime.store.read(target) + '\nOperator note kept on retry.');
      await createMeetingCallbacks(runtime, directory).commit(fixture());
      assertAppliedOnce(runtime);
      if (target === 'plans/current.md')
        assert.match(runtime.store.read(target), /Operator note kept on retry/);
    } finally {
      runtime.store.close();
    }
  });
}

void test('accepted meeting action identity cannot be reused for changed content, and rejection creates no effects', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lasso-meeting-identity-'));
  const runtime = open(directory);
  try {
    await createMeetingCallbacks(runtime, directory).commit(fixture(false));
    assert.equal(runtime.store.get('prompt:coach'), undefined);
    assert.doesNotMatch(runtime.store.read('plans/current.md'), /Accepted plan response/);
    assert.equal(runtime.store.get(`reviewed:meeting-action:${day}:0`), undefined);
    await runtime.tool(
      actions[0].name,
      actions[0].args,
      'coach',
      undefined,
      `meeting-action:${day}:0`,
    );
    await assert.rejects(
      runtime.tool(
        actions[0].name,
        { ...actions[0].args, text: 'Changed action' },
        'coach',
        undefined,
        `meeting-action:${day}:0`,
      ),
      /changed during retry/,
    );
  } finally {
    runtime.store.close();
  }
});

void test('accepted diary content survives final report generation and a retry after its side effect', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lasso-meeting-diary-'));
  let runtime = open(directory);
  const meeting = fixture();
  const proposal = JSON.parse(meeting.proposal!);
  proposal.actions.push({
    name: 'propose_record_update',
    args: { target: 'diary', text: 'Accepted diary detail', evidence: ['synthetic:diary'] },
  });
  meeting.proposal = JSON.stringify(proposal);
  const tool = runtime.tool.bind(runtime);
  runtime.tool = async (...args) => {
    const result = await tool(...args);
    if (args[0] === 'propose_record_update' && args[1].target === 'diary')
      throw new Error('Injected crash after accepted diary write');
    return result;
  };
  try {
    await assert.rejects(
      createMeetingCallbacks(runtime, directory).commit(meeting),
      /Injected crash/,
    );
    runtime.store.close();
    runtime = open(directory);
    await createMeetingCallbacks(runtime, directory).commit(meeting);
    await createMeetingCallbacks(runtime, directory).commit(meeting);
    const diary = runtime.store.read(`diary/${day}.md`);
    assert.equal(count(diary, 'Accepted diary detail'), 1);
    assert.match(diary, /synthetic:diary/);
    assert.match(diary, /Supported synthetic training and engineering response/);
    assert.equal(runtime.store.get(`meeting-action:${day}:4`), true);
  } finally {
    runtime.store.close();
  }
});
