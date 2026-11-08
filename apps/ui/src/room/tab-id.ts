/*
 * This browser tab's identity, sent with every room claim (`room/session.ts`), match join
 * (`MatchRequest.tabId`) and pod join.
 *
 * The server holds one live tab per player per room (`apps/server/src/room/session.ts`): a reload or
 * reconnect of the SAME tab is the same holder and never asks, and a socket cut without a close
 * reaching the server (match m-ca7bad04b715, 2026-10-28) is replaced by its own tab's reconnect at
 * once. A second tab is another holder, and is asked before it takes over.
 *
 * One id per page load, held in memory: every socket this page opens — every reconnect — carries the
 * same id. A reload keeps it, read back from sessionStorage. Only a reload: a duplicate, a restored
 * tab, a new tab and a link navigate as something other than `reload`, so they mint their own. And
 * because a duplicated tab starts with a COPY of the original's sessionStorage, the stored id is
 * also probed (`@wolffm/rooms-protocol`'s `settleTabId`): if another live tab answers that it uses
 * it, this one mints a fresh one. Every id the page sends is the settled one: an id handed out
 * before the probe answered could be the duplicate's, and a join carrying it would hold the room
 * for the other tab while this one's claim was asked about itself. `settledTabId` waits for it, and
 * `withSettledTabId` hands it over at once when it is known (every page but a reload's first 150 ms).
 */

import { answerTabProbes, browserTabChannel, isTabId, mintTabId, settleTabId, type TabIdChannel } from '@wolffm/rooms-protocol';

const STORAGE_KEY = 'cardtable:tab-id';

/** How this page was loaded: `reload`, or anything else (`navigate`, `back_forward`, `prerender`, unknown). */
function loadedBy(): string {
  const entry = typeof performance === 'undefined' ? undefined : performance.getEntriesByType?.('navigation')[0];
  return entry !== undefined && 'type' in entry ? String((entry as PerformanceNavigationTiming).type) : 'unknown';
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

/** The stored id this page may keep, given how it was loaded: only a reload's; exported for its test. */
export function storedCandidate(navigation: string, stored: string | null): string | null {
  return navigation === 'reload' && isTabId(stored) ? stored : null;
}

let provisional: string | null = null;
let settled: string | null = null;
let settling: Promise<string> | null = null;

function begin(): Promise<string> {
  if (settling !== null) return settling;
  const store = storage();
  let stored: string | null = null;
  try {
    stored = store?.getItem(STORAGE_KEY) ?? null;
  } catch (err) {
    console.warn('[tab-id] could not read the stored id', err);
  }
  const candidate = storedCandidate(loadedBy(), stored);
  provisional = candidate ?? mintTabId();
  let channel: TabIdChannel | null = null;
  try {
    channel = browserTabChannel();
  } catch (err) {
    console.warn('[tab-id] no BroadcastChannel', err);
  }
  if (channel !== null) answerTabProbes(channel, () => settled ?? provisional);
  // A freshly minted id is nobody else's: only a kept one is probed.
  settling = settleTabId({ candidate: provisional, channel: candidate === null ? null : channel }).then((id) => {
    settled = id;
    try {
      store?.setItem(STORAGE_KEY, id);
    } catch (err) {
      console.warn('[tab-id] could not store the id', err);
    }
    return id;
  });
  return settling;
}

/** This tab's id once no other live tab claims it: what a player's claim and joins carry. */
export function settledTabId(): Promise<string> {
  return begin();
}

/** Run `use` with this tab's settled id: now when it is known, else once the probe has answered. */
export function withSettledTabId(use: (id: string) => void): void {
  const pending = begin();
  if (settled !== null) use(settled);
  else void pending.then(use);
}
