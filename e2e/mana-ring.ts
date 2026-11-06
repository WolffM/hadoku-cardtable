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

/**
 * What a click on a permanent asks "which ability?" with, by Forge's words; [] when nothing is open. A
 * source with a mana ability is asked on the mana ring (its other abilities are chips named by their
 * title, its mana abilities discs); anything else on the generic picker.
 */
export async function abilityChoices(page: Page): Promise<string[]> {
  const chips = ring(page).locator('[data-testid="mana-ring-chip"], [data-testid="mana-ring-option"]');
  if (await chips.first().isVisible({ timeout: 300 }).catch(() => false)) {
    return chips.evaluateAll((els) => els.map((e) => e.getAttribute('title') ?? e.getAttribute('data-mana') ?? ''));
  }
  const options = page.getByTestId('live-prompt').locator('[data-testid="prompt-choice"]');
  if (!(await options.first().isVisible({ timeout: 300 }).catch(() => false))) return [];
  return options.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? e.textContent ?? ''));
}

/** Pick the ability whose words match `want` (the first offered when none does), on whichever of the two asks. */
export async function chooseAbility(page: Page, want: RegExp): Promise<void> {
  const labels = await abilityChoices(page);
  const i = Math.max(0, labels.findIndex((l) => want.test(l)));
  const chips = ring(page).locator('[data-testid="mana-ring-chip"], [data-testid="mana-ring-option"]');
  if ((await chips.count()) > 0) await chips.nth(i).click();
  else await page.getByTestId('live-prompt').locator('[data-testid="prompt-choice"]').nth(i).click();
}

/** The centre of `disc` on screen, once it has bloomed out to its place (two reads a frame apart agree). */
export async function centreOf(disc: Locator): Promise<Point> {
  let last = '';
  let at: Point = { x: 0, y: 0 };
  await expect
    .poll(
      async () => {
        const b = await boxOf(disc);
        at = { x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 };
        const key = `${Math.round(at.x)},${Math.round(at.y)},${Math.round(b.right - b.left)}`;
        const still = key === last;
        last = key;
        return still;
      },
      { timeout: 5_000, intervals: [50], message: 'the disc stands still at its place' },
    )
    .toBe(true);
  return at;
}

/** The points a pointer passes through going from `from` to `to` in `steps` even moves. */
export function pathTo(from: Point, to: Point, steps = 8): Point[] {
  return Array.from({ length: steps }, (_, i) => ({ x: from.x + ((to.x - from.x) * (i + 1)) / steps, y: from.y + ((to.y - from.y) * (i + 1)) / steps }));
}

/** What the page hit-tests at `at`, as the element and its nearest ancestors with a test id or class, for a failure's message. */
export async function whatIsAt(page: Page, at: Point): Promise<string> {
  return page.evaluate(({ x, y }) => {
    const path: string[] = [];
    for (let el = document.elementFromPoint(x, y); el !== null && path.length < 6; el = el.parentElement) {
      const id = el.getAttribute('data-testid');
      path.push(`${el.tagName.toLowerCase()}${id === null ? '' : `[${id}]`}${typeof el.className === 'string' && el.className !== '' ? `.${el.className.split(' ')[0]}` : ''}`);
    }
    return path.join(' < ');
  }, at);
}
