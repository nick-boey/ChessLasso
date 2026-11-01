<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { Chess } from 'chess.js';
  import Board from './lib/Board.svelte';
  import Icon from './lib/Icon.svelte';
  import Markdown from './lib/Markdown.svelte';
  import {
    loadGame,
    practiceGame,
    validBudget,
    playNotation,
  } from './lib/chess';
  import type { Budget, GameState, Demonstration } from './lib/chess';
  import coach from '../config/mock-coach.json';

  type Page = 'today' | 'progress' | 'journal';
  type Modal = 'guide' | 'demo' | 'settings' | 'question' | null;
  type Message = {
    id: number;
    role: 'coach' | 'player';
    text: string;
    action?: string;
    fen?: string;
    demonstration?: Demonstration;
  };
  type MoveConversation = {
    id: number;
    fen: string;
    label: string;
    messages: Message[];
  };
  type Activity = typeof coach.activities.development;
  type PracticeEvent = {
    at: string;
    kind: string;
    detail: string;
    fen: string;
  };
  type CoachResponse = {
    text: string;
    action: string;
    game?: GameState;
    fen?: string;
    activity?: Activity;
  };

  let messageId = 0;
  let page = $state<Page>('today');
  let game = $state(practiceGame());
  let notation = $state('');
  let chat = $state('');

  let activity = $state<Activity>(coach.activities.development);
  let conversations = $state<MoveConversation[]>([]);
  let events = $state<PracticeEvent[]>([]);
  let busy = $state(false);
  let thinking = $state(false);
  let quiet = $state(false);
  let flipped = $state(false);
  let error = $state('');
  let chatError = $state('');
  let savedNotice = $state('');
  let ready = $state(false);
  let version = $state(0);
  let mode = $state<'mock' | 'live'>('mock');
  let playerSide = $state('w');
  let provider = $state('google');
  let model = $state('gemini-3.8-flash');
  let paused = $state(false);
  let hasControl = $state(true);
  let profile = $state('Baseline not assessed.');
  let plan = $state('Establish a varied baseline.');
  let diary = $state<string[]>([]);
  let totals = $state({
    moves: 0,
    assistance: 0,
    notationRejects: 0,
    games: 0,
  });
  let accessToken = $state('');
  let loginRequired = $state(false);
  let importText = $state('');
  let importUsername = $state('');
  let backupStatus = $state('No backup yet');
  let developmentStatus = $state('');
  let spent = $state(0);
  const clientId =
    sessionStorage.getItem('chesslasso-device') ?? crypto.randomUUID();
  sessionStorage.setItem('chesslasso-device', clientId);
  let presenceSequence = Date.now();
  let revision = 0;
  let pendingMove:
    { id: string; notation: string; version: number } | undefined;
  let apiConnected = $state(false);
  let visible = $state(true);
  let modal = $state<Modal>(null);
  let dialog = $state<HTMLDialogElement>();
  let moveInput = $state<HTMLInputElement>();
  let transcript = $state<HTMLDivElement>();
  let coachPanel = $state<HTMLElement>();
  let step = $state(0);
  let questionFen = $state(practiceGame().fen);
  let questionMessageId = $state<number | undefined>();
  let candidate = $state('');
  let candidateResult = $state('');
  let answering = $state(false);
  let budget = $state<Budget>({ mode: 'none', amount: 50 });
  let budgetDraft = $state<Budget>({ mode: 'none', amount: 50 });
  let settingsError = $state('');
  let demo = $state<Demonstration>(coach.demonstration);
  const demoFen = $derived.by(() => {
    const board = new Chess(
      (demo as typeof demo & { initialFen?: string }).initialFen,
    );
    for (const move of demo.steps[step].moves) board.move(move);
    return board.fen();
  });

  let lastShownMessage = '';
  $effect(() => {
    const conversation = conversations.at(-1);
    const key = `${conversation?.id}:${conversation?.messages.at(-1)?.id}`;
    if (ready && page === 'today' && transcript && key !== lastShownMessage) {
      lastShownMessage = key;
      void showLatestMessage();
    }
  });

  async function showLatestMessage() {
    await tick();
    const conversation = transcript?.querySelector<HTMLElement>(
      '.move-conversation:last-child',
    );
    const current =
      conversation?.querySelector<HTMLElement>('.message:last-child') ??
      conversation;
    const behavior = window.matchMedia('(prefers-reduced-motion: reduce)')
      .matches
      ? 'instant'
      : 'smooth';
    if (current && transcript)
      transcript.scrollTo({
        top:
          transcript.scrollTop +
          current.getBoundingClientRect().top -
          transcript.getBoundingClientRect().top -
          8,
        behavior,
      });
    if (window.innerWidth < 760)
      coachPanel?.scrollIntoView({ block: 'nearest', behavior });
  }

  function importSummary(results: unknown[]) {
    const failed = results.filter(
      (item) => item && typeof item === 'object' && 'error' in item,
    ).length;
    return `Imported ${results.length - failed} games.${failed ? ` ${failed} malformed records quarantined.` : ''}`;
  }

  function record(kind: string, detail: string) {
    events = [
      ...events.slice(-199),
      { at: new Date().toISOString(), kind, detail, fen: game.fen },
    ];
  }

  function restore(saved: any) {
    if (ready && saved.version < version) return;
    if (saved.playerSide !== playerSide) {
      playerSide = saved.playerSide;
      flipped = playerSide === 'b';
    }
    game = saved.game;
    version = saved.version;
    activity = saved.activity;
    quiet = saved.quiet;
    budget = saved.budget;
    mode = saved.mode;
    provider = saved.provider;
    model = saved.model;
    paused = saved.paused;
    conversations = saved.conversations;
    messageId = Math.max(
      0,
      ...conversations.flatMap((item) =>
        item.messages.map((message) => message.id),
      ),
    );
    profile = saved.stats.profile;
    plan = saved.stats.plan;
    totals = saved.stats;
    diary = saved.journal;
    spent = saved.usage?.amount ?? 0;
    if (saved.budget.mode === 'warning' && spent >= saved.budget.amount)
      savedNotice =
        'Monthly model spend estimate reached your warning threshold. Coaching and background work continue.';
    developmentStatus =
      saved.development?.reason ?? saved.development?.status ?? '';
    backupStatus = saved.backup.ok
      ? 'Private backup current'
      : saved.backup.pending
        ? 'Private backup pending'
        : 'No backup yet';
  }
  async function refresh() {
    try {
      const response = await fetch('/api/state');
      if (response.status === 401) {
        loginRequired = true;
        return;
      }
      if (!response.ok) throw new Error('Server unavailable');
      restore(await response.json());
      apiConnected = true;
      ready = true;
      loginRequired = false;
    } catch {
      apiConnected = false;
    }
  }
  async function presence() {
    visible = document.visibilityState === 'visible';
    try {
      const result = await api<{ control: boolean }>('/api/presence', {
        clientId,
        seq: ++presenceSequence,
        visible,
        focused: document.hasFocus(),
        version,
        monotonicMs: performance.now(),
      });
      hasControl = result.control;
    } catch {
      apiConnected = false;
    }
  }
  onMount(() => {
    void refresh().then(presence);
    const offline = () => {
      apiConnected = false;
    };
    document.addEventListener('visibilitychange', presence);
    window.addEventListener('offline', offline);
    window.addEventListener('online', refresh);
    window.addEventListener('focus', presence);
    window.addEventListener('blur', presence);
    const heartbeat = setInterval(() => {
      void presence();
    }, 15000);
    const stream = new EventSource('/api/stream');
    stream.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (
        (data.version !== version || data.revision !== revision) &&
        !busy &&
        !thinking
      ) {
        revision = data.revision;
        void refresh();
      }
    };
    return () => {
      clearInterval(heartbeat);
      stream.close();
      document.removeEventListener('visibilitychange', presence);
      window.removeEventListener('offline', offline);
      window.removeEventListener('online', refresh);
      window.removeEventListener('focus', presence);
      window.removeEventListener('blur', presence);
    };
  });

  $effect(() => {
    if (!dialog) return;
    if (modal && !dialog.open) dialog.showModal();
    else if (!modal && dialog.open) dialog.close();
  });

  async function api<T>(path: string, body: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      apiConnected = false;
      throw new Error(
        'The local server is disconnected. Your position is safe; reconnect and try again.',
      );
    }
    apiConnected = true;
    const result = await response.json();
    if (!response.ok) {
      if (result.workspace) restore(result.workspace);
      throw new Error(
        result.error ??
          'That request could not be completed. Please try again.',
      );
    }
    return result;
  }

  async function play(event: SubmitEvent) {
    event.preventDefault();
    if (!ready || busy || thinking || game.over || paused || !hasControl)
      return;
    error = '';
    // Validate before any request so a rejected entry never changes the board.
    try {
      playNotation(loadGame(game.pgn), notation);
    } catch (reason) {
      error = (reason as Error).message;
      record('notation_rejected', notation);
      void api('/api/event', { kind: 'notation_rejected', version }).catch(
        () => {},
      );
      modal = 'guide';
      return;
    }
    busy = true;
    if (!pendingMove || pendingMove.notation !== notation)
      pendingMove = { id: crypto.randomUUID(), notation, version };
    try {
      const result = await api<{
        game: GameState;
        played: string;
        note: string;
        workspace: any;
        demonstration?: typeof demo;
      }>('/api/move', {
        version: pendingMove.version,
        clientId,
        commandId: pendingMove.id,
        notation,
      });
      restore(result.workspace);
      pendingMove = undefined;
      if (result.demonstration) {
        demo = result.demonstration;
        step = 0;
        modal = 'demo';
      }
      record('move', result.played);
      notation = '';

      if (!quiet) record('coaching_note', result.note);
    } catch (reason) {
      error = (reason as Error).message;
    } finally {
      busy = false;
      await tick();
      moveInput?.focus({ preventScroll: true });
    }
  }

  async function sendMessage(text = chat) {
    if (!text.trim() || thinking || busy) return;
    chatError = '';
    const conversation = conversations.at(-1)!;
    conversation.messages.push({
      id: ++messageId,
      role: 'player',
      text: text.trim(),
    });
    chat = '';
    thinking = true;
    try {
      const result = await api<
        CoachResponse & { workspace: any; demonstration?: typeof demo }
      >('/api/coach', {
        message: text,
        fen: game.fen,
        version,
        commandId: crypto.randomUUID(),
      });
      record(result.action, result.text);
      if (result.action === 'demonstrate') {
        step = 0;
        modal = 'demo';
      }
      if (result.demonstration) demo = result.demonstration;
      restore(result.workspace);
    } catch (reason) {
      chatError = (reason as Error).message;
      chat = text;
    } finally {
      thinking = false;
      await tick();
    }
  }

  function settings() {
    budgetDraft = { ...budget };
    settingsError = '';
    modal = 'settings';
  }
  async function saveSettings(event: SubmitEvent) {
    event.preventDefault();
    if (!validBudget(budgetDraft)) {
      settingsError =
        'Enter a positive monthly amount, or keep the existing amount while disabling the cap.';
      return;
    }
    try {
      restore(
        await api('/api/settings', {
          budget: budgetDraft,
          mode,
          provider,
          model,
          paused,
        }),
      );
      modal = null;
      savedNotice = 'Preferences saved.';
    } catch (reason) {
      settingsError = (reason as Error).message;
    }
  }
  async function answerQuestion(event: SubmitEvent) {
    event.preventDefault();
    if (answering) return;
    answering = true;
    try {
      const board = new Chess(questionFen);
      const move = playNotation(board, candidate);
      const result = await api<{ text: string; workspace: any }>(
        '/api/answer',
        {
          fen: questionFen,
          notation: move.san,
          commandId: crypto.randomUUID(),
        },
      );
      candidateResult = result.text;
      restore(result.workspace);
      record('question_answer', move.san);
    } catch (reason) {
      candidateResult = (reason as Error).message;
    } finally {
      answering = false;
    }
  }
</script>

<svelte:head
  ><title
    >ChessLasso · {page === 'today'
      ? 'Your practice room'
      : page === 'progress'
        ? 'Your progress'
        : 'Coaching journal'}</title
  ></svelte:head
>

<header class="topbar">
  <a
    class="brand"
    href="#today"
    onclick={() => (page = 'today')}
    aria-label="ChessLasso home"
  >
    <svg
      class="brand-mark"
      width="35"
      height="35"
      viewBox="0 0 35 35"
      fill="none"
      aria-hidden="true"
      ><path
        d="M26 9C22 3 10 4 6 12c-5 10 7 17 16 12 8-5 4-15-3-13-6 1-6 10 1 13l9 6"
        stroke="currentColor"
        stroke-width="2.5"
        stroke-linecap="round"
      /></svg
    >
    ChessLasso
  </a>
  <nav aria-label="Main navigation">
    <button
      class:active={page === 'today'}
      aria-current={page === 'today' ? 'page' : undefined}
      onclick={() => (page = 'today')}>Board</button
    >
    <button
      class:active={page === 'progress'}
      aria-current={page === 'progress' ? 'page' : undefined}
      onclick={() => (page = 'progress')}>Progress</button
    >
    <button
      class:active={page === 'journal'}
      aria-current={page === 'journal' ? 'page' : undefined}
      onclick={() => (page = 'journal')}>Journal</button
    >
  </nav>
  <div class="header-actions">
    <span class="prototype-tag">{mode === 'mock' ? 'Mock' : 'Live'}</span
    ><button class="icon-button" aria-label="Open settings" onclick={settings}
      ><Icon name="settings" /></button
    ><span class="avatar player-avatar" aria-label="Your profile">Y</span>
  </div>
</header>

<main>
  {#if loginRequired}<form
      class="paper-section"
      onsubmit={async (event) => {
        event.preventDefault();
        try {
          await api('/api/login', { token: accessToken });
          window.location.reload();
        } catch (reason) {
          savedNotice = (reason as Error).message;
        }
      }}
    >
      <label for="access-token">Access token</label><input
        id="access-token"
        type="password"
        bind:value={accessToken}
      /><button class="primary-button">Sign in</button>
    </form>{/if}
  {#if page === 'today'}
    {#if savedNotice}<p class="notice" role="status">{savedNotice}</p>{/if}
    {#if !hasControl}<button
        class="secondary-button"
        onclick={async () => {
          await api('/api/control', { clientId });
          hasControl = true;
        }}>Take move control on this device</button
      >{/if}
    <div class="practice-layout">
      <section class="board-workspace" aria-label="Your game">
        <div class="activity-heading" aria-live="polite">
          <div>
            <h1>{activity.heading}</h1>
            <p>{activity.subtitle}</p>
          </div>
          <button
            class="icon-button"
            aria-label="Flip board"
            title="Flip board"
            onclick={() => (flipped = !flipped)}
            ><Icon name="flip" size={18} /></button
          >
        </div>
        <div class="board-frame">
          <Board
            fen={game.fen}
            {flipped}
            lastMove={game.lastMove}
            label={`Main chessboard. ${game.status}. Enter moves in the field below.`}
          />
        </div>
        <form class="move-form" onsubmit={play}>
          <label class="sr-only" for="move">Your move</label>
          <input
            id="move"
            bind:this={moveInput}
            bind:value={notation}
            placeholder="Nc3"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            aria-invalid={!!error}
            aria-describedby={error ? 'move-error' : undefined}
            disabled={!hasControl ||
              !ready ||
              busy ||
              thinking ||
              game.over ||
              paused}
          />
          <button
            class="play-move"
            type="submit"
            aria-label={busy ? 'Playing move' : 'Play move'}
            title="Play move"
            disabled={!hasControl ||
              !ready ||
              busy ||
              thinking ||
              game.over ||
              paused ||
              !notation.trim()}><Icon name="play" size={18} /></button
          >
          <button
            type="button"
            class="icon-button"
            aria-label="Notation guide"
            title="Notation guide"
            onclick={() => (modal = 'guide')}
            ><Icon name="book" size={18} /></button
          >
          {#if error}<p id="move-error" class="error-text" role="alert">
              {error}
            </p>{/if}
        </form>
      </section>

      <aside
        class="coach-panel"
        aria-label="Chat with your coach"
        bind:this={coachPanel}
      >
        <div class="coach-header">
          <div>
            <h2>Coach</h2>
            {#if quiet}<span class="coach-state">Observing</span>{/if}
          </div>
          <span class="availability-dot" aria-label="Coach available"></span>
        </div>
        <div
          class="transcript"
          bind:this={transcript}
          aria-live="polite"
          aria-label="Conversation"
        >
          {#each conversations as conversation (conversation.id)}
            <section
              class="move-conversation"
              data-conversation={conversation.id}
              aria-label={`Position after ${conversation.label}`}
            >
              <div class="move-context">
                <span>{conversation.label}</span
                >{#if !conversation.messages.length}<span>Observing</span>{/if}
              </div>
              {#each conversation.messages as message (message.id)}
                <div
                  class:from-player={message.role === 'player'}
                  class="message"
                >
                  <span class="message-author"
                    >{message.role === 'coach' ? 'Coach' : 'You'}</span
                  >
                  <Markdown text={message.text} />
                  {#if message.action === 'demonstrate'}<button
                      class="example-link"
                      onclick={() => {
                        if (message.demonstration) demo = message.demonstration;
                        step = 0;
                        modal = 'demo';
                      }}
                      ><Icon name="play" size={16} /> Reopen the example <Icon
                        name="chevron"
                        size={15}
                      /></button
                    >{/if}
                  {#if message.action === 'question' && message.fen}<button
                      class="example-link"
                      onclick={() => {
                        questionFen = message.fen!;
                        questionMessageId = message.id;
                        candidate = '';
                        candidateResult = '';
                        modal = 'question';
                      }}
                      ><Icon name="book" size={16} /> Open question board <Icon
                        name="chevron"
                        size={15}
                      /></button
                    >{/if}
                </div>
              {/each}
            </section>
          {/each}
          {#if thinking}<p class="thinking" role="status">
              Preparing response…
            </p>{/if}
        </div>
        <div class="chat-controls">
          <div class="quick-actions">
            <button
              disabled={thinking || busy}
              onclick={() => sendMessage('Give me a hint')}>Hint</button
            ><button
              disabled={thinking || busy}
              onclick={() =>
                sendMessage(
                  quiet
                    ? 'Resume coaching and help again'
                    : 'Let me keep thinking quietly',
                )}>{quiet ? 'Resume coaching' : 'Observe'}</button
            ><button
              disabled={thinking || busy}
              onclick={() => sendMessage('Show me an example')}>Example</button
            >
          </div>
          <form
            class="chat-form"
            onsubmit={(event) => {
              event.preventDefault();
              void sendMessage();
            }}
          >
            <label class="sr-only" for="chat">Message your coach</label
            ><textarea
              id="chat"
              bind:value={chat}
              placeholder="Message coach…"
              rows="2"
              maxlength="4000"
              onkeydown={(event) => {
                if (
                  event.key === 'Enter' &&
                  !event.shiftKey &&
                  !event.isComposing
                ) {
                  event.preventDefault();
                  void sendMessage();
                }
              }}></textarea><button
              class="send-button"
              aria-label="Send message"
              disabled={thinking || busy || !chat.trim()}
              ><Icon name="arrow" size={20} /></button
            >
          </form>
          {#if chatError}<p class="error-text" role="alert">{chatError}</p>{/if}
          <p class="mock-label">
            {mode === 'mock' ? 'Deterministic mock' : `${provider} · ${model}`} ·
            {paused ? 'Paused' : 'Training'}
          </p>
        </div>
      </aside>
    </div>
    <div class="practice-footer">
      <span
        ><span class:disconnected={!apiConnected} class="connection-dot"
        ></span>{apiConnected
          ? 'Local server connected'
          : 'Local server disconnected'} <span class="footer-divider">/</span>
        {visible ? 'Tab visible' : 'Tab hidden'}</span
      >
    </div>
  {:else if page === 'progress'}
    <div class="reading-layout">
      <section class="paper-section">
        <h2>Baseline</h2>
        <p>{profile}</p>
        <div class="profile-facts">
          <div>
            <span>Long-term reference</span><strong>FIDE standard</strong>
          </div>
          <div>
            <span>Imported results</span><strong
              >Separate Chess.com pools</strong
            >
          </div>
          <div>
            <span>Training commitment</span><strong>Not set</strong>
          </div>
        </div>
        <h3>Recorded training</h3>
        <div class="session-facts">
          <span><strong>{totals.moves}</strong> moves submitted</span><span
            ><strong>{totals.assistance}</strong> assistance events</span
          >
        </div>
        <p class="small-copy">
          Counts are observations, not evidence of improvement. Tab visibility
          is not proof of attention.
        </p>
      </section>
      <aside class="paper-section">
        <h2>Import games</h2>
        <form
          onsubmit={async (event) => {
            event.preventDefault();
            try {
              const result = await api<{ results: unknown[] }>(
                '/api/import/pgn',
                { pgn: importText },
              );
              savedNotice = importSummary(result.results);
              await refresh();
            } catch (reason) {
              savedNotice = (reason as Error).message;
            }
          }}
        >
          <label for="pgn-import">PGN</label><textarea
            id="pgn-import"
            bind:value={importText}
            rows="4"></textarea><button
            class="secondary-button"
            disabled={!importText.trim()}>Import PGN</button
          >
        </form>
        <form
          onsubmit={async (event) => {
            event.preventDefault();
            try {
              const result = await api<{ results: unknown[] }>(
                '/api/import/chesscom',
                { username: importUsername },
              );
              savedNotice = importSummary(result.results);
              await refresh();
            } catch (reason) {
              savedNotice = (reason as Error).message;
            }
          }}
        >
          <label for="chesscom-user">Chess.com username</label><input
            id="chesscom-user"
            bind:value={importUsername}
          /><button class="secondary-button" disabled={!importUsername.trim()}
            >Import archive</button
          >
        </form>
        <h2>Skills</h2>
        <ul class="skill-list">
          <li>
            <strong>Board vision & tactics</strong><span
              >Notice threats before choosing a plan.</span
            >
          </li>
          <li>
            <strong>Calculation & decisions</strong><span
              >Compare candidates and opponent replies.</span
            >
          </li>
          <li>
            <strong>Endgames & strategy</strong><span
              >Understand what each piece needs.</span
            >
          </li>
          <li>
            <strong>Notation & reflection</strong><span
              >Record your ideas and learn from them.</span
            >
          </li>
        </ul>
        <button class="secondary-button" onclick={() => (page = 'today')}
          >Back to your board <Icon name="arrow" size={17} /></button
        >
      </aside>
    </div>
  {:else}
    <div class="reading-layout">
      <article class="paper-section journal-entry">
        <div class="journal-meta">
          <span>Coaching diary</span><span>04:00 · Australia/Sydney</span>
        </div>
        {#if diary.length}{#each diary as entry}<p style="white-space:pre-wrap">
              {entry}
            </p>{/each}{:else}<p>
            No completed daily meeting yet. The first meeting will review
            recorded training after the next cutoff.
          </p>{/if}
        <h3>Current plan</h3>
        <p style="white-space:pre-wrap">{plan}</p>
      </article>
      <aside class="paper-section">
        <h2>Session events</h2>
        <p>
          {backupStatus}. Coaching records and annotated PGNs are stored in the
          private archive.
        </p>
        <ol class="event-list">
          {#each events
            .slice()
            .reverse()
            .filter((event) => !['heartbeat', 'focus', 'visibility'].includes(event.kind))
            .slice(0, 10) as event (event.at + event.kind)}<li>
              <time
                >{new Intl.DateTimeFormat('en-AU', {
                  hour: '2-digit',
                  minute: '2-digit',
                }).format(new Date(event.at))}</time
              ><span>{event.kind.replaceAll('_', ' ')}</span>
            </li>{/each}
        </ol>
      </aside>
    </div>
  {/if}
</main>

<dialog
  bind:this={dialog}
  onclose={() => {
    modal = null;
    if (page === 'today') moveInput?.focus();
  }}
  oncancel={() => (modal = null)}
  class:wide-dialog={modal === 'demo' || modal === 'question'}
>
  <div class="dialog-heading">
    <h2>
      {modal === 'guide'
        ? 'Notation guide'
        : modal === 'settings'
          ? 'Settings'
          : modal === 'question'
            ? 'Position question'
            : demo.title}
    </h2>
    <button
      class="icon-button"
      aria-label="Close dialog"
      onclick={() => (modal = null)}><Icon name="close" /></button
    >
  </div>
  {#if modal === 'guide'}
    {#if error}<p class="validation-message" role="alert">{error}</p>{:else}<p>
        Say which piece is moving and where it is going. Pawn moves only need
        the destination.
      </p>{/if}
    <dl class="notation-guide">
      <div>
        <dt><code>e4</code></dt>
        <dd>Move a pawn to e4.</dd>
      </div>
      <div>
        <dt><code>Nf3</code></dt>
        <dd>Move a knight to f3. N means knight.</dd>
      </div>
      <div>
        <dt><code>Bxe6</code></dt>
        <dd>A bishop captures on e6. x means capture.</dd>
      </div>
      <div>
        <dt><code>Nbd2</code></dt>
        <dd>The knight on the b-file moves to d2.</dd>
      </div>
      <div>
        <dt><code>O-O</code> / <code>O-O-O</code></dt>
        <dd>Castle kingside / queenside. Zeros work too.</dd>
      </div>
      <div>
        <dt><code>e8=Q</code></dt>
        <dd>A pawn reaches e8 and promotes to a queen.</dd>
      </div>
      <div>
        <dt><code>+</code> / <code>#</code></dt>
        <dd>
          Check / checkmate. Optional when entering; shown in the move record.
        </dd>
      </div>
    </dl>
    <p class="small-copy">
      Piece letters: K king · Q queen · R rook · B bishop · N knight. Files a–h
      run across the board; ranks 1–8 run up it. Your entry stays in the field
      when a move is rejected.
    </p>
    <button class="primary-button" onclick={() => (modal = null)}
      >Back to my move <Icon name="arrow" size={17} /></button
    >
  {:else if modal === 'demo'}
    <p class="dialog-intro">Example board. Your game is unchanged.</p>
    <div class="demo-board">
      <Board
        fen={demoFen}
        label={`Demonstration board. Step ${step + 1}: ${demo.steps[step].title}`}
      />
    </div>
    <div class="demo-step">
      <span>Step {step + 1} of {demo.steps.length}</span>
      <h3>{demo.steps[step].title}</h3>
      <p>{demo.steps[step].note}</p>
    </div>
    <div class="demo-navigation">
      <button
        class="secondary-button"
        disabled={step === 0}
        onclick={() => step--}>Previous</button
      >
      <div class="step-dots" aria-label="Demonstration steps">
        {#each demo.steps as item, i (item.title)}<button
            aria-label={`Go to step ${i + 1}`}
            aria-current={step === i ? 'step' : undefined}
            class:current={step === i}
            onclick={() => (step = i)}
          ></button>{/each}
      </div>
      <button
        class="primary-button"
        onclick={() => {
          if (step < demo.steps.length - 1) step++;
          else modal = null;
        }}
        >{step === demo.steps.length - 1 ? 'Back to my game' : 'Next step'}<Icon
          name="arrow"
          size={16}
        /></button
      >
    </div>
  {:else if modal === 'question'}
    <p class="dialog-intro">Try a candidate move. Your game is unchanged.</p>
    <div class="demo-board">
      <Board
        fen={questionFen}
        label="Coach question board, a snapshot of your position"
      />
    </div>
    <form class="question-form" onsubmit={answerQuestion}>
      <label for="candidate">Your candidate move</label>
      <div class="move-input-row">
        <input
          id="candidate"
          bind:value={candidate}
          placeholder="e.g. Nc3"
          autocapitalize="off"
          autocomplete="off"
          spellcheck="false"
        /><button
          class="primary-button"
          disabled={!candidate.trim() || answering}>Check candidate</button
        >
      </div>
      <p role="status">{candidateResult}</p>
    </form>
  {:else if modal === 'settings'}
    <p>Preferences apply to this local coach.</p>
    <form class="settings-form" onsubmit={saveSettings}>
      <label for="budget-mode">Monthly model budget</label><select
        id="budget-mode"
        bind:value={budgetDraft.mode}
        ><option value="none">No cap</option><option value="warning"
          >Warn at a threshold</option
        ><option value="hard">Stop paid calls at a hard cap</option></select
      ><label for="budget-amount">Amount in USD</label><input
        id="budget-amount"
        type="number"
        min="0.01"
        step="0.01"
        bind:value={budgetDraft.amount}
        disabled={budgetDraft.mode === 'none'}
      />
      <p class="small-copy">
        {budgetDraft.mode === 'hard'
          ? 'A hard cap stops new paid calls across coaching and background improvements. It can be raised or removed at any time.'
          : budgetDraft.mode === 'warning'
            ? 'Warn without stopping coaching or background improvements.'
            : 'No spending limit. Background improvements remain enabled.'}
      </p>
      <p class="small-copy">
        Estimated model spend this UTC month: ${spent.toFixed(4)}. Pending
        reservations are included; provider invoices may differ.
      </p>
      <label for="runtime-mode">Coach</label><select
        id="runtime-mode"
        bind:value={mode}
        ><option value="mock">Deterministic mock</option><option value="live"
          >Live model + Stockfish</option
        ></select
      >
      <label for="provider">Provider</label><select
        id="provider"
        bind:value={provider}
        ><option value="google">Google Gemini</option><option value="fireworks"
          >Fireworks</option
        ></select
      >
      <label for="model">Model ID</label><input
        id="model"
        bind:value={model}
        maxlength="180"
      />
      <label
        ><input type="checkbox" bind:checked={paused} /> Pause practice</label
      >
      <p class="small-copy">
        Daily meeting: 04:00 Australia/Sydney. Exposure records show visible,
        focused, connected time; they do not measure attention. {backupStatus}.
      </p>
      <p class="small-copy">Application improvements: {developmentStatus}</p>
      {#if settingsError}<p class="error-text" role="alert">
          {settingsError}
        </p>{/if}<button class="primary-button"
        >Save preferences <Icon name="check" size={17} /></button
      >
    </form>
  {/if}
</dialog>
