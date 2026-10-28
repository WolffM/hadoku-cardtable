/**
 * A coin flipped in the game is the toss's own coin, on both screens (the operator, 2026-10-27: "for
 * coin flip we should just use the coinflip animation we already have"). Forge tells a flip as a word;
 * the bridge hands the seats the flip itself, and the coin lands on the face it came up.
 *
 * `wd-coin.state`: alice casts Stitch in Time and calls heads. On both screens the coin flips and lands
 * on the face Forge's flip came up — heads when she won the call, tails when she lost — ringed as won or
 * lost; alice's coin is her own, bob's the other seat's.
 */
import { expect, test, type Page } from '@playwright/test';

import { castUntilOnStack, handCardNamed, makeTitled, says } from './play/board.ts';
import { answerConfirm, confirmOpen } from './play/confirm.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch, type ScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** The landed in-game coin on `page`: its face, the call's outcome, whose it is and its words — null until one has landed. */
async function landed(page: Page): Promise<{ outcome: string; won: string; flipper: string; caption: string } | null> {
  return page.evaluate(() => {
    const coin = document.querySelector<HTMLElement>('[data-testid="coin-flip"]:not([data-flipping])');
    if (coin === null) return null;
    const { outcome = '', won = '', flipper = '' } = coin.dataset;
    return { outcome, won, flipper, caption: coin.querySelector('.coin-toss__name')?.textContent ?? '' };
  });
}

test(titled('Stitch in Time’s called flip: both screens flip the toss’s coin and land it on Forge’s face'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  let seated: ScenarioMatch | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, 'wd-coin');
    const alice = seated.alice.page;
    const bob = seated.bob.page;
    await expect.poll(() => handCardNamed(alice, 'Stitch in Time'), { timeout: 45_000, message: 'alice holds Stitch in Time' }).toBeDefined();
    await castUntilOnStack(alice, stack, (await handCardNamed(alice, 'Stitch in Time'))!, []);
    await expect.poll(() => says(alice), { timeout: 20_000, message: 'alice is asked to call the coin' }).toContain('Call coin flip');
    await expect.poll(() => confirmOpen(alice), { timeout: 10_000, message: 'the call is a two-button question' }).toBe(true);
    await answerConfirm(alice, 'yes'); // heads

    await expect(alice.getByTestId('coin-flip'), 'the coin flips on alice’s screen').toHaveCount(1, { timeout: 30_000 });
    type Landed = NonNullable<Awaited<ReturnType<typeof landed>>>;
    const seen: { alice?: Landed; bob?: Landed } = {};
    await expect.poll(async () => (seen.alice ??= (await landed(alice)) ?? undefined), { timeout: 5_000, message: 'it lands on alice’s screen' }).toBeDefined();
    await expect.poll(async () => (seen.bob ??= (await landed(bob)) ?? undefined), { timeout: 10_000, message: 'it lands on bob’s screen' }).toBeDefined();
    const mine = seen.alice!;
    const theirs = seen.bob!;
    console.log(`[wd-coin] alice ${JSON.stringify(mine)} bob ${JSON.stringify(theirs)}`);
    expect(mine.outcome, 'heads called: heads is a win').toBe(mine.won === 'true' ? 'heads' : 'tails');
    expect(mine.flipper).toBe('you');
    expect(theirs).toMatchObject({ outcome: mine.outcome, won: mine.won, flipper: 'them' });
    expect(mine.caption).toBe(mine.won === 'true' ? 'You win the flip' : 'You lose the flip');
    expect(theirs.caption).toBe(mine.won === 'true' ? 'Alice wins the flip' : 'Alice loses the flip');
    await expect(alice.getByTestId('coin-flip'), 'the coin leaves a moment after it lands').toHaveCount(0, { timeout: 10_000 });
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});
