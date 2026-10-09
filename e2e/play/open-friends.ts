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
import { renameSync } from 'node:fs';

import type { BrowserContext, Page } from '@playwright/test';

const open = new Set<BrowserContext>();

/**
 * Video metadata for a context, present only while `CARDTABLE_E2E_VIDEO=1`
 * (the operator's own acceptance gate: *"a recorded video of the thing
 * working must be shown to me before it passes"*) — `openFriend`'s own doc
 * has the rest.
 */
interface FriendVideo {
  page: Page;
  /** `<RUN_DIR>/videos/<spec slug>` — already created. */
  dir: string;
  /** The file name within it, without the extension (the friend's own name — "alice", "bob"). */
  name: string;
}
const videos = new Map<BrowserContext, FriendVideo>();

export function registerFriendContext(context: BrowserContext, video?: FriendVideo): void {
  open.add(context);
  if (video !== undefined) videos.set(context, video);
  context.on('close', () => {
    open.delete(context);
    videos.delete(context);
  });
}

/**
 * Close one context, and — only when it was recording — name its videos: the
 * page that showed the MATCH becomes `<name>.webm`, every other page of the
 * context `<name>-<n>.webm`. The first cut kept only the page `openFriend`
 * created, which sits on `about:blank` (a white frame) while Forge starts and
 * is not always the page a spec plays the match in — the operator's review
 * page got twelve seconds of white and the real footage stayed behind under
 * Playwright's own `page@…` name (2026-10-09, "there's still a ton of just
 * white screen").
 */
async function closeOneFriend(context: BrowserContext): Promise<void> {
  const video = videos.get(context);
  // The pages' urls are only readable while the context is open; the video
  // files only land once it is closed.
  const pages = video === undefined ? [] : context.pages().map((p) => ({ page: p, url: p.url() }));
  await context.close().catch(() => undefined);
  if (video === undefined) return;
  const recorded: { path: string; url: string; registered: boolean }[] = [];
  for (const { page, url } of pages) {
    const path = await page.video()?.path().catch(() => undefined);
    if (path !== undefined) recorded.push({ path, url, registered: page === video.page });
  }
  if (recorded.length === 0) return;
  const isMatch = (url: string) => /\/match\//.test(url);
  const main = recorded.find((r) => isMatch(r.url)) ?? recorded.find((r) => r.registered) ?? recorded[0]!;
  let n = 0;
  for (const r of recorded) {
    const target = r === main ? `${video.dir}/${video.name}.webm` : `${video.dir}/${video.name}-${++n}.webm`;
    try {
      renameSync(r.path, target);
    } catch (err) {
      // A rename failing is not a reason to fail the test over — but it is said, not swallowed.
      console.warn(`[video] ${video.name}: could not rename ${r.path}: ${String(err)}`);
    }
  }
}

/** Close every context still open from earlier tests. Returns how many it closed. */
export async function closeStaleFriends(): Promise<number> {
  const stale = [...open];
  open.clear();
  await Promise.all(stale.map((c) => closeOneFriend(c)));
  return stale.length;
}
