/**
 * The operator, 2026-10-21: *"class cards should show their current level as a pip, currently they
 * show nothing"*.
 *
 * Scenario `cl-class-level`: alice has Wizard Class on the battlefield at level 1 and three Islands.
 * The Class wears its level in the card's tag column on both screens — one pip per level Forge's card
 * has, the reached ones filled — 1 of 3 at the start, and 2 of 3 once she levels it up.
 *
 * Every step prints one `[cl]` line. Needs a Forge build (`CARDTABLE_FORGE_JAR` +
 * `CARDTABLE_FORGE_RES`); without one this SKIPS and the title says why. Serves the prebuilt
 * `apps/ui/dist` — rebuild before running.
 */
import { expect, test, type Page } from '@playwright/test';

import { clickPermanent, enabledOk, makeTitled, ownNamed, pressPaymentAuto, says, stackCount } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const log = (step: string, data: unknown): void => console.log(`[cl] ${JSON.stringify({ step, data })}`);

/** The level mark card `id` wears on `page`: its level, its top, the pips drawn filled of all drawn, and its tip. */
function levelMark(page: Page, id: number): Promise<{ value: string; max: string; pips: string; tip: string } | null> {
  return page.evaluate((cardId) => {
    const tag = document.querySelector<HTMLElement>(`[data-board-card="${cardId}"] > .board-card__tags > [data-state="classLevel"]`);
    if (tag === null) return null;
    const pips = [...tag.querySelectorAll<HTMLElement>('.board-card__state-pip')];
    return {
      value: tag.dataset.value ?? '',
      max: tag.dataset.max ?? '',
      pips: `${pips.filter((p) => p.hasAttribute('data-filled')).length}/${pips.length}`,
      tip: tag.dataset.tip ?? '',
    };
  }, id);
}

test(titled('a Class wears its level as pips, on both screens: 1 of 3, then 2 of 3 once levelled up'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice: a, bob: b } = await startScenarioMatch(browser, stack, 'cl-class-level');
    const alice = a.page;
    const bob = b.page;
    const [wizard] = await expect
      .poll(() => ownNamed(alice, 'Wizard Class'), { timeout: 30_000, message: 'Wizard Class is on alice’s battlefield' })
      .toHaveLength(1)
      .then(() => ownNamed(alice, 'Wizard Class'));
    const both = async () => ({ alice: await levelMark(alice, wizard!), bob: await levelMark(bob, wizard!) });
    const at = (level: number) => ({ value: String(level), max: '3', pips: `${level}/3`, tip: `Level ${level} of 3` });

    try {
      await expect.poll(both, { timeout: 20_000, message: 'level 1 of 3 on both screens' }).toEqual({ alice: at(1), bob: at(1) });
    } finally {
      log('before', await both());
    }

    expect(await clickPermanent(alice, wizard!), 'alice activates Wizard Class').toBe(true);
    await expect
      .poll(
        async () => {
          if ((await levelMark(alice, wizard!))?.value === '2') return true;
          await pressPaymentAuto(alice);
          if ((await stackCount(alice)) > 0) for (const page of [alice, bob]) await enabledOk(page).click({ timeout: 500 }).catch(() => undefined);
          return (await levelMark(alice, wizard!))?.value === '2';
        },
        { timeout: 60_000, intervals: [250], message: `Wizard Class reaches level 2 — says: "${await says(alice)}"` },
      )
      .toBe(true)
      .finally(async () => log('levelling', { says: await says(alice), stack: await stackCount(alice), mark: await both() }));

    try {
      await expect.poll(both, { timeout: 20_000, message: 'level 2 of 3 on both screens' }).toEqual({ alice: at(2), bob: at(2) });
    } finally {
      log('after', await both());
    }
  } finally {
    await stack.stop();
  }
});
