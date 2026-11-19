/**
 * A block Forge would refuse cannot be declared, against a real Forge match.
 *
 * The operator: *"when a menace creature is attacking, if i only assign one creature to block then it
 * should not allow me to click 'Done Blocking' one creature assigned as blocker to menace attacker
 * should make that button disabled until i remove the blocker again"*.
 *
 * Forge's `InputBlock` enables its OK whatever the blocks are and checks them only once it is pressed
 * (`CombatUtil.validateBlocks`, `InputBlock.java:100-111`): the press is refused with a message and
 * the window stays open. The bridge sends that validator's verdict on every bar the input sends
 * (`refusal1`, `PlayBridge.java`'s `buttonOneRefusal`); Done Blocking is off while it is set, and its
 * hover says why.
 *
 * Scenario `menace-block`: bob (seat 1) attacks alice (seat 0) with Boggart Brute (3/2, menace);
 * alice holds two Walls of Stone (0/8).
 *
 * - One wall on the Brute: Done Blocking is disabled, its tooltip names the Brute.
 * - The second wall joins: enabled; Done; at Combat Damage both walls block the Brute.
 * - Or the one wall leaves: enabled; Done; nothing blocks, and the Brute's 3 reach alice.
 *
 * The lone wall's block arrow is BRITTLE (the operator's pick, 2026-11-18, replacing AF637's
 * broken-shield corner mark): faded, cracked into uneven chunks that stand still, its head hollow,
 * shaking now and then (`gestures/arrow.ts`'s `crack`) — on alice's screen AND bob's, since it rides
 * the shared combat view (`live/match.ts`'s `insufficientBlockers`), not an `InputBlock` only alice
 * runs. A second wall knits it into the solid ribbon, both arrows solid; if the wall leaves instead,
 * its arrow simply goes.
 *
 * Every step prints one `[menace-block]` line.
 */

import { expect, test, type Page } from '@playwright/test';

import { enabledOk, lifeOf, makeTitled, says } from './play/board.ts';
import { assignBlock, attackingCards, decisionOk, decisionOkTip, ownBattlefieldCards, passDeclareAttackers, phaseOf, undoBlock } from './play/combat.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { answerPrompt } from './play/prompts.ts';
import { startScenarioMatch } from './play/scenario.ts';
import { pressInMenu } from './play/phone.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const log = (step: string, data: unknown): void => console.log(`[menace-block] ${JSON.stringify({ step, data })}`);

/** Every block arrow `page` draws, as `blocker>attacker`, sorted. */
async function blocks(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid="stack-target-arrow"][data-key^="block:"]'))
      .map((el) => (el.getAttribute('data-key') ?? '').split(':').slice(1).join('>'))
      .sort(),
  );
}

/** Alice's own life total, as her screen draws it. */
const ownLife = async (page: Page): Promise<string | null> => (await lifeOf(page, 'me').textContent())?.trim() ?? null;

/**
 * How `page` draws the block arrow from `blocker` to `attacker`: `brittle` (cracked stems that stand
 * still, the shaft hidden, the shake running, and not a ghost), `solid` (the ribbon, no stems), or
 * `none`. Read the same way on alice's screen and bob's.
 */
const blockArrow = (page: Page, blocker: number, attacker: number): Promise<'brittle' | 'solid' | 'none' | string> =>
  page.evaluate((key) => {
    const svg = document.querySelector<SVGSVGElement>(`[data-testid="stack-target-arrow"][data-key="${key}"]`);
    if (svg === null) return 'none';
    const stems = [...svg.querySelectorAll<SVGPathElement>('.arrow__stem')];
    const shaft = svg.querySelector('.arrow__shaft');
    const shaftShown = shaft !== null && getComputedStyle(shaft).display !== 'none';
    if (!svg.hasAttribute('data-brittle')) return stems.length === 0 && shaftShown ? 'solid' : `closing:${stems.length}`;
    const still = stems.every((p) => getComputedStyle(p).animationName === 'none');
    const shakes = getComputedStyle(svg).animationName === 'arrow-jitter';
    const ok = stems.length === 2 && still && !shaftShown && !svg.hasAttribute('data-ghost') && (shakes || svg.hasAttribute('data-closing'));
    return ok ? 'brittle' : `odd:${JSON.stringify({ stems: stems.length, still, shaftShown, shakes })}`;
  }, `block:${blocker}:${attacker}`);

/**
 * Whether the brittle arrow shakes within one jitter period: its svg's own transform, sampled through
 * 3.5 s, leaves identity at least once and is back at rest at the end of the window it was read in.
 */
const shakes = (page: Page, blocker: number, attacker: number): Promise<{ moved: number; samples: number }> =>
  page.evaluate(async (key) => {
    const svg = document.querySelector<SVGSVGElement>(`[data-testid="stack-target-arrow"][data-key="${key}"]`);
    let moved = 0;
    let samples = 0;
    const until = performance.now() + 3_500;
    while (performance.now() < until) {
      const t = svg === null ? 'none' : getComputedStyle(svg).transform;
      if (t !== 'none' && t !== 'matrix(1, 0, 0, 1, 0, 0)') moved += 1;
      samples += 1;
      await new Promise((r) => setTimeout(r, 40));
    }
    return { moved, samples };
  }, `block:${blocker}:${attacker}`);

/** No combat chip on the card any more (the operator, 2026-11-18): the arrows say it. */
const chips = (page: Page, cardId: number): Promise<number> =>
  page.locator(`[data-board-card="${cardId}"] > .board-card__marks > [data-mark]:not([data-mark="sick"], [data-mark="cantBlock"])`).count();

/** The match up to alice's open block window: the Brute's id and her two walls. */
async function openBlockWindow(alice: Page, bob: Page): Promise<{ brute: number; x: number; y: number }> {
  const ids = async (l: ReturnType<typeof attackingCards>): Promise<number[]> =>
    (await l.evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-board-card'))))).sort((a, b) => a - b);
  await expect(attackingCards(alice), 'the scenario declared the Brute attacking').toHaveCount(1);
  await expect(ownBattlefieldCards(alice), 'alice holds two walls').toHaveCount(2);
  const [brute] = (await ids(attackingCards(alice))) as [number];
  const [x, y] = (await ids(ownBattlefieldCards(alice))) as [number, number];
  await passDeclareAttackers(bob);
  await expect.poll(() => says(alice), { timeout: 90_000, message: 'the block window is open for alice' }).toMatch(/select creatures to block/i);
  await expect(decisionOk(alice), 'no block at all is a legal block').toBeEnabled();
  await expect(decisionOk(alice)).toHaveText('Done Blocking');
  return { brute, x, y };
}

/** One wall on the Brute: Done Blocking off, saying why on hover; its block arrow brittle, both screens. */
async function oneBlockerRefused(alice: Page, bob: Page, brute: number, x: number): Promise<void> {
  await assignBlock(alice, x, brute);
  await expect.poll(() => blocks(alice), { timeout: 10_000, message: 'the wall blocks the Brute' }).toEqual([`${x}>${brute}`]);
  // Forge's next bar answers the block; read the button once it has.
  try {
    await expect(decisionOk(alice), 'one blocker on a menace attacker: Done Blocking is off').toBeDisabled({ timeout: 5_000 });
  } finally {
    log('one blocker', { disabled: await decisionOk(alice).isDisabled(), says: await says(alice) });
  }
  const tip = await decisionOkTip(alice);
  log('one blocker tip', tip);
  expect(tip, 'the hover says why, in Forge’s words, by name').toMatch(/^Boggart Brute cannot be blocked with 1 creatures/);

  // The lone wall's arrow is brittle, on alice's screen AND bob's, and no chip says it instead.
  await expect.poll(() => blockArrow(alice, x, brute), { timeout: 10_000, message: "the lone wall's arrow is brittle on alice's screen" }).toBe('brittle');
  await expect.poll(() => blockArrow(bob, x, brute), { timeout: 10_000, message: "and on bob's screen too" }).toBe('brittle');
  expect(await chips(alice, x), 'no chip on the wall').toBe(0);
  expect(await chips(bob, x), 'nor on bob’s').toBe(0);
  const shake = await shakes(alice, x, brute);
  log('one blocker shake', shake);
  expect(shake.moved, 'it shakes within one 3 s period').toBeGreaterThan(0);
  expect(shake.moved, 'briefly, then still').toBeLessThan(shake.samples / 2);
  log('one blocker arrow', { alice: await blockArrow(alice, x, brute), bob: await blockArrow(bob, x, brute) });
}

/**
 * Hold the game at each step with full control, press Done, and wait for Combat Damage. Two blockers
 * on one attacker ask bob to divide its damage (`assignCombatDamage`); he takes Forge's default.
 */
async function declare(alice: Page, bob: Page): Promise<void> {
  await pressInMenu(alice, 'live-full-control');
  await expect(alice.getByTestId('live-full-control')).toHaveAttribute('aria-pressed', 'true');
  await decisionOk(alice).click();
  await expect.poll(() => enabledOk(alice).count(), { timeout: 10_000, message: 'alice’s own priority opens, held by full control' }).toBeGreaterThan(0);
  await enabledOk(alice).click();
  await expect
    .poll(
      async () => {
        await answerPrompt(bob);
        return (await phaseOf(alice))?.phase ?? '';
      },
      { timeout: 15_000, message: 'Forge is held at Combat Damage Step by full control' },
    )
    .toBe('COMBAT_DAMAGE');
}

test(titled('a menace attacker with one blocker: Done Blocking is off and says why; a second blocker turns it on, and Forge declares both'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  let seated: Awaited<ReturnType<typeof startScenarioMatch>> | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, 'menace-block');
    const alice = seated.alice.page;
    const bob = seated.bob.page;
    const { brute, x, y } = await openBlockWindow(alice, bob);
    await oneBlockerRefused(alice, bob, brute, x);

    await assignBlock(alice, y, brute);
    await expect.poll(() => blocks(alice), { timeout: 10_000, message: 'both walls block the Brute' }).toEqual([`${x}>${brute}`, `${y}>${brute}`].sort());
    await expect(decisionOk(alice), 'two blockers: Done Blocking is on').toBeEnabled({ timeout: 5_000 });
    const tip = await decisionOkTip(alice);
    log('two blockers', { disabled: await decisionOk(alice).isDisabled(), tip });
    expect(tip, 'nothing to explain').toBeNull();

    // A second blocker knits the first wall's arrow into the ribbon: both arrows solid, on both screens.
    for (const [who, page] of [['alice', alice], ['bob', bob]] as const) {
      await expect.poll(() => blockArrow(page, x, brute), { timeout: 10_000, message: `${who}: the first wall's arrow knits solid` }).toBe('solid');
      await expect.poll(() => blockArrow(page, y, brute), { timeout: 10_000, message: `${who}: the second wall's arrow is solid` }).toBe('solid');
    }
    log('two blockers arrows', { alice: [await blockArrow(alice, x, brute), await blockArrow(alice, y, brute)], bob: [await blockArrow(bob, x, brute), await blockArrow(bob, y, brute)] });

    await declare(alice, bob);
    log('declared', { alice: await blocks(alice), bob: await blocks(seated.bob.page) });
    expect(await blocks(alice), 'Forge declared both walls on the Brute').toEqual([`${x}>${brute}`, `${y}>${brute}`].sort());
    expect(await blocks(seated.bob.page), 'bob sees the same block').toEqual([`${x}>${brute}`, `${y}>${brute}`].sort());
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});

test(titled('a menace attacker with one blocker: removing the blocker turns Done Blocking on, and the Brute is unblocked'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  let seated: Awaited<ReturnType<typeof startScenarioMatch>> | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, 'menace-block');
    const alice = seated.alice.page;
    const bob = seated.bob.page;
    const { brute, x } = await openBlockWindow(alice, bob);
    await oneBlockerRefused(alice, bob, brute, x);

    await undoBlock(alice, x);
    await expect.poll(() => blocks(alice), { timeout: 10_000, message: 'the wall leaves combat' }).toEqual([]);
    await expect(decisionOk(alice), 'no blocker: Done Blocking is on').toBeEnabled({ timeout: 5_000 });
    log('blocker removed', { disabled: await decisionOk(alice).isDisabled(), tip: await decisionOkTip(alice) });

    // The wall left combat, so its arrow simply goes — both screens.
    await expect.poll(() => blockArrow(alice, x, brute), { timeout: 10_000, message: "the arrow goes on alice's screen once the blocker leaves" }).toBe('none');
    await expect.poll(() => blockArrow(bob, x, brute), { timeout: 10_000, message: "and on bob's" }).toBe('none');

    await declare(alice, bob);
    expect(await blocks(alice), 'nothing blocks').toEqual([]);
    await expect.poll(() => ownLife(alice), { timeout: 10_000, message: 'the unblocked Brute’s 3 reach alice' }).toBe('17');
    log('declared', { life: await ownLife(alice) });
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});
