/**
 * How a game's app is used: each screen shown and each named control pressed, batched to a URL
 * the caller gives (never built here) a POST at a time. ONE click listener on the document, not a
 * call in every component: a press is named by the nearest `data-testid` above it, lowercased with
 * its ids stripped (`seat-3` → `seat`), so a new control is counted without anyone remembering to;
 * a press on nothing named is not counted. A batch goes when it is full, on a timer, and when the
 * page hides (`sendBeacon`, which survives the tab closing). A failed send is dropped.
 */

export interface UsageEntry {
  kind: 'view' | 'click';
  screen: string;
  target?: string;
}

export interface UsageBatch {
  entries: UsageEntry[];
}

const NAME = /^[a-z0-9][a-z0-9_.:/-]*$/;

/** A `data-testid` as a usage name, or null when what is left is not a name. */
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
  /** Where a batch is posted; the caller's own `/api/...` path. */
  url: string;
  /** The screen a route hash names; the caller's own route parsing. */
  screenOf: (hash: string) => string;
  /** Entries per batch before an early flush; the caller's own schema limit. */
  batchMax: number;
  flushMs?: number;
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
export function startUsage(deps: UsageDeps): () => void {
  const { url, screenOf, batchMax, flushMs = 30_000 } = deps;
  const doc = deps.doc ?? document;
  const win = deps.win ?? window;
  const send = deps.send ?? beacon;
  let entries: UsageEntry[] = [];

  const flush = (): void => {
    if (entries.length === 0) return;
    const batch = { entries };
    entries = [];
    send(url, batch);
  };
  const push = (entry: UsageEntry): void => {
    entries.push(entry);
    if (entries.length >= batchMax) flush();
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
  const timer = win.setInterval(flush, flushMs);

  return () => {
    win.removeEventListener('hashchange', onHash);
    doc.removeEventListener('click', onClick, { capture: true });
    doc.removeEventListener('visibilitychange', onHide);
    win.removeEventListener('pagehide', flush);
    win.clearInterval(timer);
    flush();
  };
}
