<script lang="ts">
  import { onMount } from 'svelte';
  import { Chessground } from '@lichess-org/chessground';
  import type { Api } from '@lichess-org/chessground/api';
  import type { Key } from '@lichess-org/chessground/types';

  let {
    fen,
    flipped = false,
    lastMove = null,
    label = 'Chess position',
  }: {
    fen: string;
    flipped?: boolean;
    lastMove?: [string, string] | null;
    label?: string;
  } = $props();
  let element: HTMLDivElement;
  let board = $state.raw<Api>();
  onMount(() => {
    board = Chessground(element, {
      fen,
      viewOnly: true,
      coordinates: true,
      orientation: flipped ? 'black' : 'white',
      animation: {
        enabled: !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
        duration: 180,
      },
      draggable: { enabled: false },
      selectable: { enabled: false },
      drawable: { enabled: false, visible: true },
      lastMove: (lastMove ?? undefined) as Key[] | undefined,
    });
    return () => board?.destroy();
  });
  $effect(() => {
    board?.set({
      fen,
      orientation: flipped ? 'black' : 'white',
      lastMove: (lastMove ?? undefined) as Key[] | undefined,
    });
  });
</script>

<div
  class="chess-board"
  role="img"
  aria-label={label}
  bind:this={element}
></div>
