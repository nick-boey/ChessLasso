<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { Chess } from 'chess.js';
  import Board from './lib/Board.svelte';
  import Icon from './lib/Icon.svelte';
  import {
    loadGame,
    practiceGame,
    snapshot,
    validBudget,
    playNotation,
  } from './lib/chess';
  import type { Budget, GameState } from './lib/chess';
  import coach from '../config/mock-coach.json';

  type Page = 'today' | 'progress' | 'journal';
  type Modal = 'guide' | 'demo' | 'settings' | 'question' | null;
  type Message = {
    id: number;
    role: 'coach' | 'player';
    text: string;
    action?: string;
    fen?: string;
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
  let conversationId = 0;
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
  let apiConnected = $state(false);
  let visible = $state(true);
  let modal = $state<Modal>(null);
  let dialog = $state<HTMLDialogElement>();
  let moveInput = $state<HTMLInputElement>();
  let transcript = $state<HTMLDivElement>();
  let coachPanel = $state<HTMLElement>();
  let step = $state(0);
  let questionFen = $state(practiceGame().fen);
  let candidate = $state('');
  let candidateResult = $state('');
  let budget = $state<Budget>({ mode: 'none', amount: 50 });
  let budgetDraft = $state<Budget>({ mode: 'none', amount: 50 });
  let settingsError = $state('');
  const demo = coach.demonstration;
  const demoFen = $derived.by(() => {
    const board = new Chess();
    for (const move of demo.steps[step].moves) board.move(move);
    return board.fen();
  });
  const assists = $derived(
    events.filter((event) =>
      ['hint', 'demonstrate', 'question'].includes(event.kind),
    ).length,
  );

  function beginConversation(text?: string, response?: CoachResponse) {
    const moves = game.moves;
    const label = moves.length
      ? `${Math.ceil(moves.length / 2)}. ${moves.length % 2 ? moves.at(-1) : moves.slice(-2).join(' ')}`
      : 'Position';
    conversations.push({
      id: ++conversationId,
      fen: game.fen,
      label,
      messages: text
        ? [
            {
              id: ++messageId,
              role: 'coach',
              text,
              action: response?.action,
              fen: response?.fen,
            },
          ]
        : [],
    });
  }

  async function showCurrentConversation() {
    await tick();
    const current = transcript?.querySelector<HTMLElement>(
      '.move-conversation:last-child',
    );
    const behavior = window.matchMedia('(prefers-reduced-motion: reduce)')
      .matches
      ? 'instant'
      : 'smooth';
    if (current && transcript)
      transcript.scrollTo({ top: current.offsetTop - 8, behavior });
    if (window.innerWidth < 760)
      coachPanel?.scrollIntoView({ block: 'nearest', behavior });
  }

  function record(kind: string, detail: string) {
    events = [
      ...events.slice(-199),
      { at: new Date().toISOString(), kind, detail, fen: game.fen },
    ];
  }

  onMount(() => {
    try {
      const raw = localStorage.getItem('chesslasso-prototype-v1');
      if (raw) {
        const saved = JSON.parse(raw);
        if (typeof saved.pgn === 'string') game = snapshot(loadGame(saved.pgn));
        if (validBudget(saved.budget)) budget = saved.budget;
        if (typeof saved.quiet === 'boolean') quiet = saved.quiet;
        if (
          typeof saved.activity?.heading === 'string' &&
          typeof saved.activity?.subtitle === 'string'
        )
          activity = saved.activity;
      }
    } catch {
      savedNotice =
        'The saved demo could not be restored. A fresh practice position is ready.';
    }
    beginConversation(coach.welcome);
    ready = true;
    visible = document.visibilityState === 'visible';
    record('opened', 'Prototype opened; presence is not proof of attention.');
    const presence = () => {
      visible = document.visibilityState === 'visible';
      record('visibility', visible ? 'visible' : 'hidden');
    };
    const offline = () => {
      apiConnected = false;
      record('connection', 'Browser offline');
    };
    const health = async () => {
      try {
        const response = await fetch('/api/health');
        apiConnected = response.ok;
      } catch {
        apiConnected = false;
      }
    };
    const focus = () =>
      record('focus', document.hasFocus() ? 'focused' : 'blurred');
    document.addEventListener('visibilitychange', presence);
    window.addEventListener('offline', offline);
    window.addEventListener('online', health);
    window.addEventListener('focus', focus);
    window.addEventListener('blur', focus);
    void health();
    const heartbeat = setInterval(() => {
      record('heartbeat', visible ? 'visible' : 'hidden');
      void health();
    }, 15000);
    return () => {
      clearInterval(heartbeat);
      document.removeEventListener('visibilitychange', presence);
      window.removeEventListener('offline', offline);
      window.removeEventListener('online', health);
      window.removeEventListener('focus', focus);
      window.removeEventListener('blur', focus);
    };
  });

  $effect(() => {
    if (!ready) return;
    try {
      localStorage.setItem(
        'chesslasso-prototype-v1',
        JSON.stringify({ pgn: game.pgn, budget, quiet, activity }),
      );
    } catch {
      savedNotice =
        'Browser storage is unavailable. This position will not survive a reload.';
    }
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
    if (!response.ok)
      throw new Error(
        result.error ??
          'That request could not be completed. Please try again.',
      );
    return result;
  }

  async function play(event: SubmitEvent) {
    event.preventDefault();
    if (busy || thinking || game.over) return;
    error = '';
    // Validate before any request so a rejected entry never changes the board.
    try {
      playNotation(loadGame(game.pgn), notation);
    } catch (reason) {
      error = (reason as Error).message;
      record('notation_rejected', notation);
      modal = 'guide';
      return;
    }
    busy = true;
    try {
      const result = await api<{
        game: GameState;
        played: string;
        note: string;
      }>('/api/move', { pgn: game.pgn, notation });
      game = result.game;
      record('move', result.played);
      notation = '';
      beginConversation(quiet ? undefined : result.note);
      if (!quiet) record('coaching_note', result.note);
      await showCurrentConversation();
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
      const result = await api<CoachResponse>('/api/coach', {
        message: text,
        fen: game.fen,
      });
      record(result.action, result.text);
      if (result.action === 'demonstrate') {
        step = 0;
        modal = 'demo';
      }
      if (result.activity) activity = result.activity;
      if (result.game) {
        game = result.game;
        notation = '';
        error = '';
        page = 'today';
        beginConversation(result.text, result);
      } else {
        conversation.messages.push({
          id: ++messageId,
          role: 'coach',
          text: result.text,
          action: result.action,
          fen: result.fen,
        });
      }
      if (result.action === 'quiet' || result.action === 'new_game')
        quiet = true;
      if (['hint', 'resume'].includes(result.action)) quiet = false;
    } catch (reason) {
      chatError = (reason as Error).message;
      chat = text;
    } finally {
      thinking = false;
      await tick();
      await showCurrentConversation();
    }
  }

  function settings() {
    budgetDraft = { ...budget };
    settingsError = '';
    modal = 'settings';
  }
  function saveSettings(event: SubmitEvent) {
    event.preventDefault();
    if (!validBudget(budgetDraft)) {
      settingsError =
        'Enter a positive monthly amount, or keep the existing amount while disabling the cap.';
      return;
    }
    budget = { ...budgetDraft };
    record('budget_changed', budget.mode);
    modal = null;
    savedNotice =
      'Budget preference saved in this browser. This prototype makes no paid model calls.';
  }
  function answerQuestion(event: SubmitEvent) {
    event.preventDefault();
    try {
      const board = new Chess(questionFen);
      const move = playNotation(board, candidate);
      candidateResult = `${move.san} is a legal candidate. Your main game has not changed.`;
      record('question_answer', move.san);
    } catch (reason) {
      candidateResult = (reason as Error).message;
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
    <span class="prototype-tag">Interactive prototype</span><button
      class="icon-button"
      aria-label="Open settings"
      onclick={settings}><Icon name="settings" /></button
    ><span class="avatar player-avatar" aria-label="Your profile">Y</span>
  </div>
</header>

<main>
  {#if page === 'today'}
    {#if savedNotice}<p class="notice" role="status">{savedNotice}</p>{/if}
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
            disabled={busy || thinking || game.over}
          />
          <button
            class="play-move"
            type="submit"
            aria-label={busy ? 'Playing move' : 'Play move'}
            title="Play move"
            disabled={busy || thinking || game.over || !notation.trim()}
            ><Icon name="play" size={18} /></button
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
          <span class="availability-dot" aria-label="Scripted coach available"
          ></span>
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
                  <p>{message.text}</p>
                  {#if message.action === 'demonstrate'}<button
                      class="example-link"
                      onclick={() => {
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
          <p class="mock-label">Scripted coach · no AI model connected</p>
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
        <p>Not assessed. Sample profile; no training history yet.</p>
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
        <h3>This browser session</h3>
        <div class="session-facts">
          <span
            ><strong
              >{events.filter((event) => event.kind === 'move').length}</strong
            > moves submitted</span
          ><span><strong>{assists}</strong> assistance events</span>
        </div>
        <p class="small-copy">
          Counts are observations, not evidence of improvement. Tab visibility
          is not proof of attention.
        </p>
      </section>
      <aside class="paper-section">
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
          <span>Example coaching meeting</span><span
            >04:00 · Australia/Sydney</span
          >
        </div>
        <h3>Observation</h3>
        <p>
          A player develops a piece after a hint. That shows the hint was
          usable. It does not yet show independent recognition.
        </p>
        <h3>Assistant coach’s challenge</h3>
        <blockquote>
          Could the learner find the same idea in an unfamiliar position? One
          assisted success is not a trend.
        </blockquote>
        <h3>Next experiment</h3>
        <p>
          Return to development in a different, unlabelled position after a
          delay. Ask for a candidate and an expected reply before providing
          help.
        </p>
        <h3>Application improvement</h3>
        <p>
          Keep notation mistakes separate from tactical errors, and preserve the
          player’s original attempt.
        </p>
        <p class="small-copy">
          Production meetings will link to PGNs, exact moves, prompt versions,
          and the independent critique transcript.
        </p>
      </article>
      <aside class="paper-section">
        <h2>Session events</h2>
        <p>
          Local session events. These reset on reload; the production archive is
          specified in the PRD.
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
        /><button class="primary-button" disabled={!candidate.trim()}
          >Check notation</button
        >
      </div>
      <p role="status">{candidateResult}</p>
    </form>
  {:else if modal === 'settings'}
    <p>Preferences are saved in this browser.</p>
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
          ? 'In production, a hard cap stops new paid calls across coaching and background improvements. It can be raised or removed at any time.'
          : budgetDraft.mode === 'warning'
            ? 'Warn without stopping coaching or background improvements.'
            : 'No spending limit. Background improvements remain enabled.'}
      </p>
      <div class="setting-summary">
        <strong>Daily coaching meeting</strong><span
          >04:00 · Australia/Sydney</span
        ><strong>Prototype model</strong><span
          >Deterministic mock · $0 in API calls</span
        >
      </div>
      <p class="small-copy">
        Budget enforcement and scheduled meetings are production features. This
        prototype saves your budget preference only.
      </p>
      {#if settingsError}<p class="error-text" role="alert">
          {settingsError}
        </p>{/if}<button class="primary-button"
        >Save preferences <Icon name="check" size={17} /></button
      >
    </form>
  {/if}
</dialog>
