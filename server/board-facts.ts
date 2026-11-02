import { createHash } from 'node:crypto';
import { Chess, SQUARES, type Color, type PieceSymbol, type Square } from 'chess.js';

export interface PositionReference {
  fen: string;
  version: number;
  id: string;
}

/** Version and full FEN (including turn/rights/clocks) identify evidence, not just piece placement. */
export function positionReference(fen: string, version: number): PositionReference {
  if (!Number.isSafeInteger(version) || version < 0) throw new Error('Invalid board version.');
  const canonical = new Chess(fen).fen();
  return {
    fen: canonical,
    version,
    id: createHash('sha256').update(`${version}:${canonical}`).digest('hex'),
  };
}

const directions = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];
const value: Record<PieceSymbol, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };
function ray(square: Square, dx: number, dy: number): Square[] {
  const squares: Square[] = [];
  for (
    let x = square.charCodeAt(0) - 97 + dx, y = Number(square[1]) - 1 + dy;
    x >= 0 && x < 8 && y >= 0 && y < 8;
    x += dx, y += dy
  )
    squares.push(`${String.fromCharCode(97 + x)}${y + 1}` as Square);
  return squares;
}
function slides(piece: PieceSymbol, diagonal: boolean) {
  return piece === 'q' || piece === (diagonal ? 'b' : 'r');
}

/** Attacks are geometric chess.js attacks (including pinned pieces), never a claim of legality. */
export function boardFacts(fen: string, version: number) {
  const board = new Chess(fen);
  const pins: { kind: 'absolute' | 'relative'; piece: Square; attacker: Square; target: Square }[] =
    [];
  for (const target of SQUARES) {
    const protectedPiece = board.get(target);
    if (!protectedPiece || value[protectedPiece.type] < 5) continue;
    for (const [dx, dy] of directions) {
      const occupied = ray(target, dx, dy).filter((square) => board.get(square));
      const [piece, attacker] = occupied;
      if (!piece || !attacker) continue;
      const candidate = board.get(piece)!;
      const pinner = board.get(attacker)!;
      if (
        candidate.color === protectedPiece.color &&
        pinner.color !== protectedPiece.color &&
        slides(pinner.type, dx !== 0 && dy !== 0) &&
        value[protectedPiece.type] > value[candidate.type]
      )
        pins.push({
          kind: protectedPiece.type === 'k' ? 'absolute' : 'relative',
          piece,
          attacker,
          target,
        });
    }
  }
  const legal = board.moves({ verbose: true });
  return {
    reference: positionReference(fen, version),
    semantics: {
      attacks:
        'Geometric attacks include defended friendly pieces and pinned attackers; they are not legal moves.',
      pins: 'Absolute pins expose the king; relative pins expose a more valuable piece and do not prohibit legal moves.',
      legalMoves: 'Only the side to move; king escapes are legal king moves, excluding castling.',
    },
    turn: board.turn(),
    check: board.isCheck(),
    checkmate: board.isCheckmate(),
    pieces: SQUARES.flatMap((square) => {
      const piece = board.get(square);
      if (!piece) return [];
      const enemy: Color = piece.color === 'w' ? 'b' : 'w';
      return [
        {
          square,
          color: piece.color,
          type: piece.type,
          attacks: SQUARES.filter((target) =>
            board.attackers(target, piece.color).includes(square),
          ),
          defenders: board.attackers(square, piece.color),
          attackers: board.attackers(square, enemy),
          blockers: directions
            .filter(([dx, dy]) => slides(piece.type, dx !== 0 && dy !== 0))
            .flatMap(([dx, dy]) => {
              const blocker = ray(square, dx, dy).find((target) => board.get(target));
              return blocker ? [blocker] : [];
            }),
        },
      ];
    }),
    pins,
    legalMoves: legal.map((move) => ({ from: move.from, to: move.to, san: move.san })),
    kingEscapes: legal
      .filter((move) => move.piece === 'k' && !move.isKingsideCastle() && !move.isQueensideCastle())
      .map((move) => ({ from: move.from, to: move.to, san: move.san })),
  };
}
