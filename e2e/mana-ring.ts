/**
 * What `mana-ring.spec.ts` and `mana-ring.phone.spec.ts` share: pressing a mana source where a player
 * would, the ring that opens, and where it opened against that press.
 */
import { expect, type Locator, type Page } from '@playwright/test';

import { boardCard, holdsLiveWindow, isOffered } from './play/board.ts';
import { boxOf, type Point } from './mana-floating.ts';

/** How far the ring's centre may stand from the press that opened it, in px, unless the board's edge held it. */
export const RING_NEAR_PX = 12;

export const ring = (page: Page): Locator => page.getByTestId('mana-ring');
export const ringOptions = (page: Page): Locator => ring(page).getByTestId('mana-ring-option');
export const ringOption = (page: Page, mana: string): Locator => ring(page).locator(`[data-testid="mana-ring-option"][data-mana="${mana}"]`);

/** The face of a board card a player presses. */
const faceOf = (page: Page, id: number): Locator => boardCard(page, id).locator(':scope > button.face__hit, :scope > button.board-card__face').first();

/** Where on `id`'s face a press lands: `fx`/`fy` of the way across it. Waits until the card is offered in a live window. */
export async function pressPoint(page: Page, id: number, fx = 0.35, fy = 0.4): Promise<Point> {
  await expect.poll(async () => (await isOffered(page, id)) && (await holdsLiveWindow(page)), { timeout: 30_000, message: `card ${id} offered in a live window` }).toBe(true);
  const face = await boxOf(faceOf(page, id));
  return { x: face.left + fx * (face.right - face.left), y: face.top + fy * (face.bottom - face.top) };
}

/** The ring's centre on screen: its hub's, which is drawn on the centre its discs stand round. */
export async function ringCentre(page: Page): Promise<Point> {
  const hub = ring(page).getByTestId('mana-ring-hub');
  await expect(hub, 'the mana ring opens').toBeVisible({ timeout: 15_000 });
  const b = await boxOf(hub);
  return { x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 };
}

/** The ring opened on `press`: its centre within {@link RING_NEAR_PX} of it. */
export async function expectRingOn(page: Page, press: Point, what: string): Promise<void> {
  const at = await ringCentre(page);
  const off = Math.hypot(at.x - press.x, at.y - press.y);
  expect(off, `${what}: the ring's centre (${Math.round(at.x)}, ${Math.round(at.y)}) is on the press (${Math.round(press.x)}, ${Math.round(press.y)})`).toBeLessThanOrEqual(RING_NEAR_PX);
}

/** The seat's life as its seat shows it. */
export async function lifeNow(page: Page, life: Locator): Promise<number> {
  return Number((await life.textContent())?.replace(/\D/g, '') ?? 'NaN');
}

/**
 * The land under the pointer is hovered as its ring opens, and the hover's expanded card view stands
 * beside the ring, never on a disc (`inspect/index.ts`'s OPEN_WINDOW). Checked once the view is up.
 */
export async function expectCardViewBesideRing(page: Page, what: string): Promise<void> {
  const view = page.getByTestId('card-view');
  const shown = await view.first().waitFor({ state: 'visible', timeout: 3_000 }).then(() => true, () => false);
  if (!shown) return;
  // The view moves to its place a frame after it opens.
  await page.waitForTimeout(300);
  const v = await boxOf(view.first());
  const covered: string[] = [];
  for (const disc of await ringOptions(page).all()) {
    const d = await boxOf(disc);
    if (d.left < v.right && v.left < d.right && d.top < v.bottom && v.top < d.bottom) covered.push((await disc.getAttribute('data-mana')) ?? '?');
  }
  expect(covered, `${what}: the expanded card view covers no disc of the ring`).toEqual([]);
}
