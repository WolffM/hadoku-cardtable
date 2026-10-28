/*
 * This browser tab's identity, sent with every match join (`MatchRequest.tabId`).
 *
 * The server holds one controlling socket per seat, and a second socket on a held seat
 * spectates. A socket cut without a close reaching the server (match m-ca7bad04b715,
 * 2026-10-28) stays the controller until its ping times out, so the SAME tab's reconnect was
 * told the seat "is being played in another window" for 21 s. With a tab id the server can
 * tell the same tab coming back from a second one, and hands the seat straight back.
 *
 * One id per page load, held in memory: every socket this page opens — every reconnect —
 * carries the same id. A reload keeps it, read back from sessionStorage, so a player who
 * reloads a stalled board is not locked out by their own dead socket either. Only a reload:
 * a duplicated tab starts with a copy of the original's sessionStorage, and two live tabs
 * sharing an id would take the seat from each other. A duplicate, a restored tab, a new tab
 * and a link all navigate as something other than `reload`, so they mint their own.
 */

const STORAGE_KEY = 'cardtable:tab-id';
const SHAPE = /^[A-Za-z0-9_-]{8,64}$/;

/** How this page was loaded: `reload`, or anything else (`navigate`, `back_forward`, `prerender`, unknown). */
function loadedBy(): string {
  const entry = typeof performance === 'undefined' ? undefined : performance.getEntriesByType?.('navigation')[0];
  return entry !== undefined && 'type' in entry ? String((entry as PerformanceNavigationTiming).type) : 'unknown';
}

/** 128 random bits as hex: `getRandomValues`, not `randomUUID`, which an insecure origin (a LAN dev server) lacks. */
function mint(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}

function storage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch (err) {
    // A sandboxed frame throws on the accessor: the id then lives for this page only.
    console.warn('[tab-id] no sessionStorage', err);
    return null;
  }
}

/** The tab id for a page loaded as `navigation`, given the stored one; exported for its test. */
export function chooseTabId(navigation: string, stored: string | null, fresh: () => string = mint): string {
  return navigation === 'reload' && stored !== null && SHAPE.test(stored) ? stored : fresh();
}

let current: string | null = null;

/** This page's tab id: decided on first use, the same for every socket the page opens after. */
export function pageTabId(): string {
  if (current !== null) return current;
  const store = storage();
  let stored: string | null = null;
  try {
    stored = store?.getItem(STORAGE_KEY) ?? null;
  } catch (err) {
    console.warn('[tab-id] could not read the stored id', err);
  }
  const id = chooseTabId(loadedBy(), stored);
  current = id;
  try {
    store?.setItem(STORAGE_KEY, id);
  } catch (err) {
    console.warn('[tab-id] could not store the id', err);
  }
  return id;
}
