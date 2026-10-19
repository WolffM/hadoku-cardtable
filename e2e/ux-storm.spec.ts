/**
 * The operator, 2026-10-14: *"show storm counter as an emblem if storm card in hand"* and *"mana
 * color outline box is ugly"*; and 2026-10-19, *"let's make a special zone between their name and the
 * deck symbol for this type of information"*.
 *
 * Against real Forge: `ux-storm.state` is alice's own main phase with Grapeshot and two Dark
 * Rituals in hand. While Grapeshot is in her hand her seat's status zone carries the storm count
 * (`GameView.StormCount`, spells cast this turn): 0, then 1 and 2 as she casts the Rituals — never
 * her avatar. Bob's
 * screen never shows a storm count — whether alice holds a Storm card is hidden from him. The
 * BBB the Rituals float is drawn as the Mana font's symbol and a count, with no coloured outline
 * round it, on both screens.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one this SKIPS and
 * its title says why. Serves the prebuilt `apps/ui/dist`.
 */
import { expect, test, type Page } from '@playwright/test';

import { clickHandCard, handCardNamed, makeTitled } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const OWN_STATUS = '.seat[data-viewer] [data-player-bar] > [data-seat-status]';
const stormOn = (page: Page, where: string) =>
  page.locator(`${where} [data-testid="storm-count"]`).evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-storm'))));
const anyStorm = (page: Page) => page.locator('[data-testid="storm-count"]').count();
const inGraveyard = (page: Page, id: number) => page.locator(`[data-zone="graveyard"][data-owner="you"] [data-board-card="${id}"]`).count().then((n) => n > 0);

/** Every floating-mana entry on a screen: colour, count, and the outline drawn round it. */
const poolOutlines = (page: Page) =>
  page.locator('[data-mana-pool] [data-mana]').evaluateAll((els) =>
    els.map((e) => {
      const s = getComputedStyle(e);
      return { mana: e.getAttribute('data-mana'), count: Number(e.getAttribute('data-mana-count')), border: `${s.borderTopStyle} ${s.borderTopWidth} ${s.borderTopColor}` };
    }),
  );

async function castRitual(page: Page, expectStorm: number): Promise<void> {
  const ritual = await handCardNamed(page, 'Dark Ritual');
  expect(ritual, 'a Dark Ritual in hand').not.toBeUndefined();
  for (let i = 0; i < 10 && (await handCardNamed(page, 'Dark Ritual')) === ritual; i++) {
    await clickHandCard(page, ritual!);
    await expect.poll(() => inGraveyard(page, ritual!), { timeout: 3_000 }).toBe(true).catch(() => undefined);
  }
  await expect.poll(() => inGraveyard(page, ritual!), { timeout: 20_000, message: 'the Ritual resolved' }).toBe(true);
  await expect.poll(() => stormOn(page, OWN_STATUS), { timeout: 15_000, message: `the storm count reads ${expectStorm}` }).toEqual([expectStorm]);
}

test(titled('a Storm card in hand puts the storm count in your own seat’s status zone, never on the avatar or the opponent’s screen; floating mana has no coloured outline'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'ux-storm');
    const a = alice.page;
    await expect.poll(() => handCardNamed(a, 'Grapeshot'), { timeout: 45_000, message: 'alice holds Grapeshot' }).not.toBeUndefined();
    await expect.poll(() => stormOn(a, OWN_STATUS), { timeout: 15_000, message: 'storm 0 in alice’s status zone' }).toEqual([0]);
    expect(await anyStorm(a), 'and only there: not on her avatar').toBe(1);
    console.log(`[ux-storm] start: alice ${JSON.stringify(await stormOn(a, OWN_STATUS))} bob ${await anyStorm(bob.page)}`);

    await castRitual(a, 1);
    await castRitual(a, 2);
    console.log(`[ux-storm] after two Rituals: alice ${JSON.stringify(await stormOn(a, OWN_STATUS))} bob ${await anyStorm(bob.page)}`);
    expect(await anyStorm(bob.page), 'bob never sees a storm count').toBe(0);

    for (const [who, page] of [['alice', a], ['bob', bob.page]] as const) {
      await expect.poll(async () => (await poolOutlines(page)).filter((p) => p.mana === 'B' && p.count > 0).length, { timeout: 15_000, message: `${who}: alice’s black mana floats` }).toBeGreaterThan(0);
      const pool = await poolOutlines(page);
      console.log(`[ux-storm] ${who} pool ${JSON.stringify(pool)}`);
      for (const p of pool) expect(p.border.startsWith('none'), `${who}: ${p.mana}${p.count} has no outline (${p.border})`).toBe(true);
    }
  } finally {
    await stack.stop();
  }
});
