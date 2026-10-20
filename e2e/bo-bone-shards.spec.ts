/**
 * The operator, 2026-10-19: *"can you look at what just happened to my bone shards? something weird. it
 * seems like no target was selected for the cast?"*
 *
 * Bone Shards: "As an additional cost to cast this spell, sacrifice a creature or discard a card. Destroy
 * target creature or planeswalker." In the live game Forge asked the target first and the sacrifice after
 * it: the operator clicked his own Woodfall Primus as the target, then sacrificed the Primus too, and the
 * spell fizzled.
 *
 * The operator, 2026-10-20: *"sacrifice first makes sense to me"* — the order Arena asks in. The sacrifice
 * is CHOSEN first and still PAID after the targets (rule 601.2c before 601.2h), so the creature chosen
 * stays on the battlefield, and a legal target, until the cast is paid.
 *
 * The operator, 2026-10-20: *"yes, auto-pick the only legal sacrifice, bone shards too."*
 *
 * Scenario `bo-bone-shards-two`: alice holds only Bone Shards (so its cost can only be the sacrifice), a
 * Swamp, Grizzly Bears and Llanowar Elves; bob has Hill Giant. Casting asks the sacrifice first — only her
 * own creatures, no aiming arrow — and the target after it. Cancelling at the target puts Bone Shards
 * back in her hand with nothing sacrificed. Cast again, she sacrifices the Bears and targets the Giant by
 * her own clicks; the spell destroys the Giant, and nothing was answered for her but the one-way choice
 * of the cost.
 *
 * Scenario `bo-bone-shards`: the Bears are her only creature. The server takes them as the sacrifice
 * itself (`auto-picked`, "the only legal sacrifice") before the target is asked: the sacrifice is never
 * offered to her, the Bears are still out while she aims, and the Giant dies.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one this SKIPS and the
 * title says why.
 */
import { expect, test, type Page } from '@playwright/test';

import { boardCard, cancelCast, clickHandCard, handCardNamed, isOffered, makeTitled, offered, ownNamed, pressOffered, says, serverLog, stackCount } from './play/board.ts';
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

/** Alice's Bone Shards, bob's Hill Giant and her Grizzly Bears, once the board draws them and Bone Shards is offered. */
async function setUp(page: Page): Promise<{ shards: number; giant: number; bears: number }> {
  await expect.poll(() => handCardNamed(page, 'Bone Shards'), { timeout: 30_000, message: 'alice holds Bone Shards' }).not.toBeUndefined();
  const shards = (await handCardNamed(page, 'Bone Shards'))!;
  await expect.poll(() => theirNamed(page, 'Hill Giant'), { timeout: 30_000, message: 'bob has Hill Giant out' }).toHaveLength(1);
  const [giant] = await theirNamed(page, 'Hill Giant');
  const [bears] = await ownNamed(page, 'Grizzly Bears');
  expect(bears, 'alice has her Grizzly Bears').not.toBeUndefined();
  await expect.poll(() => offered(page), { timeout: 45_000, message: 'Bone Shards is offered' }).toContain(shards);
  return { shards, giant: giant!, bears: bears! };
}

/** Cast Bone Shards from alice's hand. */
async function cast(page: Page, round: string): Promise<number> {
  const shards = (await handCardNamed(page, 'Bone Shards'))!;
  await expect.poll(() => offered(page), { timeout: 45_000, message: `${round}: Bone Shards is offered` }).toContain(shards);
  expect(await clickHandCard(page, shards), `${round}: Bone Shards lifted and cast`).toBe(true);
  return shards;
}

/** The target is asked: the Giant is offered, the Bears are still out (chosen, not yet paid), and the question aims from Bone Shards. */
async function targetAsked(page: Page, round: string, shards: number, giant: number, bears: number): Promise<void> {
  await expect.poll(() => isOffered(page, giant), { timeout: 20_000, message: `${round}: the target is asked — says: "${await says(page)}"` }).toBe(true);
  expect(await ownNamed(page, 'Grizzly Bears'), `${round}: the Bears are not sacrificed before the cast is paid`).toEqual([bears]);
  const targeting = await hoverArrows(page, giant);
  console.log(`[bo] ${round} target asked: says="${(await says(page)).replace(/\s+/g, ' ')}" hover giant→ ${JSON.stringify(targeting)}`);
  expect(targeting.targeter, `${round}: the target question aims from Bone Shards`).toMatch(new RegExp(`^click:${shards}→card:${giant}$`));
}

/** The sacrifice is asked first: only her own creatures, nothing aimed yet, and no aiming arrow. Alice picks the Bears. */
async function sacrificeTheBears(page: Page, round: string, giant: number, bears: number): Promise<void> {
  await expect.poll(() => isOffered(page, bears), { timeout: 20_000, message: `${round}: the sacrifice is asked first — says: "${await says(page)}"` }).toBe(true);
  expect(await isOffered(page, giant), `${round}: the first question is the sacrifice, which offers only her own creatures — not the target`).toBe(false);
  const paying = await hoverArrows(page, bears);
  console.log(`[bo] ${round} sacrifice asked: says="${(await says(page)).replace(/\s+/g, ' ')}" hover bears→ ${JSON.stringify(paying)}`);
  expect(paying.targeter, `${round}: the sacrifice is not aimed: no aiming arrow`).toBeNull();
  expect(paying.aimed, `${round}: nothing is aimed yet`).toEqual([]);
  expect(await pressOffered(boardCard(page, bears)), `${round}: alice picks the Bears to sacrifice`).toBe(true);
}

/** The spell resolved: the Giant died, the Bears were sacrificed, and nothing aimed is left. */
async function resolved(page: Page): Promise<void> {
  await expect.poll(() => stackCount(page), { timeout: 20_000, message: 'Bone Shards resolved' }).toBe(0);
  await expect.poll(() => theirNamed(page, 'Hill Giant'), { timeout: 15_000, message: 'the Giant died' }).toHaveLength(0);
  expect(await ownNamed(page, 'Grizzly Bears'), 'the Bears were sacrificed').toHaveLength(0);
  await expect(page.locator('[data-testid="stack-target-arrow"][data-role="aim"]'), 'nothing aimed is left behind').toHaveCount(0);
}

test(titled('Bone Shards with two creatures: the sacrifice is asked before the target; cancelling at the target sacrifices nothing; cast again it destroys the target'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioMatch(browser, stack, 'bo-bone-shards-two');
    const page = alice.page;
    const { giant, bears } = await setUp(page);
    const clicksBefore = serverLog(stack).filter((r) => r.evt === 'click' && r.seat === 0).length;

    // Cast, choose the sacrifice, then cancel at the target: the cast rolls back with nothing paid.
    let shards = await cast(page, 'first cast');
    await sacrificeTheBears(page, 'first cast', giant, bears);
    await targetAsked(page, 'first cast', shards, giant, bears);
    await cancelCast(page);
    await expect.poll(() => handCardNamed(page, 'Bone Shards'), { timeout: 20_000, message: 'the cancelled Bone Shards is back in her hand' }).not.toBeUndefined();
    expect(await ownNamed(page, 'Grizzly Bears'), 'cancelling at the target sacrificed nothing').toEqual([bears]);
    expect((await ownNamed(page, 'Llanowar Elves')).length, 'nor the Elves').toBe(1);
    expect(await theirNamed(page, 'Hill Giant'), 'the Giant is untouched').toEqual([giant]);
    expect(await stackCount(page), 'nothing reached the stack').toBe(0);
    console.log(`[bo] cancelled at the target: bears=${JSON.stringify(await ownNamed(page, 'Grizzly Bears'))} hand=${String(await handCardNamed(page, 'Bone Shards'))}`);

    // Cast again and finish it: sacrifice the Bears, target the Giant.
    shards = await cast(page, 'second cast');
    await sacrificeTheBears(page, 'second cast', giant, bears);
    await targetAsked(page, 'second cast', shards, giant, bears);
    expect(await pressOffered(boardCard(page, giant)), 'alice picks the Giant').toBe(true);
    await resolved(page);
    expect((await ownNamed(page, 'Llanowar Elves')).length, 'the Elves stayed').toBe(1);

    // Nothing was chosen for her: the sacrifices and the target are her own clicks, and the only ask
    // the server answered is the one-way choice of the additional cost.
    const rows = serverLog(stack).filter((r) => r.seat === 0);
    const clicks = rows.filter((r) => r.evt === 'click').slice(clicksBefore).map((r) => Number(r.card));
    const auto = rows.filter((r) => r.evt === 'ask-auto-answered').map((r) => `${String(r.method)}:${String(r.why)}`);
    console.log(`[bo] resolved: clicks=${JSON.stringify(clicks)} auto=${JSON.stringify(auto)}`);
    expect(clicks.filter((id) => id === giant || id === bears), 'her clicks chose the Bears, the Bears again, then the Giant').toEqual([bears, bears, giant]);
    expect(auto.every((a) => a.startsWith('getAbilityToPlay:')), `no question but an ability choice was answered for her: ${JSON.stringify(auto)}`).toBe(true);
    expect(rows.filter((r) => r.evt === 'auto-picked'), 'no pick was made for her').toEqual([]);
  } finally {
    await stack.stop();
  }
});

test(titled('Bone Shards with one creature: the only legal sacrifice is taken for her before the target — never asked — and the target dies'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioMatch(browser, stack, 'bo-bone-shards');
    const page = alice.page;
    const { giant, bears } = await setUp(page);
    const clicksBefore = serverLog(stack).filter((r) => r.evt === 'click' && r.seat === 0).length;
    const casting = serverLog(stack).length;
    const shards = await cast(page, 'cast');
    await targetAsked(page, 'cast', shards, giant, bears);

    // From the cast until the server took the Bears, no selection reached her wire (the probe trace's
    // `wire-frame` rows): the sacrifice was never offered to her, and it was taken before the target.
    const all = serverLog(stack);
    const at = all.findIndex((r) => r.evt === 'auto-picked' && r.seat === 0);
    expect(at, 'the server took the sacrifice before the target was asked').toBeGreaterThanOrEqual(casting);
    expect(all.slice(casting, at).filter((r) => r.evt === 'wire-frame' && r.seat === 0 && r.method === 'setSelectables'), 'the sacrifice never reached her').toEqual([]);

    expect(await pressOffered(boardCard(page, giant)), 'alice picks the Giant').toBe(true);
    await resolved(page);

    const rows = serverLog(stack).filter((r) => r.seat === 0);
    const picked = rows.filter((r) => r.evt === 'auto-picked');
    const clicks = rows.filter((r) => r.evt === 'click').slice(clicksBefore).map((r) => Number(r.card));
    console.log(`[bo] resolved: clicks=${JSON.stringify(clicks)} picked=${JSON.stringify(picked)}`);
    expect(picked, 'the server took the Bears, and said why').toEqual([expect.objectContaining({ why: 'the only legal sacrifice', cards: [{ id: bears, name: 'Grizzly Bears' }] })]);
    // Every act the server sends Forge is watched as a click too: the one on the Bears is its own pick, made first.
    expect(clicks.filter((id) => id === giant || id === bears), 'the Bears were picked once, by the server, then she chose the Giant').toEqual([bears, giant]);
  } finally {
    await stack.stop();
  }
});
