import { freezeEvidence, makeMeetingRequest } from './evidence.js';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import {
  meetingSource,
  meetingFacts,
  verificationReceipts,
  provenanceObjections,
  factsReport,
  countObjections,
  type VerificationReceipt,
} from './meeting-facts.js';
import { parseProposal, qualityProposal, qualityReport } from './meeting-quality.js';
import type { Runtime } from './runtime.js';
import { type DailyCallbacks } from './jobs.js';

export function createMeetingCallbacks(runtime: Runtime, directory: string): DailyCallbacks {
  return {
    snapshot: async (day) => freezeEvidence(runtime.store, day),
    prepareEvidence: async (day, evidence) => freezeEvidence(runtime.store, day, evidence),
    propose: async (day, evidence) => {
      if (runtime.store.workspace().mode === 'mock')
        return JSON.stringify(
          qualityProposal(
            {
              text: `Mock consolidation for ${day}: insufficient independent evidence; preserve the baseline plan.`,
              actions: [],
            },
            meetingSource(runtime.store, evidence),
          ),
        );
      const result = await runtime.paid(
        makeMeetingRequest(runtime.store, day, evidence, { stage: 'proposal' }),
        runtime.store.workspace(),
        'consolidation',
      );
      return JSON.stringify({
        ...qualityProposal(result, meetingSource(runtime.store, evidence)),
        verification: verificationReceipts(result.actions),
      });
    },
    critique: async (day, evidence, proposal, round) => {
      const facts = meetingFacts(runtime.store, day, evidence);
      const parsed = parseProposal(proposal);
      const result =
        runtime.store.workspace().mode === 'mock'
          ? {
              text: 'Independent mock review: do not infer strength from assisted completion or a small sample.',
              actions: [],
            }
          : await runtime.paid(
              makeMeetingRequest(runtime.store, day, evidence, {
                stage: 'critique',
                proposal,
                round,
              }),
              runtime.store.workspace(),
              'assistant-coach',
            );
      const verification = verificationReceipts(result.actions);
      const leadText = [
        parsed.text,
        ...parsed.actions
          .filter((action) => action.name === 'propose_record_update')
          .map((action) => (typeof action.args.text === 'string' ? action.args.text : '')),
      ].join('\n');
      const objections = [
        ...facts.issues,
        ...countObjections(leadText, facts),
        ...countObjections(result.text, facts),
        ...provenanceObjections(leadText, parsed.verification ?? [], 'lead'),
        ...provenanceObjections(result.text, verification, 'reviewer'),
      ];
      return {
        accepted:
          (runtime.store.workspace().mode === 'mock' || /\bACCEPT\s*$/.test(result.text)) &&
          objections.length === 0,
        text: objections.length
          ? result.text.replace(/\bACCEPT\s*$/, 'REVISE') +
            '\nHost review objections: ' +
            objections.join(' ')
          : result.text,
        verification,
        hostFacts: facts,
        objections,
      };
    },
    revise: async (day, evidence, proposal, critique) => {
      const result = await runtime.paid(
        makeMeetingRequest(runtime.store, day, evidence, { stage: 'revision', proposal, critique }),
        runtime.store.workspace(),
        'consolidation',
      );
      return JSON.stringify({
        ...qualityProposal(result, meetingSource(runtime.store, evidence)),
        verification: verificationReceipts(result.actions),
      });
    },
    commit: async (meeting) => {
      if (runtime.store.get('meeting:' + meeting.day)) return;
      const proposal = parseProposal(meeting.proposal ?? 'No change.');
      const facts = meetingFacts(runtime.store, meeting.day, meeting.evidence);
      const leadText = [
        proposal.text,
        ...proposal.actions
          .filter((action) => action.name === 'propose_record_update')
          .map((action) => (typeof action.args.text === 'string' ? action.args.text : '')),
      ].join('\n');
      const objections = [
        ...provenanceObjections(leadText, proposal.verification ?? [], 'lead'),
        ...countObjections(leadText, facts),
      ];
      const accepted = meeting.rounds.at(-1)?.critique.accepted === true && objections.length === 0;
      const engineering = qualityReport(proposal, accepted);
      const review = meeting.rounds.at(-1)?.critique as
        | { verification?: VerificationReceipt[]; objections?: string[] }
        | undefined;
      const safeText = objections.length
        ? 'Lead narrative withheld from the final report because its verification or strength claims are unsupported. See proposal.json for the attributed, unaccepted source claim.\n' +
          objections.join('\n')
        : proposal.text;
      const report =
        safeText +
        engineering +
        factsReport(facts, proposal.verification ?? [], review?.verification ?? []);
      const unresolved = accepted
        ? ''
        : '\n\nUnresolved assistant-coach objections: retain the prior training plan and profile pending further evidence.';
      runtime.store.write(`meetings/${meeting.day}/proposal.json`, meeting.proposal ?? '{}');
      runtime.store.write(`meetings/${meeting.day}/decision.md`, report + unresolved);
      runtime.store.write(
        `meetings/${meeting.day}/critique.jsonl`,
        meeting.rounds.map((round) => JSON.stringify(round)).join('\n'),
      );
      if (accepted)
        for (const [index, action] of (proposal.actions ?? []).entries()) {
          const key = `meeting-action:${meeting.day}:${index}`;
          if (runtime.store.get(key)) continue;
          await runtime.tool(action.name, action.args);
          runtime.store.put(key, true);
        }
      runtime.store.write(`diary/${meeting.day}.md`, report + unresolved);
      runtime.store.transaction(() => {
        runtime.store.put('meeting:' + meeting.day, meeting);
        runtime.store.put('journal', [
          ...(runtime.store.get<string[]>('journal') ?? []),
          `${meeting.day}\n${report}${unresolved}`,
        ]);
        runtime.store.event('meeting', { day: meeting.day, accepted });
      });
      runtime.store.flushEvents();
      void runtime.backup.checkpoint();
    },
    develop: async (meeting) => {
      const supervisor = join(directory, 'supervisor', 'supervisor.mjs');
      const policy = join(directory, 'supervisor', 'policy.json');
      if (!existsSync(supervisor) || !existsSync(policy)) {
        runtime.store.put('development:' + meeting.day, {
          status: 'pending',
          reason:
            'Run npm run setup:runtime, then configure a verified isolated Codex runner and release adapter.',
        });
        return false;
      }
      const request = join(directory, 'supervisor', `request-${meeting.day}.json`);
      const { writeFile } = await import('node:fs/promises');
      await writeFile(
        request,
        JSON.stringify({
          backlog: runtime.store.read('backlog/app-improvements.md'),
          prompt: runtime.prompts('codex'),
          retrospective: runtime.prompts('retro'),
        }),
        { mode: 0o600 },
      );
      const { runCandidate } = await import(pathToFileURL(supervisor).href);
      const record = (await runCandidate(policy, request)) as { status: string; reason: string };
      runtime.store.put('development:' + meeting.day, record);
      runtime.store.put('development-status', record);
      return record.status === 'deployed' || record.status === 'validated';
    },
  };
}
