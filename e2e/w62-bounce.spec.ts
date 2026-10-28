/**
 * Playtest 15, AE13 — the operator, 2026-10-08: *"bug with selesnya sanctuary.
 * if played as the only land, the shortcut returns it immediately. but on the
 * opponent screen it still shows 'Waiting for Bella to decide…' as if i
 * needed to make a choice there."*
 *
 * Measured against the real jar (`w62-bounce.jvm.test.ts`): the bounce's one
 * legal choice is answered by Forge itself — no ask ever reaches the server —
 * and the sentence came from the server's bar fallback, which reported an
 * ordinary "Priority: …" window with a live bar as `confirm` ("decide"). Now
 * that window is `priority`, drawn with no verb. This spec watches bob's
 * pop-out for the whole play and records every text it ever showed.
 */

import { expect, test } from '@playwright/test';

import { clickHandCard, handCardNamed, makeTitled, offeredCard, pressPaymentAuto, says, serverLog, stackCount } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { answerPrompt } from './play/prompts.ts';
import { startScenarioMatch } from './play/scenario.ts';
import { recordSurface } from './play/surface.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

test(titled('a bounceland played as the only land returns at once; the other seat is never told to "decide"'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w62-bounce');

    // Everything bob's pop-out ever says, from before the play — a poll can miss a flash.
    const pop = await recordSurface(bob.page, '[data-testid="live-waiting-pop"]');

    const land = await handCardNamed(alice.page, 'Selesnya Sanctuary');
    expect(land, 'alice holds the Sanctuary').toBeDefined();
    expect(await clickHandCard(alice.page, land!), 'the Sanctuary is played').toBe(true);

    // It enters, bounces itself, and is back in her hand — on both screens.
    const inHand = alice.page.locator('[data-zone="hand"][data-owner="you"] [data-board-card]');
    await expect.poll(async () => (await alice.page.locator('[data-zone="hand"][data-owner="you"] .card__name').allTextContents()).join('|'), { timeout: 30_000 }).toContain('Selesnya Sanctuary');
    await expect(alice.page.locator('[data-zone="battlefield"][data-owner="you"] [data-board-card]')).toHaveCount(0, { timeout: 10_000 });
    await expect(bob.page.locator('[data-zone="battlefield"][data-owner="them"] [data-board-card]')).toHaveCount(0, { timeout: 10_000 });
    await expect(bob.page.locator('[data-zone="hand"][data-owner="them"] li')).toHaveCount(await inHand.count(), { timeout: 10_000 });

    // Let the server decide her next window, then read the record.
    await bob.page.waitForTimeout(1500);
    const seen = (await pop.rows()).map((r) => r.text);
    console.log(`[w62-bounce] bob's pop-out said: ${JSON.stringify(seen)}; alice says: ${JSON.stringify(await says(alice.page))}`);
    const asks = serverLog(stack).filter((r) => r.seat === 0 && r.method === 'getAbilityToPlay' && (r.evt === 'ask-answered' || r.evt === 'ask-auto-answered'));
    console.log(`[w62-bounce] alice's getAbilityToPlay: ${asks.map((r) => (r.evt === 'ask-answered' ? `browser ${String(r.ms)} ms` : `server (${String(r.why)})`)).join(', ')}`);
    expect(seen.filter((t) => /to decide/.test(t)), `bob was told alice had a decision: ${JSON.stringify(seen)}`).toEqual([]);
    expect(seen.filter((t) => /to choose/.test(t)), `bob was told alice had a choice: ${JSON.stringify(seen)}`).toEqual([]);
  } finally {
    await stack.stop();
  }
});

/*
 * The same sentence for the other ask a seat's browser answers by itself: a counterspell's lone
 * stack target (`selfAnswer`, Mana Leak's optional "one or none"). Nobody decides it, so the
 * other screen is never told anyone is choosing — however long a loaded browser takes to reply,
 * which is why alice's page runs CPU-throttled here: the CI runners' 139–371 ms replies, every time.
 */
test(titled('a counterspell\'s lone target answers itself; the other seat is never told to "choose"'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    // lone-spell.state: bob has an uncontested MAIN1 and a free Memnite; alice holds Mana Leak + 3 Islands.
    const { alice, bob, matchId } = await startScenarioMatch(browser, stack, 'lone-spell');
    const pop = await recordSurface(bob.page, '[data-testid="live-waiting-pop"]');

    expect(await clickHandCard(bob.page, await offeredCard(bob.page, 'Memnite', { zone: 'hand', timeout: 90_000, message: 'bob is offered his Memnite' })), 'Memnite is played').toBe(true);
    await expect.poll(() => stackCount(alice.page), { timeout: 15_000, message: 'bob’s Memnite is the only thing on the stack' }).toBe(1);
    const manaLeak = await offeredCard(alice.page, 'Mana Leak', { zone: 'hand', timeout: 15_000, message: 'alice is offered her counterspell' });

    const cdp = await alice.context.newCDPSession(alice.page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 20 });
    try {
      expect(await clickHandCard(alice.page, manaLeak), 'Mana Leak is played').toBe(true);
      await expect
        .poll(
          async () => {
            await answerPrompt(alice.page);
            await pressPaymentAuto(alice.page);
            return alice.page.locator('[data-zone="graveyard"][data-owner="them"]').getAttribute('data-count');
          },
          { timeout: 60_000, message: 'Mana Leak resolved: Memnite is in bob’s graveyard' },
        )
        .toBe('1');
    } finally {
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    }

    await bob.page.waitForTimeout(1500);
    const seen = (await pop.rows()).map((r) => r.text);
    const targets = serverLog(stack).filter((r) => r.matchId === matchId && r.seat === 0 && r.method === 'getChoices' && (r.evt === 'ask-answered' || r.evt === 'ask-auto-answered'));
    console.log(`[w62-bounce] lone target: bob's pop-out said ${JSON.stringify(seen)}; alice's getChoices: ${targets.map((r) => (r.evt === 'ask-answered' ? `browser ${String(r.ms)} ms` : `server (${String(r.why)})`)).join(', ')}`);
    expect(targets.some((r) => r.evt === 'ask-answered'), 'the lone target reached alice’s browser and was answered there').toBe(true);
    expect(seen.filter((t) => /to (choose|decide)/.test(t)), `bob was told alice had a choice: ${JSON.stringify(seen)}`).toEqual([]);
  } finally {
    await stack.stop();
  }
});
