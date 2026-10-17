/**
 * The operator, 2026-10-10: "i noticed in some cases the ability chips display differently. I had a
 * situation where an emrakul annihalator trigger created a very long vertical ability chip which
 * was ugly … help me allow ability chips to get a little more horizontal, especially if the
 * reminder text is very long. lets also allow hovering them just like cards to see an expanded
 * view."
 *
 * And 2026-10-11, of the wider rule that answered it — Delver of Secrets' upkeep trigger drawn as a
 * ~360×95 bar on a wide screen and ~110×165 on a narrower one: "the rendering here is too extreme.
 * the second one is clearly a better view and my guess is the first one happens that way because
 * the screen is wider. the goal should be to get as close to square as possible".
 *
 * A long trigger (Eternal Witness's, ~150 characters with Forge's "(Targeting: …)" tail) and a short
 * one (Elvish Visionary's "draw a card"), at four window sizes, on both screens: the chip is as near
 * square as its bounds allow — aspect w/h within [0.75, 1.33], or, outside it, pinned at the bound
 * that stopped it (never narrower than a card; never wider than three cards or a third of the
 * board). Both screens draw it the same shape, it stays on the board, and hovering it opens the one
 * expanded view with its text.
 */
import { expect, test, type Page } from '@playwright/test';

import { makeTitled, resizeWindow } from './play/board.ts';
import { chipOf, triggerOnStack } from './play/chip.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';
import { installSizeOf, type SizeOfWindow } from './play/w32.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const SIZES = [
  { width: 1280, height: 720 },
  { width: 1600, height: 900 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
];

const SQUARE_MIN = 0.75;
const SQUARE_MAX = 1.33;

const CASES = [
  { name: 'long', scenario: 'w67-trigger', creature: 'Eternal Witness', reads: 'return target card from your graveyard' },
  { name: 'short', scenario: 'visionary-trigger', creature: 'Elvish Visionary', reads: 'draw a card' },
] as const;

interface Shape {
  w: number;
  h: number;
  card: number;
  /** The widest the chip may be: three cards, or a third of the board. */
  max: number;
  /** The card width the chip itself was sized from (its own `--card-w`). */
  sizedFrom: number;
  inside: boolean;
  text: number;
}

/** The chip's own size, the screen's own battlefield card width, and whether the chip's drawn box is on the board. */
async function shapeOf(page: Page): Promise<Shape> {
  await installSizeOf(page);
  return page.evaluate(() => {
    const el = document.querySelector('[data-placed-spell]:has([data-ability-chip])')!;
    const chip = el.getBoundingClientRect();
    const size = (window as unknown as SizeOfWindow).__sizeOf(el);
    const sizedFrom = Number.parseFloat(getComputedStyle(el).getPropertyValue('--card-w'));
    const overlay = document.querySelector('[data-board-overlay]')!.getBoundingClientRect();
    const card = document.querySelector('[data-zone="battlefield"] li.board-card')?.getBoundingClientRect().width ?? 0;
    const inside = chip.left >= overlay.left - 0.5 && chip.right <= overlay.right + 0.5 && chip.top >= overlay.top - 0.5 && chip.bottom <= overlay.bottom + 0.5;
    const text = el.querySelector('.placed__chip-text')?.textContent?.length ?? 0;
    return {
      w: Math.round(size.width),
      h: Math.round(size.height),
      card: Math.round(card),
      max: Math.round(Math.min(card * 3, overlay.width / 3)),
      sizedFrom: Math.round(sizedFrom),
      inside,
      text,
    };
  });
}

/** The chip's box once it has stopped changing (a resize re-lays it out and places it again). */
async function settledShape(page: Page): Promise<Shape> {
  let last = await shapeOf(page);
  for (let i = 0; i < 20; i += 1) {
    await page.waitForTimeout(100);
    const next = await shapeOf(page);
    if (next.w === last.w && next.h === last.h && Math.abs(next.sizedFrom - next.card) <= 1) return next;
    last = next;
  }
  return last;
}

for (const c of CASES) {
  test(titled(`a ${c.name} trigger’s ability chip is as near square as its bounds allow, at every window, the same on both screens`), async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(4 * 60_000);
    const stack = await startPlayStack(forge);
    try {
      const { alice, bob } = await startScenarioMatch(browser, stack, c.scenario);
      await triggerOnStack(alice.page, bob.page, c.creature);

      for (const size of SIZES) {
        for (const p of [alice.page, bob.page]) await resizeWindow(p, size);
        const a = await settledShape(alice.page);
        const b = await settledShape(bob.page);
        for (const [who, s] of [['alice', a], ['bob', b]] as const) {
          const aspect = s.w / s.h;
          const bound = aspect > SQUARE_MAX ? 'min' : aspect < SQUARE_MIN ? 'max' : 'none';
          console.log(
            `[cc-chip] ${c.name} ${size.width}x${size.height} ${who} chip=${s.w}x${s.h} aspect=${aspect.toFixed(2)} card=${s.card} max=${s.max} text=${s.text} bound=${bound} inside=${s.inside}`,
          );
          const at = `${c.name}, ${who} at ${size.width}x${size.height}: ${s.w}×${s.h} (card ${s.card}, max ${s.max})`;
          if (bound === 'min') expect.soft(s.w, `${at} — wider than square, so it must already be at its narrowest, one card`).toBeLessThanOrEqual(s.card + 1);
          if (bound === 'max') expect.soft(s.w, `${at} — taller than square, so it must already be at its widest`).toBeGreaterThanOrEqual(s.max - 1);
          expect.soft(s.w, `${at}: never narrower than a card`).toBeGreaterThanOrEqual(s.card - 1);
          expect.soft(s.inside, `${at}: the chip stays on the board`).toBe(true);
          expect.soft(Math.abs(s.sizedFrom - s.card), `${at}: sized from this window's own card (${s.card}), not the last one's (${s.sizedFrom})`).toBeLessThanOrEqual(1);
        }
        expect.soft(Math.abs(a.w - b.w), `${c.name} at ${size.width}: both screens draw it the same width (${a.w} / ${b.w})`).toBeLessThanOrEqual(2);
        expect.soft(Math.abs(a.h - b.h), `${c.name} at ${size.width}: and the same height (${a.h} / ${b.h})`).toBeLessThanOrEqual(2);
      }

      // Hover: the one expanded view, with the ability's whole text — on both screens.
      for (const [who, page] of [['alice', alice.page], ['bob', bob.page]] as const) {
        await chipOf(page).hover();
        const panel = page.locator('[data-inspect] [data-ability-chip]');
        await expect(panel, `${who}: hovering the chip opens the expanded view`).toHaveCount(1);
        await expect(panel.locator('.placed__chip-text'), `${who}: with the ability's text`).toContainText(c.reads);
        const fontOf = (sel: string) => page.locator(sel).first().evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize));
        const readSize = await fontOf('[data-inspect] .placed__chip-text');
        const chipSize = await fontOf('[data-placed-spell] .placed__chip-text');
        const enlarged = (await panel.boundingBox())!;
        console.log(`[cc-chip] ${c.name} ${who} hover panel=${Math.round(enlarged.width)}x${Math.round(enlarged.height)} text=${readSize}px (chip ${chipSize}px)`);
        expect(readSize, `${who}: the expanded view's text is larger than the chip's`).toBeGreaterThan(chipSize);
        await page.mouse.move(2, 2);
        await expect(panel, `${who}: and it closes when the pointer leaves`).toHaveCount(0);
      }
    } finally {
      await stack.stop();
    }
  });
}
