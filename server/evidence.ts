import { createHash } from 'node:crypto';
import { coachingDay } from './jobs.js';
import { meetingFacts } from './meeting-facts.js';
import type { ArchiveEntry, Store } from './store.js';

export interface EvidenceRecord {
  path: string;
  sha256: string;
  totalBytes: number;
}
export interface FrozenEvidence {
  version: 2;
  day: string;
  watermark: number;
  truncated: boolean;
  cutoff: string;
  counts: { teaching: number; presence: number };
  presence: { observedExposureMs: number; interpretation: string };
  records: { raw: EvidenceRecord; teaching: EvidenceRecord; context: EvidenceRecord };
}
type Event = { id: number; at: string; kind: string; value: unknown };

export function isFrozenEvidence(value: unknown): value is FrozenEvidence {
  return (
    !!value &&
    typeof value === 'object' &&
    'version' in value &&
    value.version === 2 &&
    'records' in value
  );
}

function record(store: Store, day: string, label: string, text: string): EvidenceRecord {
  const sha256 = createHash('sha256').update(text).digest('hex');
  const path = `meetings/${day}/evidence/${sha256}/${label}`;
  // Content addressed records are never replaced with a newer view of the archive.
  try {
    if (store.read(path) !== text) throw new Error('Frozen evidence integrity failure.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    store.write(path, text);
  }
  return { path, sha256, totalBytes: Buffer.byteLength(text) };
}

/** Legacy migration archives exactly the checkpoint, never a new query of live events. */
export function freezeEvidence(store: Store, day: string, legacy?: unknown): FrozenEvidence {
  if (isFrozenEvidence(legacy)) return legacy;
  const dayEvents = legacy === undefined ? store.dayEvents(day, coachingDay) : undefined;
  const gameIds = new Set(
    dayEvents?.events.flatMap((event) => {
      const value = event.value as { gameId?: string } | null;
      return typeof value?.gameId === 'string' ? [value.gameId] : [];
    }),
  );
  const games =
    legacy === undefined
      ? (store.get<ArchiveEntry[]>('game-index') ?? [])
          .filter(
            (game) =>
              gameIds.has(game.id) || coachingDay(new Date(game.importedAt ?? game.at)) === day,
          )
          .map((game) => ({
            ...game,
            frozen: record(store, day, 'game.pgn', store.read(game.path)),
          }))
      : undefined;
  const snapshot = legacy ?? {
    day,
    ...dayEvents,
    allTimeStats: store.stats(),
    plan: store.read('plans/current.md'),
    games,
    capturedAt: new Date().toISOString(),
  };
  if (!snapshot || typeof snapshot !== 'object')
    throw new Error('Invalid legacy meeting evidence.');
  const source = snapshot as Record<string, unknown>;
  const events = Array.isArray(source.events) ? (source.events as Event[]) : [];
  const teaching = events.filter((event) => event.kind !== 'presence');
  const presence = events.filter((event) => event.kind === 'presence');
  const exposure = presence.reduce((total, event) => {
    const value = event.value as { observedExposureMs?: unknown } | null;
    return (
      total +
      (typeof value?.observedExposureMs === 'number' && Number.isFinite(value.observedExposureMs)
        ? Math.max(0, Math.min(20000, value.observedExposureMs))
        : 0)
    );
  }, 0);
  const { events: _events, ...context } = source;
  return {
    version: 2,
    day,
    watermark:
      typeof source.watermark === 'number'
        ? source.watermark
        : events.reduce((max, event) => Math.max(max, event.id), 0),
    truncated: source.truncated === true,
    cutoff:
      typeof source.capturedAt === 'string'
        ? source.capturedAt
        : (events.at(-1)?.at ?? 'legacy checkpoint; capture time unavailable'),
    counts: { teaching: teaching.length, presence: presence.length },
    presence: {
      observedExposureMs: exposure,
      interpretation:
        'Exposure only. Presence duration is not measured attention, practice quality, or independent performance.',
    },
    records: {
      raw: record(store, day, 'raw.json', JSON.stringify(snapshot)),
      teaching: record(
        store,
        day,
        'teaching.jsonl',
        teaching.map((event) => JSON.stringify(event)).join('\n'),
      ),
      context: record(store, day, 'context.json', JSON.stringify(context)),
    },
  };
}

/** Proposal and critique growth cannot enlarge the initial model request. All bytes remain readable. */
export function makeMeetingRequest(
  store: Store,
  day: string,
  evidence: unknown,
  details: {
    stage: 'proposal' | 'critique' | 'revision';
    proposal?: string;
    critique?: unknown;
    round?: number;
  },
) {
  const frozen = freezeEvidence(store, day, evidence);
  const { proposal, critique, ...stage } = details;
  return JSON.stringify({
    day,
    ...stage,
    evidence: frozen,
    hostFacts: record(
      store,
      day,
      'host-facts.json',
      JSON.stringify(meetingFacts(store, day, frozen)),
    ),
    proposal: proposal === undefined ? undefined : record(store, day, 'proposal.json', proposal),
    critique:
      critique === undefined
        ? undefined
        : record(store, day, 'critique.json', JSON.stringify(critique)),

  });
}
