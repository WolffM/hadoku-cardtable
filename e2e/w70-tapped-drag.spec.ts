/**
 * The operator, 2026-10-11: "when dragging cards i notice tapped cards shift down slightly. seems
 * like there is something that happens that moves them when i touch cards."
 *
 * Scenario `w70-tapped-drag`: alice's front tier is two tapped creatures and nothing else, her back
 * tier three tapped Plains and one untapped. Her own pointer presses a card, moves it past the drag
 * slop, carries it across the row and lets go over its own column; every tapped card's face box is
 * measured at each step and must not move until the release.
 */
import { expect, test, type Page } from '@playwright/test';

import { makeTitled } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';
import { boxOf, centre } from './play/w32.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

type Boxes = Record<string, { x: number; y: number }>;

/** Every tapped card's face on alice's own battlefield, by card id. */
const tappedFaces = (page: Page): Promise<Boxes> =>
  page.locator('.seat[data-viewer] [data-zone="battlefield"] li.board-card[data-tapped]').evaluateAll((els) =>
    Object.fromEntries(
      els.map((li) => {
        const face = li.querySelector(':scope > .board-card__face')!.getBoundingClientRect();
        return [li.getAttribute('data-card-id') ?? '?', { x: Math.round(face.x * 10) / 10, y: Math.round(face.y * 10) / 10 }];
      }),
    ),
  );

/** The largest move of any one card from `from` to `to`, in px. */
function drift(from: Boxes, to: Boxes): number {
  return Math.max(0, ...Object.entries(from).map(([id, a]) => (to[id] === undefined ? Infinity : Math.max(Math.abs(to[id]!.x - a.x), Math.abs(to[id]!.y - a.y)))));
}

const fmt = (b: Boxes): string => Object.entries(b).map(([id, p]) => `${id}@${p.x},${p.y}`).join(' ');

for (const which of ['untapped Plains', 'tapped Plains'] as const) {
  test(titled(`pressing and dragging the ${which} moves no tapped card until the release`), async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(2 * 60_000);
    const stack = await startPlayStack(forge);
    try {
      const { alice } = await startScenarioMatch(browser, stack, 'w70-tapped-drag');
      await alice.page.setViewportSize({ width: 1280, height: 800 });
      const own = alice.page.locator('.seat[data-viewer] [data-zone="battlefield"]');
      await expect.poll(async () => Object.keys(await tappedFaces(alice.page)).length, { timeout: 30_000, message: 'five tapped cards drawn' }).toBe(5);
      const card = which === 'untapped Plains'
        ? own.locator('[data-tier="back"] li.board-card[data-arrange-card]:not([data-tapped])').first()
        : own.locator('[data-tier="back"] li.board-card[data-arrange-card][data-tapped]').first();
      await expect(card, `the ${which} is arrangeable`).toHaveCount(1, { timeout: 15_000 });
      await alice.page.waitForTimeout(600);

      const from = centre(await boxOf(card));
      const steps: [string, Boxes][] = [['rest', await tappedFaces(alice.page)]];
      await alice.page.mouse.move(from.x, from.y);
      await alice.page.waitForTimeout(250);
      steps.push(['hover', await tappedFaces(alice.page)]);
      await alice.page.mouse.down();
      await alice.page.waitForTimeout(250);
      steps.push(['down', await tappedFaces(alice.page)]);
      await alice.page.mouse.move(from.x + 10, from.y + 6, { steps: 3 });
      await alice.page.waitForTimeout(250);
      steps.push(['drag', await tappedFaces(alice.page)]);
      await alice.page.mouse.move(from.x + 140, from.y - 20, { steps: 8 });
      await alice.page.waitForTimeout(250);
      steps.push(['carried', await tappedFaces(alice.page)]);
      await alice.page.mouse.move(from.x, from.y, { steps: 8 });
      await alice.page.mouse.up();
      await alice.page.waitForTimeout(600);
      steps.push(['released', await tappedFaces(alice.page)]);

      const rest = steps[0]![1];
      for (const [name, boxes] of steps) console.log(`[w70-tapped-drag] ${which}: ${name} drift ${drift(rest, boxes)}px | ${fmt(boxes)}`);
      for (const [name, boxes] of steps.slice(1)) {
        expect(drift(rest, boxes), `${which}: no tapped card moves at "${name}"`).toBeLessThanOrEqual(0.5);
      }
    } finally {
      await stack.stop();
    }
  });
}
