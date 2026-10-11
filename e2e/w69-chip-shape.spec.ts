/**
 * The operator, 2026-10-10: "i noticed in some cases the ability chips display differently. I had a
 * situation where an emrakul annihalator trigger created a very long vertical ability chip which
 * was ugly … help me allow ability chips to get a little more horizontal, especially if the
 * reminder text is very long. lets also allow hovering them just like cards to see an expanded
 * view."
 *
 * Measured first (run 38093217851, both screens at 1280×720): Eternal Witness's trigger — Forge's
 * description is ~150 characters with its "(Targeting: …) [Zone Changer: …]" tail — drew as a chip
 * about 60 px wide and 280 px tall on BOTH screens. One rule drew both: `placed.ts` sized every
 * stack item, a chip included, as a battlefield card (`sizeAsBattlefieldCard`), so the chip was as
 * narrow as that screen's cards and as tall as its text then needed. A smaller window, or a fuller
 * battlefield, has narrower cards, so the same trigger stood taller there.
 *
 * Both screens, at two window sizes: the chip is wider than it is tall, it stays on the board, both
 * screens draw it the same shape, and hovering it opens the one expanded view with its text.
 */
import { expect, test, type Page } from '@playwright/test';

import { makeTitled } from './play/board.ts';
import { witnessTriggerOnStack } from './play/chip.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const SIZES = [
  { width: 1280, height: 720 },
  { width: 1600, height: 900 },
];

interface Shape {
  w: number;
  h: number;
  card: number;
  /** The card width the chip itself was sized from (its own `--card-w`). */
  sizedFrom: number;
  inside: boolean;
}

/** The chip's drawn box, the screen's own battlefield card width, and whether the chip is on the board. */
async function shapeOf(page: Page): Promise<Shape> {
  return page.evaluate(() => {
    const el = document.querySelector('[data-placed-spell]:has([data-ability-chip])')!;
    const chip = el.getBoundingClientRect();
    const sizedFrom = Number.parseFloat(getComputedStyle(el).getPropertyValue('--card-w'));
    const overlay = document.querySelector('[data-board-overlay]')!.getBoundingClientRect();
    const card = document.querySelector('[data-zone="battlefield"] li.board-card')?.getBoundingClientRect().width ?? 0;
    const inside = chip.left >= overlay.left - 0.5 && chip.right <= overlay.right + 0.5 && chip.top >= overlay.top - 0.5 && chip.bottom <= overlay.bottom + 0.5;
    return { w: Math.round(chip.width), h: Math.round(chip.height), card: Math.round(card), sizedFrom: Math.round(sizedFrom), inside };
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

test(titled('a long trigger’s ability chip grows wider before taller, the same on both screens, and hovering it reads it'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w67-trigger');
    await witnessTriggerOnStack(alice.page, bob.page);

    let smaller: Shape | null = null;
    for (const size of SIZES) {
      for (const p of [alice.page, bob.page]) await p.setViewportSize(size);
      const a = await settledShape(alice.page);
      const b = await settledShape(bob.page);
      console.log(
        `[w69-chip-shape] ${size.width}x${size.height} alice chip=${a.w}x${a.h} card=${a.card} sizedFrom=${a.sizedFrom} inside=${a.inside} · bob chip=${b.w}x${b.h} card=${b.card} sizedFrom=${b.sizedFrom} inside=${b.inside}`,
      );
      for (const [who, s] of [['alice', a], ['bob', b]] as const) {
        expect(s.w, `${who} at ${size.width}: the chip is wider than it is tall (${s.w}×${s.h})`).toBeGreaterThanOrEqual(s.h);
        expect(s.w, `${who} at ${size.width}: never narrower than a card (${s.card})`).toBeGreaterThanOrEqual(s.card - 1);
        expect(s.inside, `${who} at ${size.width}: the chip stays on the board`).toBe(true);
        expect(Math.abs(s.sizedFrom - s.card), `${who} at ${size.width}: sized from this window's own card (${s.card}), not the last one's (${s.sizedFrom})`).toBeLessThanOrEqual(1);
      }
      expect(Math.abs(a.w - b.w), `at ${size.width}: both screens draw it the same width`).toBeLessThanOrEqual(2);
      expect(Math.abs(a.h - b.h), `at ${size.width}: and the same height`).toBeLessThanOrEqual(2);
      if (smaller !== null) expect(a.w, `a bigger window's bigger cards make the chip wider, not taller (${smaller.w}×${smaller.h} before)`).toBeGreaterThan(smaller.w);
      smaller = a;
    }

    // Hover: the one expanded view, with the ability's whole text — on both screens.
    for (const [who, page] of [['alice', alice.page], ['bob', bob.page]] as const) {
      const text = page.locator('[data-placed-spell]:has([data-ability-chip]) .placed__chip-text');
      await text.hover();
      const panel = page.locator('[data-inspect] [data-ability-chip]');
      await expect(panel, `${who}: hovering the chip opens the expanded view`).toHaveCount(1);
      await expect(panel.locator('.placed__chip-text'), `${who}: with the ability's text`).toContainText('return target card from your graveyard');
      const fontOf = (sel: string) => page.locator(sel).first().evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize));
      const readSize = await fontOf('[data-inspect] .placed__chip-text');
      const chipSize = await fontOf('[data-placed-spell] .placed__chip-text');
      const enlarged = (await panel.boundingBox())!;
      console.log(`[w69-chip-shape] ${who} hover panel=${Math.round(enlarged.width)}x${Math.round(enlarged.height)} text=${readSize}px (chip ${chipSize}px)`);
      expect(readSize, `${who}: the expanded view's text is larger than the chip's`).toBeGreaterThan(chipSize);
      await page.mouse.move(2, 2);
      await expect(panel, `${who}: and it closes when the pointer leaves`).toHaveCount(0);
    }
  } finally {
    await stack.stop();
  }
});
