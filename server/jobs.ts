import { mkdir, readFile, readdir, rename, writeFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function coachingDay(now: Date, timezone = 'Australia/Sydney'): string {
  const values = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const part = (type: string) => values.find((value) => value.type === type)?.value ?? '';
  const date = new Date(`${part('year')}-${part('month')}-${part('day')}T00:00:00Z`);
  if (Number(part('hour')) < 4) date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

export function previousDay(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

export type Critique = { accepted: boolean; text: string };
export type Meeting = {
  day: string;
  evidence?: unknown;
  proposal?: string;
  rounds: { critique: Critique; revision?: string }[];
  status: 'pending' | 'complete';
  error?: string;
  development?: 'complete' | 'pending';
  nextDevelopmentAt?: number;
};
export interface DailyCallbacks {
  snapshot(day: string): Promise<unknown>;
  /** Upgrade an old frozen checkpoint without resnapshotting live evidence. */
  prepareEvidence?(day: string, evidence: unknown): Promise<unknown>;
  propose(day: string, evidence: unknown): Promise<string>;
  critique(day: string, evidence: unknown, proposal: string, round: number): Promise<Critique>;
  revise(day: string, evidence: unknown, proposal: string, critique: Critique): Promise<string>;
  /** Must be idempotent by day. Atomically saves diary, plan, meeting and accepted backlog. */
  commit(meeting: Meeting): Promise<void>;
  /** Development may return pending; a failed rollout never undoes the meeting. */
  develop?(meeting: Meeting): Promise<void | boolean>;
}

/** Durable checkpoints make completed provider calls reusable after a restart. */
export class DailyJobs {
  private running = false;
  private ticking = false;
  constructor(
    private directory: string,
    private callbacks: DailyCallbacks,
    private timezone = 'Australia/Sydney',
  ) {}

  private async save(file: string, value: unknown) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
    await rename(temporary, file);
  }

  async runDay(day: string): Promise<Meeting | null> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('Invalid coaching day');
    if (this.running) return null;
    this.running = true;
    const lock = path.join(this.directory, 'meeting.lock');
    let owned = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      try {
        await mkdir(lock);
        owned = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        // A stopped process leaves a lease; live holders refresh it every minute.
        if (Date.now() - (await stat(lock)).mtimeMs < 30 * 60_000) return null;
        await rm(lock, { recursive: true });
        try {
          await mkdir(lock);
          owned = true;
        } catch {
          return null;
        }
      }
      heartbeat = setInterval(() => {
        void import('node:fs/promises')
          .then(({ utimes }) => utimes(lock, new Date(), new Date()))
          .catch(() => {});
      }, 60_000);
      heartbeat.unref();
      const file = path.join(this.directory, `${day}.json`);
      let meeting: Meeting;
      try {
        meeting = JSON.parse(await readFile(file, 'utf8')) as Meeting;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        meeting = { day, rounds: [], status: 'pending' };
      }
      if (meeting.status === 'complete') return meeting;
      try {
        if (meeting.evidence === undefined) {
          meeting.evidence = await this.callbacks.snapshot(day);
          await this.save(file, meeting);
        }
        if (this.callbacks.prepareEvidence) {
          meeting.evidence = await this.callbacks.prepareEvidence(day, meeting.evidence);
          await this.save(file, meeting);
        }
        if (!meeting.proposal) {
          meeting.proposal = await this.callbacks.propose(day, meeting.evidence);
          await this.save(file, meeting);
        }
        for (let round = 0; round < 2; round++) {
          let entry = meeting.rounds[round];
          if (!entry) {
            entry = {
              critique: await this.callbacks.critique(
                day,
                meeting.evidence,
                meeting.proposal,
                round + 1,
              ),
            };
            meeting.rounds.push(entry);
            await this.save(file, meeting);
          }
          if (entry.critique.accepted) break;
          if (!entry.revision) {
            entry.revision = await this.callbacks.revise(
              day,
              meeting.evidence,
              meeting.proposal,
              entry.critique,
            );
            await this.save(file, meeting);
          }
          meeting.proposal = entry.revision;
        }
        delete meeting.error;
        await this.callbacks.commit({ ...meeting, status: 'complete' });
        meeting.status = 'complete';
        await this.save(file, meeting);
        return meeting;
      } catch (error) {
        meeting.error = error instanceof Error ? error.name : 'JobFailure';
        await this.save(file, meeting);
        throw error;
      }
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      if (owned) await rm(lock, { recursive: true, force: true });
      this.running = false;
    }
  }

  async tick(now = new Date(), firstDay = previousDay(coachingDay(now, this.timezone))) {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const last = previousDay(coachingDay(now, this.timezone));
      const cursor = path.join(this.directory, 'cursor.json');
      let day = firstDay;
      try {
        day = (JSON.parse(await readFile(cursor, 'utf8')) as { next: string }).next;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      // Bound work on wake, while the durable cursor continues beyond the first month.
      for (let count = 0; day <= last && count < 31; count++) {
        if (!(await this.runDay(day))) break;
        const next = new Date(`${day}T00:00:00Z`);
        next.setUTCDate(next.getUTCDate() + 1);
        day = next.toISOString().slice(0, 10);
        await this.save(cursor, { next: day });
      }
      if (!this.callbacks.develop) return;
      // Development is a separate durable queue; provider/deployment failure cannot block consolidation.
      for (const name of (await readdir(this.directory))
        .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
        .sort()) {
        const file = path.join(this.directory, name);
        const result = JSON.parse(await readFile(file, 'utf8')) as Meeting;
        if (
          result.status !== 'complete' ||
          result.development === 'complete' ||
          (result.nextDevelopmentAt ?? 0) > now.getTime()
        )
          continue;
        try {
          result.development =
            (await this.callbacks.develop(result)) === false ? 'pending' : 'complete';
        } catch {
          result.development = 'pending';
        }
        result.nextDevelopmentAt = now.getTime() + 60 * 60_000;
        await this.save(file, result);
      }
    } finally {
      this.ticking = false;
    }
  }

  start(firstDay?: string, report: (error: unknown) => void = () => {}) {
    const tick = () => {
      void this.tick(new Date(), firstDay).catch(report);
    };
    tick();
    const timer = setInterval(tick, 60_000);
    timer.unref();
    return () => clearInterval(timer);
  }
}
