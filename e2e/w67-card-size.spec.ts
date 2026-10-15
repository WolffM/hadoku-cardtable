/**
 * One source of truth for a card's size (the operator, 2026-10-09): "aspect ratio is squished
 * horizontally so cards are smaller … when released there's a brief flash where the card expands to a
 * larger size … lets make sure the whole process respects the resized card". On a squeezed window a
 * spell is lifted, released over the board and parked on the stack: every frame of it — the lifted
 * card, the stack card, the opponent's back — is the one size, which is a hand card's (the operator,
 * 2026-10-15: "casting cards are just as big as hand cards"), each screen's own: never a flash larger,
 * never a step smaller.
 */
import { expect, test, type Page } from '@playwright/test';

import { makeTitled, offeredNamed, says } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';
import { installSizeOf, type SizeOfWindow } from './play/w32.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** Records, every animation frame, the widest card-sized thing drawn off the rows. */
async function recordWidths(page: Page): Promise<void> {
  await installSizeOf(page);
  await page.evaluate(() => {
    const w = window as unknown as SizeOfWindow & { __widths: { t: number; what: string; width: number }[] };
    w.__widths = [];
    const t0 = performance.now();
    const tick = () => {
      for (const [what, sel] of [
        ['lifted', '[data-cast-lift]'],
        ['stack', '[data-placed-spell]'],
        ['back', '.presence__back'],
      ] as const) {
        for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
          // The held back is drawn tilted, which widens its bounding box (68×95 → 73), and the stack
          // card's face turns as it hovers: their own size is what this measures. The lift by its drawn box.
          const width = what === 'lifted' ? el.getBoundingClientRect().width : w.__sizeOf(el).width;
          if (width > 0) w.__widths.push({ t: Math.round(performance.now() - t0), what, width: Math.round(width * 10) / 10 });
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}
const widthsOf = (page: Page) => page.evaluate(() => (window as unknown as { __widths: { t: number; what: string; width: number }[] }).__widths);
/** A card in this screen's own hand, as drawn before anything is lifted — a probe column of its row when it holds none. */
const handCard = (page: Page) =>
  page.evaluate(() => {
    const list = document.querySelector<HTMLElement>('[data-zone="hand"][data-owner="you"] :is(.zone__cards, .card-backs)')!;
    const drawn = list.querySelector<HTMLElement>(':scope > li:is(.board-card, .card-back)');
    const probe = drawn === null ? list.appendChild(Object.assign(document.createElement('li'), { className: 'board-card' })) : null;
    const width = (drawn ?? probe)!.getBoundingClientRect().width;
    probe?.remove();
    return Math.round(width * 10) / 10;
  });

test(titled('on a squeezed window a released spell is drawn at a hand card’s size from lift to stack — the lift, the stack card and the opponent’s back are one size'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'bolt-player');
    // Squeezed horizontally: the operator's window.
    for (const p of [alice.page, bob.page]) await p.setViewportSize({ width: 900, height: 800 });
    let bolt: number | undefined;
    await expect.poll(async () => (bolt = await offeredNamed(alice.page, 'Lightning Bolt')), { timeout: 60_000, message: 'alice is offered the Bolt' }).not.toBeUndefined();
    const cardW = await handCard(alice.page);
    const bobCardW = await handCard(bob.page);
    await recordWidths(alice.page);
    await recordWidths(bob.page);

    const from = (await alice.page.locator(`[data-board-card="${bolt}"]`).boundingBox())!;
    const field = (await alice.page.locator('.seat[data-viewer] [data-zone="battlefield"]').boundingBox())!;
    await alice.page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await alice.page.mouse.down();
    await alice.page.mouse.move(field.x + field.width * 0.6, field.y + field.height * 0.4, { steps: 12 });
    await alice.page.mouse.up();
    // Parked on its target ask; aimed at bob's face it goes to the stack where it was let go.
    await expect.poll(() => says(alice.page), { timeout: 15_000, message: 'the Bolt asks for its target' }).toMatch(/Lightning Bolt.*target/is);
    await alice.page.locator('[data-player-face]:not([data-viewer])').click();
    await expect(alice.page.locator('[data-placed-spell]'), 'the Bolt is a stack card at the release point').toHaveCount(1, { timeout: 15_000 });
    await alice.page.waitForTimeout(1500);

    const mine = await widthsOf(alice.page);
    const theirs = await widthsOf(bob.page);
    const widths = (rows: { what: string; width: number }[], what: string) => rows.filter((r) => r.what === what).map((r) => r.width);
    const widest = (rows: { what: string; width: number }[], what: string) => Math.max(0, ...widths(rows, what));
    const narrowest = (rows: { what: string; width: number }[], what: string) => Math.min(Infinity, ...widths(rows, what));
    console.log(
      `[card-size] hand card alice=${cardW} bob=${bobCardW}; alice lifted=${narrowest(mine, 'lifted')}–${widest(mine, 'lifted')} stack=${narrowest(mine, 'stack')}–${widest(mine, 'stack')}; bob back=${narrowest(theirs, 'back')}–${widest(theirs, 'back')} stack=${narrowest(theirs, 'stack')}–${widest(theirs, 'stack')}`,
    );
    for (const [rows, what, hand, says] of [
      [mine, 'lifted', cardW, 'the lifted card is a hand card'],
      [mine, 'stack', cardW, 'the stack card is a hand card, never a flash larger'],
      [theirs, 'back', bobCardW, 'the opponent’s back is a hand card'],
      [theirs, 'stack', bobCardW, 'and so is the opponent’s view of the stack card'],
    ] as const) {
      expect(widths(rows, what).length, `${says}: drawn`).toBeGreaterThan(0);
      expect(widest(rows, what), says).toBeLessThanOrEqual(hand + 2);
      expect(narrowest(rows, what), `${says}, never a step smaller`).toBeGreaterThanOrEqual(hand - 2);
    }
  } finally {
    await stack.stop();
  }
});
