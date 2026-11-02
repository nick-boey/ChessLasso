import type { VerificationReceipt } from './meeting-facts.js';
import type { CoachAction, CoachResult } from './coach.js';

export interface QualityDefect {
  category: string;
  evidence: string[];
  response: 'application-proposal';
}
export interface MeetingProposal {
  text: string;
  actions: Pick<CoachAction, 'name' | 'args'>[];
  qualityDefects?: QualityDefect[];
  verification?: VerificationReceipt[];
}

/** Only host-recorded deterministic rejections create engineering work automatically. */
export function recurringDefects(evidence: unknown): QualityDefect[] {
  if (!evidence || typeof evidence !== 'object') return [];
  const events = (evidence as { events?: unknown }).events;
  if (!Array.isArray(events)) return [];
  const grouped = new Map<string, string[]>();
  for (const event of events as {
    id?: number;
    kind?: string;
    value?: { valid?: boolean; category?: string };
  }[]) {
    if (
      event.kind !== 'coach_verification' ||
      event.value?.valid !== false ||
      typeof event.value.category !== 'string' ||
      !Number.isInteger(event.id)
    )
      continue;
    const entries = grouped.get(event.value.category) ?? [];
    const reference = `event:${event.id}`;
    if (!entries.includes(reference)) entries.push(reference);
    grouped.set(event.value.category, entries);
  }
  return [...grouped]
    .filter(([, ids]) => ids.length >= 2)
    .map(([category, evidence]) => ({ category, evidence, response: 'application-proposal' }));
}

export function qualityProposal(
  result: Pick<CoachResult, 'text' | 'actions'>,
  evidence: unknown,
): MeetingProposal {
  const actions: MeetingProposal['actions'] = result.actions
    .filter((action) =>
      ['propose_record_update', 'revise_prompt', 'propose_app_change'].includes(action.name),
    )
    .map(({ name, args }) => ({ name, args }));
  const qualityDefects = recurringDefects(evidence);
  for (const defect of qualityDefects) {
    // A response must link the observed failures; a generic training recommendation does not close it.
    const addressed = actions.some(
      (action) =>
        ['propose_app_change', 'revise_prompt'].includes(action.name) &&
        defect.evidence.every((id) => JSON.stringify(action.args).includes(id)),
    );
    if (!addressed)
      actions.push({
        name: 'propose_app_change',
        args: {
          problem: `Recurring coach/harness defect: ${defect.category} was rejected by deterministic verification ${defect.evidence.length} times. This is a coaching accuracy defect, separate from the player's learning needs.`,
          evidence: defect.evidence.join(', '),
          desiredBehavior: `Audit the rejected ${defect.category} claims against their recorded positions; reuse the existing board verification gate, correct the originating coach instruction or harness path, and withhold unsupported tactical advice. Independent baseline play does not repair this defect.`,
          acceptance: `Replay ${defect.evidence.join(', ')} as anonymized synthetic regressions; invalid geometry or mate claims are withheld, corrected claims cite rule or engine provenance, and valid coaching still reaches the player. Verify the original failure cannot recur before marking the defect resolved.`,
          priority: 'high',
        },
      });
  }
  return { text: result.text, actions, qualityDefects };
}

export function parseProposal(text: string): MeetingProposal {
  try {
    const value = JSON.parse(text) as MeetingProposal;
    if (typeof value.text === 'string' && Array.isArray(value.actions)) return value;
  } catch {
    /* Legacy plain-text meetings remain readable. */
  }
  return { text, actions: [] };
}

export function qualityReport(proposal: MeetingProposal, accepted: boolean): string {
  const responses = proposal.actions.filter((action) =>
    ['propose_app_change', 'revise_prompt'].includes(action.name),
  );
  const defects = proposal.qualityDefects ?? [];
  if (!responses.length && !defects.length)
    return '\n\nEngineering review: no supported recurring defect or engineering change identified.';
  return (
    '\n\nEngineering review (' +
    (accepted ? 'accepted' : 'deferred; independent objections remain') +
    '):\n' +
    responses.map((action) => `- ${action.name}: ${JSON.stringify(action.args)}`).join('\n') +
    (defects.length
      ? '\nObserved recurring defects: ' +
        defects.map((defect) => `${defect.category} (${defect.evidence.join(', ')})`).join('; ') +
        (accepted
          ? '. Accepted responses are queued; defects remain open until their acceptance checks pass.'
          : '. Intentionally deferred with the rejected proposal; prior prompts and training records remain active.')
      : '')
  );
}
