import type { ToolActivity } from '../src/lib/chat.js';
import { DatabaseSync } from 'node:sqlite';
import {
  mkdirSync,
  chmodSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  readdirSync,
  openSync,
  readSync,
  closeSync,
  fstatSync,
} from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Chess } from 'chess.js';
import {
  practiceGame,
  snapshot,
  validBudget,
  type Budget,
  type GameState,
  type Demonstration,
} from '../src/lib/chess.js';
import { redactCoachText } from './coach.js';
import defaults from '../config/mock-coach.json' with { type: 'json' };

export interface Message {
  id: number;
  role: 'coach' | 'player' | 'tool';
  tool?: ToolActivity;
  text: string;
  action?: string;
  fen?: string;
  demonstration?: Demonstration;
}
export interface Conversation {
  id: number;
  fen: string;
  label: string;
  messages: Message[];
}
export interface Workspace {
  game: GameState;
  gameId: string;
  initialPly?: number;
  version: number;
  activity: { heading: string; subtitle: string };
  quiet: boolean;
  playerSide: 'w' | 'b';
  opponent: 'stockfish' | 'coach';
  skill?: number;
  conversations: Conversation[];
  budget: Budget;
  mode: 'mock' | 'live';
  provider: string;
  model: string;
  paused: boolean;
}
export interface ArchiveEntry {
  id: string;
  path: string;
  hash: string;
  at: string;
  summary: string;
  source: string;
  assistance: string;
  importedAt?: string;
  metadata?: Record<string, string>;
  themes?: string[];
  evidence?: string[];
}
export class Store {
  db: DatabaseSync;
  archive: string;
  constructor(
    public directory: string,
    archive = join(directory, 'archive'),
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.archive = resolve(archive);
    const source = resolve(process.cwd());
    if (resolve(directory) === source || resolve(directory).startsWith(source + sep))
      throw new Error('Runtime state must be outside the public source checkout.');
    if (this.archive === source || this.archive.startsWith(source + sep))
      throw new Error('Coaching archive must be outside the public source checkout.');
    mkdirSync(this.archive, { recursive: true, mode: 0o700 });
    this.archive = realpathSync(this.archive);
    const canonicalSource = realpathSync(source);
    const canonicalRuntime = realpathSync(directory);
    if (canonicalRuntime === canonicalSource || canonicalRuntime.startsWith(canonicalSource + sep))
      throw new Error('Runtime state must be outside the public source checkout.');
    if (this.archive === canonicalSource || this.archive.startsWith(canonicalSource + sep))
      throw new Error('Coaching archive must be outside the public source checkout.');
    this.db = new DatabaseSync(join(directory, 'state.sqlite'));
    chmodSync(join(directory, 'state.sqlite'), 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS usage(id TEXT PRIMARY KEY, period TEXT NOT NULL, amount REAL NOT NULL, settled INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, status TEXT NOT NULL, value TEXT NOT NULL);`);
    if (!this.get<Workspace>('workspace') && existsSync(this.path('workspace/checkpoint.json'))) {
      const checkpoint = JSON.parse(this.read('workspace/checkpoint.json')) as {
        settings: { key: string; value: string }[];
        usage: { id: string; period: string; amount: number; settled: number }[];
      };
      const candidate = checkpoint.settings.find((item) => item.key === 'workspace');
      if (!candidate) throw new Error('Coaching checkpoint has no workspace.');
      const recovered = JSON.parse(candidate.value) as Workspace;
      const board = new Chess();
      board.loadPgn(recovered.game.pgn);
      if (
        !validBudget(recovered.budget) ||
        !Number.isInteger(recovered.version) ||
        !Array.isArray(recovered.conversations) ||
        typeof recovered.activity.heading !== 'string' ||
        !['mock', 'live'].includes(recovered.mode)
      )
        throw new Error('Invalid coaching checkpoint.');
      for (const row of checkpoint.settings)
        if (row.key !== 'access-token' && !row.key.startsWith('presence:'))
          this.db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run(row.key, row.value);
      recovered.game = snapshot(board);
      recovered.version++;
      this.save(recovered);
      for (const row of checkpoint.usage)
        if (Number.isFinite(row.amount) && row.amount >= 0)
          this.db
            .prepare('INSERT OR REPLACE INTO usage VALUES(?,?,?,?)')
            .run(row.id, row.period, row.amount, row.settled);
      let maxId = 0;
      for (const [path, text] of Object.entries(this.files(100000, 64 * 1024 * 1024)))
        if (path.startsWith('events/') && path.endsWith('.jsonl'))
          for (const line of text.split('\n').filter(Boolean)) {
            const row = JSON.parse(line) as {
              id: number;
              at: string;
              kind: string;
              value: unknown;
            };
            if (
              !Number.isInteger(row.id) ||
              typeof row.at !== 'string' ||
              typeof row.kind !== 'string'
            )
              throw new Error('Invalid archived event.');
            this.db
              .prepare('INSERT OR IGNORE INTO events(id,at,kind,value) VALUES(?,?,?,?)')
              .run(row.id, row.at, row.kind, JSON.stringify(row.value));
            maxId = Math.max(maxId, row.id);
          }
      this.put('archive-watermark', maxId);
      this.put('archive-recovered', true);
    }
    if (!this.get<Workspace>('workspace')) {
      this.put('workspace', {
        game: practiceGame(),
        gameId: randomUUID(),
        initialPly: 6,
        version: 0,
        activity: defaults.activities.development,
        quiet: false,
        playerSide: 'w',
        opponent: 'stockfish',
        conversations: [
          {
            id: 1,
            fen: practiceGame().fen,
            label: 'Position',
            messages: [{ id: 1, role: 'coach', text: defaults.welcome }],
          },
        ],
        budget: { mode: 'none', amount: 50 },
        mode: 'mock',
        provider: 'google',
        model: process.env.CHESSLASSO_MODEL ?? 'gemini-3.8-flash',
        paused: false,
      } satisfies Workspace);
    }
    for (const [path, template] of Object.entries({
      'profile/current.md': 'profile.md',
      'plans/current.md': 'plan.md',
      'backlog/app-improvements.md': 'backlog.md',
      'research/index.md': 'research.md',
    }))
      if (!existsSync(this.path(path)))
        this.write(path, readFileSync(join(process.cwd(), 'config/archive', template), 'utf8'));
  }

  path(path: string) {
    if (lstatSync(this.archive).isSymbolicLink())
      throw new Error('Archive root cannot be a symlink.');
    const target = resolve(this.archive, path);
    if (
      target === this.archive ||
      relative(this.archive, target).startsWith('..') ||
      path.includes('\0')
    )
      throw new Error('Invalid archive path.');
    // Existing archive directories must never redirect a validated path outside the archive.
    let current = this.archive;
    for (const part of relative(this.archive, target).split(sep)) {
      current = join(current, part);
      if (existsSync(current) && requireLstat(current))
        throw new Error('Archive symlinks are not permitted.');
    }
    return target;
  }
  get<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as
      | { value: string }
      | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }
  put(key: string, value: unknown) {
    this.db
      .prepare('INSERT OR REPLACE INTO settings VALUES(?,?)')
      .run(key, redactCoachText(JSON.stringify(value)));
  }
  workspace() {
    return this.get<Workspace>('workspace')!;
  }
  save(value: Workspace) {
    this.put('workspace', value);
  }
  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  event(kind: string, value: unknown) {
    const at = new Date().toISOString();
    const result = this.db
      .prepare('INSERT INTO events(at,kind,value) VALUES(?,?,?)')
      .run(at, kind, redactCoachText(JSON.stringify(value)));
    return { id: Number(result.lastInsertRowid), at, kind, value };
  }
  events(after = 0) {
    return (
      this.db.prepare('SELECT * FROM events WHERE id>? ORDER BY id LIMIT 2000').all(after) as {
        id: number;
        at: string;
        kind: string;
        value: string;
      }[]
    ).map((row) => ({ ...row, value: JSON.parse(row.value) as unknown }));
  }
  command<T>(id: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM commands WHERE id=?').get(id) as
      | { value: string }
      | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }
  remember(id: string, value: unknown) {
    this.db
      .prepare('INSERT OR REPLACE INTO commands VALUES(?,?)')
      .run(id, redactCoachText(JSON.stringify(value)));
  }
  write(path: string, content: string) {
    const target = this.path(path);
    mkdirSync(resolve(target, '..'), { recursive: true, mode: 0o700 });
    const temporary = target + '.tmp';
    writeFileSync(temporary, redactCoachText(content), { mode: 0o600 });
    renameSync(temporary, target);
  }
  read(path: string) {
    return readFileSync(this.path(path), 'utf8');
  }
  readChunk(path: string, offset = 0, limit = 16000) {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 32000
    )
      throw new Error('Invalid record range.');
    const handle = openSync(this.path(path), 'r');
    try {
      const info = fstatSync(handle);
      if (!info.isFile()) throw new Error('Choose a record file.');
      const buffer = Buffer.alloc(Math.min(Math.max(4, limit), Math.max(0, info.size - offset)));
      let bytes = readSync(handle, buffer, 0, buffer.length, offset);
      // Do not split a UTF-8 character between pages (even for a one-byte requested range).
      while (bytes > 0) {
        try {
          new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytes));
          break;
        } catch {
          bytes--;
        }
      }
      if (buffer.length && !bytes) throw new Error('Record is not valid UTF-8 at this offset.');
      return {
        text: buffer.subarray(0, bytes).toString('utf8'),
        offset,
        nextOffset: offset + bytes < info.size ? offset + bytes : null,
        totalBytes: info.size,
      };
    } finally {
      closeSync(handle);
    }
  }
  files(maxFiles = 500, maxSize = 512000) {
    const result: Record<string, string> = {};
    const visit = (dir: string) => {
      for (const entry of readdirSync(this.path(dir), { withFileTypes: true })) {
        if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) visit(path);
        else if (entry.isFile() && /\.(md|jsonl|pgn|json)$/.test(path)) {
          const text = this.read(path);
          if (text.length < maxSize && Object.keys(result).length < maxFiles) result[path] = text;
        }
      }
    };
    for (const entry of readdirSync(this.archive, { withFileTypes: true }))
      if (
        entry.isDirectory() &&
        [
          'profile',
          'plans',
          'backlog',
          'research',
          'games',
          'diary',
          'events',
          'sessions',
          'meetings',
          'prompts',
          'releases',
          'workspace',
        ].includes(entry.name)
      )
        visit(entry.name);
    return result;
  }
  archiveGame(
    workspace = this.workspace(),
    summary = 'Training game in progress',
    source = 'ChessLasso',
    assistance = 'event-linked',
  ) {
    const chess = new Chess();
    chess.loadPgn(workspace.game.pgn);
    const at = this.get<string>('game-start:' + workspace.gameId) ?? new Date().toISOString();
    this.put('game-start:' + workspace.gameId, at);
    const originalHeaders = chess.getHeaders();
    if (source === 'ChessLasso')
      chess.header(
        'Event',
        source,
        'Site',
        'ChessLasso',
        'Date',
        at.slice(0, 10).replaceAll('-', '.'),
        'UTCDate',
        at.slice(0, 10).replaceAll('-', '.'),
        'UTCTime',
        at.slice(11, 19),
        'White',
        workspace.playerSide === 'w' ? 'Player' : 'Training opponent',
        'Black',
        workspace.playerSide === 'b' ? 'Player' : 'Training opponent',
        'GameId',
        workspace.gameId,
        'Assistance',
        assistance,
      );
    if (source !== 'ChessLasso') chess.header('GameId', workspace.gameId, 'Assistance', assistance);
    const path = `games/${at.slice(0, 4)}/${at.slice(5, 7)}/${at.replaceAll(':', '-')}-${workspace.gameId}.pgn`;
    const pgn = chess.pgn();
    this.write(path, pgn + '\n');
    const entries = this.get<ArchiveEntry[]>('game-index') ?? [];
    const previous = entries.find((item) => item.id === workspace.gameId);
    const entry = {
      ...previous,
      id: workspace.gameId,
      path,
      hash: createHash('sha256').update(pgn).digest('hex'),
      at,
      summary: previous && summary === 'Training game in progress' ? previous.summary : summary,
      source,
      assistance,
      ...(source !== 'ChessLasso'
        ? { importedAt: new Date().toISOString(), metadata: originalHeaders }
        : {}),
    };
    const next = [...entries.filter((item) => item.id !== entry.id), entry];
    this.put('game-index', next);
    this.write('games/index.jsonl', next.map((item) => JSON.stringify(item)).join('\n') + '\n');
    this.write(
      'games/index.md',
      '# Games\n\n' +
        next
          .map((item) => `- [${item.at} — ${item.summary}](${item.path.replace(/^games\//, '')})`)
          .join('\n') +
        '\n',
    );
    return entry;
  }
  updateIndex(id: string, summary: string, themes: string[], evidence: string[]) {
    const entries = this.get<ArchiveEntry[]>('game-index') ?? [];
    const entry = entries.find((item) => item.id === id);
    if (!entry) throw new Error('Unknown game ID.');
    entry.summary = summary;
    entry.themes = themes;
    entry.evidence = evidence;
    this.put('game-index', entries);
    this.write('games/index.jsonl', entries.map((item) => JSON.stringify(item)).join('\n') + '\n');
    this.write(
      'games/index.md',
      '# Games\n\n' +
        entries
          .map((item) => `- [${item.at} — ${item.summary}](${item.path.replace(/^games\//, '')})`)
          .join('\n') +
        '\n',
    );
    return entry;
  }
  reserve(amount: number) {
    return this.transaction(() => {
      const workspace = this.workspace();
      const period = new Date().toISOString().slice(0, 7);
      const used = Number(
        (
          this.db
            .prepare('SELECT COALESCE(SUM(amount),0) AS total FROM usage WHERE period=?')
            .get(period) as { total: number }
        ).total,
      );
      if (workspace.budget.mode === 'hard' && used + amount > workspace.budget.amount)
        throw new Error('Monthly hard cap reached. Change the budget to continue paid work.');
      const id = randomUUID();
      this.db.prepare('INSERT INTO usage VALUES(?,?,?,0)').run(id, period, amount);
      return id;
    });
  }
  settle(id: string, amount: number) {
    this.db.prepare('UPDATE usage SET amount=?,settled=1 WHERE id=?').run(Math.max(0, amount), id);
  }
  dayEvents(day: string, classify: (date: Date) => string) {
    const start = new Date(Date.parse(day + 'T00:00:00Z') - 86400000).toISOString();
    const end = new Date(Date.parse(day + 'T00:00:00Z') + 3 * 86400000).toISOString();
    const rows = this.db
      .prepare('SELECT * FROM events WHERE at>=? AND at<? ORDER BY id')
      .all(start, end) as { id: number; at: string; kind: string; value: string }[];
    return {
      events: rows
        .filter((row) => classify(new Date(row.at)) === day)
        .map((row) => ({ ...row, value: JSON.parse(row.value) as unknown })),
      truncated: false,
      watermark: rows.at(-1)?.id ?? 0,
    };
  }
  checkpoint() {
    const settings = (
      this.db.prepare('SELECT * FROM settings').all() as { key: string; value: string }[]
    ).filter((row) => row.key !== 'access-token' && !row.key.startsWith('presence:'));
    const usage = this.db.prepare('SELECT * FROM usage').all();
    this.write(
      'workspace/checkpoint.json',
      JSON.stringify({ version: 1, at: new Date().toISOString(), settings, usage }),
    );
  }
  flushEvents() {
    const watermark = this.get<number>('archive-watermark') ?? 0;
    const rows = this.db.prepare('SELECT * FROM events WHERE id>? ORDER BY id').all(watermark) as {
      id: number;
      at: string;
      kind: string;
      value: string;
    }[];
    for (const date of new Set(rows.map((row) => row.at.slice(0, 10)))) {
      const events = this.db
        .prepare('SELECT * FROM events WHERE at>=? AND at<? ORDER BY id')
        .all(date, date + 'z') as { id: number; at: string; kind: string; value: string }[];
      this.write(
        `events/${date.slice(0, 4)}/${date.slice(5, 7)}/${date}.jsonl`,
        events.map((row) => JSON.stringify({ ...row, value: JSON.parse(row.value) })).join('\n') +
          '\n',
      );
    }
    if (rows.length) this.put('archive-watermark', rows.at(-1)!.id);
  }
  journal() {
    const directory = 'diary';
    const entries = existsSync(this.path(directory))
      ? readdirSync(this.path(directory), { withFileTypes: true })
          .filter((entry) => entry.isFile() && /^\d{4}-\d{2}-\d{2}\.md$/.test(entry.name))
          .sort((a, b) => b.name.localeCompare(a.name))
          .map((entry) => ({
            day: entry.name.slice(0, -3),
            text: this.read(`${directory}/${entry.name}`),
          }))
      : [];
    return {
      notes: existsSync(this.path('games/coach-notes.md')) ? this.read('games/coach-notes.md') : '',
      profile: this.read('profile/current.md'),
      plan: this.read('plans/current.md'),
      entries,
    };
  }
  stats() {
    const count = (kind: string) =>
      Number(
        (
          this.db.prepare('SELECT COUNT(*) AS total FROM events WHERE kind=?').get(kind) as {
            total: number;
          }
        ).total,
      );
    return {
      moves: count('move'),
      assistance: count('assistance'),
      notationRejects: count('notation_rejected'),
      games: (this.get<ArchiveEntry[]>('game-index') ?? []).length,
      note: 'Descriptive counts only. Exposure is not measured attention; insufficient evidence for a FIDE rating.',
      profile: this.read('profile/current.md'),
      plan: this.read('plans/current.md'),
    };
  }
  close() {
    this.db.close();
  }
}
import { lstatSync, realpathSync } from 'node:fs';
function requireLstat(path: string) {
  return lstatSync(path).isSymbolicLink();
}
export function nextConversation(
  workspace: Workspace,
  text?: string,
  action?: string,
  fen?: string,
  demonstration?: Demonstration,
) {
  const moves = workspace.game.moves;
  const id = Math.max(0, ...workspace.conversations.map((item) => item.id)) + 1;
  const messageId =
    Math.max(
      0,
      ...workspace.conversations.flatMap((item) => item.messages.map((message) => message.id)),
    ) + 1;
  workspace.conversations.push({
    id,
    fen: workspace.game.fen,
    label: moves.length
      ? `${Math.ceil(moves.length / 2)}. ${moves.length % 2 ? moves.at(-1) : moves.slice(-2).join(' ')}`
      : 'Position',
    messages: text ? [{ id: messageId, role: 'coach', text, action, fen, demonstration }] : [],
  });
}
export function replaceGame(workspace: Workspace, fen?: string) {
  workspace.game = snapshot(new Chess(fen));
  workspace.gameId = randomUUID();
  workspace.initialPly = 0;
  workspace.version++;
}
