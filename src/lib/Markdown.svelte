<script lang="ts">
  import DOMPurify from 'dompurify';
  import { marked } from 'marked';

  let { text }: { text: string } = $props();
  const html = $derived(
    DOMPurify.sanitize(marked.parse(text, { async: false }), {
      ALLOWED_TAGS: [
        'p',
        'br',
        'strong',
        'em',
        'del',
        'blockquote',
        'ul',
        'ol',
        'li',
        'h1',
        'h2',
        'h3',
        'h4',
        'h5',
        'h6',
        'pre',
        'code',
        'hr',
        'a',
        'table',
        'thead',
        'tbody',
        'tr',
        'th',
        'td',
      ],
      ALLOWED_ATTR: ['href', 'title', 'start'],
      ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[/?#])/i,
      ALLOW_ARIA_ATTR: false,
      ALLOW_DATA_ATTR: false,
    }),
  );
</script>

<div class="message-content">{@html html}</div>
