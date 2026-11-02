import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { parseProposal, qualityProposal, qualityReport } from './meeting-quality.js';
import type { Runtime } from './runtime.js';
import { coachingDay, type DailyCallbacks } from './jobs.js';

export function createMeetingCallbacks(runtime: Runtime, directory: string): DailyCallbacks {
  return {
    snapshot: async (day) => ({
      day,
      stats: runtime.store.stats(),
      ...runtime.store.dayEvents(day, coachingDay),
      plan: runtime.store.read('plans/current.md'),
    }),
    propose: async (day, evidence) => {
      if (runtime.store.workspace().mode === 'mock')
        return JSON.stringify(
          qualityProposal(
            {
              text: `Mock consolidation for ${day}: insufficient independent evidence; preserve the baseline plan.`,
              actions: [],
            },
            evidence,
          ),
        );
      const result = await runtime.paid(
        JSON.stringify({ day, evidence }),
        runtime.store.workspace(),
        'consolidation',
      );
      return JSON.stringify(qualityProposal(result, evidence));
    },
    critique: async (day, evidence, proposal, round) => {
      if (runtime.store.workspace().mode === 'mock')
        return {
          accepted: true,
          text: 'Independent mock review: do not infer strength from assisted completion or a small sample.',
        };
      const text = (
        await runtime.paid(
          JSON.stringify({ day, evidence, proposal, round }),
          runtime.store.workspace(),
          'assistant-coach',
        )
      ).text;
      return { accepted: /\bACCEPT\s*$/.test(text), text };
    },
    revise: async (day, evidence, proposal, critique) => {
      const result = await runtime.paid(
        JSON.stringify({ day, evidence, proposal, critique }),
        runtime.store.workspace(),
        'consolidation',
      );
      return JSON.stringify(qualityProposal(result, evidence));
    },
    commit: async (meeting) => {
      if (runtime.store.get('meeting:' + meeting.day)) return;
      const proposal = parseProposal(meeting.proposal ?? 'No change.');
      const accepted = meeting.rounds.at(-1)?.critique.accepted === true;
      const engineering = qualityReport(proposal, accepted);
      const report = proposal.text + engineering;
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
