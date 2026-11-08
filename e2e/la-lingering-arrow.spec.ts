/**
 * The operator, 2026-11-07 (match m-620d099199bb): "the guul draz assassin animation killed the
 * target very quickly, but then the targeting arrow still lingered there for a few seconds
 * afterwards." Its log: the ability resolved with the target's departure at 01:33:33.972, and
 * 1.4 s later the page was still running a ghost arrow's dash travel, with the stack empty.
 *
 * Against real Forge and the AI: alice's Prodigal Sorcerer pings one of bob's creatures, picked by a
 * click, as she picked Guul Draz's target. Every arrow on her board is sampled each frame from the
 * click; none may outlive the ability's resolution by more than a departure — once a 1/1 Memnite
 * that dies, once a Grizzly Bears that lives (the same log shows the linger after a spell earlier
 * in that match, whose target survived).
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one it SKIPS.
 */

import { expect, test, type Browser, type Page } from '@playwright/test';

import { clickPermanent, clickTarget, makeTitled, ownNamed } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioVsAi } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** Long enough for a departure to finish, and short of the 4 s a committed arrow waited for nothing. */
const AFTER_MS = 1_200;

/**
 * Start `scenario` against the AI, ping bob's `victim` with alice's Sorcerer, wait for `resolved`, then
 * `AFTER_MS` more, and fail if any arrow is still on her board — with the frame-by-frame timeline.
 */
async function pingAndLook(browser: Browser, scenario: string, victim: string, resolved: (page: Page, id: number) => Promise<void>): Promise<void> {
  if (!forge.ok) return;
  const stack = await startPlayStack(forge);
  let close: (() => Promise<void>) | null = null;
  try {
    const { alice } = await startScenarioVsAi(browser, stack, scenario, { fastMode: false });
    close = () => alice.context.close();
    const page = alice.page;
    const [sorcerer] = await ownNamed(page, 'Prodigal Sorcerer');
    const target = Number(
      await page.locator('.seat:not([data-viewer]) [data-zone="battlefield"] [data-board-card]').filter({ hasText: victim }).first().getAttribute('data-board-card'),
    );
    expect(sorcerer, 'the Sorcerer is on alice’s side').toBeDefined();
    expect(target, `${victim} is on bob’s side`).toBeGreaterThan(0);

    // Every frame from here: which arrows the board draws, and whether the target is still there.
    await page.evaluate((id) => {
      const w = window as unknown as { __arrows: string[] };
      w.__arrows = [];
      const start = performance.now();
      let last = '';
      const sample = (): void => {
        const count = (sel: string): number => document.querySelectorAll(sel).length;
        const row = [
          `targeter=${count('[data-testid="targeter"]')}`,
          `ghost=${count('svg.arrow[data-ghost]')}`,
          `committed=${count('[data-testid="targeter-committed"]')}`,
          `placed=${count('[data-testid="placed-arrow"]')}`,
          `auto=${count('[data-testid="stack-target-arrow"]')}`,
          `target=${count(`[data-board-card="${id}"]`)}`,
        ].join(' ');
        if (row !== last) w.__arrows.push(`${Math.round(performance.now() - start)} ${row}`);
        last = row;
        if (performance.now() - start < 10_000) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }, target);

    expect(await clickPermanent(page, sorcerer!), 'the Sorcerer is offered to activate').toBe(true);
    expect(await clickTarget(page, target), `${victim} is offered as its target`).toBe(true);
    await resolved(page, target);
    await page.waitForTimeout(AFTER_MS);
    const timeline = await page.evaluate(() => (window as unknown as { __arrows: string[] }).__arrows);
    console.log(`[la ${victim}] ${timeline.join(`\n[la ${victim}] `)}`);
    const arrows = await page.locator('[data-board-overlay] svg.arrow').count();
    expect(arrows, `no arrow ${AFTER_MS} ms after the ping resolved; timeline:\n${timeline.join('\n')}`).toBe(0);
  } finally {
    await close?.();
    await stack.stop();
  }
}

test.describe.configure({ mode: 'serial' });

test(titled('la — a tap ability that kills its target leaves no arrow behind once the target has gone'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(2 * 60_000);
  await pingAndLook(browser, 'la-lingering-arrow', 'Memnite', async (page, id) => {
    await expect(page.locator(`[data-board-card="${id}"]`), 'Memnite dies').toHaveCount(0, { timeout: 15_000 });
  });
});

test(titled('la — a tap ability whose target lives leaves no arrow behind once it has resolved'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(2 * 60_000);
  await pingAndLook(browser, 'la-lingering-arrow-survives', 'Grizzly Bears', async (page, id) => {
    const damage = page.locator(`[data-board-card="${id}"][data-damage], [data-board-card="${id}"] [data-damage]`);
    await expect.poll(() => damage.count(), { timeout: 15_000, message: 'the Bears take the damage' }).toBeGreaterThan(0);
  });
});
