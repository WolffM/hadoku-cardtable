/**
 * The operator, 2026-10-15, about a spell on the stack:
 *
 *  - AF71: "i think we need a visual distortion shimmer and maybe a slight saturation change to the
 *    'hovering' casting card";
 *  - AF72: "can we make it so casting cards are just as big as hand cards and shrink down to card
 *    size once they resolve?"
 *
 * Alice drags Grizzly Bears onto her battlefield and bob keeps a priority stop over it (scenario
 * `st-stack-resolve`, at 1280×800). What this pins, on BOTH screens:
 *
 *  - on the stack the spell is drawn at the size that screen's own hand draws its cards — bigger
 *    than a battlefield card — and its face is sharp (no SVG displacement haze since 2026-10-17: it
 *    blurred the card) and a little more saturated;
 *  - resolving, the one landing stand-in (the caster's parked copy; bob's flight copy) starts at
 *    that hand size and shrinks, frame by frame, to the permanent's slot, which ends as a plain
 *    battlefield card.
 *
 * Every step prints one `[af72]` line. Needs a Forge build (`CARDTABLE_FORGE_JAR` +
 * `CARDTABLE_FORGE_RES`); without one this SKIPS and the title says why. Serves the prebuilt
 * `apps/ui/dist` — rebuild before running.
 */
import { expect, test, type Page } from '@playwright/test';

import { castByDrag, enabledOk, handCardNamed, makeTitled, offered, stackCount } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const log = (step: string, data: unknown): void => console.log(`[af72] ${JSON.stringify({ step, data })}`);

interface OnStack {
  /** The stack card's own width (its layout box: the hover's turn never widens it). */
  stack: number;
  /** A card in this screen's own hand. */
  hand: number;
  /** A card on this screen's battlefield. */
  field: number;
  /** The face's own filter, inside the hover. */
  faceFilter: string;
}

function onStack(page: Page): Promise<OnStack | null> {
  return page.evaluate(() => {
    const placed = document.querySelector<HTMLElement>('[data-placed-spell]:not([data-placed-leaving])');
    const face = placed?.querySelector<HTMLElement>('.placed__hover > :is(.placed__tile, .placed__back)') ?? null;
    const hand = document.querySelector<HTMLElement>('.seat[data-viewer] [data-zone="hand"] li:is(.board-card, .card-back):not([data-cast-lift])');
    const field = document.querySelector<HTMLElement>('[data-zone="battlefield"] li.board-card:not([data-tapped])');
    if (placed === null || face === null || hand === null || field === null) return null;
    const w = (el: HTMLElement): number => Math.round(Number.parseFloat(getComputedStyle(el).width) * 10) / 10;
    return { stack: w(placed), hand: w(hand), field: w(field), faceFilter: getComputedStyle(face).filter };
  });
}

/** Start recording, every frame, the landing stand-in's drawn width and the permanent's own, once it is shown. */
async function recordLanding(page: Page, name: string): Promise<void> {
  await page.evaluate((card) => {
    const w = window as unknown as { __af72: { t: number; ghost: number | null; field: number | null }[]; __af72Done: boolean };
    w.__af72 = [];
    w.__af72Done = false;
    const t0 = performance.now();
    let shownAt: number | null = null;
    const tick = (): void => {
      const now = performance.now() - t0;
      const ghost = document.querySelector<HTMLElement>('[data-cast-ghost][data-cast-lift], .presence__handoff');
      const li = Array.from(document.querySelectorAll<HTMLElement>('[data-zone="battlefield"] li.board-card')).find(
        (el) => el.querySelector(':scope > .board-card__face .card__name')?.textContent?.trim() === card,
      );
      const visible = li !== undefined && getComputedStyle(li).visibility !== 'hidden';
      if (visible && ghost === null) shownAt ??= now;
      w.__af72.push({
        t: Math.round(now),
        ghost: ghost === null ? null : Math.round(ghost.getBoundingClientRect().width * 10) / 10,
        field: visible ? Math.round(li!.getBoundingClientRect().width * 10) / 10 : null,
      });
      if (shownAt !== null && now - shownAt > 500) {
        w.__af72Done = true;
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, name);
}

async function landing(page: Page): Promise<{ t: number; ghost: number | null; field: number | null }[]> {
  await page.waitForFunction(() => (window as unknown as { __af72Done: boolean }).__af72Done, null, { timeout: 20_000 });
  return page.evaluate(() => (window as unknown as { __af72: { t: number; ghost: number | null; field: number | null }[] }).__af72);
}

test(titled('a spell on the stack is a hand card’s size, sharp and a little more saturated, and shrinks into its slot as it resolves — on both screens'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'st-stack-resolve');
    for (const p of [alice.page, bob.page]) await p.setViewportSize({ width: 1280, height: 800 });
    const field = (await alice.page.locator('[data-zone="battlefield"][data-owner="you"]').boundingBox())!;
    const at = { x: Math.round(field.x + field.width * 0.6), y: Math.round(field.y + field.height * 0.5) };

    const bears = await handCardNamed(alice.page, 'Grizzly Bears');
    expect(bears, 'Grizzly Bears is in alice’s hand').not.toBeUndefined();
    await castByDrag(alice.page, stack, bears!, at);
    await expect.poll(() => stackCount(alice.page), { timeout: 10_000, message: 'the Bears are on the stack' }).toBe(1);
    await expect.poll(async () => (await offered(bob.page)).length > 0 && (await enabledOk(bob.page).count()) > 0, { timeout: 20_000, message: 'bob holds priority over the Bears' }).toBe(true);

    for (const [who, page] of [
      ['alice', alice.page],
      ['bob', bob.page],
    ] as const) {
      let look: OnStack | null = null;
      try {
        // Bob's copy turns over once its art is decoded; the size is the same either way.
        await expect.poll(async () => (look = await onStack(page)) !== null && Math.abs(look.stack - look.hand) <= 1, { timeout: 10_000, message: `${who}: the stack card is a hand card’s size` }).toBe(true);
      } finally {
        log(`on the stack (${who})`, look);
      }
      const l = look as OnStack | null;
      expect(l!.stack, `${who}: bigger than a battlefield card`).toBeGreaterThan(l!.field + 4);
      expect(l!.faceFilter, `${who}: its face is sharp — no displacing haze over it`).not.toMatch(/url\(/);
      const saturate = /saturate\(([\d.]+)\)/.exec(l!.faceFilter);
      expect(Number(saturate?.[1] ?? 1), `${who}: and a little more saturated`).toBeGreaterThan(1.05);
    }

    await recordLanding(alice.page, 'Grizzly Bears');
    await recordLanding(bob.page, 'Grizzly Bears');
    await enabledOk(bob.page).first().click();
    for (const [who, page] of [
      ['alice', alice.page],
      ['bob', bob.page],
    ] as const) {
      const frames = await landing(page);
      const ghost = frames.filter((f) => f.ghost !== null).map((f) => f.ghost!);
      const slot = frames.filter((f) => f.field !== null).at(-1)?.field ?? 0;
      const hand = (await page.locator('.seat[data-viewer] [data-zone="hand"] li:is(.board-card, .card-back)').first().evaluate((el) => Number.parseFloat(getComputedStyle(el).width))) || 0;
      log(`landing (${who})`, { hand, slot, ghost: ghost.join(' ') });
      expect(ghost.length, `${who}: one stand-in lands the Bears`).toBeGreaterThan(0);
      expect(Math.abs(ghost[0]! - hand), `${who}: it starts at the hand card’s size (${ghost[0]} vs ${hand})`).toBeLessThanOrEqual(2);
      expect(Math.abs(ghost.at(-1)! - slot), `${who}: and ends at the slot’s (${ghost.at(-1)} vs ${slot})`).toBeLessThanOrEqual(2);
      expect(ghost.some((g) => g < ghost[0]! - 2 && g > slot + 2), `${who}: shrinking through the sizes between, not in one step`).toBe(true);
    }
  } finally {
    await stack.stop();
  }
});
