<script lang="ts">
  let {
    name,
    size = 20,
  }: {
    name:
      | 'arrow'
      | 'book'
      | 'close'
      | 'flip'
      | 'settings'
      | 'chevron'
      | 'previous'
      | 'first'
      | 'last'
      | 'spark'
      | 'play'
      | 'check';
    size?: number;
  } = $props();
  const paths = {
    arrow: 'M5 12h14m-6-6 6 6-6 6',
    book: 'M12 5v15M3 4c4-1 6 0 9 2 3-2 5-3 9-2v15c-4-1-6 0-9 2-3-2-5-3-9-2Z',
    close: 'm6 6 12 12M6 18 18 6',
    flip: 'M4 8h14l-4-4m6 12H6l4 4M4 8v5m16 3v-5',
    settings: 'M4 6h16M4 12h16M4 18h16M8 3v6m8 0v6M10 15v6',
    chevron: 'm9 5 7 7-7 7',
    previous: 'm15 5-7 7 7 7',
    first: 'M5 5v14m13-14-7 7 7 7',
    last: 'M19 5v14M6 5l7 7-7 7',
    spark: 'm12 3 2.6 6.4L21 12l-6.4 2.6L12 21l-2.6-6.4L3 12l6.4-2.6Z',
    play: 'm8 4 12 8-12 8Z',
    check: 'm5 12 4 4L19 6',
  };
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.7"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"><path d={paths[name]} /></svg
>
