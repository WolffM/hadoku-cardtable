/**
 * Shared touch gestures for item 2c's spec (`w90a-deck-peek-touch.phone.spec.ts`): a single-finger
 * hold at a point, and a short tap — both dispatched over CDP because `hasTouch` contexts give
 * Playwright's own `Locator.tap()` no way to hold a press open for a controlled duration (it is
 * one touchstart/touchend pair with nothing in between).
 */
import type { Page } from '@playwright/test';

/** Starts a touch at `at` and returns a function that ends it (touchend) after however long the
 *  caller keeps the gesture open — call `release()` to lift the finger, `moveTo(x, y)` to slide it
 *  while held. */
export async function touchPressStart(page: Page, at: { x: number; y: number }): Promise<{
  moveTo: (x: number, y: number) => Promise<void>;
  release: () => Promise<void>;
}> {
  const client = await page.context().newCDPSession(page);
  const point = (x: number, y: number) => ({ x, y, radiusX: 11, radiusY: 11, force: 1, id: 1 });
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point(at.x, at.y)] });
  let ended = false;
  return {
    moveTo: async (x, y) => {
      if (ended) return;
      await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point(x, y)] });
    },
    release: async () => {
      if (ended) return;
      ended = true;
      await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await client.detach().catch(() => undefined);
    },
  };
}

/** A tap shorter than any hold threshold this wave uses — `touchstart` immediately followed by
 *  `touchend`, the same way a real brief tap reaches the page. */
export async function touchTap(page: Page, at: { x: number; y: number }): Promise<void> {
  const press = await touchPressStart(page, at);
  await press.release();
}
