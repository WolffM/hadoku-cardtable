/**
 * Every browser context `openFriend` opened and nobody closed. Almost no spec
 * closes its contexts, so by the 40th test one Chromium carried ~26 dead
 * pages, each with a live socket.io client reconnecting to every NEW stack
 * on the same port (the `match-gone` floods in a stack's first second) and a
 * React board re-rendering on every frame. The three CI-only reds of
 * 2026-10-03 (R13/T1, Q7, R4/T8) were each the test carrying the most of
 * them: Forge raised its first priority prompt a second after the seat's
 * socket handover and the server never answered it. `startPlayStack` closes
 * them all before a new stack boots, so a test only ever shares the browser
 * with its own pages.
 */
import type { BrowserContext } from '@playwright/test';

const open = new Set<BrowserContext>();

export function registerFriendContext(context: BrowserContext): void {
  open.add(context);
  context.on('close', () => open.delete(context));
}

/** Close every context still open from earlier tests. Returns how many it closed. */
export async function closeStaleFriends(): Promise<number> {
  const stale = [...open];
  open.clear();
  await Promise.all(stale.map((c) => c.close().catch(() => undefined)));
  return stale.length;
}
