<script lang="ts">
  import { onMount } from 'svelte';
  import { Chess } from 'chess.js';
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
  const descriptionId = 'board-' + crypto.randomUUID();
  const description = $derived(
    new Chess(fen)
      .board()
      .flatMap((rank) =>
        rank.flatMap((piece) =>
          piece
            ? [
                `${piece.color === 'w' ? 'White' : 'Black'} ${{ p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' }[piece.type]} on ${piece.square}`,
              ]
            : [],
        ),
      )
      .join('; '),
  );
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
  aria-describedby={descriptionId}
  bind:this={element}
></div>

<p id={descriptionId} class="sr-only">{description}</p>
