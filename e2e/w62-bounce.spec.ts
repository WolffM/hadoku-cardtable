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

import { clickHandCard, handCardNamed, makeTitled, says } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

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
    await bob.page.evaluate(() => {
      const seen: string[] = [];
      const w = window as unknown as { __waitingSeen: string[] };
      w.__waitingSeen = seen;
      const read = () => {
        const el = document.querySelector('[data-testid="live-waiting-pop"]');
        const text = el?.textContent?.trim() ?? '';
        if (seen[seen.length - 1] !== text) seen.push(text);
      };
      new MutationObserver(read).observe(document.body, { childList: true, subtree: true, characterData: true });
      read();
    });

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
    const seen = await bob.page.evaluate(() => (window as unknown as { __waitingSeen: string[] }).__waitingSeen);
    console.log(`[w62-bounce] bob's pop-out said: ${JSON.stringify(seen)}; alice says: ${JSON.stringify(await says(alice.page))}`);
    expect(seen.filter((t) => /to decide/.test(t)), `bob was told alice had a decision: ${JSON.stringify(seen)}`).toEqual([]);
    expect(seen.filter((t) => /to choose/.test(t)), `bob was told alice had a choice: ${JSON.stringify(seen)}`).toEqual([]);
  } finally {
    await stack.stop();
  }
});
