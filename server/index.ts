import { registerManualMeeting } from './manual-meeting.js';
import { resolve, join } from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createTelemetry, initTelemetry } from './telemetry.js';
try {
  process.loadEnvFile();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
const directory = resolve(process.env.CHESSLASSO_RUNTIME_DIR ?? '../chesslasso-runtime');
const archive = resolve(process.env.CHESSLASSO_ARCHIVE_DIR ?? '../ChessLasso-coaching');
const telemetry = await createTelemetry({
  directory: join(directory, 'telemetry'),
  excludedRoots: [process.cwd(), archive],
});
const observability = initTelemetry(telemetry);
const [
  { createApp },
  { Runtime },
  { CoachRuntime },
  { analysePosition },
  { DailyJobs, coachingDay },
] = await Promise.all([
  import('./app.js'),
  import('./runtime.js'),
  import('./coach.js'),
  import('./engine.js'),
  import('./jobs.js'),
]);
const runtime = new Runtime(directory, archive);
const pendingReservations: string[] = [];
runtime.engine = {
  play: async (fen, pgn, skill) => {
    const result = await observability.operation('engine', () =>
      analysePosition({ fen, pgn, milliseconds: 350, skill: skill ?? 1 }),
    );
    if (!result.bestmove) throw new Error('No legal opponent move.');
    return result.bestmove;
  },
  analyze: (fen) => observability.operation('engine', () => analysePosition({ fen })),
};
runtime.coach = new CoachRuntime({
  sessionsDir: runtime.sessionDirectory(),
  getSettings: () => {
    const state = runtime.store.workspace();
    return {
      mode: state.mode,
      provider: state.provider as 'google' | 'fireworks',
      model: state.model,
    };
  },
  getPrompt: async (role) => ({
    text: runtime.prompts(role),
    version: runtime.store.get<string>('prompt:' + role) ?? 'default',
  }),
  invokeTool: async (name, args, context) =>
    runtime.tool(
      name,
      args,
      typeof context.runRole === 'string' ? context.runRole : 'coach',
      context,
    ),
  beforePaidCall: () => {
    pendingReservations.push(runtime.store.reserve(0.25));
  },
  onUsage: (usage) => {
    const id = pendingReservations.shift();
    if (id) runtime.store.settle(id, usage.cost > 0 ? usage.cost : 0.25);
  },
  onEvent: (event) => observability.event('tool', { operation: event.tool ?? 'coach' }),
});
const app = createApp(runtime, {
  request: async (c, next) => {
    if (c.req.path.startsWith('/api/telemetry')) return next();
    const attributes: Record<string, string | number> = { method: c.req.method };
    await observability.withTrace(c.req.header('traceparent'), () =>
      observability.operation(
        'request',
        async () => {
          await next();
          attributes.status = c.res.status;
          attributes.outcome = c.res.status < 400 ? 'ok' : 'error';
        },
        attributes,
      ),
    );
  },
});
app.post('/api/telemetry/:signal', async (c) => {
  const signal = c.req.param('signal');
  if (!['traces', 'logs', 'metrics'].includes(signal))
    return c.json({ error: 'Unsupported signal.' }, 400);
  return c.json({
    accepted: telemetry.ingest(signal as 'traces' | 'logs' | 'metrics', await c.req.json()),
  });
});
app.get('/api/telemetry/status', (c) => c.json({ ...telemetry.status(), directory: undefined }));
const { createMeetingCallbacks } = await import('./meeting.js');
const jobs = new DailyJobs(join(directory, 'jobs'), createMeetingCallbacks(runtime, directory));
const firstDay = runtime.store.get<string>('first-day') ?? coachingDay(new Date());
runtime.store.put('first-day', firstDay);
const stopJobs = jobs.start(firstDay, (error) => {
  runtime.store.put('job-error', { at: new Date().toISOString(), error: String(error) });
});
registerManualMeeting(app, jobs);
app.use('/*', serveStatic({ root: './dist' }));
app.get('*', serveStatic({ path: './dist/index.html' }));
const backupTimer = setInterval(() => void runtime.backup.checkpoint(), 5 * 60_000);
backupTimer.unref();
const port = Number(process.env.PORT ?? 3001);
const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () =>
  console.log(`ChessLasso: http://127.0.0.1:${port}`),
);
// Recover an accepted player move interrupted before its opponent response.
void runtime.serial(() => runtime.reply()).catch(() => runtime.store.put('opponent-pending', true));
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    stopJobs();
    clearInterval(backupTimer);
    server.close(() => {
      void Promise.all([observability.close(), telemetry.close()]).finally(() => {
        runtime.store.close();
        process.exit(0);
      });
    });
  });
