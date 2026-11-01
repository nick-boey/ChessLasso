import { Chess } from 'chess.js';

export interface GameState {
  fen: string;
  pgn: string;
  moves: string[];
  turn: 'w' | 'b';
  lastMove: [string, string] | null;
  over: boolean;
  status: string;
}

export class NotationError extends Error {
  constructor(
    message: string,
    public kind: 'notation' | 'ambiguous' | 'illegal',
  ) {
    super(message);
  }
}

export function snapshot(chess: Chess): GameState {
  const last = chess.history({ verbose: true }).at(-1);
  return {
    fen: chess.fen(),
    pgn: chess.pgn(),
    moves: chess.history(),
    turn: chess.turn(),
    lastMove: last ? [last.from, last.to] : null,
    over: chess.isGameOver(),
    status: chess.isCheckmate()
      ? 'Checkmate'
      : chess.isDraw()
        ? 'Draw'
        : chess.isCheck()
          ? 'Check — protect your king'
          : `${chess.turn() === 'w' ? 'White' : 'Black'} to move`,
  };
}

export function practiceGame(): GameState {
  const chess = new Chess();
  for (const move of ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5']) chess.move(move);
  return snapshot(chess);
}

export function loadGame(pgn: string): Chess {
  const chess = new Chess();
  if (pgn.trim()) chess.loadPgn(pgn);
  return chess;
}

export function playNotation(chess: Chess, raw: string) {
  const input = raw.trim().replace(/^0-0(-0)?(?=[+#]?$)/, (text) => text.replaceAll('0', 'O'));
  if (!input || input.length > 16 || /^[a-h][1-8][a-h][1-8]/.test(input)) {
    throw new NotationError(
      'Use short algebraic notation: e4 for a pawn, Nf3 for a knight. Keep your move and try again.',
      'notation',
    );
  }
  const legal = chess.moves({ verbose: true });
  const match = legal.find((move) =>
    /[+#]$/.test(input) ? move.san === input : move.san.replace(/[+#]$/, '') === input,
  );
  if (match) return chess.move(match.san);
  const ambiguous = legal.filter((move) => {
    const short = `${move.piece === 'p' ? '' : move.piece.toUpperCase()}${move.isCapture() ? 'x' : ''}${move.to}`;
    return short === input.replace(/[+#]$/, '');
  });
  if (ambiguous.length > 1) {
    throw new NotationError(
      'More than one piece can make that move. Add the starting file or rank, as in Nbd2 or R1e2.',
      'ambiguous',
    );
  }
  if (!/^(?:O-O(?:-O)?|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?)[+#]?$/.test(input)) {
    throw new NotationError(
      'That notation is not recognised. Use a capital piece letter, a destination square, and x for a capture.',
      'notation',
    );
  }
  throw new NotationError(
    chess.isCheck()
      ? 'Your king is in check. Enter a legal move that gets your king out of check.'
      : 'That move is not legal in this position. Check the destination, the path, and whose turn it is.',
    'illegal',
  );
}

// shortcut: deterministic legal opponent for the prototype, replace with Stockfish/Pi in the production milestone.
export function playMockOpponent(chess: Chess) {
  if (chess.isGameOver()) return;
  const legal = chess.moves();
  const preferred = ['Nf6', 'Nc6', 'e5', 'd6', 'O-O', 'd5', 'Bc5', 'Be7', 'Nf3', 'Nc3', 'e4'];
  chess.move(preferred.find((move) => legal.includes(move)) ?? legal[0]);
}

export interface Budget {
  mode: 'none' | 'warning' | 'hard';
  amount: number;
}

export function validBudget(value: unknown): value is Budget {
  if (!value || typeof value !== 'object') return false;
  const budget = value as Partial<Budget>;
  return (
    ['none', 'warning', 'hard'].includes(budget.mode ?? '') &&
    typeof budget.amount === 'number' &&
    Number.isFinite(budget.amount) &&
    budget.amount > 0
  );
}

export interface Demonstration {
  title: string;
  initialFen?: string;
  steps: { title: string; note: string; moves: string[] }[];
}
