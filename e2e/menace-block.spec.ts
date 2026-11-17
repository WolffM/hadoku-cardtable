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
 * AF637 (the operator, 2026-11-16): the lone wall ALSO carries its own corner mark
 * (`Board.tsx`'s `StateMarks`, `data-mark="underBlocked"`) — on alice's screen AND bob's, since it
 * rides the shared combat view, not an `InputBlock` only alice runs — gone once the second wall
 * joins or the first one leaves.
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
 * AF637: whether `cardId`'s own corner marks carry the "needs another blocker" mark, on `page` —
 * read the same way on alice's screen and bob's, since it rides the shared combat view
 * (`live/match.ts`'s `insufficientBlockers`), never an `InputBlock` only one of them runs.
 */
const underBlocked = (page: Page, cardId: number): Promise<boolean> =>
  page.locator(`[data-board-card="${cardId}"] > .board-card__marks > [data-mark="underBlocked"]`).count().then((n) => n > 0);

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

/** One wall on the Brute: Done Blocking off, saying why on hover; AF637's mark on the wall, both screens. */
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

  // AF637: the lone wall itself carries the insufficient-block mark, on alice's screen AND bob's.
  await expect.poll(() => underBlocked(alice, x), { timeout: 10_000, message: "the lone wall shows AF637's mark on alice's screen" }).toBe(true);
  await expect.poll(() => underBlocked(bob, x), { timeout: 10_000, message: "and on bob's screen too" }).toBe(true);
  log('one blocker mark', { alice: await underBlocked(alice, x), bob: await underBlocked(bob, x) });
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

    // AF637: a second blocker resolves it — the mark is gone, on both screens, from the ORIGINAL wall too.
    await expect.poll(() => underBlocked(alice, x), { timeout: 10_000, message: "the mark clears on alice's screen once a second blocker joins" }).toBe(false);
    await expect.poll(() => underBlocked(bob, x), { timeout: 10_000, message: 'and on bob\'s' }).toBe(false);
    expect(await underBlocked(alice, y), 'the second wall never carried the mark either').toBe(false);

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

    // AF637: the wall left combat, so the mark leaves with it — both screens.
    await expect.poll(() => underBlocked(alice, x), { timeout: 10_000, message: "the mark clears on alice's screen once the blocker leaves" }).toBe(false);
    await expect.poll(() => underBlocked(bob, x), { timeout: 10_000, message: "and on bob's" }).toBe(false);

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
