<script lang="ts">
  import { onMount } from 'svelte';
  import Markdown from './Markdown.svelte';

  type Journal = {
    notes: string;
    profile: string;
    plan: string;
    entries: { day: string; text: string }[];
  };
  let journal = $state<Journal>();
  let loading = $state(true);
  let error = $state('');

  async function refresh() {
    loading = true;
    error = '';
    try {
      const response = await fetch('/api/journal');
      if (!response.ok) throw new Error('Journal unavailable');
      journal = await response.json();
    } catch {
      error = 'Unable to load the coaching journal. Try refreshing it.';
    } finally {
      loading = false;
    }
  }
  onMount(() => {
    void refresh();
  });
</script>

<article class="paper-section journal-entry" aria-busy={loading}>
  <div class="journal-heading">
    <h1>Coaching journal</h1>
    <button class="secondary-button" onclick={refresh} disabled={loading}>
      {loading ? 'Loading…' : 'Refresh journal'}
    </button>
  </div>
  <p>Your coach’s saved notes, current plan and daily reflections.</p>
  {#if error}<p role="alert">{error}</p>{/if}
  {#if journal}
    <section class="journal-section" aria-labelledby="coaching-notes-heading">
      <h2 id="coaching-notes-heading">Coaching notes</h2>
      {#if journal.notes.trim()}
        <Markdown text={journal.notes} />
      {:else}<p>No coaching notes saved yet.</p>{/if}
    </section>
    <section class="journal-section" aria-labelledby="profile-heading">
      <h2 id="profile-heading">Player profile</h2>
      <Markdown text={journal.profile} />
    </section>
    <section class="journal-section" aria-labelledby="plan-heading">
      <h2 id="plan-heading">Current plan</h2>
      <Markdown text={journal.plan} />
    </section>
    <section class="journal-section" aria-labelledby="diary-heading">
      <h2 id="diary-heading">Coaching diary</h2>
      {#each journal.entries as entry (entry.day)}
        <section class="diary-entry" aria-label={`Diary for ${entry.day}`}>
          <h3>
            <time datetime={entry.day}
              >{new Intl.DateTimeFormat('en-AU', {
                dateStyle: 'long',
                timeZone: 'Australia/Sydney',
              }).format(new Date(`${entry.day}T12:00:00+11:00`))}</time
            >
          </h3>
          <Markdown text={entry.text} />
        </section>
      {:else}
        <p>
          No diary entries yet. Daily reflections will appear here after a
          coaching meeting.
        </p>
      {/each}
    </section>
  {/if}
</article>
