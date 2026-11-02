import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { Store } from './store.js';

interface ActionReceipt {
  fingerprint: string;
  complete?: boolean;
  result?: unknown;
}

/** Private host-only identity for the three accepted meeting mutation tools. */
export function meetingAction(
  store: Store,
  key: string | undefined,
  name: string,
  args: Record<string, unknown>,
) {
  if (key === undefined) return undefined;
  const match = /^meeting-action:(\d{4}-\d{2}-\d{2}):\d+$/.exec(key);
  if (!match || !['propose_record_update', 'revise_prompt', 'propose_app_change'].includes(name))
    throw new Error('Invalid accepted meeting action identity.');
  const fingerprint = createHash('sha256').update(JSON.stringify({ name, args })).digest('hex');
  const receiptKey = 'reviewed:' + key;
  const existing = store.get<ActionReceipt>(receiptKey);
  if (existing && existing.fingerprint !== fingerprint)
    throw new Error('Accepted meeting action changed during retry.');
  if (!existing) store.put(receiptKey, { fingerprint });
  const id = 'meeting-' + createHash('sha256').update(key).digest('hex');
  return {
    id,
    day: match[1],
    complete: existing?.complete === true,
    result: existing?.result,
    /** The append identity lives in the same atomic file replacement as its content. */
    append(path: string, content: string) {
      const marker = `<!-- accepted-meeting-action:${id} -->`;
      const before = existsSync(store.path(path)) ? store.read(path) : '';
      if (!before.includes(marker)) store.write(path, before + '\n\n' + content + '\n' + marker);
    },
    /** Call in the same SQLite transaction as corresponding prompt versions or audit events. */
    finish(result: unknown) {
      store.put(receiptKey, { fingerprint, complete: true, result });
      return result;
    },
  };
}
