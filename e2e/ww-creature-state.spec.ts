/**
 * Three of the operator's playtest items, on one real-Forge board (`ww-creature-state.state`):
 *
 *  1. *"should be able to see that creature is flying … a tag on the creature when they gain
 *     flying. i just had an enchantment attached to a creature and didn't see it gain its new
 *     tag."* Arcane Flight goes on Grizzly Bears; both screens tag it and float it.
 *  2. *"blocking is unclear … maybe also we need to have creatures animate or become larger …
 *     when its time to do something with them?"* In the declare-attackers window the creatures
 *     Forge says can attack grow and lift; the sick one does not; the battlefield does not scroll.
 *  3. *"when planeswalkers become creatures they should get power and toughness."* Gideon
 *     Blackblade on his own turn is a 4/4 planeswalker creature: both screens draw 4/4 beside
 *     his loyalty.
 *
 * Every step prints one `[ww-creature-state]` line, green or red.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one each test
 * SKIPS and its title says why. Serves the prebuilt `apps/ui/dist` — rebuild before running.
 */

import { expect, test, type Page } from '@playwright/test';

import { castUntilOnStack, clickHandCard, clickOnce, enabledOk, makeTitled, offeredNamed, says, stackCount } from './play/board.ts';
import { phaseOf } from './play/combat.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const SCENARIO = 'ww-creature-state';
const log = (step: string, data: unknown): void => console.log(`[ww-creature-state] ${JSON.stringify({ step, data })}`);

/** The battlefield card of this name on `owner`'s side as `page` draws it, by id. */
async function battlefieldNamed(page: Page, owner: 'you' | 'them', name: string): Promise<number> {
  let id: number | undefined;
  await expect
    .poll(
      async () => {
        const cards = await page
          .locator(`[data-zone="battlefield"][data-owner="${owner}"] [data-board-card]`)
          .evaluateAll((els) => els.map((e) => ({ id: Number(e.getAttribute('data-board-card')), name: e.querySelector('.card__name')?.textContent?.trim() ?? '' })));
        id = cards.find((c) => c.name === name)?.id;
        return id;
      },
      { timeout: 30_000, message: `${name} is on the ${owner} battlefield` },
    )
    .not.toBeUndefined();
  return id!;
}

interface Afloat {
  tags: string[];
  flying: boolean;
  translate: string;
  animation: string;
}

/** A card's keyword tags and whether its art floats, as `page` draws them. */
function afloat(page: Page, id: number): Promise<Afloat | null> {
  return page.evaluate((cardId) => {
    const li = document.querySelector<HTMLElement>(`[data-board-card="${cardId}"]`);
    const art = li?.querySelector<HTMLElement>(':scope > .board-card__face > .card');
    if (li === null || li === undefined || art === null || art === undefined) return null;
    const style = getComputedStyle(art);
    return {
      tags: Array.from(li.querySelectorAll(':scope > .board-card__tags > [data-keyword]')).map((t) => t.textContent ?? ''),
      flying: li.hasAttribute('data-flying'),
      translate: style.translate,
      animation: style.animationName,
    };
  }, id);
}

interface Emphasis {
  ready: number[];
  scaleOf: Record<number, string>;
  scrolls: string | null;
}

/** Which cards are drawn combat-ready, each named card's face scale, and whether the viewer's battlefield scrolls. */
function emphasis(page: Page, ids: number[]): Promise<Emphasis> {
  return page.evaluate((cardIds) => {
    const scaleOf: Record<number, string> = {};
    for (const id of cardIds) {
      const face = document.querySelector<HTMLElement>(`[data-board-card="${id}"] > .board-card__face`);
      scaleOf[id] = face === null ? 'absent' : getComputedStyle(face).scale;
    }
    const zone = document.querySelector<HTMLElement>('.seat[data-viewer] [data-zone="battlefield"]');
    const scrolls =
      zone === null
        ? 'no battlefield'
        : zone.scrollHeight > zone.clientHeight + 1 || zone.scrollWidth > zone.clientWidth + 1
          ? `${zone.scrollWidth}x${zone.scrollHeight} in ${zone.clientWidth}x${zone.clientHeight}`
          : null;
    return {
      ready: Array.from(document.querySelectorAll('[data-combat-ready]')).map((el) => Number(el.getAttribute('data-board-card'))).sort((a, b) => a - b),
      scaleOf,
      scrolls,
    };
  }, ids);
}

/** Press alice's OK at her Main 1 priority until Forge's live `InputAttack` opens. */
async function passToDeclareAttackers(page: Page): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!/^Select creatures to attack/i.test(await says(page)) && Date.now() < deadline) {
    const text = await says(page);
    if (/^Priority:/.test(text) && (await enabledOk(page).count()) > 0) await clickOnce(page, text, 'ok');
    await page.waitForTimeout(40);
  }
  await expect.poll(() => says(page), { timeout: 5_000, message: 'the live declare-attackers window opened' }).toMatch(/^Select creatures to attack/i);
}

test(titled('an aura that grants flying tags the creature and floats it, on both screens'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);

  const stack = await startPlayStack(forge);
  let seated: Awaited<ReturnType<typeof startScenarioMatch>> | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, SCENARIO);
    const { alice, bob } = seated;
    const bears = await battlefieldNamed(alice.page, 'you', 'Grizzly Bears');
    await battlefieldNamed(bob.page, 'them', 'Grizzly Bears');
    const before = { alice: await afloat(alice.page, bears), bob: await afloat(bob.page, bears) };
    log('before the aura', { bears, ...before });
    expect(before.alice?.tags, 'no tag before the aura').toEqual([]);
    expect(before.alice?.flying, 'no float before the aura').toBe(false);

    await alice.page.getByTestId('live-full-control').click();
    await expect(alice.page.getByTestId('live-full-control')).toHaveAttribute('aria-pressed', 'true');

    let aura: number | undefined;
    await expect.poll(async () => (aura = await offeredNamed(alice.page, 'Arcane Flight')), { timeout: 30_000, message: 'Arcane Flight is offered' }).not.toBeUndefined();
    await clickHandCard(alice.page, aura!);
    const target = alice.page.locator(`[data-board-card="${bears}"]`);
    await castUntilOnStack(alice.page, stack, async () => {
      if ((await target.getAttribute('data-selectable')) === null) return false;
      const box = await target.boundingBox();
      if (box === null) return false;
      await alice.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      return true;
    });
    const resolvedBy = Date.now() + 20_000;
    while ((await stackCount(alice.page)) > 0 && Date.now() < resolvedBy) {
      for (const page of [alice.page, bob.page]) {
        const ok = page.getByTestId('live-decision-ok');
        if ((await ok.count()) > 0) await ok.click().catch(() => undefined);
      }
      await alice.page.waitForTimeout(40);
    }
    expect(await stackCount(alice.page), 'Arcane Flight resolved').toBe(0);

    for (const [who, page] of [
      ['alice', alice.page],
      ['bob', bob.page],
    ] as const) {
      let seen: Afloat | null = null;
      try {
        await expect
          .poll(async () => (seen = await afloat(page, bears))?.tags, { timeout: 15_000, message: `${who}: the Bears wear a Flying tag once the aura grants it` })
          .toContain('Flying');
        expect(seen!.flying, `${who}: the Bears float`).toBe(true);
        expect(seen!.translate, `${who}: the art is lifted`).not.toMatch(/^(none|0px)$/);
        if (who === 'alice') expect(seen!.animation, `${who}: and drifts`).toBe('card-float');
      } finally {
        log(`after the aura (${who})`, seen);
      }
    }
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});

test(titled('declaring attackers lifts the creatures that can attack, not the rest, and the battlefield does not scroll'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);

  const stack = await startPlayStack(forge);
  let seated: Awaited<ReturnType<typeof startScenarioMatch>> | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, SCENARIO);
    const { alice, bob } = seated;
    const bears = await battlefieldNamed(alice.page, 'you', 'Grizzly Bears');
    const giant = await battlefieldNamed(alice.page, 'you', 'Hill Giant');
    const island = await battlefieldNamed(alice.page, 'you', 'Island');
    const ids = [bears, giant, island];
    const atMain = await emphasis(alice.page, ids);
    log('main phase', { bears, giant, island, ...atMain });
    expect(atMain.ready, 'nothing is combat-ready outside the window').toEqual([]);

    await passToDeclareAttackers(alice.page);
    let seen: Emphasis | null = null;
    try {
      await expect
        .poll(async () => (seen = await emphasis(alice.page, ids)).ready, { timeout: 10_000, message: 'the Bears are drawn ready to attack' })
        .toContain(bears);
    } finally {
      log('declare attackers open (alice)', seen);
    }
    // Measured once the growth has settled: the battlefield must hold the creature at its full size.
    try {
      await expect
        .poll(async () => (seen = await emphasis(alice.page, ids)).scaleOf[bears], { timeout: 5_000, message: 'the Bears are drawn larger' })
        .toBe('1.06');
    } finally {
      log('declare attackers settled (alice)', seen);
    }
    const open = seen!;
    expect(open.ready, 'the summoning-sick Hill Giant is not').not.toContain(giant);
    expect(open.ready, 'a land is not').not.toContain(island);
    expect(open.scaleOf[giant], 'the Hill Giant is not').toBe('none');
    expect(open.scrolls, 'the battlefield does not scroll inside itself').toBeNull();
    const onBob = await emphasis(bob.page, ids);
    log('declare attackers open (bob)', onBob);
    expect(onBob.ready, 'the defender sees no attack emphasis').toEqual([]);

    await alice.page.locator(`[data-board-card="${bears}"] button`).first().click();
    await expect(alice.page.locator(`[data-board-card="${bears}"]`), 'the Bears are declared').toHaveAttribute('data-attacking', 'true', { timeout: 10_000 });
    await expect.poll(async () => (await emphasis(alice.page, ids)).ready, { timeout: 10_000, message: 'a declared attacker is no longer emphasised' }).not.toContain(bears);
    log('bears declared', await emphasis(alice.page, ids));

    // Done attacking: the window's own OK, pressed by state — only while the window is still open.
    await expect
      .poll(
        async () => {
          const text = await says(alice.page);
          if (/^Select creatures to attack/i.test(text)) await clickOnce(alice.page, text, 'ok');
          return (await emphasis(alice.page, ids)).ready;
        },
        { timeout: 15_000, message: 'the emphasis ends with the window' },
      )
      .toEqual([]);
    await expect
      .poll(async () => (await phaseOf(alice.page))?.phase, { timeout: 30_000, message: 'the game moves past declare attackers' })
      .not.toBe('COMBAT_DECLARE_ATTACKERS');
    const after = await emphasis(alice.page, ids);
    log('window closed', { phase: (await phaseOf(alice.page))?.phase, ...after });
    expect(after.ready, 'and stays ended').toEqual([]);
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});

test(titled('a planeswalker that is a creature (Gideon Blackblade on his turn) shows its power and toughness beside its loyalty'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(2 * 60_000);

  const stack = await startPlayStack(forge);
  let seated: Awaited<ReturnType<typeof startScenarioMatch>> | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, SCENARIO);
    const { alice, bob } = seated;
    for (const [who, page, owner] of [
      ['alice', alice.page, 'you'],
      ['bob', bob.page, 'them'],
    ] as const) {
      const gideon = await battlefieldNamed(page, owner, 'Gideon Blackblade');
      const badges = (): Promise<string[][]> =>
        page
          .locator(`[data-board-card="${gideon}"] > .board-card__pt`)
          .evaluateAll((els) => els.map((el) => [el.getAttribute('data-pt') ?? '', el.textContent ?? '']));
      let seen: string[][] = [];
      try {
        await expect
          .poll(async () => (seen = await badges()), { timeout: 15_000, message: `${who}: Gideon shows 4/4 beside his loyalty` })
          .toEqual([
            ['loyalty', '4'],
            ['', '4/4'],
          ]);
      } finally {
        log(`gideon badges (${who})`, { gideon, seen });
      }
    }
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});
