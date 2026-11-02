import { randomUUID } from 'node:crypto';
import { Chess, type Square } from 'chess.js';
import { loadGame, playNotation } from '../src/lib/chess.js';
import { boardFacts, positionReference, type PositionReference } from './board-facts.js';
import { analysePosition, type EngineRequest, type EngineResult } from './engine.js';

interface AnalysisEvidence {
  id: string;
  reference: PositionReference;
  root: PositionReference;
  moves: string[];
  result: EngineResult;
}
interface ClaimEvidence {
  id: string;
  reference: PositionReference;
  root: PositionReference;
  moves: string[];
  text: string;
  analysisId?: string;
}
export class VerificationError extends Error {
  constructor(
    public category: 'illegal-sequence' | 'false-claim' | 'unverified-output',
    message: string,
  ) {
    super(message);
  }
}
/** Report the actual result without relying on the model or supplying a move hint. */
export function describeGameOver(pgn: string) {
  const board = loadGame(pgn);
  if (!board.isGameOver()) throw new VerificationError('false-claim', 'This game has not ended.');
  const result = board.isCheckmate()
    ? `${board.turn() === 'w' ? 'Black' : 'White'} won by checkmate.`
    : board.isStalemate()
      ? 'The game is drawn by stalemate.'
      : board.isInsufficientMaterial()
        ? 'The game is drawn by insufficient material.'
        : board.isThreefoldRepetition()
          ? 'The game is drawn by threefold repetition.'
          : 'The game is drawn by the fifty-move rule.';
  return `Game over. ${result}`;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new VerificationError('false-claim', 'Provide a structured claim.');
  return value as Record<string, unknown>;
}
function square(value: unknown): Square {
  if (typeof value !== 'string' || !/^[a-h][1-8]$/.test(value))
    throw new VerificationError('false-claim', 'Invalid claim square.');
  return value as Square;
}

/** Receipts live for one turn. An engine call cannot bless free prose or an unrelated continuation. */
export class CoachingVerification {
  readonly root: PositionReference;
  private analyses = new Map<string, AnalysisEvidence>();
  private claims = new Map<string, ClaimEvidence>();
  private published?: string;
  constructor(
    private context: { fen: string; pgn: string; version: number },
    private engine = analysePosition,
  ) {
    this.root = positionReference(context.fen, context.version);
  }
  private assertRoot(args: Record<string, unknown>) {
    if (args.version !== this.root.version || args.referenceId !== this.root.id)
      throw new VerificationError(
        'false-claim',
        'Evidence must reference this exact position and version.',
      );
  }
  private derive(raw: unknown) {
    if (
      raw !== undefined &&
      (!Array.isArray(raw) ||
        raw.length > 40 ||
        raw.some((move) => typeof move !== 'string' || move.length > 16))
    )
      throw new VerificationError('illegal-sequence', 'Provide at most 40 SAN moves.');
    const board = new Chess(this.root.fen);
    const moves: string[] = [];
    try {
      for (const move of (raw ?? []) as string[]) moves.push(playNotation(board, move).san);
    } catch {
      throw new VerificationError(
        'illegal-sequence',
        'The continuation is not legal from the referenced position.',
      );
    }
    return { moves, reference: positionReference(board.fen(), this.root.version) };
  }
  async analyse(args: Record<string, unknown>, signal?: AbortSignal) {
    this.assertRoot(args);
    const derived = this.derive(args.moves);
    if (args.fen !== undefined && args.fen !== derived.reference.fen)
      throw new VerificationError(
        'illegal-sequence',
        'A counterfactual FEN must be reached by the supplied legal continuation.',
      );
    let pgn = this.context.pgn;
    if (derived.moves.length) {
      const history = new Chess();
      if (pgn.trim()) history.loadPgn(pgn);
      else history.load(this.root.fen);
      if (history.fen() !== this.root.fen)
        throw new VerificationError('illegal-sequence', 'History does not match the reference.');
      for (const move of derived.moves) history.move(move);
      pgn = history.pgn();
    }
    const options = (key: string) => (typeof args[key] === 'number' ? args[key] : undefined);
    const request: EngineRequest = {
      fen: derived.reference.fen,
      pgn: pgn.trim() ? pgn : undefined,
      milliseconds: options('milliseconds'),
      depth: options('depth'),
      variations: options('variations'),
      skill: options('skill'),
      signal,
    };
    const result = await this.engine(request);
    const evidence: AnalysisEvidence = { id: randomUUID(), root: this.root, ...derived, result };
    this.analyses.set(evidence.id, evidence);
    return {
      ...result,
      evidence: {
        id: evidence.id,
        reference: evidence.reference,
        root: this.root,
        moves: evidence.moves,
      },
    };
  }
  verify(args: Record<string, unknown>) {
    this.assertRoot(args);
    const derived = this.derive(args.moves);
    if (!Array.isArray(args.claims) || !args.claims.length || args.claims.length > 12)
      throw new VerificationError('false-claim', 'Provide 1–12 structured claims.');
    const facts = boardFacts(derived.reference.fen, this.root.version);
    const sentences: string[] = [];
    let analysisId: string | undefined;
    for (const raw of args.claims) {
      const claim = object(raw);
      if (claim.kind === 'attack') {
        const from = square(claim.from);
        const to = square(claim.to);
        const piece = facts.pieces.find((entry) => entry.square === from);
        if (!piece || !piece.attacks.includes(to))
          throw new VerificationError(
            'false-claim',
            `${from} does not geometrically attack ${to}.`,
          );
        const names = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
        const target = facts.pieces.find((entry) => entry.square === to);
        const relationship = !target
          ? 'controls'
          : target.color === piece.color
            ? 'defends'
            : 'attacks';
        const destination = target
          ? `the ${target.color === 'w' ? 'white' : 'black'} ${names[target.type]} on ${to}`
          : to;
        sentences.push(
          `The ${piece.color === 'w' ? 'white' : 'black'} ${names[piece.type]} on ${from} ${relationship} ${destination}.`,
        );
      } else if (claim.kind === 'check' || claim.kind === 'checkmate') {
        if (!(claim.kind === 'check' ? facts.check : facts.checkmate))
          throw new VerificationError(
            'false-claim',
            claim.kind === 'checkmate'
              ? 'This is not checkmate; legal replies or king escapes remain, or the king is not in check.'
              : 'The side to move is not in check.',
          );
        sentences.push(
          claim.kind === 'checkmate'
            ? 'The side to move is checkmated: its king is in check and it has no legal reply.'
            : 'The side to move is in check.',
        );
      } else if (claim.kind === 'engine-line') {
        const evidence =
          typeof args.analysisId === 'string' ? this.analyses.get(args.analysisId) : undefined;
        if (
          !evidence ||
          evidence.root.id !== this.root.id ||
          !evidence.result.variations.some((variation) => {
            const line = [...evidence.moves, ...variation.san];
            return (
              derived.moves.length > evidence.moves.length &&
              derived.moves.length <= line.length &&
              derived.moves.every((move, index) => line[index] === move)
            );
          })
        )
          throw new VerificationError(
            'false-claim',
            'This exact continuation is not supported by the referenced engine variation.',
          );
        analysisId = evidence.id;
        sentences.push('Stockfish suggests examining this continuation.');
      } else throw new VerificationError('false-claim', 'Unknown structured claim.');
    }
    const prefix = derived.moves.length ? `After ${derived.moves.join(' ')}, ` : '';
    const evidence: ClaimEvidence = {
      id: randomUUID(),
      root: this.root,
      ...derived,
      text: `${prefix}${sentences.join(' ')}`,
      analysisId,
    };
    this.claims.set(evidence.id, evidence);
    return evidence;
  }
  private textFor(args: Record<string, unknown>) {
    this.assertRoot(args);
    if (!Array.isArray(args.verificationIds) || args.verificationIds.length > 12)
      throw new VerificationError('unverified-output', 'Provide bounded verification receipts.');
    return args.verificationIds
      .map((id) => {
        const receipt = typeof id === 'string' ? this.claims.get(id) : undefined;
        if (!receipt || receipt.root.id !== this.root.id)
          throw new VerificationError(
            'unverified-output',
            'Unknown or stale verification receipt.',
          );
        return receipt.text;
      })
      .join('\n\n');
  }
  get checkedClaimIds() {
    return [...this.claims.keys()];
  }
  async publish(
    args: Record<string, unknown>,
    beforePublish: (evidence: {
      reference: PositionReference;
      verificationIds: unknown;
    }) => Promise<void>,
  ) {
    this.textFor({ ...args, verificationIds: args.verificationIds ?? [] });
    if (
      Object.keys(args).some(
        (key) => !['version', 'referenceId', 'verificationIds', 'text'].includes(key),
      )
    )
      throw new VerificationError(
        'unverified-output',
        'Supply your own coaching text and optional checked claim references.',
      );
    if (typeof args.text !== 'string' || !args.text.trim() || args.text.length > 16000)
      throw new VerificationError(
        'unverified-output',
        'Provide a nonempty coaching message of at most 16000 characters.',
      );
    await beforePublish({ reference: this.root, verificationIds: args.verificationIds ?? [] });
    this.published = args.text;
    return {
      text: this.published,
      reference: this.root,
      verificationIds: args.verificationIds ?? [],
      classification: 'agent-authored',
    };
  }
  finalText(text: string) {
    const response = text.trim() ? text : this.published;
    if (!response?.trim())
      throw new VerificationError('unverified-output', 'The coach did not provide a response.');
    if (response.length > 16000)
      throw new VerificationError('unverified-output', 'The coaching response is too long.');
    return response;
  }
  /** Validate mechanics and references without rewriting the agent's teaching language. */
  visibleTool(name: string, args: Record<string, unknown>) {
    if (name === 'start_activity') {
      const { activityType: _type, ...safe } = args;
      return safe;
    }
    if (name === 'show_demonstration') {
      const board = new Chess(
        typeof args.initialFen === 'string' ? args.initialFen : this.root.fen,
      );
      if (!Array.isArray(args.steps) || args.steps.length > 24)
        throw new VerificationError('illegal-sequence', 'Invalid demonstration.');
      return {
        ...args,
        initialFen: board.fen(),
        steps: args.steps.map((raw) => {
          const step = object(raw);
          const branch = new Chess(board.fen());
          if (!Array.isArray(step.moves) || step.moves.length > 40)
            throw new VerificationError('illegal-sequence', 'Invalid demonstration moves.');
          const moves = step.moves.map((move) => {
            if (typeof move !== 'string')
              throw new VerificationError('illegal-sequence', 'Invalid demonstration move.');
            try {
              return playNotation(branch, move).san;
            } catch {
              throw new VerificationError(
                'illegal-sequence',
                'Illegal demonstration continuation.',
              );
            }
          });
          return {
            title: typeof step.title === 'string' ? step.title : '',
            note: typeof step.note === 'string' ? step.note : '',
            moves,
          };
        }),
      };
    }
    if (['ask_question', 'write_player_note', 'record_intervention'].includes(name)) {
      const receipt =
        typeof args.verificationId === 'string' ? this.claims.get(args.verificationId) : undefined;
      if (args.verificationId !== undefined && !receipt)
        throw new VerificationError('unverified-output', 'Unknown verification receipt.');
      if (
        name === 'ask_question' &&
        receipt &&
        args.fen !== undefined &&
        args.fen !== receipt.reference.fen
      )
        throw new VerificationError(
          'unverified-output',
          'A verified question must display its exact evidence position.',
        );
      const { verificationId: _id, ...safe } = args;
      const text = typeof args.text === 'string' ? args.text : receipt?.text;
      if (typeof text !== 'string' || !text.trim() || text.length > 4000)
        throw new VerificationError(
          'unverified-output',
          'Provide your own brief question or note.',
        );
      return {
        ...safe,
        text,
        ...(receipt ? { reference: receipt.reference, rootReference: receipt.root } : {}),
        ...(name === 'ask_question' && receipt ? { fen: receipt.reference.fen } : {}),
      };
    }
    return args;
  }
}
