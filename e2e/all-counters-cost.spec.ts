/**
 * A mandatory part of a cost the player chose to pay is not asked again. "Remove all counters?" is the
 * one cost question Forge raises itself rather than through its payment confirm
 * (`HumanCostDecision.visit(CostRemoveCounter)`, for a cost that removes every counter from its own
 * source: Sage of Hours, Jar of Eyeballs, Essence Bottle, Hankyu), so it carried no mark of being a
 * cost and was put to the player once only marked confirms were answered for them. Clicking the
 * permanent already said yes; declining only cancels the activation.
 *
 * `all-counters-cost.state`: alice's Sage of Hours has three +1/+1 counters. She clicks it: no yes/no
 * is drawn, its ability goes on the stack and the counters are gone. `offspring-asks.spec.ts` holds
 * the other side: an optional additional cost is still asked.
 */
import { expect, test } from '@playwright/test';

import { boardCard, clickPermanent, makeTitled, ownNamed, passOverStack, says, serverLog, stackCount } from './play/board.ts';
import { confirmOpen } from './play/confirm.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch, type ScenarioMatch } from './play/scenario.ts';
import { recordSurface } from './play/surface.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

test(titled('a cost that removes all counters from its source is paid on the click: no yes/no, the ability on the stack, the counters gone'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  let seated: ScenarioMatch | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, 'all-counters-cost');
    const page = seated.alice.page;
    const confirms = await recordSurface(page, '[data-testid="live-confirm"]');
    const stackSeen = await recordSurface(page, '[data-zone="stack"]', { attrs: ['data-count'], shown: 'present' });
    const answeredForHer = () => serverLog(stack).filter((r) => r.evt === 'auto-confirmed' && r.seat === 0).map((r) => r.why);

    const [sage] = await ownNamed(page, 'Sage of Hours');
    expect(sage, 'alice controls Sage of Hours').toBeDefined();
    const counters = boardCard(page, sage!).locator('[data-counter]');
    await expect(counters, 'the Sage starts with its three counters').toHaveAttribute('data-count', '3', { timeout: 30_000 });

    expect(await clickPermanent(page, sage!), 'the Sage took the click').toBe(true);
    await expect
      .poll(
        async () => {
          if (await confirmOpen(page)) return `asked: "${await says(page)}"`;
          return (await counters.count()) === 0 ? 'paid' : 'waiting';
        },
        { timeout: 30_000, intervals: [100], message: 'the counters are removed without a question' },
      )
      .toBe('paid');

    await expect
      .poll(
        async () => {
          await passOverStack(page);
          await passOverStack(seated!.bob.page);
          return stackCount(page);
        },
        { timeout: 45_000, message: 'the ability resolves' },
      )
      .toBe(0);

    expect((await stackSeen.rows()).map((r) => r.attrs['data-count']), 'the ability went on the stack').toContain('1');
    expect((await confirms.rows()).filter((r) => r.shown).map((r) => r.text), 'alice was asked nothing').toEqual([]);
    expect(answeredForHer(), 'the server answered the cost for her').toEqual(['the seat chose this ability just before']);
    expect(await ownNamed(page, 'Sage of Hours'), 'the Sage is still hers').toEqual([sage]);
    expect(await counters.count(), 'no counter is left on it').toBe(0);
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});
