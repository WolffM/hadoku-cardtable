/*
 * The lobby never scrolls — the operator, 2026-10-10: "lobby screen should not
 * have scrolling. definetly not the chat rooms".
 *
 * Two real browsers in a constructed room on the real built server: alice makes
 * the room, bob opens it, both choose a deck, alice readies. That is the room at
 * its fullest — both seat rows, both verdicts, the era's whole deck list, the
 * chat aside beside it. At 1280×800, 1366×768 and 1024×700 nothing on either
 * screen may scroll: not the document, not the room frame, not a panel, not the
 * chat. Every deck and the Ready button lie inside the window, so a fit that
 * merely clipped them would fail too. The front page's room list is measured
 * the same way.
 *
 * `[lobby-fit]` lines are the evidence: every overflowing box with its
 * scrollHeight against its clientHeight.
 */
import { expect, test, type Page } from '@playwright/test';

import { makeTitled } from './play/board.ts';
import { openFriend, type Friend } from './play/browser.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const PREFIX = '/cardtable';
const ROOMS_OPEN = 6;
const SIZES = [
  { width: 1280, height: 800 },
  { width: 1366, height: 768 },
  { width: 1024, height: 700 },
] as const;

interface Fit {
  size: string;
  scrollers: string[];
  outside: string[];
  boxes: string[];
}

/** The chat aside renders for a signed-in viewer: answer whoami the way the edge does for a friend. */
async function signIn(f: Friend): Promise<void> {
  await f.page.route('**/session/whoami', (route) =>
    route.fulfill({ json: { valid: true, userId: `e2e-${f.name}`, userType: 'friend', name: f.name } }),
  );
}

/** Every box that scrolls, and every one of `mustShow` that lies outside the window. */
async function measure(page: Page, mustShow: string): Promise<Fit> {
  return page.evaluate((sel) => {
    const SCROLLS = new Set(['auto', 'scroll']);
    const name = (e: Element): string => {
      const id = e.getAttribute('data-testid');
      const cls = typeof e.className === 'string' ? e.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
      return `${e.tagName.toLowerCase()}${id ? `[${id}]` : ''}${cls ? `.${cls}` : ''}`;
    };
    const scrollers: string[] = [];
    const doc = document.scrollingElement as HTMLElement;
    if (doc.scrollHeight > innerHeight + 1 || doc.scrollWidth > innerWidth + 1) {
      scrollers.push(`document: scroll ${doc.scrollWidth}x${doc.scrollHeight} > window ${innerWidth}x${innerHeight}`);
    }
    for (const el of Array.from(document.body.querySelectorAll('*'))) {
      const e = el as HTMLElement;
      const cs = getComputedStyle(e);
      const tall = e.clientHeight > 0 && e.scrollHeight > e.clientHeight + 1 && SCROLLS.has(cs.overflowY);
      const wide = e.clientWidth > 0 && e.scrollWidth > e.clientWidth + 1 && SCROLLS.has(cs.overflowX);
      if (tall || wide) scrollers.push(`${name(e)}: scroll ${e.scrollWidth}x${e.scrollHeight} > client ${e.clientWidth}x${e.clientHeight}`);
    }
    const outside: string[] = [];
    for (const el of Array.from(document.querySelectorAll(sel))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || r.left < -1 || r.top < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1) {
        outside.push(`${name(el)}${el.getAttribute('data-deck-id') ? `(${el.getAttribute('data-deck-id')})` : ''} at ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
    }
    const boxes: string[] = [];
    for (const s of ['.app-header', '.wp-room-chrome-frame__content', '.wp-room-chrome', '.shell', '.shell__head', '.lobby__card', '.lobby__card > *', '.deckpick', '.deckpick__option', '.rooms', '.rooms__row', '.rooms__create']) {
      for (const el of Array.from(document.querySelectorAll(s))) {
        const r = el.getBoundingClientRect();
        boxes.push(`${s} ${Math.round(r.width)}x${Math.round(r.height)}@${Math.round(r.top)}`);
      }
    }
    return { size: `${innerWidth}x${innerHeight}`, scrollers, outside, boxes };
  }, mustShow);
}

async function fitsAt(page: Page, who: string, where: string, mustShow: string, failures: string[]): Promise<void> {
  for (const size of SIZES) {
    await page.setViewportSize(size);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const fit = await measure(page, mustShow);
    console.log(`[lobby-fit] ${where} ${who} ${fit.size} boxes: ${fit.boxes.join(' | ')}`);
    for (const s of fit.scrollers) console.log(`[lobby-fit] ${where} ${who} ${fit.size} SCROLLS ${s}`);
    for (const o of fit.outside) console.log(`[lobby-fit] ${where} ${who} ${fit.size} OUTSIDE ${o}`);
    failures.push(...fit.scrollers.map((s) => `${where} ${who} ${fit.size}: ${s}`));
    failures.push(...fit.outside.map((o) => `${where} ${who} ${fit.size}: outside the window: ${o}`));
  }
}

test(titled('the lobby and a full room fit the window at 1280×800, 1366×768 and 1024×700: nothing scrolls, the chat included'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice');
    const bob = await openFriend(browser, 'bob');
    await signIn(alice);
    await signIn(bob);
    const failures: string[] = [];

    // A friend group's evening: a handful of rooms already open (production held three on 2026-10-10).
    for (let i = 1; i <= ROOMS_OPEN; i++) {
      const made = await bob.context.request.post(`${stack.origin}${PREFIX}/api/rooms`, {
        data: { name: `open table ${i}`, gameType: i % 2 === 0 ? 'draft' : 'constructed-1v1' },
      });
      expect(made.status()).toBe(201);
    }
    await alice.page.goto(`${stack.origin}${PREFIX}/`);
    await expect(alice.page.getByTestId('room-create')).toBeVisible();
    await expect(alice.page.getByTestId('room-row')).toHaveCount(ROOMS_OPEN);
    await fitsAt(alice.page, 'alice', 'front', '[data-testid="room-create-submit"], [data-testid="room-row"]', failures);

    await alice.page.getByTestId('room-create-name').fill(`lobby fit ${Date.now()}`);
    await alice.page.getByTestId('room-create-type').selectOption('constructed-1v1');
    await alice.page.getByTestId('room-create-submit').click();
    await alice.page.waitForURL(/#\/room\/r-[0-9a-f]{12}$/, { timeout: 30_000 });
    await bob.page.goto(alice.page.url());
    await expect(bob.page.getByTestId('constructed')).toBeVisible({ timeout: 30_000 });
    // The room's own era — a fresh room's is the newest Standard one, a full twelve decks — and
    // each player takes one of the decks it offers.
    for (const [f, n] of [
      [alice, 0],
      [bob, 1],
    ] as const) {
      await expect(f.page.getByTestId('deck-mine')).toBeEnabled();
      await f.page.getByTestId('deck-mine').locator('[data-deck-id]').nth(n).click();
      await expect(f.page.getByTestId('verdict-mine')).toContainText('Legal in');
    }
    const era = await bob.page.getByTestId('format-fixed').getAttribute('data-format');
    await alice.page.getByTestId('ready-toggle').click();
    await expect(alice.page.getByTestId('ready-toggle')).toHaveAttribute('aria-pressed', 'true');
    await expect(bob.page.getByTestId('room-seat-1-empty')).toHaveCount(0);
    const decks = await alice.page.getByTestId('deck-mine').locator('[data-deck-id]').count();
    console.log(`[lobby-fit] room on ${era}: ${decks} decks on offer; chat aside drawn: ${await alice.page.locator('.wp-room-chrome').count()}`);

    const mustShow = '[data-testid="ready-toggle"], [data-testid="deck-mine"] [data-deck-id], [data-testid="room-players"]';
    await fitsAt(alice.page, 'alice', 'room', mustShow, failures);
    await fitsAt(bob.page, 'bob', 'room', mustShow, failures);

    expect(failures, 'nothing in the lobby scrolls and nothing it offers is outside the window').toEqual([]);
  } finally {
    await stack.stop();
  }
});
