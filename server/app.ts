import { Hono, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getCookie, setCookie } from 'hono/cookie';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { CoachFailure, redactCoachText } from './coach.js';
import { Runtime, ConflictError } from './runtime.js';
import { NotationError, validBudget } from '../src/lib/chess.js';

function equal(a: string, b: string) {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
export function createApp(
  runtime: Runtime,
  options: { authentication?: boolean; request?: MiddlewareHandler } = {},
) {
  const app = new Hono();
  const sessions = new Set<string>();
  const token =
    process.env.CHESSLASSO_ACCESS_TOKEN ??
    runtime.store.get<string>('access-token') ??
    randomUUID();
  runtime.store.put('access-token', token);
  const allowed = new Set(
    (
      process.env.CHESSLASSO_ORIGINS ??
      'http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:3001,http://localhost:3001'
    ).split(','),
  );
  app.use(
    '/api/*',
    bodyLimit({ maxSize: 2_100_000, onError: (c) => c.json({ error: 'Request too large.' }, 413) }),
  );
  const limits = new Map<string, { at: number; count: number }>();
  app.use('/api/*', async (c, next) => {
    const client = c.req.header('x-forwarded-for') ?? 'local';
    const now = Date.now();
    const entry = limits.get(client);
    if (!entry || now - entry.at > 60000) limits.set(client, { at: now, count: 1 });
    else if (++entry.count > 600)
      return c.json({ error: 'Too many requests; wait a moment.' }, 429);
    if (limits.size > 1000) limits.clear();
    if (options.authentication === false) return next();
    const url = new URL(c.req.url);
    const origin = c.req.header('Origin');
    if (
      ![...allowed].some((value) => new URL(value).host === url.host) ||
      (origin && !allowed.has(origin))
    )
      return c.json({ error: 'Origin is not allowed.' }, 403);
    if (c.req.path === '/api/login') return next();
    const session = getCookie(c, 'chesslasso_session');
    if (session && sessions.has(session)) return next();
    // Bootstrap only from direct loopback hosts. Remote Tailscale access always requires the operator token.
    if (
      ['127.0.0.1', 'localhost'].includes(url.hostname) &&
      (!origin || new URL(origin).hostname === url.hostname)
    ) {
      const id = randomUUID();
      sessions.add(id);
      setCookie(c, 'chesslasso_session', id, {
        httpOnly: true,
        sameSite: 'Strict',
        secure:
          url.protocol === 'https:' ||
          [...allowed].some(
            (value) => new URL(value).host === url.host && value.startsWith('https:'),
          ),
        path: '/',
      });
      return next();
    }
    return c.json({ error: 'Sign in with the local access token.' }, 401);
  });
  if (options.request) app.use('/api/*', options.request);
  app.post('/api/login', async (c) => {
    const body = await c.req.json();
    if (typeof body.token !== 'string' || !equal(body.token, token))
      return c.json({ error: 'Invalid access token.' }, 401);
    const id = randomUUID();
    sessions.add(id);
    setCookie(c, 'chesslasso_session', id, {
      httpOnly: true,
      sameSite: 'Strict',
      secure:
        new URL(c.req.url).protocol === 'https:' ||
        [...allowed].some(
          (value) => new URL(value).host === new URL(c.req.url).host && value.startsWith('https:'),
        ),
      path: '/',
    });
    return c.json({ ok: true });
  });
  app.get('/api/health', (c) =>
    c.json({ ok: true, mode: runtime.store.workspace().mode, version: '0.2.0' }),
  );
  app.get('/api/state', (c) => c.json(runtime.state()));
  app.get('/api/journal', (c) => c.json(runtime.store.journal()));
  app.post('/api/move', async (c) => {
    const body = await c.req.json();
    if (
      typeof body.notation !== 'string' ||
      body.notation.length > 16 ||
      typeof body.version !== 'number' ||
      typeof body.commandId !== 'string' ||
      body.commandId.length > 100
    )
      return c.json({ error: 'Notation, position version, and command ID are required.' }, 400);
    return c.json(
      await runtime.move(
        body.notation,
        body.version,
        body.commandId,
        typeof body.clientId === 'string' ? body.clientId : undefined,
      ),
    );
  });
  app.post('/api/coach', async (c) => {
    const body = await c.req.json();
    if (
      typeof body.message !== 'string' ||
      !body.message.trim() ||
      body.message.length > 4000 ||
      typeof body.version !== 'number' ||
      typeof body.commandId !== 'string' ||
      (body.reviewPly !== undefined &&
        (!Number.isSafeInteger(body.reviewPly) || body.reviewPly < 0))
    )
      return c.json(
        { error: 'Enter a message of up to4,000 characters with a current position version.' },
        400,
      );
    return c.json(await runtime.chat(body.message, body.version, body.commandId, body.reviewPly));
  });
  app.post('/api/answer', async (c) => {
    const body = await c.req.json();
    if (
      typeof body.fen !== 'string' ||
      body.fen.length > 120 ||
      typeof body.notation !== 'string' ||
      body.notation.length > 16 ||
      typeof body.commandId !== 'string' ||
      body.commandId.length > 100
    )
      return c.json({ error: 'A question position and SAN candidate are required.' }, 400);
    return c.json(
      await runtime.answer(
        body.fen,
        body.notation,
        body.commandId,
        Number.isSafeInteger(body.questionMessageId) ? body.questionMessageId : undefined,
      ),
    );
  });
  app.post('/api/settings', async (c) => {
    const body = await c.req.json();
    const workspace = runtime.store.workspace();
    if (body.budget !== undefined) {
      if (!validBudget(body.budget)) return c.json({ error: 'Invalid budget.' }, 400);
      workspace.budget = body.budget;
    }
    if (body.mode !== undefined) {
      if (!['live', 'mock'].includes(body.mode)) return c.json({ error: 'Invalid mode.' }, 400);
      workspace.mode = body.mode;
    }
    if (body.provider !== undefined) {
      if (!['google', 'fireworks'].includes(body.provider))
        return c.json({ error: 'Invalid provider.' }, 400);
      workspace.provider = body.provider;
    }
    if (body.model !== undefined) {
      if (typeof body.model !== 'string' || !body.model.trim() || body.model.length > 180)
        return c.json({ error: 'Invalid model.' }, 400);
      workspace.model = body.model;
    }
    if (typeof body.paused === 'boolean') workspace.paused = body.paused;
    runtime.save(workspace, 'settings', {
      budget: workspace.budget,
      mode: workspace.mode,
      provider: workspace.provider,
      model: workspace.model,
      paused: workspace.paused,
    });
    return c.json(runtime.state());
  });
  app.post('/api/control', async (c) => {
    const body = await c.req.json();
    if (typeof body.clientId !== 'string' || body.clientId.length > 100)
      return c.json({ error: 'Invalid device.' }, 400);
    runtime.store.put('control-lease', { clientId: body.clientId, until: Date.now() + 45000 });
    return c.json({ ok: true });
  });
  app.post('/api/presence', async (c) => {
    const body = await c.req.json();
    if (
      typeof body.clientId !== 'string' ||
      body.clientId.length > 100 ||
      typeof body.seq !== 'number' ||
      typeof body.visible !== 'boolean' ||
      typeof body.focused !== 'boolean' ||
      (body.reviewPly !== undefined &&
        (!Number.isSafeInteger(body.reviewPly) ||
          body.reviewPly < 0 ||
          body.reviewPly > runtime.store.workspace().game.moves.length))
    )
      return c.json({ error: 'Invalid presence observation.' }, 400);
    const previous = runtime.store.get<{
      at: number;
      seq: number;
      visible: boolean;
      focused: boolean;
      reviewPly?: number;
    }>('presence:' + body.clientId);
    const now = Date.now();
    if (previous && body.seq <= previous.seq) return c.json({ ok: true });
    const duration = previous ? Math.min(20000, Math.max(0, now - previous.at)) : 0;
    runtime.store.put('presence:' + body.clientId, {
      at: now,
      seq: body.seq,
      visible: body.visible,
      focused: body.focused,
      reviewPly: body.reviewPly,
    });
    runtime.store.put('last-presence', now);
    const lease = runtime.store.get<{ clientId: string; until: number }>('control-lease');
    const control = !lease || lease.until < now || lease.clientId === body.clientId;
    if (control)
      runtime.store.put('control-lease', { clientId: body.clientId, until: now + 45000 });
    runtime.store.event('presence', {
      clientId: body.clientId,
      seq: body.seq,
      visible: body.visible,
      focused: body.focused,
      reviewPly: body.reviewPly,
      version: runtime.store.workspace().version,
      observedExposureMs:
        control &&
        !runtime.store.workspace().paused &&
        previous?.visible &&
        previous.focused &&
        previous.reviewPly === undefined &&
        body.reviewPly === undefined &&
        now - previous.at <= 20000
          ? duration
          : 0,
      reviewExposureMs:
        control &&
        !runtime.store.workspace().paused &&
        previous?.visible &&
        previous.focused &&
        previous.reviewPly !== undefined &&
        previous.reviewPly === body.reviewPly &&
        now - previous.at <= 20000
          ? duration
          : 0,
      unknownMs: previous && now - previous.at > 20000 ? now - previous.at : 0,
      monotonicMs:
        typeof body.monotonicMs === 'number' && Number.isFinite(body.monotonicMs)
          ? body.monotonicMs
          : undefined,
    });
    return c.json({ ok: true, serverTime: now, control });
  });
  app.post('/api/event', async (c) => {
    const body = await c.req.json();
    if (
      !['notation_rejected', 'entry_started', 'question_answer', 'paused'].includes(body.kind) ||
      typeof body.version !== 'number'
    )
      return c.json({ error: 'Unsupported observation.' }, 400);
    runtime.store.event(body.kind, { version: body.version });
    return c.json({ ok: true });
  });
  app.get('/api/events', (c) => {
    const after = Number(c.req.query('after') ?? 0);
    return c.json({
      events: runtime.store.events(Number.isFinite(after) ? after : 0),
      workspace: runtime.state(),
    });
  });
  app.get('/api/stream', (_c) => {
    let close = () => {};
    const stream = new ReadableStream({
      start(controller) {
        const send = () => {
          try {
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({ toolRevision: runtime.toolRevision, version: runtime.store.workspace().version, revision: Number((runtime.store.db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM events').get() as { id: number }).id) })}\n\n`,
              ),
            );
          } catch {
            close();
          }
        };
        runtime.listeners.add(send);
        const heartbeat = setInterval(send, 15000);
        close = () => {
          clearInterval(heartbeat);
          runtime.listeners.delete(send);
        };
        send();
      },
      cancel() {
        close();
      },
    });
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  });
  app.post('/api/import/pgn', async (c) => {
    const body = await c.req.json();
    if (typeof body.pgn !== 'string') return c.json({ error: 'PGN text is required.' }, 400);
    return c.json({ results: runtime.importPgn(body.pgn) });
  });
  app.post('/api/import/chesscom', async (c) => {
    const body = await c.req.json();
    if (typeof body.username !== 'string' || !/^[a-zA-Z0-9_-]{2,50}$/.test(body.username))
      return c.json({ error: 'A Chess.com username is required.' }, 400);
    const username = body.username.toLowerCase();
    const response = await fetch(`https://api.chess.com/pub/player/${username}/games/archives`, {
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': 'ChessLasso personal training archive' },
    });
    if (!response.ok)
      return c.json({ error: 'Chess.com archives unavailable; try again later.' }, 502);
    const data = (await response.json()) as { archives: string[] };
    const imported = [];
    for (const url of data.archives) {
      if (!/^https:\/\/api\.chess\.com\/pub\/player\/[\w-]+\/games\/\d{4}\/\d{2}$/.test(url))
        continue;
      const cursor = runtime.store.get<string>('import-cursor:' + url);
      if (
        cursor === new Date().toISOString().slice(0, 7) &&
        !url.endsWith(new Date().toISOString().slice(0, 7).replace('-', '/'))
      )
        continue;
      const month = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!month.ok) continue;
      const games = (await month.json()) as { games: { pgn?: string }[] };
      for (const game of games.games)
        if (game.pgn) imported.push(...runtime.importPgn(game.pgn, 'Chess.com'));
      runtime.store.put('import-cursor:' + url, new Date().toISOString().slice(0, 7));
    }
    return c.json({ results: imported });
  });
  app.post('/api/prompts/undo', async (c) => {
    const body = await c.req.json();
    return c.json(runtime.undoPrompt(String(body.target)));
  });
  app.post('/api/backup', async (c) => {
    await runtime.backup.checkpoint();
    return c.json(runtime.store.get('backup'));
  });
  app.get('/api/games', (c) => c.json(runtime.store.get('game-index') ?? []));
  app.onError((error, c) => {
    if (error instanceof CoachFailure)
      return c.json(
        { error: error.message, kind: error.code },
        error.code === 'timeout' ? 504 : error.code === 'provider_failure' ? 502 : 422,
      );
    if (error instanceof NotationError)
      return c.json({ error: error.message, kind: error.kind }, 422);
    if (error instanceof ConflictError)
      return c.json({ error: error.message, workspace: runtime.state() }, 409);
    if (error instanceof SyntaxError)
      return c.json({ error: 'The request could not be read.' }, 400);
    return c.json(
      {
        error:
          error instanceof Error
            ? redactCoachText(error.message)
            : 'The request could not be completed.',
      },
      400,
    );
  });
  return app;
}
