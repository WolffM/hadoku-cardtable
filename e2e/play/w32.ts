/**
 * Wave 32's shared hands for the specs: the header settings menu (Q15), and a
 * pointer drag of a permanent (Q4), which replaced the browser's HTML5 drag.
 */

import { expect, type Locator, type Page } from '@playwright/test';

import type { Friend } from './browser.ts';

/* ── the header settings menu (Q15) ──────────────────────────────────── */

/** The fleet's own gear, in `AppHeader` (`@wolffm/task-ui-components` `ConnectedSettings`). */
export const headerGear = (page: Page): Locator => page.getByRole('button', { name: 'User settings' });
/** The popout panel the gear opens. */
export const headerPanel = (page: Page): Locator => page.getByRole('dialog', { name: 'User settings' });
/** Where the match portals its own controls into (`chrome/HeaderSettings.tsx`). */
export const appSettings = (page: Page): Locator => page.getByTestId('header-app-settings');

/** Open the header menu the way a person does, and wait for the match's controls in it. */
export async function openHeaderSettings(page: Page): Promise<Locator> {
  if ((await headerPanel(page).count()) === 0) await headerGear(page).click();
  await expect(headerPanel(page), 'the header settings popout opened').toBeVisible();
  await expect(appSettings(page), 'the match put its settings into the header menu').toBeVisible();
  return appSettings(page);
}

export async function closeHeaderSettings(page: Page): Promise<void> {
  // The popout's own full-page overlay sits over the gear while it is open; a click on it is
  // the fleet component's outside-click close.
  if ((await headerPanel(page).count()) > 0) await page.locator('.settings-popout__overlay').click({ position: { x: 2, y: 2 } });
  await expect(headerPanel(page)).toHaveCount(0);
}

/** Put `f`'s OWN board in the four-lane layout, through the header menu (Q15). */
export async function chooseLanes(f: Friend): Promise<void> {
  const menu = await openHeaderSettings(f.page);
  await menu.locator('input[name="board-layout"][value="type-separated"]').check();
  await closeHeaderSettings(f.page);
  await expect(
    f.page.locator('.seat[data-viewer] [data-zone="battlefield"] [data-board-row]'),
    `${f.name}: the four lanes`,
  ).not.toHaveCount(0);
}

/* ── the pointer drag (Q4) ───────────────────────────────────────────── */

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export async function boxOf(l: Locator): Promise<Box> {
  const b = await l.boundingBox();
  if (b === null) throw new Error(`no box for ${l}`);
  return b;
}

export const centre = (b: Box): { x: number; y: number } => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

/**
 * The board's observable drag surface (`docs/planning/wave32-evidence/q4-drag-interaction.md`).
 * `data-arrange-slot` is on every slot box permanently; the rest exist only mid-drag.
 *
 * **`indicator` excludes `[hidden]`, found diagnosing a real e2e red** (the
 * manager's own request, logged every `[data-arrange-indicator]`'s
 * outerHTML at the midway point): wave 35 R9 gave the Arena-cast gesture its
 * OWN reusable preview indicator (`Board.tsx`'s `previewPlayedTo` — "the
 * element is created once and reused (hidden between calls)"), a SEPARATE
 * singleton from the pre-existing arrange-REORDER drag's own indicator,
 * both drawn with the identical `data-arrange-indicator` attribute. Once a
 * session has used BOTH gestures at least once, both singletons exist in the
 * DOM permanently — one hidden (whichever gesture last finished), one live
 * — so a bare `[data-arrange-indicator]` count can read 2 even though only
 * ONE is actually drawn. Confirmed directly: the stale element from an
 * earlier bot-driven cast DID carry `hidden=""` (correctly cleared, not a
 * skipped-clear bug to route anywhere) — this was always a test-side
 * counting gap, not a product one.
 */
export const DRAG_HOOKS = {
  ghost: '[data-arrange-ghost]',
  indicator: '[data-arrange-indicator]:not([hidden])',
  pickedUp: '[data-arrange-active]',
} as const;

/** One of the viewer's battlefield slots: `back` / `front` by default, a lane name in type-separated. */
export const viewerSlot = (page: Page, slot: string): Locator =>
  page.locator(`.seat[data-viewer] [data-zone="battlefield"] [data-arrange-slot="${slot}"]`);

/** Where a drop lands at the END of a slot: just right of its last card, or the middle of an empty slot. */
export async function endOfSlot(slot: Locator): Promise<{ x: number; y: number }> {
  const box = await boxOf(slot);
  const cards = slot.locator('li.board-card');
  if ((await cards.count()) === 0) return centre(box);
  const last = await boxOf(cards.last());
  return { x: Math.min(last.x + last.width + 10, box.x + box.width - 4), y: last.y + last.height / 2 };
}

export interface DragTrace {
  /** Whatever the board drew mid-drag: the ghost and the target indicator. */
  midway: { ghost: number; indicator: number; pickedUp: number };
}

/**
 * Drag `card` to the viewport point `to` with a REAL pointer (mouse down, several
 * moves, mouse up): the board's own drag is pointer events, so this is what a
 * person's hand does, and it is independent of how the board listens. Reports what
 * was drawn halfway, so a caller can assert the ghost and the target indicator.
 *
 * `hooks` are the board's observable drag surface (`q4-drag-interaction.md`).
 */
export async function pointerDrag(
  page: Page,
  card: Locator,
  to: { x: number; y: number },
  hooks: { ghost: string; indicator: string; pickedUp: string } = DRAG_HOOKS,
): Promise<DragTrace> {
  const from = centre(await boxOf(card));
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  // A first move past any dead-zone, then the long way round.
  await page.mouse.move(from.x + 8, from.y + 8, { steps: 3 });
  // Armed here, before the midway sample, so "never armed" and "armed but
  // sampled too early" fail with different messages.
  await expect
    .poll(() => page.locator(hooks.pickedUp).count(), { timeout: 3_000, message: 'the drag never armed: pickedUp stayed 0 after mouse.down' })
    .toBeGreaterThan(0);
  const steps = 12;
  let midway: DragTrace['midway'] = { ghost: 0, indicator: 0, pickedUp: 0 };
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
    if (i === Math.floor(steps / 2)) {
      midway = {
        ghost: await page.locator(hooks.ghost).count(),
        indicator: await page.locator(hooks.indicator).count(),
        pickedUp: await page.locator(hooks.pickedUp).count(),
      };
    }
  }
  await page.mouse.up();
  return { midway };
}

/**
 * The same drag with a finger: CDP touch events, which Chromium turns into
 * `pointerType: 'touch'` pointer events. The board's drag is built on pointer
 * events, so a touch must carry a card the way the mouse does (wave 32 Q4: "touch
 * works"). Reports what was drawn halfway, like {@link pointerDrag}.
 */
export async function touchDrag(page: Page, card: Locator, to: { x: number; y: number }): Promise<DragTrace> {
  const from = centre(await boxOf(card));
  const cdp = await page.context().newCDPSession(page);
  const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', p?: { x: number; y: number }) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: p === undefined ? [] : [{ x: p.x, y: p.y }] });
  try {
    await touch('touchStart', from);
    // A first move past any dead-zone, same as `pointerDrag`: arming needs a
    // move past `SLOP` first.
    await touch('touchMove', { x: from.x + 8, y: from.y + 8 });
    // Armed here, before the midway sample, so "never armed" and "armed but
    // sampled too early" fail with different messages.
    await expect
      .poll(() => page.locator(DRAG_HOOKS.pickedUp).count(), { timeout: 3_000, message: 'the touch drag never armed: pickedUp stayed 0 after touchStart' })
      .toBeGreaterThan(0);
    const steps = 12;
    let midway: DragTrace['midway'] = { ghost: 0, indicator: 0, pickedUp: 0 };
    for (let i = 1; i <= steps; i++) {
      await touch('touchMove', { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps });
      if (i === Math.floor(steps / 2)) {
        midway = {
          ghost: await page.locator(DRAG_HOOKS.ghost).count(),
          indicator: await page.locator(DRAG_HOOKS.indicator).count(),
          pickedUp: await page.locator(DRAG_HOOKS.pickedUp).count(),
        };
      }
    }
    await touch('touchEnd');
    return { midway };
  } finally {
    await cdp.detach();
  }
}
