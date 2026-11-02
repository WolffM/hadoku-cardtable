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
import { expect, test, type Page } from '@playwright/test';

/**
 * True while the running test is in the `phone` project (`playwright.config.ts`'s own
 * `*.phone.spec.ts` project). Every sibling driver's phone branch reads this one function, so a
 * desktop spec never sees any of them flip (RULES: no duplicate code paths — one helper, not one
 * copy of the check per file).
 */
export const isPhone = (): boolean => test.info().project.name === 'phone';

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
 * Tap a card's own clickable face with a REAL touch gesture — `Locator.tap()`, which (because the
 * phone context carries `hasTouch: true`) dispatches `touchstart`/`touchend`, not a mouse click.
 * Settled 5 makes a touch tap on ANY card open the one expanded card view rather than play or cast it;
 * a plain `.click()` here would prove nothing, because Chromium's click on a touch-enabled context is
 * still a mouse event (`pointerType: 'mouse'`) — D's gesture install branches on the real thing.
 */
export async function tapCard(page: Page, cardId: number): Promise<void> {
  await page.locator(`[data-board-card="${cardId}"] button`).first().tap();
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
 * project, rather than each dispatching its own CDP touch sequence.
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
