/**
 * The phone context every `*.phone.spec.ts` test runs in (Settled 1: portrait only, ≤600 CSS px
 * wide and taller than wide — this is the review's own 390×844 iPhone shape), plus the few gestures a
 * mouse cannot make: a real touch tap (`tapCard`) and a two-finger pinch (`pinch`, dispatched over CDP
 * because Playwright's own API has no multi-touch gesture). `noSideways` is the one assertion every
 * phone spec that renders the board makes at least once (Settled 3: "the page body never scrolls
 * sideways").
 *
 * Every OTHER phone driver lives beside the desktop one it replaces (`board.ts`, `combat.ts`,
 * `confirm.ts`, `prompts.ts`, `hands.ts`), branching on `isPhone()` — this file holds only what
 * doesn't belong to any one of them.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';

/** The lanes' own `phone` specs and `phone-core`, the desktop suite run on the same context: both drive by touch. */
const PHONE_PROJECTS = new Set(['phone', 'phone-core']);

/**
 * True while the running test is in a phone project (`playwright.config.ts`'s `phone`, its own
 * `*.phone.spec.ts`, or `phone-core`). Every sibling driver's phone branch reads this one function, so a
 * desktop spec never sees any of them flip (RULES: no duplicate code paths — one helper, not one
 * copy of the check per file).
 */
export const isPhone = (): boolean => PHONE_PROJECTS.has(test.info().project.name);

/**
 * A control the bar's ⋯ sheet holds (Chat, Menu, the zoom): in portrait the sheet is opened first when it
 * is closed, as a player would. A no-op on a wider table, where the bar is not drawn.
 */
export async function inMore(page: Page, testId: string): Promise<Locator> {
  const more = page.getByTestId('action-more');
  if ((await more.isVisible().catch(() => false)) && (await more.getAttribute('aria-expanded')) !== 'true') await more.tap();
  return page.getByTestId(testId).filter({ visible: true });
}

/**
 * A match control the portrait action menu holds (Full Control, Concede, End Turn, the settings gear): on a
 * phone the menu is opened first when it is closed — ⋯, then Menu — as a player would. A no-op on a wider table.
 */
export async function inMenu(page: Page, testId: string): Promise<Locator> {
  const menu = page.getByTestId('action-menu');
  if ((await page.getByTestId('action-more').isVisible().catch(() => false)) && (await menu.getAttribute('aria-expanded')) !== 'true') await (await inMore(page, 'action-menu')).tap();
  return page.getByTestId(testId).filter({ visible: true });
}

/** Press a control `inMenu` reaches, then close the menu again where it is still open, as a player does. */
export async function pressInMenu(page: Page, testId: string): Promise<void> {
  const control = await inMenu(page, testId);
  if (isPhone()) await control.tap();
  else await control.click();
  const menu = page.getByTestId('action-menu');
  if (isPhone() && (await menu.count()) > 0 && (await menu.getAttribute('aria-expanded')) === 'true') await page.keyboard.press('Escape');
}

/**
 * Context options for every `*.phone.spec.ts` file: `test.use(PHONE)`. This is the exact shape the
 * wave 89 brief fixed so every lane's red-first spec could be written before this file landed — don't
 * reshape it without checking every lane's spec still imports the same object.
 */
export const PHONE = {
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 3,
  colorScheme: 'dark',
} as const;

/**
 * Raise the phone's hand, as a player does before touching a card in it: the hand rests as a peek
 * (Mockup 2), and the tap that raises it is the hand's alone. A no-op once it is up, or for a card that
 * is not in the hand. Resolves once the raised hand has stopped growing.
 */
export async function raiseHand(page: Page, cardId?: number): Promise<void> {
  const lane = page.getByTestId('lane-my-hand');
  if ((await lane.count()) === 0) return;
  if (cardId !== undefined && (await lane.locator(`[data-board-card="${cardId}"]`).count()) === 0) return;
  if ((await page.locator('.board[data-hand-raised]').count()) > 0) return;
  const box = await lane.boundingBox();
  if (box === null) return;
  await page.touchscreen.tap(box.x + 12, box.y + box.height / 2);
  await expect(page.locator('.board[data-hand-raised]')).toHaveCount(1);
  let last = -1;
  await expect
    .poll(async () => {
      const h = (await lane.boundingBox())?.height ?? 0;
      const still = Math.abs(h - last) < 0.5;
      last = h;
      return still;
    })
    .toBe(true);
}

/**
 * Tap a card's own clickable face with a REAL touch gesture — `Locator.tap()`, which (because the
 * phone context carries `hasTouch: true`) dispatches `touchstart`/`touchend`, not a mouse click.
 * Settled 5 makes a touch tap on ANY card open the one expanded card view rather than play or cast it;
 * a plain `.click()` here would prove nothing, because Chromium's click on a touch-enabled context is
 * still a mouse event (`pointerType: 'mouse'`) — D's gesture install branches on the real thing.
 */
export async function tapCard(page: Page, cardId: number): Promise<void> {
  await raiseHand(page, cardId);
  await page.locator(`[data-board-card="${cardId}"] button`).first().tap();
}

/**
 * A touch long-press: held at the card's own centre, past `LONG_PRESS_MS` (450 ms,
 * `apps/ui/src/play/inspect/index.ts`) with no movement, released in place — `tapCard`/`touchDrag`
 * cover a plain tap and a drag; this is the one gesture neither makes. It is how a touch reads a
 * permanent, whose tap is its click.
 */
export async function longPressCard(page: Page, cardId: number, holdMs = 650): Promise<void> {
  const box = await page.locator(`[data-board-card="${cardId}"] button`).first().boundingBox();
  if (box === null) throw new Error(`card ${cardId} has no box to long-press`);
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const client = await page.context().newCDPSession(page);
  try {
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: point.x, y: point.y, radiusX: 11, radiusY: 11, force: 1, id: 1 }],
    });
    await page.waitForTimeout(holdMs);
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally {
    await client.detach().catch(() => undefined);
  }
}

export interface PinchOptions {
  /** Centre of the gesture, in CSS px. Defaults to the viewport's own centre. */
  at?: { x: number; y: number };
  /** >1 spreads the two fingers apart (zoom in); <1 brings them together (zoom out). */
  scale: number;
  /** Touch points the gesture moves through, each its own `touchMove` — more for a slower, observable pinch. */
  steps?: number;
}

/**
 * A two-finger pinch, dispatched over CDP `Input.dispatchTouchEvent` because Playwright's own API has
 * no multi-touch gesture (`Locator.tap()` and `page.touchscreen` are both single-finger). Two touch
 * points start 60 CSS px apart on either side of `at` and move, in `steps` real `touchMove` events, to
 * `60 * scale` px apart, then lift together — the same shape a finger pinch makes, not one synthetic
 * "zoom" event the board's own listener could not tell from a bug.
 */
export async function pinch(page: Page, opts: PinchOptions): Promise<void> {
  const viewport = page.viewportSize();
  const at = opts.at ?? (viewport === null ? { x: 0, y: 0 } : { x: viewport.width / 2, y: viewport.height / 2 });
  const steps = opts.steps ?? 8;
  const startSpread = 60;
  const endSpread = startSpread * opts.scale;
  const client = await page.context().newCDPSession(page);
  const touchPoint = (dx: number) => ({ x: at.x + dx, y: at.y, radiusX: 11, radiusY: 11, force: 1 });
  try {
    for (let i = 0; i <= steps; i++) {
      const half = (startSpread + ((endSpread - startSpread) * i) / steps) / 2;
      await client.send('Input.dispatchTouchEvent', {
        type: i === 0 ? 'touchStart' : 'touchMove',
        touchPoints: [
          { ...touchPoint(-half), id: 1 },
          { ...touchPoint(half), id: 2 },
        ],
      });
      await page.waitForTimeout(16);
    }
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally {
    await client.detach().catch(() => undefined);
  }
}

/**
 * A single-finger touch drag: press at `from`, move through each of `points` with a real CDP
 * `Input.dispatchTouchEvent` `touchMove` (never `page.mouse.*`, which sends mouse events even inside
 * a touch context — D's gesture install branches on the real thing), release at the last point. The
 * one primitive `board.ts`'s hand-card drag and `combat.ts`'s block drag both build on for the phone
 * project (and `swipe` below), rather than each dispatching its own CDP touch sequence.
 */
export async function touchDrag(page: Page, from: { x: number; y: number }, points: readonly { x: number; y: number }[]): Promise<void> {
  const client = await page.context().newCDPSession(page);
  const point = (p: { x: number; y: number }) => ({ x: p.x, y: p.y, radiusX: 11, radiusY: 11, force: 1, id: 1 });
  try {
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point(from)] });
    for (const p of points) {
      await page.waitForTimeout(16);
      await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point(p)] });
    }
    await page.waitForTimeout(16);
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally {
    await client.detach().catch(() => undefined);
  }
}

/** A single-finger touch drag from `from` to `to` in `steps` even moves: `touchDrag` along a straight line. */
export async function swipe(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, steps = 12): Promise<void> {
  const points = Array.from({ length: steps }, (_, i) => ({ x: from.x + ((to.x - from.x) * (i + 1)) / steps, y: from.y + ((to.y - from.y) * (i + 1)) / steps }));
  await touchDrag(page, from, points);
}

/**
 * Settled 3: "the page body never scrolls sideways. Only lanes do." One assertion every phone spec
 * that renders the board makes: the document's own scrolling element has nothing to scroll past its
 * own width. A board lane's OWN scroller (Settled 3's four lanes) may scroll sideways on its own axis;
 * this only ever reads the page.
 */
export async function noSideways(page: Page): Promise<void> {
  const { scrollWidth, clientWidth } = await page.evaluate(() => {
    const se = document.scrollingElement ?? document.documentElement;
    return { scrollWidth: se.scrollWidth, clientWidth: se.clientWidth };
  });
  expect(scrollWidth, 'the page body does not scroll sideways').toBe(clientWidth);
}

/** One edge cue of a portrait lane, read off its pseudo-element: the glyph it draws and its width. */
export interface LaneCue {
  glyph: string;
  width: number;
}

/**
 * The edge cues a portrait lane draws (`portrait.css`): a chevron in the fade on each edge the lane
 * can still scroll toward, `‹` on the left (`::before`) and `›` on the right (`::after`). Read off
 * the computed pseudo-elements, since the cue is no element of its own; `null` where that edge has
 * none.
 */
export async function laneCues(lane: Locator): Promise<{ left: LaneCue | null; right: LaneCue | null }> {
  return lane.evaluate((el) => {
    const read = (pseudo: '::before' | '::after') => {
      const style = getComputedStyle(el, pseudo);
      if (style.content === 'none' || style.content === 'normal') return null;
      return { glyph: style.content.replace(/^"|"$/g, ''), width: Number.parseFloat(style.width) };
    };
    return { left: read('::before'), right: read('::after') };
  });
}

/**
 * The action bar is on the screen's bottom edge (the operator, 2026-11-03: "in some cases the bottom bar
 * wasn't anchored to the bottom of the page"): its bottom is the layout viewport's bottom, its own row sits
 * above the bottom safe area, and nothing is drawn over its middle. `state` names the moment in the message.
 */
export async function expectBarAnchored(page: Page, state: string): Promise<void> {
  const read = await page.getByTestId('action-bar').evaluate((bar) => {
    const probe = document.createElement('div');
    probe.style.cssText = 'position: fixed; visibility: hidden; height: env(safe-area-inset-bottom, 0px)';
    document.body.append(probe);
    const safe = probe.getBoundingClientRect().height;
    probe.remove();
    const box = bar.getBoundingClientRect();
    const buttons = [...bar.querySelectorAll('button')].filter((b) => b.getBoundingClientRect().height > 0).map((b) => b.getBoundingClientRect().bottom);
    const top = document.elementFromPoint(box.left + box.width / 2, box.top + 6);
    return { bottom: box.bottom, height: box.height, edge: window.innerHeight, safe, lowest: Math.max(...buttons), covered: top === null || !bar.contains(top) ? (top?.className.toString() ?? 'nothing') : null };
  });
  console.log(`[bar] ${state}: bottom ${read.bottom} of ${read.edge}, safe ${read.safe}, lowest button ${read.lowest}, covered by ${read.covered ?? 'nothing'}`);
  expect.soft(read.bottom, `${state}: the bar’s bottom is the screen’s bottom`).toBeCloseTo(read.edge, 0);
  expect.soft(read.lowest, `${state}: the bar’s buttons sit above the bottom safe area`).toBeLessThanOrEqual(read.edge - read.safe + 0.5);
  expect.soft(read.covered, `${state}: nothing is drawn over the bar`).toBeNull();
}
