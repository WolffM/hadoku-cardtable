/**
 * A die roll is drawn on the table, on both screens (the operator, 2026-10-27: "wizard's spellbook
 * animation? we need a dice rolling animation that would be cool"; treatment A, "Tumble from the
 * card"). Forge tells the roll as prose; the bridge hands the seats the roll itself, and the board
 * throws the die from the card that rolled it.
 *
 * Nothing is one card's: the board draws whatever roll the seat is told. `wd-dice.state`: alice taps
 * Wizard's Spellbook at the Lightning Bolt in bob's graveyard (its one legal target). On both screens a
 * d20 tumbles from the Spellbook and lands on the number Forge rolled, which the log says too —
 * alice's die her own, bob's tinted as the other seat's. Then Berserker's Frenzy: two d20, the lower
 * set aside.
 */
import { expect, test, type Page } from '@playwright/test';

import { castUntilOnStack, clickPermanent, handCardNamed, makeTitled, ownNamed, pressOffered, says } from './play/board.ts';
import { answerConfirm, confirmOpen } from './play/confirm.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch, type ScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** The landed die on `page`: its result, the face it shows, its sides and whose it is — null until one has landed. */
async function landed(page: Page): Promise<{ result: string; face: string; sides: string; roller: string } | null> {
  return page.evaluate(() => {
    const die = document.querySelector<HTMLElement>('[data-board-overlay] .board-die[data-die-landed]');
    if (die === null) return null;
    const { dieResult = '', dieFace = '', dieSides = '', dieRoller = '' } = die.dataset;
    return { result: dieResult, face: dieFace, sides: dieSides, roller: dieRoller };
  });
}

test(titled("Wizard's Spellbook rolls a d20: both screens throw the die from the card and land it on Forge's roll"), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  let seated: ScenarioMatch | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, 'wd-dice');
    const alice = seated.alice.page;
    const bob = seated.bob.page;
    await expect.poll(() => ownNamed(alice, "Wizard's Spellbook"), { timeout: 45_000, message: 'alice has her Spellbook' }).toHaveLength(1);
    // What the roll decides waits for the die (the operator, 2026-10-28: "make sure the dice roll completes before any
    // action is triggered"): alice's copy question first shows with her die already landed.
    await alice.evaluate(() => {
      const w = window as unknown as { askedInTheAir?: boolean };
      new MutationObserver((_, observer) => {
        if (document.querySelector('[data-testid="prompt-confirm-yes"]') === null) return;
        w.askedInTheAir = document.querySelector('[data-board-overlay] .board-die:not([data-die-landed])') !== null;
        observer.disconnect();
      }).observe(document.body, { childList: true, subtree: true, attributes: true });
    });
    const [book] = await ownNamed(alice, "Wizard's Spellbook");
    expect(await clickPermanent(alice, book!), 'the Spellbook is activated').toBe(true);
    // Its target: the Bolt, the top of bob's graveyard pile.
    const bolt = alice.locator('[data-zone="graveyard"][data-owner="them"] [data-board-card]', { hasText: 'Lightning Bolt' });
    await expect.poll(() => pressOffered(bolt), { timeout: 20_000, message: 'alice targets the Bolt in bob’s graveyard' }).toBe(true);

    // Thrown: the die is in flight from the Spellbook on alice's screen before it lands.
    await expect(alice.locator('[data-board-overlay] .board-die'), 'a die is thrown on alice’s screen').toHaveCount(1, { timeout: 30_000 });
    // Each read once, by the poll that saw it land: a landed die leaves the table a moment later.
    type Landed = NonNullable<Awaited<ReturnType<typeof landed>>>;
    const seen: { alice?: Landed; bob?: Landed } = {};
    await expect.poll(async () => (seen.alice ??= (await landed(alice)) ?? undefined), { timeout: 5_000, message: 'the die lands on alice’s screen' }).toBeDefined();
    await expect.poll(async () => (seen.bob ??= (await landed(bob)) ?? undefined), { timeout: 10_000, message: 'the die lands on bob’s screen' }).toBeDefined();
    const mine = seen.alice!;
    const theirs = seen.bob!;
    console.log(`[wd-dice] alice ${JSON.stringify(mine)} bob ${JSON.stringify(theirs)}`);
    expect(mine).toEqual({ result: mine.result, face: mine.result, sides: '20', roller: 'you' });
    expect(theirs).toEqual({ result: mine.result, face: mine.result, sides: '20', roller: 'them' });
    expect(Number(mine.result)).toBeGreaterThanOrEqual(1);
    expect(Number(mine.result)).toBeLessThanOrEqual(20);
    await expect(alice.getByTestId('live-log'), 'the log says the roll').toContainText(`Alice rolled ${mine.result}`);

    // The roll's "you may cast the copy": no. The die is gone a moment later; the log keeps the roll.
    await expect.poll(() => says(alice), { timeout: 20_000, message: 'alice is offered the copy' }).toContain('Do you want to play Lightning Bolt');
    await expect.poll(() => confirmOpen(alice), { timeout: 10_000, message: 'the copy is a yes-or-no question' }).toBe(true);
    expect(await alice.evaluate(() => (window as unknown as { askedInTheAir?: boolean }).askedInTheAir), 'the question waited for the die to land').toBe(false);
    await answerConfirm(alice, 'no');
    await expect(alice.locator('.board-die'), 'the die leaves the table').toHaveCount(0, { timeout: 10_000 });
    await expect(alice.getByTestId('live-log')).toContainText(`Alice rolled ${mine.result}`);

    // Any roll, not one card's: Berserker's Frenzy rolls two d20 and ignores the lower. Both dice
    // tumble on bob's screen; the ignored one lands dimmed.
    const frenzy = await handCardNamed(alice, "Berserker's Frenzy");
    expect(frenzy, "alice holds Berserker's Frenzy").toBeDefined();
    await castUntilOnStack(alice, stack, frenzy!, []);
    const pair = async (): Promise<string[]> =>
      bob.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-board-overlay] .board-die[data-die-landed]')].map((d) => `${d.dataset.dieSides}:${d.dataset.dieFace}${'dieIgnored' in d.dataset ? ' ignored' : ''}`));
    let two: string[] = [];
    await expect.poll(async () => (two = await pair()).length, { timeout: 30_000, message: 'both of the Frenzy’s dice land on bob’s screen' }).toBe(2);
    console.log(`[wd-dice] frenzy on bob's screen: ${JSON.stringify(two)}`);
    expect(two.filter((d) => d.endsWith(' ignored')), 'one die set aside').toHaveLength(1);
    expect(two.every((d) => d.startsWith('20:')), 'two d20').toBe(true);
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});
