import type { ToolActivity } from '../src/lib/chat.js';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Chess } from 'chess.js';
import {
  loadGame,
  playNotation,
  snapshot,
  gameAtPly,
  playMockOpponent,
  type Demonstration,
} from '../src/lib/chess.js';
import { Store, nextConversation, replaceGame, type Workspace } from './store.js';
import { redactCoachText, type CoachRuntime, type CoachRole } from './coach.js';
import fixture from '../config/mock-coach.json' with { type: 'json' };
import { Backup } from './backup.js';
import { searchArchive } from './sandbox.js';
import { meetingAction } from './meeting-actions.js';
import { boardFacts } from './board-facts.js';
import { describeGameOver } from './verification.js';
import { chooseNextActivity, type NextActivity } from './training.js';

export class Runtime {
  store: Store;
  backup: Backup;
  private tail: Promise<unknown> = Promise.resolve();
  listeners = new Set<() => void>();
  toolRevision = 0;
  engine?: {
    play(fen: string, pgn?: string, skill?: number): Promise<string>;
    analyze(fen: string): Promise<unknown>;
  };
  coach?: CoachRuntime;
  constructor(directory: string, archive?: string) {
    this.store = new Store(directory, archive);
    this.backup = new Backup(this.store);
  }
  serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => undefined);
    return result;
  }
  state() {
    return {
      ...this.store.workspace(),
      stats: this.store.stats(),
      promptVersions: Object.fromEntries(
        ['coach', 'assistant-coach', 'consolidation', 'planner', 'retro'].map((name) => [
          name,
          this.store.get<string>('prompt:' + name) ?? 'default',
        ]),
      ),
      backup: this.store.get('backup') ?? { pending: true },
      journal: this.store.get('journal') ?? [],
      development: this.store.get('development-status') ?? {
        status: 'pending',
        reason:
          'An independently isolated Codex runner and release adapter have not been configured.',
      },
      usage: {
        ...this.store.db
          .prepare('SELECT COALESCE(SUM(amount),0) AS amount FROM usage WHERE period=?')
          .get(new Date().toISOString().slice(0, 7)),
      },
    };
  }
  save(workspace: Workspace, kind: string, value: unknown) {
    this.store.transaction(() => {
      this.store.save(workspace);
      this.store.event(kind, value);
    });
    this.store.archiveGame(workspace);
    this.store.flushEvents();
    this.store.checkpoint();
    for (const notify of this.listeners) notify();
  }
  interventions(
    version: number,
    fen = this.store.workspace().game.fen,
    gameId = this.store.workspace().gameId,
  ) {
    return Number(
      (
        this.store.db
          .prepare(
            `SELECT COUNT(*) AS total FROM events
             WHERE kind='assistance' AND json_extract(value,'$.version')=?
               AND COALESCE(json_extract(value,'$.scope'),'live')='live'
               AND (json_extract(value,'$.fen') IS NULL OR json_extract(value,'$.fen')=?)
               AND (json_extract(value,'$.gameId') IS NULL OR json_extract(value,'$.gameId')=?)`,
          )
          .get(version, fen, gameId) as { total: number }
      ).total,
    );
  }
  async move(notation: string, version: number, id: string, clientId?: string) {
    return this.serial(async () => {
      const repeated = this.store.command(id);
      if (repeated) return repeated;
      let workspace = this.store.workspace();
      if (clientId) {
        const lease = this.store.get<{ clientId: string; until: number }>('control-lease');
        if (lease && lease.until > Date.now() && lease.clientId !== clientId)
          throw new Error('Another device controls move entry. Take control before playing.');
        this.store.put('control-lease', { clientId, until: Date.now() + 45000 });
      }
      if (workspace.version !== version) throw new ConflictError();
      if (workspace.paused) throw new Error('Resume practice before entering a move.');
      if (workspace.game.turn !== workspace.playerSide)
        throw new Error('Wait for the opponent to finish its turn.');
      const chess = loadGame(workspace.game.pgn);
      if (chess.isGameOver())
        throw new Error('This position has ended. Ask the coach for the next exercise.');
      const played = playNotation(chess, notation);
      workspace.game = snapshot(chess);
      workspace.version++;
      this.save(workspace, 'move', {
        san: played.san,
        version: workspace.version,
        gameId: workspace.gameId,
        assistanceStatus:
          this.interventions(workspace.version - 1, played.before, workspace.gameId) > 0
            ? 'assisted'
            : workspace.quiet
              ? 'independent-observation'
              : 'unknown',
      });
      let opponentError = '';
      try {
        await this.reply();
      } catch {
        opponentError =
          'The opponent is temporarily unavailable. Your accepted move is saved; retry after reconnecting.';
      }
      workspace = this.store.workspace();
      let note = '';
      let response: Record<string, unknown> = {};
      if (workspace.game.over) {
        note = describeGameOver(workspace.game.pgn);
        workspace.activity = { heading: 'Game complete', subtitle: workspace.game.status };
        this.store.save(workspace);
        if (workspace.mode === 'live' && this.coach) {
          const priorDecision = this.store.get<NextActivity>('next-activity:' + workspace.gameId);
          try {
            const decision = await this.paid(this.prompts('game-complete'), workspace);
            note += '\n\n' + decision.text;
            response = { ...decision };
            const choice = decision.actions.find((action) => action.name === 'choose_next_activity')
              ?.result as NextActivity | undefined;
            if (choice?.kind === 'review') response.reviewPly = choice.reviewPly;
            if (this.store.workspace().gameId !== workspace.gameId) {
              await this.reply();
              const next = this.store.workspace();
              if (next.game.moves.length)
                note += `\n\nThe opponent played ${next.game.moves.at(-1)}. ${next.game.status}.`;
            }
          } catch {
            const accepted = this.store.get<NextActivity>('next-activity:' + workspace.gameId);
            if (accepted && accepted.planningId !== priorDecision?.planningId) {
              if (!note.includes(accepted.text)) note += '\n\n' + accepted.text;
              if (accepted.kind === 'review') response.reviewPly = accepted.reviewPly;
              else if (this.store.workspace().gameId !== workspace.gameId)
                note +=
                  '\n\nThe next activity is set up. If the opponent has not moved yet, retry after reconnecting.';
              else
                note +=
                  '\n\nThe chosen activity could not be set up. The completed game is still available.';
            } else
              note +=
                '\n\nI couldn’t complete the training-plan review. Your final position is saved; send a message to retry planning the next activity.';
          }
        }
      } else if (!workspace.quiet) {
        if (workspace.mode === 'live' && this.coach) {
          try {
            const result = await this.paid(
              this.prompts('after-move').replaceAll('{move}', played.san),
              workspace,
            );
            note = result.text;
            response = { ...result };
          } catch (error) {
            note =
              error instanceof Error
                ? error.message
                : 'The coach is unavailable; your move is saved.';
          }
        } else
          note = fixture.afterMove[
            Math.floor(workspace.game.moves.length / 2) % fixture.afterMove.length
          ].replaceAll('{reply}', workspace.game.moves.at(-1) ?? played.san);
      }
      for (const action of (response.actions ?? []) as {
        name: string;
        args: Record<string, unknown>;
      }[]) {
        if (action.name === 'show_demonstration') {
          response.action = 'demonstrate';
          response.demonstration = action.args;
        }
        if (action.name === 'ask_question') {
          response.action = 'question';
          response.fen = action.args.fen;
        }
      }
      workspace = this.store.workspace();
      if (note)
        this.store.event('assistance', {
          version: workspace.version,
          kind: 'coach_response',
          classification: 'unclassified-content',
        });
      nextConversation(
        workspace,
        note || opponentError,
        response.action as string | undefined,
        response.fen as string | undefined,
        response.demonstration as Demonstration | undefined,
      );
      this.save(workspace, 'position', { gameId: workspace.gameId, version: workspace.version });
      const result = {
        game: workspace.game,
        played: played.san,
        note,
        workspace: this.state(),
        ...response,
      };
      this.store.remember(id, result);
      return result;
    });
  }
  async reply() {
    const workspace = this.store.workspace();
    if (workspace.game.over || workspace.game.turn === workspace.playerSide) return;
    if (workspace.mode === 'live' && workspace.opponent === 'coach') {
      await this.paid(this.prompts('opponent'), workspace);
      if (
        this.store.workspace().game.turn !== workspace.playerSide &&
        !this.store.workspace().game.over
      )
        throw new Error('The coach has not supplied its move yet.');
      return;
    }
    const chess = loadGame(workspace.game.pgn);
    if (workspace.mode === 'mock') playMockOpponent(chess);
    else {
      if (!this.engine) throw new Error('Stockfish is not initialized.');
      const uci = await this.engine.play(chess.fen(), chess.pgn(), workspace.skill ?? 1);
      chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    }
    const current = this.store.workspace();
    if (current.version !== workspace.version) throw new ConflictError();
    current.game = snapshot(chess);
    current.version++;
    this.save(current, 'opponent_move', {
      gameId: current.gameId,
      san: chess.history().at(-1),
      version: current.version,
    });
  }
  coachContext(workspace = this.store.workspace()) {
    const {
      game,
      version,
      gameId,
      activity,
      quiet,
      playerSide,
      opponent,
      skill,
      paused,
      initialPly,
    } = workspace;
    return {
      fen: game.fen,
      pgn: game.pgn,
      boardFacts: boardFacts(game.fen, version),
      version,
      gameId,
      activity,
      quiet,
      playerSide,
      opponent,
      skill,
      paused,
      initialPly,
      profile: this.store.read('profile/current.md').slice(-12000),
      plan: this.store.read('plans/current.md').slice(-8000),
      recentMessages: workspace.conversations
        .at(-1)
        ?.messages.filter((message) => message.role !== 'tool')
        .slice(-4),
      promptVersions: Object.fromEntries(
        ['coach', 'assistant-coach', 'consolidation', 'planner', 'retro'].map((name) => [
          name,
          this.store.get<string>('prompt:' + name) ?? 'default',
        ]),
      ),
    };
  }
  async paid(message: string, context: Workspace, role = 'coach') {
    if (!this.coach) throw new Error('Live coach is not initialized.');
    return this.coach.run(
      message,
      {
        ...this.coachContext(context),
        recentMessages: role === 'coach' ? this.coachContext(context).recentMessages : undefined,
        runRole: role,
        postGamePlanning: role === 'coach' && context.game.over,
        planningId: role === 'coach' && context.game.over ? randomUUID() : undefined,
      },
      role as CoachRole,
      role === 'coach' || role === 'question-feedback'
        ? (activity) => this.recordToolActivity(activity)
        : undefined,
    );
  }
  recordToolActivity(activity: ToolActivity) {
    const workspace = this.store.workspace();
    const existing = workspace.conversations
      .flatMap((item) => item.messages)
      .find((message) => message.tool?.id === activity.id);
    if (existing) existing.tool = activity;
    else
      workspace.conversations.at(-1)!.messages.push({
        id:
          Math.max(
            0,
            ...workspace.conversations.flatMap((item) =>
              item.messages.map((message) => message.id),
            ),
          ) + 1,
        role: 'tool',
        text: '',
        tool: activity,
      });
    this.toolRevision++;
    this.save(workspace, 'tool_activity', activity);
  }
  async chat(message: string, version: number, id: string, reviewPly?: number) {
    message = redactCoachText(message);
    return this.serial(async () => {
      const previous = this.store.command(id);
      if (previous) return previous;
      let workspace = this.store.workspace();
      if (version !== workspace.version) throw new ConflictError();
      const reviewed =
        reviewPly === undefined ? undefined : gameAtPly(workspace.game.pgn, reviewPly);
      const conversation = workspace.conversations.at(-1)!;
      const messageId =
        Math.max(
          0,
          ...workspace.conversations.flatMap((item) => item.messages.map((msg) => msg.id)),
        ) + 1;
      conversation.messages.push({
        id: messageId,
        role: 'player',
        text: message,
        fen: reviewed?.fen,
      });
      this.store.save(workspace);
      let result: Record<string, unknown>;
      // The Resume quick action changes feedback policy, not the completed game's position.
      if (!reviewed && workspace.game.over && message === 'Resume coaching and help again') {
        workspace.quiet = false;
        this.store.save(workspace);
        result =
          workspace.mode === 'live' && this.coach
            ? { ...(await this.paid(message + '\n\n' + this.prompts('game-complete'), workspace)) }
            : { text: describeGameOver(workspace.game.pgn) };
      } else if (workspace.mode === 'live')
        result = {
          ...(await this.paid(
            message,
            reviewed ? { ...workspace, game: reviewed } : workspace,
            reviewed ? 'question-feedback' : 'coach',
          )),
        };
      else result = reviewed ? { text: fixture.default } : this.mock(message);
      if (!reviewed) await this.reply();
      workspace = this.store.workspace();
      if (Array.isArray(result.actions))
        for (const action of result.actions as { name: string; args: Record<string, unknown> }[]) {
          if (action.name === 'show_demonstration') {
            result.action = 'demonstrate';
            result.demonstration = action.args;
          }
          if (action.name === 'ask_question') {
            result.action = 'question';
            result.fen = action.args.fen;
          }
          if (action.name === 'start_activity') {
            result.activity = workspace.activity;
            result.game = workspace.game;
          }
          if (action.name === 'record_intervention' && workspace.quiet) result.action = 'quiet';
        }
      const text = typeof result.text === 'string' ? result.text : '';
      if (result.game && workspace.mode === 'mock') {
        workspace.game = result.game as Workspace['game'];
        workspace.gameId = randomUUID();
        workspace.initialPly = 0;
        workspace.version++;
      }
      if (result.activity) workspace.activity = result.activity as Workspace['activity'];
      if (result.action === 'quiet' || result.action === 'new_game') workspace.quiet = true;
      if (result.action === 'resume' || result.action === 'hint') workspace.quiet = false;
      if (result.game)
        nextConversation(
          workspace,
          text,
          result.action as string,
          result.fen as string,
          result.demonstration as Demonstration | undefined,
        );
      else
        workspace.conversations.at(-1)!.messages.push({
          id:
            Math.max(
              0,
              ...workspace.conversations.flatMap((item) =>
                item.messages.map((message) => message.id),
              ),
            ) + 1,
          role: 'coach',
          text,
          action: result.action as string,
          fen: reviewed?.fen ?? (result.fen as string),
          demonstration: result.demonstration as Demonstration | undefined,
        });
      this.save(workspace, 'chat', { version: workspace.version, message, reply: text, reviewPly });
      if (text)
        this.store.event('assistance', {
          version: workspace.version,
          kind: 'coach_chat',
          scope: reviewed ? 'review' : 'live',
          fen: reviewed?.fen ?? workspace.game.fen,
          gameId: workspace.gameId,
          classification: 'unclassified-content',
          action: result.action ?? 'text',
        });
      const choice = (result.actions as { name: string; result: NextActivity }[] | undefined)?.find(
        (action) => action.name === 'choose_next_activity',
      )?.result;
      const response = {
        ...result,
        ...(choice?.kind === 'review' ? { reviewPly: choice.reviewPly } : {}),
        workspace: this.state(),
      };
      this.store.remember(id, response);
      return response;
    });
  }
  async answer(fen: string, notation: string, id: string, questionMessageId?: number) {
    return this.serial(async () => {
      const repeated = this.store.command<{
        text: string;
        workspace: ReturnType<Runtime['state']>;
      }>(id);
      if (repeated) return repeated;
      let workspace = this.store.workspace();
      let conversation = workspace.conversations.find((item) =>
        item.messages.some(
          (message) =>
            message.action === 'question' &&
            message.fen === fen &&
            (questionMessageId === undefined || message.id === questionMessageId),
        ),
      );
      if (!conversation)
        throw new Error('This question is no longer available. Ask the coach for another.');
      const board = new Chess(fen);
      const move = playNotation(board, notation);
      this.store.event('question_answer', {
        fen,
        san: move.san,
        mainVersion: workspace.version,
        conversationId: conversation.id,
        questionMessageId,
      });
      let text = `${move.san} is a legal candidate. Your main game has not changed.`;
      if (workspace.mode === 'live') {
        const result = await this.paid(
          JSON.stringify({
            question: conversation.messages.find(
              (message) =>
                message.action === 'question' &&
                message.fen === fen &&
                (questionMessageId === undefined || message.id === questionMessageId),
            )?.text,
            fen,
            candidate: move.san,
          }),
          { ...workspace, game: snapshot(new Chess(fen)) },
          'question-feedback',
        );
        text = result.text;
      }
      const conversationId = conversation.id;
      workspace = this.store.workspace();
      conversation = workspace.conversations.find((item) => item.id === conversationId)!;
      conversation.messages.push({
        id:
          Math.max(
            0,
            ...workspace.conversations.flatMap((item) =>
              item.messages.map((message) => message.id),
            ),
          ) + 1,
        role: 'player',
        text: `Question candidate: ${move.san}`,
        fen,
      });
      conversation.messages.push({
        id:
          Math.max(
            0,
            ...workspace.conversations.flatMap((item) =>
              item.messages.map((message) => message.id),
            ),
          ) + 1,
        role: 'coach',
        text,
        fen,
      });
      this.save(workspace, 'assistance', {
        version: workspace.version,
        kind: 'question_feedback',
        scope: 'review',
        gameId: workspace.gameId,
        fen,
      });
      const response = { text, workspace: this.state() };
      this.store.remember(id, response);
      return response;
    });
  }
  mock(message: string): Record<string, unknown> {
    const text = message.toLowerCase();
    if (/example|show me|demonstrat|lesson/.test(text))
      return { text: fixture.example, action: 'demonstrate', demonstration: fixture.demonstration };
    if (/new game|fresh game|full game/.test(text))
      return {
        text: fixture.newGame,
        action: 'new_game',
        game: snapshot(new Chess()),
        activity: fixture.activities.observation,
      };
    if (/endgame|simpler position|set.*position/.test(text))
      return {
        text: fixture.position,
        action: 'set_position',
        game: snapshot(new Chess('8/7k/8/8/8/4K3/4P3/8 w - - 0 1')),
        activity: fixture.activities.endgame,
      };
    if (/focus on|training goal|change.*heading/.test(text))
      return {
        text: fixture.default,
        action: 'set_activity',
        activity: fixture.activities.calculation,
      };
    if (/quiet|less interrupt|keep thinking|observe/.test(text))
      return { text: fixture.quiet, action: 'quiet' };
    if (/resume|help again/.test(text)) return { text: fixture.resume, action: 'resume' };
    if (/hint|help|stuck/.test(text)) return { text: fixture.hint, action: 'hint' };
    if (/prefer|feedback|please.*coach|too much/.test(text))
      return { text: fixture.feedback, action: 'feedback' };
    return { text: fixture.default, action: 'question', fen: this.store.workspace().game.fen };
  }
  async tool(
    name: string,
    args: Record<string, unknown>,
    runRole = 'coach',
    context?: { fen: string; pgn: string; version: number; [key: string]: unknown },
    acceptedMeetingActionKey?: string,
  ) {
    if (
      runRole !== 'coach' &&
      ['propose_record_update', 'revise_prompt', 'propose_app_change'].includes(name)
    )
      return { staged: true, reviewRequired: true };
    const acceptedAction = meetingAction(this.store, acceptedMeetingActionKey, name, args);
    if (acceptedAction?.complete) return acceptedAction.result;
    let workspace = this.store.workspace();
    const mutations = [
      'start_activity',
      'set_activity',
      'set_position',
      'play_move',
      'set_opponent',
      'write_player_note',
      'record_intervention',
      'choose_next_activity',
    ];
    if (mutations.includes(name) && args.version !== workspace.version) throw new ConflictError();
    switch (name) {
      case 'choose_next_activity': {
        if (runRole !== 'coach')
          throw new Error('Only the coach chooses the next training activity.');
        const decision = {
          ...chooseNextActivity(workspace, this.store.read('plans/current.md'), args),
          planningId: typeof context?.planningId === 'string' ? context.planningId : undefined,
        };
        if (decision.kind === 'review')
          workspace.activity = {
            heading: 'Review the game',
            subtitle: 'Reflect on your intention and the reply you expected.',
          };
        this.store.put('next-activity:' + workspace.gameId, decision);
        this.save(workspace, 'next_activity', decision);
        return decision;
      }
      case 'record_verification_failure':
        this.store.event('coach_verification', { valid: false, ...args });
        return { recorded: true };
      case 'record_verified_assistance':
        if (context && context.version !== workspace.version) throw new ConflictError();
        this.store.event('assistance', {
          ...args,
          version: workspace.version,
          fen: context?.fen ?? workspace.game.fen,
          scope:
            runRole === 'question-feedback' || (context && context.fen !== workspace.game.fen)
              ? 'review'
              : 'live',
          gameId: workspace.gameId,
          quiet: workspace.quiet,
        });
        return { recorded: true };
      case 'inspect_board':
      case 'get_position':
      case 'get_context': {
        const referenced = runRole === 'question-feedback' ? context : undefined;
        if (referenced && referenced.version !== workspace.version) throw new ConflictError();
        if (args.version !== undefined && args.version !== workspace.version)
          throw new ConflictError();
        return referenced
          ? {
              ...this.coachContext(),
              ...referenced,
              boardFacts: boardFacts(referenced.fen, referenced.version),
            }
          : this.coachContext();
      }
      case 'set_activity':
      case 'start_activity': {
        if (context?.postGamePlanning && typeof args.fen === 'string') {
          const decision = this.store.get<NextActivity>('next-activity:' + String(context.gameId));
          if (
            !decision ||
            decision.version !== context.version ||
            decision.planningId !== context.planningId ||
            decision.planHash !==
              createHash('sha256').update(this.store.read('plans/current.md')).digest('hex')
          )
            throw new Error(
              'Choose the next activity against the current training plan before replacing the board.',
            );
          if (decision.kind === 'review')
            throw new Error('Keep the completed game available for the chosen review.');
          if (
            decision.kind === 'assessment-game' &&
            (args.fen !== new Chess().fen() || args.quiet !== true)
          )
            throw new Error(
              'An assessment game must start at the standard position with quiet=true.',
            );
        }
        if (
          (args.heading !== undefined &&
            (typeof args.heading !== 'string' || args.heading.length > 120)) ||
          (args.subtitle !== undefined &&
            (typeof args.subtitle !== 'string' || args.subtitle.length > 300))
        )
          throw new Error('Provide a short heading and subtitle.');
        if (typeof args.fen === 'string') {
          this.store.archiveGame(workspace, 'Interrupted for next training activity');
          replaceGame(workspace, args.fen);
        }
        workspace.activity = {
          heading: typeof args.heading === 'string' ? args.heading : workspace.activity.heading,
          subtitle: typeof args.subtitle === 'string' ? args.subtitle : workspace.activity.subtitle,
        };
        if (typeof args.quiet === 'boolean') workspace.quiet = args.quiet;
        if (args.playerSide === 'w' || args.playerSide === 'b')
          workspace.playerSide = args.playerSide;
        if (args.opponent === 'stockfish' || args.opponent === 'coach')
          workspace.opponent = args.opponent;
        this.save(workspace, 'activity', { ...args });
        return this.state();
      }
      case 'set_position': {
        if (typeof args.fen !== 'string') throw new Error('A legal FEN is required.');
        this.store.archiveGame(workspace, 'Interrupted for position setup');
        replaceGame(workspace, args.fen);
        this.save(workspace, 'position_setup', args);
        return this.state();
      }
      case 'play_move': {
        if (workspace.game.turn === workspace.playerSide)
          throw new Error('The player controls this side; the coach cannot play their move.');
        if (typeof args.san === 'string') args.notation = args.san;
        if (typeof args.notation !== 'string') throw new Error('A SAN move is required.');
        const board = loadGame(workspace.game.pgn);
        const move = playNotation(board, args.notation);
        workspace.game = snapshot(board);
        workspace.version++;
        this.save(workspace, 'coach_move', {
          gameId: workspace.gameId,
          san: move.san,
          version: workspace.version,
        });
        return this.state();
      }
      case 'analyze_position':
      case 'engine_analyze':
        if (!this.engine) throw new Error('Engine unavailable.');
        return this.engine.analyze(typeof args.fen === 'string' ? args.fen : workspace.game.fen);
      case 'set_assistance':
        workspace.quiet = args.quiet === true;
        this.save(workspace, 'assistance', args);
        return { quiet: workspace.quiet };
      case 'write_player_note':
      case 'write_note': {
        if (typeof args.text !== 'string' || args.text.length > 4000)
          throw new Error('Note too long.');
        const board = loadGame(workspace.game.pgn);
        board.setComment(args.text);
        workspace.game = snapshot(board);
        this.save(workspace, 'assistance', {
          text: args.text,
          version: workspace.version,
          reference: args.reference,
          rootReference: args.rootReference,
        });
        return { ok: true };
      }
      case 'read_history':
      case 'read_archive': {
        if (
          typeof args.path !== 'string' ||
          !/^(?:profile|plans|backlog|research|games|diary|events|sessions|meetings|prompts|releases|workspace)\/[\w ./:-]+\.(?:md|json|jsonl|pgn|txt)$/.test(
            args.path,
          )
        )
          throw new Error('Choose a coaching record path.');
        return this.store.readChunk(
          args.path,
          typeof args.offset === 'number' ? args.offset : 0,
          typeof args.limit === 'number' ? args.limit : 16000,
        );
      }
      case 'write_coaching_note': {
        if (
          typeof args.path !== 'string' ||
          !/^(?:profile|plans|diary|research|backlog)\/[\w/.-]+\.md$/.test(args.path) ||
          typeof args.text !== 'string' ||
          args.text.length > 100000
        )
          throw new Error('Only bounded coaching Markdown files may be edited.');
        this.store.write(args.path, args.text);
        this.store.event('archive_revision', {
          path: args.path,
          hash: createHash('sha256').update(args.text).digest('hex'),
        });
        return { ok: true };
      }
      case 'update_prompt': {
        if (
          typeof args.name !== 'string' ||
          !/^(coach|teaching|memory)$/.test(args.name) ||
          typeof args.text !== 'string' ||
          args.text.length > 20000 ||
          typeof args.reason !== 'string'
        )
          throw new Error('Invalid prompt revision.');
        const id = randomUUID();
        this.store.write(
          `prompts/history/${id}.json`,
          JSON.stringify({
            at: new Date().toISOString(),
            ...args,
            parent: this.store.get('prompt:' + args.name),
          }),
        );
        this.store.write(`prompts/current/${args.name}.md`, args.text);
        this.store.put('prompt:' + args.name, id);
        return { id };
      }
      case 'set_opponent': {
        if (args.side !== 'w' && args.side !== 'b') throw new Error('Invalid side.');
        if (args.controller === 'player') workspace.playerSide = args.side;
        else if (args.controller === 'stockfish' || args.controller === 'coach') {
          workspace.playerSide = args.side === 'w' ? 'b' : 'w';
          workspace.opponent = args.controller;
        } else throw new Error('Invalid opponent.');
        if (
          typeof args.skill === 'number' &&
          Number.isInteger(args.skill) &&
          args.skill >= 0 &&
          args.skill <= 20
        )
          workspace.skill = args.skill;
        this.save(workspace, 'opponent', args);
        return this.state();
      }
      case 'show_demonstration': {
        const steps = args.steps as { moves: string[]; title: string; note: string }[];
        if (!Array.isArray(steps) || !steps.length || steps.length > 24)
          throw new Error('Invalid demonstration.');
        for (const step of steps) {
          const board = new Chess(
            typeof args.initialFen === 'string' ? args.initialFen : undefined,
          );
          for (const san of step.moves) playNotation(board, san);
        }
        this.store.put('demonstration', args);
        this.store.event('assistance', { version: workspace.version, kind: 'demonstration' });
        return { ok: true };
      }
      case 'ask_question': {
        if (typeof args.fen === 'string') new Chess(args.fen);
        this.store.put('question', args);
        this.store.event('assistance', {
          version: workspace.version,
          kind: 'question',
          fen: args.fen,
          reference: args.reference,
          rootReference: args.rootReference,
        });
        return { ok: true };
      }
      case 'search_history': {
        const files = Array.isArray(args.paths)
          ? Object.fromEntries(
              args.paths.slice(0, 50).map((path) => {
                if (
                  typeof path !== 'string' ||
                  !/^(?:profile|plans|backlog|research|games|diary|events|sessions|meetings|prompts|releases|workspace)\/[\w ./:-]+\.(?:md|json|jsonl|pgn|txt)$/.test(
                    path,
                  )
                )
                  throw new Error('Invalid history path.');
                return [path, this.store.readChunk(path).text];
              }),
            )
          : this.store.files();
        if (typeof args.script === 'string')
          return searchArchive(
            args.script,
            Object.entries(files).map(([path, text]) => ({ path, text })),
          );
        const query = typeof args.query === 'string' ? args.query.toLowerCase() : '';
        return Object.entries(files)
          .filter(([path, text]) => (path + ' ' + text).toLowerCase().includes(query))
          .slice(0, 30)
          .map(([path, text]) => ({ path, text: text.slice(0, 10000) }));
      }
      case 'propose_record_update': {
        if (
          args.target === 'index' &&
          typeof args.gameId === 'string' &&
          typeof args.text === 'string' &&
          args.text.length <= 12000
        ) {
          const result = this.store.updateIndex(
            args.gameId,
            args.text,
            Array.isArray(args.themes)
              ? args.themes
                  .filter((value): value is string => typeof value === 'string')
                  .slice(0, 20)
              : [],
            Array.isArray(args.evidence)
              ? args.evidence
                  .filter((value): value is string => typeof value === 'string')
                  .slice(0, 30)
              : [],
          );
          acceptedAction?.finish(result);
          return result;
        }
        const paths: Record<string, string> = {
          profile: 'profile/current.md',
          diary: `diary/${acceptedAction?.day ?? new Date().toISOString().slice(0, 10)}.md`,
          plan: 'plans/current.md',
          index: 'games/coach-notes.md',
        };
        const path = paths[String(args.target)];
        if (!path || typeof args.text !== 'string' || args.text.length > 12000)
          throw new Error('Invalid record update.');
        const content = args.text + '\n\nEvidence: ' + JSON.stringify(args.evidence);
        if (acceptedAction) acceptedAction.append(path, content);
        else {
          const before = existsSync(this.store.path(path)) ? this.store.read(path) : '';
          this.store.write(path, before + '\n\n' + content);
        }
        return this.store.transaction(() => {
          this.store.event('record_revision', { path, ...args });
          const result = { ok: true };
          acceptedAction?.finish(result);
          return result;
        });
      }

      case 'revise_prompt': {
        if (
          typeof args.target !== 'string' ||
          !/^(coach|assistant-coach|consolidation|planner|retro)$/.test(args.target) ||
          typeof args.text !== 'string' ||
          args.text.length > 16000
        )
          throw new Error('Invalid prompt revision.');
        const current = this.store.get<string>('prompt:' + args.target) ?? 'default';
        if (args.parentVersion !== current)
          throw new Error('Prompt version changed; read current prompt before revising.');
        const id = acceptedAction?.id ?? randomUUID();
        const historyPath = `prompts/history/${id}.json`;
        if (!existsSync(this.store.path(historyPath)))
          this.store.write(
            historyPath,
            JSON.stringify({
              at: new Date().toISOString(),
              ...args,
              parent: current,
              previousText: this.prompts(args.target),
            }),
          );
        this.store.write(`prompts/current/${args.target}.md`, args.text);
        return this.store.transaction(() => {
          this.store.put('prompt:' + args.target, id);
          const result = { id };
          acceptedAction?.finish(result);
          return result;
        });
      }
      case 'propose_app_change': {
        const path = 'backlog/app-improvements.md';
        const content = JSON.stringify({
          id: acceptedAction?.id ?? randomUUID(),
          at: new Date().toISOString(),
          ...args,
        });
        if (acceptedAction) acceptedAction.append(path, content);
        else this.store.write(path, this.store.read(path) + '\n\n' + content);
        const result = { recorded: true };
        acceptedAction?.finish(result);
        return result;
      }

      case 'record_intervention':
        this.store.event('assistance', { ...args, version: workspace.version });
        return { recorded: true };
      case 'checkpoint':
        void this.backup.checkpoint();
        return { queued: true };
      default:
        throw new Error('Tool is not authorized.');
    }
  }
  undoPrompt(target: string) {
    if (!/^(coach|assistant-coach|consolidation|planner|retro)$/.test(target))
      throw new Error('Invalid prompt target.');
    const current = this.store.get<string>('prompt:' + target);
    if (!current) throw new Error('No prompt revision to undo.');
    const revision = JSON.parse(this.store.read(`prompts/history/${current}.json`)) as {
      previousText?: string;
      parent?: string;
    };
    const text =
      revision.previousText ??
      readFileSync(join(process.cwd(), 'config/prompts', target + '.md'), 'utf8');
    const id = randomUUID();
    this.store.write(
      `prompts/history/${id}.json`,
      JSON.stringify({
        at: new Date().toISOString(),
        target,
        text,
        parent: current,
        previousText: this.prompts(target),
        reason: 'Player requested undo',
        rollbackTarget: revision.parent ?? 'default',
      }),
    );
    this.store.write(`prompts/current/${target}.md`, text);
    this.store.put('prompt:' + target, id);
    return { id };
  }
  importPgn(text: string, source = 'PGN import') {
    if (redactCoachText(text) !== text)
      throw new Error('Possible credential in import; remove it before importing.');
    if (text.length > 2_000_000) throw new Error('PGN import limit is2MB.');
    const chunks = text.split(/(?=\[Event\s)/).filter((item) => item.trim());
    const results = [];
    for (const chunk of chunks) {
      try {
        const board = loadGame(chunk);
        const hash = createHash('sha256').update(board.pgn()).digest('hex');
        if (this.store.get('import:' + hash)) continue;
        const workspace = this.store.workspace();
        workspace.game = snapshot(board);
        workspace.gameId = randomUUID();
        const entry = this.store.archiveGame(workspace, 'Imported game', source, 'unknown');
        this.store.write(`games/originals/${entry.id}.pgn`, chunk);
        this.store.put('import:' + hash, entry.id);
        results.push(entry);
      } catch {
        const id = randomUUID();
        this.store.write(`games/quarantine/${id}.txt`, chunk);
        results.push({ error: 'Malformed PGN quarantined', id });
      }
    }
    return results;
  }
  prompts(name: string) {
    const path = `prompts/current/${name}.md`;
    if (existsSync(this.store.path(path))) return this.store.read(path);
    return readFileSync(join(process.cwd(), 'config/prompts', `${name}.md`), 'utf8');
  }
  sessionDirectory() {
    const path = this.store.path(
      'sessions/' + new Date().toISOString().slice(0, 7).replace('-', '/'),
    );
    mkdirSync(path, { recursive: true, mode: 0o700 });
    return path;
  }
}
export class ConflictError extends Error {
  constructor() {
    super('This position changed on another request. Refresh the board and try again.');
  }
}
