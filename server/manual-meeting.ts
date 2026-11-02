import type { Hono } from 'hono';
import { coachingDay, previousDay, validCoachingDay, type DailyJobs } from './jobs.js';
import { isFrozenEvidence } from './evidence.js';

/** Manual selection shares the scheduler's durable lock and completed-day checkpoints. */
export function registerManualMeeting(
  app: Hono,
  jobs: Pick<DailyJobs, 'runDay'>,
  now: () => Date = () => new Date(),
) {
  app.post('/api/meeting', async (c) => {
    let selection: unknown;
    try {
      const text = await c.req.text();
      const body: unknown = text.trim() ? JSON.parse(text) : {};
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid body');
      selection = 'day' in body ? body.day : 'previous';
    } catch {
      return c.json(
        {
          error: 'Send a JSON object with day set to current, previous, or YYYY-MM-DD.',
          kind: 'invalid_day',
        },
        400,
      );
    }
    const current = coachingDay(now());
    const day =
      selection === 'current'
        ? current
        : selection === 'previous'
          ? previousDay(current)
          : selection;
    if (!validCoachingDay(day) || day > current)
      return c.json(
        {
          error: 'Choose current, previous, or a valid coaching day no later than today.',
          kind: 'invalid_day',
        },
        400,
      );
    const meeting = await jobs.runDay(day);
    if (!meeting)
      return c.json(
        {
          day,
          status: 'locked',
          kind: 'lock_contention',
          error: 'A daily meeting is already running; retry after it finishes.',
        },
        409,
      );
    const evidence = isFrozenEvidence(meeting.evidence) ? meeting.evidence : undefined;
    return c.json({
      ...meeting,
      cutoff: evidence?.cutoff ?? null,
      watermark: evidence?.watermark ?? null,
      truncated: evidence?.truncated ?? null,
    });
  });
}
