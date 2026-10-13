/**
 * Wave 32's shared hands for the specs: cardtable's own settings (moved out of
 * the header on 2026-10-10), and a pointer drag of a permanent (Q4), which
 * replaced the browser's HTML5 drag.
 */

import { expect, type Locator, type Page } from '@playwright/test';

import type { Friend } from './browser.ts';

/* ── cardtable's settings, opened from your own face ─────────────────── */

/** The popover (`apps/ui/src/settings/Settings.tsx`). */
export const settingsPopover = (page: Page): Locator => page.getByTestId('settings');

/** Open the settings the way a player does in a match — their own face — and wait for the match's section. */
export async function openSettings(page: Page): Promise<Locator> {
  if ((await settingsPopover(page).count()) === 0) await page.getByTestId('seat-settings').click();
  await expect(page.getByTestId('live-settings-panel'), 'the match settings opened from the face').toBeVisible();
  return settingsPopover(page);
}

export async function closeSettings(page: Page): Promise<void> {
  if ((await settingsPopover(page).count()) > 0) await page.keyboard.press('Escape');
  await expect(settingsPopover(page)).toHaveCount(0);
}

/** Put `f`'s OWN board in the four-lane layout, through the settings. */
export async function chooseLanes(f: Friend): Promise<void> {
  const menu = await openSettings(f.page);
  await menu.locator('input[name="board-layout"][value="type-separated"]').check();
  await closeSettings(f.page);
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

/**
 * `l`'s box once it has SETTLED: no finite animation or transition running on it, an ancestor
 * or a descendant, and the same box two frames running. A spec aims a drag from these boxes,
 * and a box read while a card is still arriving aims at a column the board never draws (the Z8
 * stacking red: the last land read 59.6px wide mid-arrival against its settled 68.3, so a
 * release meant for the tenth column landed in the ninth). An infinite animation (a flyer's
 * float) never finishes, so it does not hold the read back: only what will finish is waited on.
 */
export async function boxOf(l: Locator): Promise<Box> {
  const settled = await l.evaluate(
    (el) =>
      new Promise<{ box: { x: number; y: number; width: number; height: number } | null; busy: string }>((resolve) => {
        const touches = (a: Animation): boolean => {
          const target = (a.effect as KeyframeEffect | null)?.target ?? null;
          return target !== null && (target === el || target.contains(el) || el.contains(target));
        };
        let previous: DOMRect | null = null;
        let steady = 0;
        let frames = 0;
        const tick = (): void => {
          frames += 1;
          const running = document
            .getAnimations()
            .filter((a) => a.playState === 'running' && touches(a))
            .filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime ?? Infinity));
          const infinite = document.getAnimations().some((a) => a.playState === 'running' && touches(a) && !running.includes(a));
          const r = el.getBoundingClientRect();
          const same = previous !== null && r.x === previous.x && r.y === previous.y && r.width === previous.width && r.height === previous.height;
          steady = running.length === 0 && (same || infinite) ? steady + 1 : 0;
          previous = r;
          if (steady >= 2) resolve({ box: { x: r.x, y: r.y, width: r.width, height: r.height }, busy: '' });
          else if (frames >= 600)
            resolve({
              box: null,
              busy: running.length > 0 ? running.map((a) => (a as CSSAnimation).animationName ?? (a as CSSTransition).transitionProperty ?? a.id).join(', ') : `the box still moving: ${JSON.stringify(r)}`,
            });
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
  if (settled.box === null) throw new Error(`${String(l)}: its box never settled in 600 frames — ${settled.busy}`);
  if (settled.box.width === 0 && settled.box.height === 0) throw new Error(`no box for ${String(l)}`);
  return settled.box;
}

export const centre = (b: Box): { x: number; y: number } => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

/**
 * A point inside `b`'s big "stack ON TOP" zone: dead centre horizontally —
 * comfortably inside `Board.tsx`'s thin edge-reorder strip's margin either
 * way the box turns out to be sized — and in the upper part of the box
 * vertically. Deliberately NOT {@link centre}: `Board.tsx`'s own
 * `onTop = y - top < height / 2` ties exactly AT the geometric centre
 * (floating-point equal, not less-than), which resolves to "stack
 * UNDERNEATH" — the dragged card becomes the new base and the card dropped
 * onto becomes the fanned member, the opposite of what a caller aiming at
 * one specific base usually wants. 35% down is unambiguously the upper half.
 */
export const onTopPoint = (b: Box): { x: number; y: number } => ({ x: b.x + b.width / 2, y: b.y + b.height * 0.35 });

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
  const from = await pressPoint(card);
  await page.mouse.move(from.x, from.y);
  const before = await armState(page, from);
  await page.evaluate(watchPress);
  await page.mouse.down();
  // A first move past any dead-zone, then the long way round.
  await page.mouse.move(from.x + 8, from.y + 8, { steps: 3 });
  // Armed here, before the midway sample, so "never armed" and "armed but
  // sampled too early" fail with different messages.
  try {
    await expect
      .poll(() => page.locator(hooks.pickedUp).count(), { timeout: 3_000, message: 'the drag never armed: pickedUp stayed 0 after mouse.down' })
      .toBeGreaterThan(0);
  } catch (error) {
    console.log(`[table-fit-arm] before the press: ${JSON.stringify(before)}`);
    console.log(`[table-fit-arm] the press: ${JSON.stringify(await page.evaluate(() => (window as unknown as { __armWatch?: unknown }).__armWatch ?? null))}`);
    console.log(`[table-fit-arm] after the poll: ${JSON.stringify(await armState(page, from))}`);
    await page.mouse.up();
    throw error;
  }
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
 * Where a hand would press `card`: the point of it nearest its centre that the card itself
 * takes a press at (`elementFromPoint` lands inside it), waiting while nothing of it can.
 *
 * Its bare centre is not enough. A drag that never armed (M3: 16 table-fit reds and 1
 * w69-blocks red between 10-09 and 10-11) had pressed a placed stack card drawn over the
 * land — `div.placed` was what the press met (the `[table-fit-arm]` dump, run 38105661039).
 * The product half was fixed in c901a112 (a stack item's id no longer places it over the
 * card of the same id); this half makes a drag press the card it names, or fail saying
 * what covers it, instead of pressing whatever is on top and timing out on the arm.
 */
async function pressPoint(card: Locator): Promise<{ x: number; y: number }> {
  const last: { at: { x: number; y: number } | null } = { at: null };
  await expect
    .poll(
      async () => {
        const seen = await card.evaluate((el) => {
          const b = el.getBoundingClientRect();
          // The centre first, then outward on a 5×5 grid inside a 10 % margin, nearest first.
          const points: { x: number; y: number }[] = [];
          for (const fx of [0.5, 0.3, 0.7, 0.1, 0.9]) for (const fy of [0.5, 0.3, 0.7, 0.1, 0.9]) points.push({ x: b.left + b.width * fx, y: b.top + b.height * fy });
          points.sort((p, q) => Math.hypot(p.x - b.left - b.width / 2, p.y - b.top - b.height / 2) - Math.hypot(q.x - b.left - b.width / 2, q.y - b.top - b.height / 2));
          const hit = points.find((p) => {
            const top = document.elementFromPoint(p.x, p.y);
            return top !== null && el.contains(top);
          });
          if (hit !== undefined) return { at: hit, cover: '' };
          const top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
          return { at: null, cover: top === null ? 'nothing (off screen)' : `${top.tagName.toLowerCase()}.${Array.from(top.classList).join('.')}` };
        });
        last.at = seen.at;
        return seen.cover;
      },
      { message: `${String(card)} can be pressed: some part of it takes the pointer, not what is drawn over it` },
    )
    .toBe('');
  if (last.at === null) throw new Error(`${String(card)}: no point to press`);
  return last.at;
}

/**
 * Records what one press met, for a drag that never armed: which element took the
 * pointerdown, whether the gestures layer (on the canvas, so before `document`)
 * claimed it, the moves that followed, and every time the board's
 * `data-arrange-active` changed.
 */
function watchPress(): void {
  const rec: { log: string[]; moves: number } = { log: [], moves: 0 };
  (window as unknown as { __armWatch?: unknown }).__armWatch = rec;
  const t0 = performance.now();
  const at = (what: string) => rec.log.push(`${Math.round(performance.now() - t0)}ms ${what}`);
  const name = (el: EventTarget | null) =>
    el instanceof Element ? `${el.tagName.toLowerCase()}.${Array.from(el.classList).join('.')}[${el.getAttribute('data-testid') ?? ''}]` : String(el);
  window.addEventListener('pointerdown', (e) => at(`down capture on ${name(e.target)} button=${e.button} primary=${e.isPrimary} prevented=${e.defaultPrevented}`), { capture: true, once: true });
  document.addEventListener('pointerdown', (e) => at(`down at document prevented=${e.defaultPrevented}`), { once: true });
  window.addEventListener('pointerdown', (e) => at(`down at window (after the board) prevented=${e.defaultPrevented}`), { once: true });
  window.addEventListener('pointermove', (e) => {
    rec.moves += 1;
    if (rec.moves <= 4) at(`move ${e.clientX},${e.clientY} buttons=${e.buttons}`);
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture', 'keydown'] as const) window.addEventListener(type, () => at(type), { capture: true, once: true });
  new MutationObserver((ms) => {
    for (const m of ms) at(`${m.attributeName} ${(m.target as Element).hasAttribute(m.attributeName ?? '') ? 'set' : 'removed'} on ${name(m.target)}`);
  }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['data-arrange-active', 'data-arrange-dragging'] });
}

/** The table at one point: phase, prompt, bar, overlays, and what is under `p`. */
function armState(page: Page, p: { x: number; y: number }): Promise<unknown> {
  return page.evaluate((pt) => {
    const name = (el: Element | null) => (el === null ? null : `${el.tagName.toLowerCase()}.${Array.from(el.classList).join('.')}[${el.getAttribute('data-testid') ?? ''}]`);
    const hit = document.elementFromPoint(pt.x, pt.y);
    const chain: (string | null)[] = [];
    for (let el = hit; el !== null && chain.length < 6; el = el.parentElement) chain.push(name(el));
    const li = hit?.closest<HTMLElement>('li.board-card, [data-placed-spell]') ?? null;
    const marks = (el: Element) => Object.fromEntries(Array.from(el.attributes).filter((a) => a.name.startsWith('data-')).map((a) => [a.name, a.value]));
    const shown = (sel: string) => Array.from(document.querySelectorAll(sel)).filter((el) => el.getClientRects().length > 0).map(name);
    return {
      phase: document.querySelector('[data-testid="live-phases"]')?.getAttribute('data-phase') ?? null,
      says: document.querySelector('[data-testid="live-says"]')?.textContent?.slice(0, 160) ?? null,
      prompt: document.querySelector('[data-testid="live-prompt"]')?.textContent?.slice(0, 160) ?? null,
      buttons: Array.from(
        document.querySelectorAll('[data-testid^="live-button"], [data-testid^="live-decision"], [data-testid^="live-payment"], [data-testid^="selection-"], [data-testid^="prompt-confirm"]'),
      ).map((b) => `${b.getAttribute('data-testid')}:${(b.textContent ?? '').trim().slice(0, 20)}${(b as HTMLButtonElement).disabled ? '(disabled)' : ''}`),
      stack: document.querySelector('[data-zone="stack"]')?.getAttribute('data-count') ?? null,
      overlays: shown(
        '[role="dialog"], dialog[open], [data-testid="settings"], [data-testid="staging"], [data-placed-spell], [data-cast-lift], [data-arrange-ghost], [data-testid*="notice"], [data-testid*="reveal"], [data-testid*="inspector"], [data-testid*="logbook"]',
      ),
      active: document.querySelector('[data-arrange-active]') !== null,
      hit: chain,
      hitCard: li === null ? null : marks(li),
    };
  }, p);
}

/**
 * The same drag with a finger: CDP touch events, which Chromium turns into
 * `pointerType: 'touch'` pointer events. The board's drag is built on pointer
 * events, so a touch must carry a card the way the mouse does (wave 32 Q4: "touch
 * works"). Reports what was drawn halfway, like {@link pointerDrag}.
 */
export async function touchDrag(page: Page, card: Locator, to: { x: number; y: number }): Promise<DragTrace> {
  const from = await pressPoint(card);
  const cdp = await page.context().newCDPSession(page);
  const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', p?: { x: number; y: number }) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: p === undefined ? [] : [{ x: p.x, y: p.y }] });
  try {
    await touch('touchStart', from);
    // A first move past any dead-zone, same as `pointerDrag`: arming needs a
    // move past `DRAG_SLOP_PX` first.
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
