import { createHash } from 'node:crypto';
import { Chess } from 'chess.js';
import type { CoachAction } from './coach.js';
import type { Store, ArchiveEntry } from './store.js';
import { coachingDay } from './jobs.js';
import { positionReference } from './board-facts.js';

interface Event {
  id: number;
  at: string;
  kind: string;
  value: unknown;
}
interface Descriptor {
  path: string;
  sha256: string;
}
interface Game extends ArchiveEntry {
  frozen?: Descriptor;
}
interface DaySource {
  day?: string;
  events?: Event[];
  truncated?: boolean;
  games?: Game[];
  boardFacts?: Record<string, unknown>[];
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function readChecked(store: Store, descriptor: Descriptor) {
  const text = store.read(descriptor.path);
  if (createHash('sha256').update(text).digest('hex') !== descriptor.sha256)
    throw new Error('Frozen meeting evidence hash mismatch.');
  return text;
}
/** Frozen manifests resolve only their captured raw data, never today's mutable archive index. */
export function meetingSource(store: Store, evidence: unknown): DaySource {
  const candidate = object(evidence);
  if (candidate.version === 2) {
    const raw = object(object(candidate.records).raw);
    if (typeof raw.path !== 'string' || typeof raw.sha256 !== 'string')
      throw new Error('Invalid frozen meeting evidence.');
    return JSON.parse(readChecked(store, raw as unknown as Descriptor)) as DaySource;
  }
  return candidate as DaySource;
}

function attempts(events: Event[]) {
  const moves = events.filter((event) => event.kind === 'move');
  const assisted = moves.filter(
    (event) => object(event.value).assistanceStatus === 'assisted',
  ).length;
  const independent = moves.filter(
    (event) => object(event.value).assistanceStatus === 'independent-observation',
  ).length;
  return {
    loggedPlayerMoves: moves.length,
    assistedAttempts: assisted,
    independentAttempts: independent,
    unknownAssistanceAttempts: moves.length - assisted - independent,
  };
}
function boardFacts(fen: string) {
  const board = new Chess(fen);
  return {
    fen: board.fen(),
    turn: board.turn(),
    check: board.isCheck(),
    checkmate: board.isCheckmate(),
    legalMoves: board.moves().sort(),
    pieces: Object.fromEntries(
      board
        .board()
        .flat()
        .filter((piece) => piece !== null)
        .map((piece) => [piece.square, piece.color + piece.type]),
    ),
  };
}
export type MeetingFacts = ReturnType<typeof meetingFacts>;

export function meetingFacts(store: Store, day: string, supplied?: unknown) {
  const source: DaySource =
    supplied === undefined
      ? { day, ...store.dayEvents(day, coachingDay), games: store.get<Game[]>('game-index') ?? [] }
      : meetingSource(store, supplied);
  const events = (source.events ?? []).filter(
    (event) => event.at && coachingDay(new Date(event.at)) === day,
  );
  const gameIds = new Set(
    events
      .map((event) => object(event.value).gameId)
      .filter((value): value is string => typeof value === 'string'),
  );
  const games = (source.games ?? []).filter(
    (game) => gameIds.has(game.id) || coachingDay(new Date(game.importedAt ?? game.at)) === day,
  );
  const issues: string[] = [];
  const positions = new Map<string, ReturnType<typeof boardFacts>>();
  const verifyFen = (fen: unknown) => {
    if (typeof fen !== 'string' || positions.has(fen) || positions.size >= 64) return;
    try {
      positions.set(fen, boardFacts(fen));
    } catch {
      issues.push('Invalid supplied FEN: board claims cannot be verified.');
    }
  };
  const gameCounts = games.map((game) => {
    try {
      if (supplied !== undefined && !game.frozen)
        throw new Error('Snapshot has no immutable PGN; live game context cannot replace it.');
      const pgn = game.frozen ? readChecked(store, game.frozen) : store.read(game.path);
      const board = new Chess();
      board.loadPgn(pgn);
      verifyFen(board.fen());
      return {
        gameId: game.id,
        evidenceWindow: day,
        gameStartedAt: game.at,
        gameStartedOutsideWindow: coachingDay(new Date(game.at)) !== day,
        totalGamePliesAtSnapshot: board.history().length,
        ...attempts(events.filter((event) => object(event.value).gameId === game.id)),
        note: 'PGN plies include setup/opening history and both sides; logged player attempts cover only the stated coaching day. Never subtract one from the other to infer assistance.',
      };
    } catch {
      issues.push(`Game ${game.id}: PGN unavailable or invalid; total game plies unknown.`);
      return {
        gameId: game.id,
        evidenceWindow: day,
        totalGamePliesAtSnapshot: null,
        ...attempts(events.filter((event) => object(event.value).gameId === game.id)),
      };
    }
  });
  for (const event of events) {
    verifyFen(object(event.value).fen);
    verifyFen(object(object(event.value).reference).fen);
  }
  for (const claim of source.boardFacts ?? []) {
    verifyFen(claim.fen);
    const actual = typeof claim.fen === 'string' ? positions.get(claim.fen) : undefined;
    if (!actual) {
      issues.push('Supplied board-fact list lacks a verifiable position.');
      continue;
    }
    for (const key of ['turn', 'check', 'checkmate'] as const)
      if (claim[key] !== undefined && claim[key] !== actual[key])
        issues.push(`Supplied ${key} claim contradicts chess.js at ${actual.fen}.`);
    if (
      claim.pieces !== undefined &&
      JSON.stringify(
        Object.entries(object(claim.pieces)).sort(([a], [b]) => a.localeCompare(b)),
      ) !== JSON.stringify(Object.entries(actual.pieces).sort(([a], [b]) => a.localeCompare(b)))
    )
      issues.push(
        `Supplied piece list is incomplete or wrong at ${actual.fen}; use the complete host board facts.`,
      );
  }
  return {
    provenance: 'deterministic-host-facts' as const,
    ruleLibrary: 'chess.js',
    engineChecks: 0,
    evidenceWindow: {
      coachingDay: day,
      timezone: 'Australia/Sydney',
      boundary: '04:00',
      truncated: source.truncated === true,
    },
    counts: attempts(events),
    games: gameCounts,
    boardFacts: [...positions.values()],
    issues,
    note: 'Counts describe typed events in this window only. Historical narrative and prior coach/diary interpretations are source claims, not verified facts. Rule checks establish legality and board state, not tactical strength or an engine evaluation.',
  };
}

export interface VerificationReceipt {
  tool: string;
  args: Record<string, unknown>;
  result: unknown;
}
export function verificationReceipts(actions: CoachAction[]): VerificationReceipt[] {
  return actions
    .filter((action) =>
      [
        'analyse_position',
        'verify_claims',
        'inspect_board',
        'read_history',
        'search_history',
      ].includes(action.name),
    )
    .map((action) => ({ tool: action.name, args: action.args, result: action.result }));
}

/** A conservative acceptance gate supplements the independent coach; it does not certify arbitrary prose. */
export function provenanceObjections(
  text: string,
  _receipts: VerificationReceipt[],
  actor: 'lead' | 'reviewer',
): string[] {
  const objections: string[] = [];
  const sentences = text.split(/[.!?\n]/);
  for (const sentence of sentences) {
    const attributedOrNegated =
      /\b(?:source claim|archive claims|archived coach claim)\b/i.test(sentence) ||
      /\b(?:no|not|without|cannot|unsupported|unverified|unavailable)\b.{0,25}\b(?:engine|verification|check|performed)\b/i.test(
        sentence,
      );
    if (
      /(?:\b(?:engine|stockfish)\b.{0,60}\b(?:check(?:ed)?|confirm(?:ed|s)?|ran|evaluat(?:ed|ion)|verif(?:ied|ication)|analys(?:ed|is)|analyz(?:ed|is))\b|\b(?:check(?:ed)?|confirm(?:ed|s)?|ran|evaluat(?:ed|ion)|verif(?:ied|ication)|analys(?:ed|is)|analyz(?:ed|is))\b.{0,60}\b(?:engine|stockfish)\b)/i.test(
        sentence,
      ) &&
      !attributedOrNegated
    )
      objections.push(
        `${actor}: engine verification declarations require host-rendered structured provenance; a cited receipt does not validate narrative.`,
      );
    if (
      /\b(?:I|we|independently)\b.{0,35}\b(?:checked|verified|validated|analysed|analyzed)\b/i.test(
        sentence,
      ) &&
      !attributedOrNegated
    )
      objections.push(
        `${actor}: self-performed board verification declarations require host-rendered structured provenance. Attribute supplied host checks explicitly.`,
      );
    if (
      /(?:\b\d{3,4}\s*(?:FIDE|Elo)\b|\b(?:FIDE|Elo|rating|rated|strength)\b.{0,25}\b\d{3,4}\b)/i.test(
        sentence,
      ) &&
      !/\b(?:source claim|unsupported|reject(?:ed)?|insufficient evidence|cannot infer)\b.{0,50}\b(?:FIDE|Elo|rating|strength|\d{3,4})\b/i.test(
        sentence,
      )
    )
      objections.push(
        `${actor}: unsupported numeric strength estimate; repetition by a coach is not independent evidence.`,
      );
  }
  return [...new Set(objections)];
}

/** Render only the structured position receipt, never provider-authored verification prose. */
function structuredProvenance(receipt: VerificationReceipt) {
  const result = object(receipt.result);
  const unknown = { tool: receipt.tool, status: 'unknown', reason: 'Malformed position receipt.' };
  try {
    const inspection = receipt.tool === 'inspect_board';
    const evidence = inspection
      ? { reference: object(result.boardFacts).reference }
      : receipt.tool === 'analyse_position'
        ? object(result.evidence)
        : result;
    const reference = object(evidence.reference);
    const root = inspection ? reference : object(evidence.root);
    for (const value of [reference, root]) {
      if (typeof value.fen !== 'string' || typeof value.version !== 'number') return unknown;
      const expected = positionReference(value.fen, value.version);
      if (value.fen !== expected.fen || value.id !== expected.id) return unknown;
    }
    const id = inspection ? reference.id : evidence.id;
    const moves: unknown = inspection ? [] : evidence.moves;
    if (
      typeof id !== 'string' ||
      !id ||
      reference.version !== root.version ||
      !Array.isArray(moves) ||
      moves.length > 40 ||
      moves.some((move) => typeof move !== 'string')
    )
      return unknown;
    const board = new Chess(root.fen as string);
    const legalContinuation = (moves as string[]).map((move) => board.move(move).san);
    if (board.fen() !== reference.fen) return unknown;
    if (receipt.tool === 'analyse_position' && typeof result.engine !== 'string') return unknown;
    return {
      tool: receipt.tool,
      status: 'recorded',
      id,
      exactFen: reference.fen,
      reference,
      root,
      legalContinuation,
      ...(receipt.tool === 'analyse_position'
        ? {
            engine: {
              name: result.engine,
              build: typeof result.build === 'string' ? result.build : 'unknown',
              limits: result.limits ?? 'unknown',
            },
          }
        : { ruleLibrary: 'chess.js' }),
    };
  } catch {
    return unknown;
  }
}

export function factsReport(
  facts: MeetingFacts,
  lead: VerificationReceipt[],
  reviewer: VerificationReceipt[],
): string {
  return (
    '\n\nVerification provenance: host chess.js rule checks; host engine checks: 0. ' +
    `Lead tool receipts: ${lead.map((receipt) => receipt.tool).join(', ') || 'none'}. Reviewer tool receipts: ${reviewer.map((receipt) => receipt.tool).join(', ') || 'none'}. ` +
    'Archived claims remain attributed source material. Narrative declarations do not establish performed checks.\n\nStructured tool provenance: ' +
    JSON.stringify({
      lead: lead
        .filter((receipt) =>
          ['inspect_board', 'analyse_position', 'verify_claims'].includes(receipt.tool),
        )
        .map(structuredProvenance),
      reviewer: reviewer
        .filter((receipt) =>
          ['inspect_board', 'analyse_position', 'verify_claims'].includes(receipt.tool),
        )
        .map(structuredProvenance),
    }) +
    '\n\nScoped host facts: ' +
    JSON.stringify(facts)
  );
}

/** Narrative counts must name their scope instead of substituting PGN history for player attempts. */
export function countObjections(text: string, facts: MeetingFacts): string[] {
  const objections: string[] = [];
  const counts: Record<string, number> = {
    'logged player moves': facts.counts.loggedPlayerMoves,
    'assisted attempts': facts.counts.assistedAttempts,
    'independent attempts': facts.counts.independentAttempts,
    'unknown assistance attempts': facts.counts.unknownAssistanceAttempts,
  };
  for (const match of text.matchAll(
    /\b(\d+)\s+(logged player moves|assisted attempts|independent attempts|unknown assistance attempts|(?:player )?moves|attempts)\b/gi,
  )) {
    const category = match[2].toLowerCase();
    if (counts[category] === undefined)
      objections.push(
        'Ambiguous narrative move/attempt count: use typed host counts with the coaching-day evidence window.',
      );
    else if (Number(match[1]) !== counts[category])
      objections.push(
        `Narrative ${category} count contradicts deterministic host facts for ${facts.evidenceWindow.coachingDay}.`,
      );
  }
  return [...new Set(objections)];
}
