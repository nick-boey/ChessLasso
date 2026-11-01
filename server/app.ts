import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { Chess } from 'chess.js';
import {
  loadGame,
  playMockOpponent,
  playNotation,
  snapshot,
  NotationError,
} from '../src/lib/chess.js';
import coach from '../config/mock-coach.json' with { type: 'json' };

export const app = new Hono();
app.use(
  '/api/*',
  bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: 'Request too large.' }, 413) }),
);
app.get('/api/health', (c) => c.json({ ok: true, mode: 'mock', version: '0.1.0' }));

app.post('/api/move', async (c) => {
  try {
    const body: unknown = await c.req.json();
    if (
      !body ||
      typeof body !== 'object' ||
      !('pgn' in body) ||
      !('notation' in body) ||
      typeof body.pgn !== 'string' ||
      typeof body.notation !== 'string'
    )
      return c.json({ error: 'A PGN and notation string are required.' }, 400);
    const chess = loadGame(body.pgn);
    if (chess.isGameOver())
      return c.json(
        { error: 'This position has ended. Ask the coach for the next exercise.', kind: 'illegal' },
        422,
      );
    const move = playNotation(chess, body.notation);
    playMockOpponent(chess);
    const note = coach.afterMove[Math.floor(chess.history().length / 2) % coach.afterMove.length];
    return c.json({
      game: snapshot(chess),
      played: move.san,
      note: note.replaceAll('{reply}', chess.history().at(-1) ?? move.san),
    });
  } catch (error) {
    if (error instanceof NotationError)
      return c.json({ error: error.message, kind: error.kind }, 422);
    return c.json(
      {
        error:
          'The game could not be read. Reload the last saved position or ask the coach for another exercise.',
      },
      400,
    );
  }
});

app.post('/api/coach', async (c) => {
  try {
    const body: unknown = await c.req.json();
    if (
      !body ||
      typeof body !== 'object' ||
      !('message' in body) ||
      !('fen' in body) ||
      typeof body.message !== 'string' ||
      !body.message.trim() ||
      body.message.length > 4000 ||
      typeof body.fen !== 'string'
    )
      return c.json(
        { error: 'Enter a message of up to 4,000 characters and a valid position.' },
        400,
      );
    new Chess(body.fen);
    const text = body.message.toLowerCase();
    if (/example|show me|demonstrat|lesson/.test(text))
      return c.json({
        text: coach.example,
        action: 'demonstrate',
        demonstration: coach.demonstration,
      });
    if (/new game|fresh game|full game/.test(text))
      return c.json({
        text: coach.newGame,
        action: 'new_game',
        game: snapshot(new Chess()),
        activity: coach.activities.observation,
      });
    if (/endgame|simpler position|set.*position/.test(text))
      return c.json({
        text: coach.position,
        action: 'set_position',
        game: snapshot(new Chess('8/7k/8/8/8/4K3/4P3/8 w - - 0 1')),
        activity: coach.activities.endgame,
      });
    if (/focus on|training goal|change.*heading/.test(text))
      return c.json({
        text: coach.default,
        action: 'set_activity',
        activity: coach.activities.calculation,
      });
    if (/quiet|less interrupt|keep thinking|observe/.test(text))
      return c.json({ text: coach.quiet, action: 'quiet' });
    if (/resume|help again/.test(text)) return c.json({ text: coach.resume, action: 'resume' });
    if (/hint|help|stuck/.test(text)) return c.json({ text: coach.hint, action: 'hint' });
    if (/prefer|feedback|please.*coach|too much/.test(text))
      return c.json({ text: coach.feedback, action: 'feedback' });
    return c.json({ text: coach.default, action: 'question', fen: body.fen });
  } catch {
    return c.json(
      { error: 'The position or request could not be read. Your game has not changed.' },
      400,
    );
  }
});

app.onError((_error, c) =>
  c.json({ error: 'The prototype could not complete that request. Please try again.' }, 500),
);
