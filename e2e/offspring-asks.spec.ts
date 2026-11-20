/**
 * An optional additional cost is the player's to choose. The operator, 2026-11-19 (m-b05f9d974d63,
 * Darkstar Augur): *"Offspring was auto-payed, that's not good. offspring should always confirm with
 * the player if they want to pay it."* That match's server log has the answer given for them:
 * `auto-confirmed`, "the seat chose this ability just before", to Forge's "Pay for Offspring? {B}", 18 ms
 * after they chose the spell — the server took the question for the confirm of a cost the spell already had.
 *
 * `offspring-asks.state`: alice has two Darkstar Augurs and seven Swamps. She casts one and answers
 * No, and one Augur enters; she casts the other and answers Yes, and its 1/1 copy enters after it.
 * Neither question is answered by the server.
 */
import { expect, test, type Page } from '@playwright/test';

import { castLiftOf, clickHandCard, drawnText, makeTitled, offeredCard, ownNamed, passOverStack, pressPaymentAuto, serverLog, stackCount } from './play/board.ts';
import { answerConfirm } from './play/confirm.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch, type ScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const AUGUR = 'Darkstar Augur';

/** Forge asks it on its bar (`InputConfirm`: Yes / No), which the board draws as the confirm pop-up. */
const offspringAsked = async (page: Page): Promise<boolean> => /Offspring/.test((await drawnText(page, 'live-confirm-host')) ?? '');

/** Cast the offered Augur from her hand until Forge's Offspring question is drawn; the press is repeated only while nothing of the cast stands. */
async function castUntilAsked(page: Page): Promise<void> {
  const augur = await offeredCard(page, AUGUR, { zone: 'hand' });
  await expect
    .poll(
      async () => {
        if (await offspringAsked(page)) return true;
        if ((await castLiftOf(page, augur)) === null) await clickHandCard(page, augur, { timeout: 2_000 }).catch(() => false);
        return offspringAsked(page);
      },
      { timeout: 45_000, intervals: [500], message: 'the Offspring question is drawn for her' },
    )
    .toBe(true);
}

/** Pay what is left to her and pass both seats over the stack until her battlefield holds `count` Augurs and the stack is empty. */
async function resolveUntil(page: Page, other: Page, count: number, message: string): Promise<void> {
  await expect
    .poll(
      async () => {
        await pressPaymentAuto(page);
        await passOverStack(page);
        await passOverStack(other);
        return [(await ownNamed(page, AUGUR)).length, await stackCount(page)];
      },
      { timeout: 60_000, message },
    )
    .toEqual([count, 0]);
}

test(titled('Offspring is asked of the player: No casts the creature alone, Yes makes its copy'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  let seated: ScenarioMatch | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, 'offspring-asks');
    const page = seated.alice.page;
    const answeredForHer = () => serverLog(stack).filter((r) => r.evt === 'auto-confirmed' && r.seat === 0).map((r) => r.why);

    await castUntilAsked(page);
    expect(answeredForHer(), 'the server answered nothing for her').toEqual([]);
    await answerConfirm(page, 'no');
    await resolveUntil(page, seated.bob.page, 1, 'No: one Augur entered and nothing came after it');

    await castUntilAsked(page);
    await answerConfirm(page, 'yes');
    await resolveUntil(page, seated.bob.page, 3, 'Yes: the second Augur entered and its copy after it');
    expect(answeredForHer(), 'the server answered neither question').toEqual([]);
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});
