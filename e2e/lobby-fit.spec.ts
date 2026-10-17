/*
 * The page never grows with the lobby's content — the operator, 2026-10-10:
 * "lobby screen should not have scrolling. definetly not the chat rooms", and
 * then, of a long deck list and a long room list: "scrolling is fine just not
 * for the whole page, the watchparty interface should not be affected by page
 * length". And of the deck verdict: "i dislike that verdict it's useless, just
 * get rid of it".
 *
 * Two real browsers in a constructed room on the real built server, on Free
 * pick — the whole library on offer — with both decks chosen and alice ready;
 * and the front page with more rooms open than one column holds. At 1280×800,
 * 1366×768 and 1024×700, on both screens:
 *
 *  - the document does not scroll;
 *  - the chrome is exactly the window's height, and watchparty's room frame —
 *    the chat aside with it — ends at the window's bottom edge;
 *  - on the front page and in a room the only box that may scroll is the
 *    screen itself, inside that frame (the operator: "please revert the layout
 *    change, it was better before");
 *  - the deck grid never scrolls inside itself — the operator, 2026-10-16, of
 *    the grid as its own scroller: "the grid has a scrollbar now, yea we gotta
 *    fix that" (it had been one since 2026-10-10, when it was one tile row
 *    high at 1024x700); it is drawn at its full height in the room's screen;
 *  - every deck tile keeps its full 190px size, however many decks there are;
 *  - Ready, both seat rows and the first room row lie inside the window;
 *  - no verdict is drawn.
 *
 * `[lobby-fit]` lines are the evidence: every scrolling box with its
 * scrollHeight against its clientHeight, and the boxes that frame the page.
 */
import { expect, test, type Page } from '@playwright/test';

import { makeTitled, resizeWindow } from './play/board.ts';
import { openFriend, type Friend } from './play/browser.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { openCreateRoom } from './play/rooms.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const PREFIX = '/cardtable';
/** More than one column of rows holds at 1024×700. */
const ROOMS_OPEN = 16;
/** A deck tile's own size (`screens.css` `.deckpick`). */
const TILE_PX = 190;
/** The only box that may scroll on each screen: the screen itself. */
const FRONT_MAY_SCROLL = ['lobby'];
const ROOM_MAY_SCROLL = ['constructed'];
const SIZES = [
  { width: 1280, height: 800 },
  { width: 1366, height: 768 },
  { width: 1024, height: 700 },
] as const;

interface Fit {
  size: string;
  failures: string[];
  evidence: string[];
}

/** The chat aside renders for a signed-in viewer: answer whoami the way the edge does for a friend. */
async function signIn(f: Friend): Promise<void> {
  await f.page.route('**/session/whoami', (route) =>
    route.fulfill({ json: { valid: true, userId: `e2e-${f.name}`, userType: 'friend', name: f.name } }),
  );
}

async function measure(page: Page, mustShow: string, mayScroll: string[], tilePx: number): Promise<Fit> {
  return page.evaluate(
    ({ sel, allowed, tile }) => {
      const SCROLLS = new Set(['auto', 'scroll']);
      const name = (e: Element): string => {
        const id = e.getAttribute('data-testid');
        const cls = typeof e.className === 'string' ? e.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
        return `${e.tagName.toLowerCase()}${id ? `[${id}]` : ''}${cls ? `.${cls}` : ''}`;
      };
      const failures: string[] = [];
      const evidence: string[] = [];
      const doc = document.scrollingElement as HTMLElement;
      if (doc.scrollHeight > innerHeight + 1 || doc.scrollWidth > innerWidth + 1) {
        failures.push(`the document scrolls: ${doc.scrollWidth}x${doc.scrollHeight} > window ${innerWidth}x${innerHeight}`);
      }
      const chrome = document.querySelector('.cardtable-chrome');
      const chromeH = chrome === null ? -1 : Math.round(chrome.getBoundingClientRect().height);
      evidence.push(`chrome ${chromeH}h`);
      if (Math.abs(chromeH - innerHeight) > 1) failures.push(`the chrome is ${chromeH}px tall, the window ${innerHeight}px`);
      for (const s of ['.wp-room-chrome-frame', '.wp-room-chrome']) {
        const el = document.querySelector(s);
        if (el === null) continue;
        const r = el.getBoundingClientRect();
        evidence.push(`${s} ${Math.round(r.width)}x${Math.round(r.height)}@${Math.round(r.top)} bottom ${Math.round(r.bottom)}`);
        if (Math.abs(r.bottom - innerHeight) > 1) failures.push(`${s} ends at ${Math.round(r.bottom)}, not the window's bottom ${innerHeight}`);
      }
      for (const el of Array.from(document.body.querySelectorAll('*'))) {
        const e = el as HTMLElement;
        const cs = getComputedStyle(e);
        const tall = e.clientHeight > 0 && e.scrollHeight > e.clientHeight + 1 && SCROLLS.has(cs.overflowY);
        const wide = e.clientWidth > 0 && e.scrollWidth > e.clientWidth + 1 && SCROLLS.has(cs.overflowX);
        if (!tall && !wide) continue;
        const line = `${name(e)}: scroll ${e.scrollWidth}x${e.scrollHeight} > client ${e.clientWidth}x${e.clientHeight}`;
        if (allowed.includes(e.getAttribute('data-testid') ?? '') && !wide) evidence.push(`scrolls inside itself ${line}`);
        else failures.push(`scrolls: ${line}`);
      }
      const tiles = Array.from(document.querySelectorAll('[data-testid="deck-mine"] [data-deck-id]'));
      const small = tiles.filter((t) => {
        const r = t.getBoundingClientRect();
        return Math.abs(r.height - tile) > 1 || r.width < tile - 1;
      });
      if (tiles.length > 0) {
        const r = tiles[0]!.getBoundingClientRect();
        evidence.push(`${tiles.length} deck tiles, the first ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
      if (small.length > 0) {
        const r = small[0]!.getBoundingClientRect();
        failures.push(`${small.length} of ${tiles.length} deck tiles are not full size (${Math.round(r.width)}x${Math.round(r.height)}, want ${tile}px)`);
      }
      for (const el of Array.from(document.querySelectorAll(sel))) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0 || r.left < -1 || r.top < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1) {
          failures.push(`outside the window: ${name(el)} at ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`);
        }
      }
      if (document.querySelector('[data-testid="verdict-mine"]') !== null) failures.push('a deck verdict is drawn');
      return { size: `${innerWidth}x${innerHeight}`, failures, evidence };
    },
    { sel: mustShow, allowed: mayScroll, tile: tilePx },
  );
}

async function fitsAt(page: Page, who: string, where: string, mustShow: string, mayScroll: string[], failures: string[]): Promise<void> {
  for (const size of SIZES) {
    await resizeWindow(page, size);
    const fit = await measure(page, mustShow, mayScroll, TILE_PX);
    console.log(`[lobby-fit] ${where} ${who} ${fit.size}: ${fit.evidence.join(' | ')}`);
    for (const f of fit.failures) console.log(`[lobby-fit] ${where} ${who} ${fit.size} FAIL ${f}`);
    failures.push(...fit.failures.map((f) => `${where} ${who} ${fit.size}: ${f}`));
  }
}

test(titled('the page and the chat stay the window’s height on the front page and in a Free pick room; only each screen scrolls, never the deck grid, tiles at full size'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice');
    const bob = await openFriend(browser, 'bob');
    await signIn(alice);
    await signIn(bob);
    const failures: string[] = [];

    for (let i = 1; i <= ROOMS_OPEN; i++) {
      const made = await bob.context.request.post(`${stack.origin}${PREFIX}/api/rooms`, {
        data: { name: `open table ${i}`, gameType: i % 2 === 0 ? 'draft' : 'constructed-1v1' },
      });
      expect(made.status()).toBe(201);
    }
    await alice.page.goto(`${stack.origin}${PREFIX}/`);
    await expect(alice.page.getByTestId('room-create-open')).toBeVisible();
    await expect(alice.page.getByTestId('room-row')).toHaveCount(ROOMS_OPEN);
    await fitsAt(alice.page, 'alice', 'front', '[data-testid="room-list"] > :first-child', FRONT_MAY_SCROLL, failures);

    await openCreateRoom(alice.page);
    await alice.page.getByTestId('room-create-name').fill(`lobby fit ${Date.now()}`);
    await alice.page.getByTestId('room-create-type').selectOption('constructed-1v1');
    await alice.page.getByTestId('room-create-submit').click();
    await alice.page.waitForURL(/#\/room\/r-[0-9a-f]{12}$/, { timeout: 30_000 });
    await bob.page.goto(alice.page.url());
    await expect(bob.page.getByTestId('constructed')).toBeVisible({ timeout: 30_000 });
    // Each takes a deck of the room's own era, then the leader moves the room to
    // Free pick: the whole library on offer, the longest list a room can draw.
    for (const [f, n] of [
      [alice, 0],
      [bob, 1],
    ] as const) {
      await expect(f.page.getByTestId('deck-mine')).toBeEnabled();
      await f.page.getByTestId('deck-mine').locator('[data-deck-id]').nth(n).click();
      await expect(f.page.getByTestId('ready-toggle')).toBeEnabled();
    }
    await alice.page.getByTestId('free-pick').click();
    await expect(alice.page.getByTestId('free-pick')).toHaveAttribute('aria-pressed', 'true');
    await expect(bob.page.getByTestId('format-fixed')).toHaveText('Free pick');
    for (const f of [alice, bob]) {
      await expect.poll(() => f.page.getByTestId('deck-mine').locator('[data-deck-id]').count(), { timeout: 30_000 }).toBeGreaterThan(100);
      // The held deck is re-sent under the new pool and is legal on Free pick.
      await expect(f.page.getByTestId('ready-toggle')).toBeEnabled({ timeout: 30_000 });
    }
    await alice.page.getByTestId('ready-toggle').click();
    await expect(alice.page.getByTestId('ready-toggle')).toHaveAttribute('aria-pressed', 'true');
    await expect(bob.page.getByTestId('room-seat-1-empty')).toHaveCount(0);
    const decks = await alice.page.getByTestId('deck-mine').locator('[data-deck-id]').count();
    console.log(`[lobby-fit] room on Free pick: ${decks} decks on offer; chat aside drawn: ${await alice.page.locator('.wp-room-chrome').count()}`);

    const mustShow = '[data-testid="ready-toggle"], [data-testid="room-players"]';
    await fitsAt(alice.page, 'alice', 'room', mustShow, ROOM_MAY_SCROLL, failures);
    await fitsAt(bob.page, 'bob', 'room', mustShow, ROOM_MAY_SCROLL, failures);

    expect(failures, 'the page is the window’s height, only each screen scrolls and never the deck grid, every tile is full size, and no verdict').toEqual([]);
  } finally {
    await stack.stop();
  }
});
