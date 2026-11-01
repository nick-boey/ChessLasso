import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { Chess } from 'chess.js';

export interface EngineRequest {
  fen: string;
  pgn?: string;
  milliseconds?: number;
  depth?: number;
  variations?: number;
  skill?: number;
  signal?: AbortSignal;
}

export interface EngineVariation {
  depth: number;
  score: {
    type: 'cp' | 'mate';
    value: number;
    perspective: 'white';
    bound: 'exact' | 'lower' | 'upper';
  };
  uci: string[];
  san: string[];
}

export interface EngineResult {
  bestmove: string | null;
  san: string | null;
  variations: EngineVariation[];
  engine: string;
  build: string;
  network: string[];
  limits: { milliseconds: number; depth: number; variations: number; skill: number };
}

function bounded(value: number | undefined, fallback: number, min: number, max: number) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max)
    throw new Error('Engine search limit is out of range.');
  return value;
}

export function enginePosition(request: Pick<EngineRequest, 'fen' | 'pgn'>) {
  if (request.fen.length > 120 || (request.pgn?.length ?? 0) > 1024 * 1024)
    throw new Error('Engine position/history exceeds its limit.');
  const chess = new Chess(request.fen);
  if (!request.pgn?.trim()) return { chess, command: `position fen ${chess.fen()}` };
  const history = new Chess();
  history.loadPgn(request.pgn);
  if (history.fen() !== chess.fen()) throw new Error('Engine history does not match the position.');
  const moves = history.history({ verbose: true });
  const initialFen = moves[0]?.before ?? history.fen();
  const uci = moves.map((move) => `${move.from}${move.to}${move.promotion ?? ''}`);
  return {
    chess,
    command: `position fen ${initialFen}${uci.length ? ` moves ${uci.join(' ')}` : ''}`,
  };
}

export function legalUci(chess: Chess, uci: string) {
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) throw new Error('Invalid engine move.');
  const legal = chess
    .moves({ verbose: true })
    .find((move) => `${move.from}${move.to}${move.promotion ?? ''}` === uci);
  if (!legal) throw new Error('Engine returned an illegal move.');
  return legal;
}

/** Each bounded search owns its worker, so cancellation cannot leak into the next position. */
export async function analysePosition(request: EngineRequest): Promise<EngineResult> {
  const { chess, command } = enginePosition(request);
  const limits = {
    milliseconds: bounded(request.milliseconds, 350, 50, 3000),
    depth: bounded(request.depth, 16, 1, 24),
    variations: bounded(request.variations, 2, 1, 3),
    skill: bounded(request.skill, 20, 0, 20),
  };
  if (request.signal?.aborted) throw new Error('Engine search cancelled.');
  const native = process.env.STOCKFISH_PATH;
  const require = createRequire(import.meta.url);
  const stockfish = require('stockfish') as { findEngine: (flavor: string) => string };
  const build = native ? 'operator-native' : 'stockfish.js 19.0.1 lite-single';
  const child = spawn(
    native || process.execPath,
    native ? [] : [stockfish.findEngine('lite-single')],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH },
    },
  );
  return new Promise((resolve, reject) => {
    let finished = false;
    let buffer = '';
    let bytes = 0;
    let engine = 'Stockfish';
    const network: string[] = [];
    const variations = new Map<number, EngineVariation>();
    const finish = (error?: Error, result?: EngineResult) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      request.signal?.removeEventListener('abort', abort);
      child.kill('SIGKILL');
      if (error) reject(error);
      else if (result) resolve(result);
    };
    const abort = () => finish(new Error('Engine search cancelled.'));
    const timeout = setTimeout(
      () => finish(new Error('Engine search timed out.')),
      8000 + limits.milliseconds,
    );
    request.signal?.addEventListener('abort', abort, { once: true });
    if (request.signal?.aborted) return abort();
    child.on('error', () =>
      finish(new Error('Stockfish could not be started. Check STOCKFISH_PATH.')),
    );
    child.on('exit', () => {
      if (!finished) finish(new Error('Stockfish exited before finishing.'));
    });
    child.stdin.on('error', () => finish(new Error('Stockfish input disconnected.')));
    child.stderr.resume();
    const send = (text: string) => child.stdin.write(`${text}\n`);
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 512 * 1024) return finish(new Error('Stockfish output exceeded its limit.'));
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const raw of lines) {
        const line = raw.trim();
        if (line.startsWith('id name ')) engine = line.slice(8, 160);
        if (line.startsWith('option name EvalFile')) network.push(line.slice(0, 300));
        if (line === 'uciok') {
          send('setoption name Hash value 16');
          send(`setoption name MultiPV value ${limits.variations}`);
          send(`setoption name Skill Level value ${limits.skill}`);
          send('isready');
        } else if (line === 'readyok') {
          send(command);
          send(`go movetime ${limits.milliseconds} depth ${limits.depth}`);
        } else if (line.startsWith('info ')) {
          const depth = Number(/\bdepth (\d+)/.exec(line)?.[1]);
          const index = Number(/\bmultipv (\d+)/.exec(line)?.[1] ?? 1);
          const score = /\bscore (cp|mate) (-?\d+)/.exec(line);
          const pv = /\bpv (.+)$/.exec(line)?.[1]?.split(' ').slice(0, 16);
          if (!depth || !score || !pv || index > limits.variations) continue;
          const branch = new Chess(chess.fen());
          const san: string[] = [];
          const uci: string[] = [];
          for (const move of pv) {
            try {
              const legal = legalUci(branch, move);
              san.push(legal.san);
              uci.push(move);
              branch.move(legal.san);
            } catch {
              break;
            }
          }
          variations.set(index, {
            depth,
            score: {
              type: score[1] === 'mate' ? 'mate' : 'cp',
              value: Number(score[2]) * (chess.turn() === 'w' ? 1 : -1),
              perspective: 'white',
              bound: line.includes(' lowerbound')
                ? chess.turn() === 'w'
                  ? 'lower'
                  : 'upper'
                : line.includes(' upperbound')
                  ? chess.turn() === 'w'
                    ? 'upper'
                    : 'lower'
                  : 'exact',
            },
            uci,
            san,
          });
        } else if (line.startsWith('bestmove ')) {
          const bestmove = line.split(' ')[1];
          if (bestmove === '(none)' || bestmove === '0000') {
            if (!chess.isGameOver()) return finish(new Error('Stockfish returned no legal move.'));
            finish(undefined, {
              bestmove: null,
              san: null,
              variations: [],
              engine,
              build,
              network,
              limits,
            });
          } else {
            try {
              const move = legalUci(chess, bestmove ?? '');
              finish(undefined, {
                bestmove: bestmove ?? null,
                san: move.san,
                variations: [...variations.entries()]
                  .sort(([a], [b]) => a - b)
                  .map(([, value]) => value),
                engine,
                build,
                network,
                limits,
              });
            } catch {
              finish(new Error('Stockfish returned an illegal move.'));
            }
          }
        }
      }
    });
    send('uci');
  });
}
