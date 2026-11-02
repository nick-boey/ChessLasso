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
const neutralPrompts = {
  candidate: 'What would you play here, and what is your idea?',
  reasoning: 'Talk me through your plan and the reply you expect.',
  retry: 'I could not verify that explanation. Let’s inspect the position and try again.',
  observation: 'Take your time. I will wait for your move.',
  acknowledgement: 'Your request is recorded. Choose a candidate move when you are ready.',
};
const teachingPrinciples = {
  opening:
    'In the opening, aim to control the center, bring your pieces into play and get your king safe.',
  'opponent-threats':
    'Before choosing your move, look at your opponent’s checks, captures and threats.',
  'loose-pieces': 'Check which pieces are undefended on both sides before committing to a move.',
  tradeoffs:
    'Compare what each move improves with what it gives up. A useful plan also accounts for your opponent’s response.',
  'king-activity':
    'In an endgame, consider how your king can support your pieces and pawns while staying safe.',
  reflection: 'Let’s take one useful lesson from this game and test it in later practice.',
};
const teachingQuestions = {
  intention: 'What would you like your next move to achieve?',
  'opponent-reply': 'What is your opponent’s strongest reply to the move you’re considering?',
  'changed-position': 'What changed after your opponent’s last move?',
  'compare-candidates':
    'Which two moves would you compare, and what is the main trade-off between them?',
  'explain-choice': 'What makes your preferred move fit your plan?',
  recall: 'What idea from earlier practice could help you here?',
  'review-intention':
    'What were you trying to achieve with your move, and what reply did you expect?',
};
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
  return `Game over. ${result}\n\nThe completed game is saved for review against your training plan before choosing the next activity.`;
}
/** Explain setup using the board itself, without relying on provider-authored chess claims. */
export function describePosition(fen: string, changed = false) {
  const board = new Chess(fen);
  const starting = board.fen() === new Chess().fen();
  const introduction = changed
    ? starting
      ? 'The board has been reset to the standard starting position.'
      : 'The board has been set to a new training position.'
    : starting
      ? 'The board shows the standard starting position.'
      : 'The board shows a training position.';
  const turn = `${board.turn() === 'w' ? 'White' : 'Black'} to move on move ${board.moveNumber()}.`;
  if (starting) return `${introduction} ${turn}`;
  const names = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
  const pieces = (['w', 'b'] as const).map((color) => {
    const locations = board
      .board()
      .flat()
      .filter((piece) => piece?.color === color)
      .map((piece) => `${names[piece!.type]} on ${piece!.square}`);
    return `${color === 'w' ? 'White' : 'Black'}: ${locations.join(', ')}.`;
  });
  return `${introduction} ${turn}\n\n${pieces.join('\n\n')}`;
}
const activities = {
  'free-play': {
    heading: 'Explore the position',
    subtitle: 'Choose a legal candidate and explain your idea.',
  },
  calculation: {
    heading: 'Compare candidate moves',
    subtitle: 'Name a candidate and the reply you expect.',
  },
  endgame: {
    heading: 'Activate your king',
    subtitle: 'Explore legal king moves in this position.',
  },
  observation: {
    heading: 'Play an independent game',
    subtitle: 'Take your time and choose your own moves.',
  },
};
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
  async publish(
    args: Record<string, unknown>,
    beforePublish: (evidence: {
      reference: PositionReference;
      verificationIds: unknown;
    }) => Promise<void>,
  ) {
    const text = this.textFor(args);
    let principle = '';
    let question = '';
    if (args.teaching !== undefined) {
      const teaching = args.teaching;
      if (!teaching || typeof teaching !== 'object' || Array.isArray(teaching))
        throw new VerificationError(
          'unverified-output',
          'Choose a supported teaching principle or question.',
        );
      const selection = teaching as Record<string, unknown>;
      if (
        !Object.keys(selection).length ||
        Object.keys(selection).some((key) => !['principle', 'question'].includes(key))
      )
        throw new VerificationError(
          'unverified-output',
          'Choose supported teaching fields; free-form tactical prose is not accepted.',
        );
      if (selection.principle !== undefined) {
        if (
          typeof selection.principle !== 'string' ||
          !Object.hasOwn(teachingPrinciples, selection.principle)
        )
          throw new VerificationError(
            'unverified-output',
            'Choose a supported teaching principle.',
          );
        principle = teachingPrinciples[selection.principle as keyof typeof teachingPrinciples];
      }
      if (selection.question !== undefined) {
        if (
          typeof selection.question !== 'string' ||
          !Object.hasOwn(teachingQuestions, selection.question)
        )
          throw new VerificationError('unverified-output', 'Choose a supported teaching question.');
        question = teachingQuestions[selection.question as keyof typeof teachingQuestions];
        if (args.prompt !== undefined)
          throw new VerificationError(
            'unverified-output',
            'Choose one teaching question or neutral prompt.',
          );
      }
    }
    let prompt =
      args.prompt === 'position'
        ? describePosition(this.root.fen)
        : args.prompt === 'game-over'
          ? describeGameOver(this.context.pgn)
          : args.prompt === undefined
            ? ''
            : neutralPrompts[args.prompt as keyof typeof neutralPrompts];
    if (prompt === undefined)
      throw new VerificationError('unverified-output', 'Choose a supported teaching prompt.');
    if (
      (args.prompt === undefined ||
        args.prompt === 'candidate' ||
        args.prompt === 'reasoning' ||
        args.prompt === 'observation' ||
        question) &&
      loadGame(this.context.pgn).isGameOver()
    ) {
      prompt = describeGameOver(this.context.pgn);
      question = '';
    }
    if (
      Object.keys(args).some(
        (key) => !['version', 'referenceId', 'verificationIds', 'prompt', 'teaching'].includes(key),
      )
    )
      throw new VerificationError(
        'unverified-output',
        'Free-form tactical prose cannot be published as verified.',
      );
    await beforePublish({ reference: this.root, verificationIds: args.verificationIds });
    this.published =
      [text, principle, question || prompt].filter(Boolean).join('\n\n') ||
      neutralPrompts.candidate;
    return { text: this.published, reference: this.root, verificationIds: args.verificationIds };
  }
  finalText(_untrustedText: string) {
    return (
      this.published ??
      (loadGame(this.context.pgn).isGameOver()
        ? describeGameOver(this.context.pgn)
        : neutralPrompts.retry)
    );
  }
  /** All provider-authored labels/notes are replaced with host-owned text before a visible tool mutates state. */
  visibleTool(name: string, args: Record<string, unknown>) {
    if (name === 'start_activity') {
      const type = args.activityType === undefined ? 'free-play' : args.activityType;
      if (typeof type !== 'string' || !(type in activities))
        throw new VerificationError('unverified-output', 'Choose a supported activity type.');
      const labels = activities[type as keyof typeof activities];
      const {
        heading: _heading,
        subtitle: _subtitle,
        goal: _goal,
        activityType: _type,
        ...safe
      } = args;
      return { ...safe, ...labels };
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
        title:
          board.fen() === this.root.fen
            ? 'Explore a legal continuation'
            : 'Explore an independent example',
        steps: args.steps.map((raw, index) => {
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
            title: `Legal example ${index + 1}`,
            note: 'Explore this legal sequence; it is not an engine recommendation.',
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
      const text = receipt
        ? name === 'write_player_note'
          ? `Verified for position ${receipt.reference.fen}: ${receipt.text}`
          : receipt.text
        : name === 'record_intervention'
          ? neutralPrompts.acknowledgement
          : neutralPrompts.candidate;
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
