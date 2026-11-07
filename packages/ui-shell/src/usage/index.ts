/**
 * How the app is used: each screen shown and each named control pressed, batched to the server's
 * `POST /api/usage`, which only counts them (`apps/server/src/http/usage.ts`).
 *
 * ONE listener on the document, not a call in every component: a click is named by the nearest
 * `data-testid` above what was pressed — the names the e2e suite already gives every control — so a
 * new button is counted without anyone remembering to. Ids are stripped from the name and nothing
 * else is read: never a label, a card, or anything a player typed. A press on nothing named is not
 * counted.
 *
 * A batch goes when it is full, every `FLUSH_MS`, and when the page is hidden (`sendBeacon`, which
 * survives the tab closing). A failed send is dropped: usage counts are not worth a retry queue.
 */
import { USAGE_BATCH_MAX, USAGE_PATH, type UsageBatch } from '@hadoku/shared';

import { apiUrl } from './http.ts';
import { parseRoute } from './screens/route.ts';

type Entry = UsageBatch['entries'][number];

export const FLUSH_MS = 30_000;
const NAME = /^[a-z0-9][a-z0-9_.:/-]*$/;

/** The screen a hash shows, by its route's kind; a room's table is its own screen. */
export function screenOf(hash: string): string {
  const route = parseRoute(hash);
  return route.kind === 'room' && route.tableId !== undefined ? 'room/table' : route.kind;
}

/**
 * A `data-testid` as a usage name: lowercased, with the ids in it stripped (`seat-3` and
 * `room-card-r-1a2b3c4d` count as `seat` and `room-card`), or null when what is left is not a name.
 */
export function targetName(testid: string): string | null {
  const name = testid
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/g, '')
    .replace(/(^|[-_:/.])[a-z]?-?[0-9a-f]*[0-9][0-9a-f]*(?=$|[-_:/.])/g, '$1')
    .replace(/[-_:/.]{2,}/g, '-')
    .replace(/^[-_:/.]+|[-_:/.]+$/g, '')
    .slice(0, 64);
  return NAME.test(name) ? name : null;
}

export interface UsageDeps {
  doc?: Document;
  win?: Window;
  send?: (url: string, batch: UsageBatch) => void;
}

function beacon(url: string, batch: UsageBatch): void {
  const body = new Blob([JSON.stringify(batch)], { type: 'application/json' });
  if (navigator.sendBeacon?.(url, body) === true) return;
  void fetch(url, {
    method: 'POST',
    body,
    keepalive: true,
    credentials: 'same-origin',
  }).catch(() => undefined);
}

/** Start counting. Returns the stop, which flushes what is left. */
export function startUsage(deps: UsageDeps = {}): () => void {
  const doc = deps.doc ?? document;
  const win = deps.win ?? window;
  const send = deps.send ?? beacon;
  const url = apiUrl(USAGE_PATH);
  let entries: Entry[] = [];

  const flush = (): void => {
    if (entries.length === 0) return;
    const batch = { entries };
    entries = [];
    send(url, batch);
  };
  const push = (entry: Entry): void => {
    entries.push(entry);
    if (entries.length >= USAGE_BATCH_MAX) flush();
  };

  let screen = screenOf(win.location.hash);
  push({ kind: 'view', screen });
  const onHash = (): void => {
    const next = screenOf(win.location.hash);
    if (next === screen) return;
    screen = next;
    push({ kind: 'view', screen });
  };
  const onClick = (event: Event): void => {
    const el = event.target instanceof Element ? event.target.closest('[data-testid]') : null;
    const testid = el?.getAttribute('data-testid');
    const target = testid ? targetName(testid) : null;
    if (target !== null) push({ kind: 'click', screen, target });
  };
  const onHide = (): void => {
    if (doc.visibilityState === 'hidden') flush();
  };

  win.addEventListener('hashchange', onHash);
  doc.addEventListener('click', onClick, { capture: true, passive: true });
  doc.addEventListener('visibilitychange', onHide);
  win.addEventListener('pagehide', flush);
  const timer = win.setInterval(flush, FLUSH_MS);

  return () => {
    win.removeEventListener('hashchange', onHash);
    doc.removeEventListener('click', onClick, { capture: true });
    doc.removeEventListener('visibilitychange', onHide);
    win.removeEventListener('pagehide', flush);
    win.clearInterval(timer);
    flush();
  };
}
