/*
 * This browser tab's identity, sent with every room claim (`room/session.ts`), match join
 * (`MatchRequest.tabId`) and pod join.
 *
 * The server holds one live tab per player per room (`packages/game-server/src/room/session.ts`): a reload or
 * reconnect of the SAME tab is the same holder and never asks, and a socket cut without a close
 * reaching the server (match m-ca7bad04b715, 2026-10-28) is replaced by its own tab's reconnect at
 * once. A second tab is another holder, and is asked before it takes over.
 *
 * The mechanism (one id per page load, kept across a reload in sessionStorage, a duplicated tab
 * probed and given its own) is `@wolffm/rooms-protocol`'s `createTabIdentity`, the same one
 * watchparty's tabs use. This binds the app's storage key (`<appId>:tab-id`).
 */

import { createTabIdentity } from '@wolffm/rooms-protocol';
import { appId } from '@hadoku/ui-shell/app-id';

const tab = createTabIdentity({ storageKey: () => `${appId()}:tab-id` });

/** This tab's id once no other live tab claims it: what a player's claim and joins carry. */
export const settledTabId: () => Promise<string> = tab.settledTabId;

/** Run `use` with this tab's settled id: now when it is known, else once the probe has answered. */
export const withSettledTabId: (use: (id: string) => void) => void = tab.withSettledTabId;
