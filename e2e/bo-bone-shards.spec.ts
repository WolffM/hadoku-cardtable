/**
 * The operator, 2026-10-19: *"can you look at what just happened to my bone shards? something weird. it
 * seems like no target was selected for the cast?"*
 *
 * Bone Shards: "As an additional cost to cast this spell, sacrifice a creature or discard a card. Destroy
 * target creature or planeswalker." Forge asks the target first and the sacrifice after it (rule 601.2c
 * before 601.2h). In the live game the operator clicked his own Woodfall Primus 0.65 s after the cast —
 * Forge's target question — and then sat on the sacrifice question for 108 s: it drew the same aiming
 * arrow from the parked spell as the target had, and nothing of the target, so the spell looked aimed at
 * nothing. He sacrificed the Primus too, and the spell fizzled.
 *
 * Scenario `bo-bone-shards`: alice holds only Bone Shards (so its cost can only be the sacrifice), a Swamp
 * and Grizzly Bears; bob has Hill Giant. Alice chooses the Giant as the target and the Bears as the
 * sacrifice, by her own clicks. While the sacrifice is asked, the Giant shows as the spell's target and
 * hovering the Bears draws no aiming arrow. The spell resolves and destroys the Giant, and no target or
 * sacrifice was answered for her.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one this SKIPS and the
 * title says why.
 */
import { expect, test, type Page } from '@playwright/test';

import { boardCard, clickHandCard, handCardNamed, isOffered, makeTitled, offered, ownNamed, pressOffered, says, serverLog, stackCount } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** Bob's battlefield cards named `name`, as alice's screen draws them. */
const theirNamed = (page: Page, name: string): Promise<number[]> =>
  page
    .locator('.seat:not([data-viewer]) [data-zone="battlefield"] [data-board-card]')
    .evaluateAll((els, want) => els.filter((e) => e.querySelector('.card__name')?.textContent?.trim() === want).map((e) => Number(e.getAttribute('data-board-card'))), name);

/** Move the pointer onto a card, and what the overlay draws then. */
async function hoverArrows(page: Page, id: number): Promise<{ targeter: string | null; aimed: string[] }> {
  const box = (await boardCard(page, id).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
  await page.waitForTimeout(150);
  return page.evaluate(() => {
    const t = document.querySelector('[data-testid="targeter"]');
    return {
      targeter: t === null ? null : `${t.getAttribute('data-mode')}:${t.getAttribute('data-source')}→${t.getAttribute('data-target') ?? '-'}`,
      aimed: [...document.querySelectorAll('[data-testid="stack-target-arrow"][data-role="aim"]')].map((e) => e.getAttribute('data-key') ?? ''),
    };
  });
}

test(titled('Bone Shards: alice picks the target, then the sacrifice — the sacrifice shows the target and draws no aiming arrow, and the target dies'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioMatch(browser, stack, 'bo-bone-shards');
    const page = alice.page;
    await expect.poll(() => handCardNamed(page, 'Bone Shards'), { timeout: 30_000, message: 'alice holds Bone Shards' }).not.toBeUndefined();
    const shards = (await handCardNamed(page, 'Bone Shards'))!;
    await expect.poll(() => theirNamed(page, 'Hill Giant'), { timeout: 30_000, message: 'bob has Hill Giant out' }).toHaveLength(1);
    const [giant] = await theirNamed(page, 'Hill Giant');
    const [bears] = await ownNamed(page, 'Grizzly Bears');
    expect(bears, 'alice has her Grizzly Bears').not.toBeUndefined();
    await expect.poll(() => offered(page), { timeout: 45_000, message: 'Bone Shards is offered' }).toContain(shards);
    const clicksBefore = serverLog(stack).filter((r) => r.evt === 'click' && r.seat === 0).length;

    expect(await clickHandCard(page, shards), 'Bone Shards lifted and cast').toBe(true);

    // The target: Forge's first question. It aims.
    await expect.poll(() => isOffered(page, giant!), { timeout: 20_000, message: `the target is asked — says: "${await says(page)}"` }).toBe(true);
    const targeting = await hoverArrows(page, giant!);
    console.log(`[bo] target asked: says="${(await says(page)).replace(/\s+/g, ' ')}" hover giant→ ${JSON.stringify(targeting)}`);
    expect(targeting.targeter, 'the target question aims from Bone Shards').toMatch(new RegExp(`^click:${shards}→card:${giant}$`));
    expect(await pressOffered(boardCard(page, giant!)), 'alice picks the Giant').toBe(true);

    // The sacrifice: Forge's next question, after the {B} is paid from the one Swamp.
    await expect.poll(() => isOffered(page, bears!), { timeout: 20_000, message: `the sacrifice is asked — says: "${await says(page)}"` }).toBe(true);
    expect(await isOffered(page, giant!), 'the sacrifice offers only her own creatures').toBe(false);
    const paying = await hoverArrows(page, bears!);
    console.log(`[bo] sacrifice asked: says="${(await says(page)).replace(/\s+/g, ' ')}" hover bears→ ${JSON.stringify(paying)}`);
    expect(paying.aimed, 'the Giant shows as the target already chosen').toEqual([`aim:card:${giant}`]);
    expect(paying.targeter, 'the sacrifice is not aimed: no aiming arrow').toBeNull();
    expect(await pressOffered(boardCard(page, bears!)), 'alice picks the Bears').toBe(true);

    await expect.poll(() => stackCount(page), { timeout: 20_000, message: 'Bone Shards resolved' }).toBe(0);
    await expect.poll(() => theirNamed(page, 'Hill Giant'), { timeout: 15_000, message: 'the Giant died' }).toHaveLength(0);
    expect(await ownNamed(page, 'Grizzly Bears'), 'the Bears were sacrificed').toHaveLength(0);
    await expect(page.locator('[data-testid="stack-target-arrow"][data-role="aim"]'), 'nothing aimed is left behind').toHaveCount(0);

    // Nothing was chosen for her: the target and the sacrifice are her own two clicks, and the only
    // ask the server answered is the one-way choice of the additional cost.
    const rows = serverLog(stack).filter((r) => r.seat === 0);
    const clicks = rows.filter((r) => r.evt === 'click').slice(clicksBefore).map((r) => Number(r.card));
    const auto = rows.filter((r) => r.evt === 'ask-auto-answered').map((r) => `${String(r.method)}:${String(r.why)}`);
    console.log(`[bo] resolved: clicks=${JSON.stringify(clicks)} auto=${JSON.stringify(auto)}`);
    expect(clicks.filter((id) => id === giant || id === bears), 'her clicks chose the Giant, then the Bears').toEqual([giant, bears]);
    expect(auto.every((a) => a.startsWith('getAbilityToPlay:')), `no question but an ability choice was answered for her: ${JSON.stringify(auto)}`).toBe(true);
  } finally {
    await stack.stop();
  }
});
