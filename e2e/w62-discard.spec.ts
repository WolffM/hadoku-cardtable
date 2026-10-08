/**
 * The cleanup discard draws no targeter arrow.
 *
 * The operator, 2026-10-08, in a live game: "Cleanup Phase — Select 1 card(s)
 * to discard to bring your hand down to the maximum of 7 cards. why is there a
 * targeter arrow coming from my 8th card in hand? i wouldn't expect a targeter
 * arrow at all here." Forge's cleanup discard is an `InputSelectCardsFromList`
 * built with no spell ability (`PlayerControllerHuman.chooseCardsToDiscardToMaximumHandSize`),
 * so its prompt names no card; the selectables are this seat's own hand; and
 * the click-mode arrow's tail then came from `clickOrigin`'s fallbacks — the
 * card clicked last, or a stack source. A pick among one's own hand is not
 * aiming: `install.ts`'s `choosingOwnHand` draws nothing.
 *
 * Scenario `w62-discard`: nine lands in hand, one land drop (the click on
 * record), End Turn into cleanup with eight.
 */
import { expect, test } from '@playwright/test';

import { clickHandCard, makeTitled, offered, says } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

test(titled('the cleanup discard: a pick among my own hand draws no targeter arrow on either screen, and the pick discards'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);

  const stack = await startPlayStack(forge);
  let seated: Awaited<ReturnType<typeof startScenarioMatch>> | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, 'w62-discard');
    const { alice, bob } = seated;
    const hand = alice.page.locator('[data-zone="hand"][data-owner="you"] [data-board-card]');
    const graveyard = alice.page.locator('[data-zone="graveyard"][data-owner="you"] [data-board-card]');
    const endTurn = alice.page.getByTestId('live-button-end-turn');

    // Her click on record: one land drop. The land is offered the moment she holds priority.
    await expect.poll(() => offered(alice.page), { timeout: 45_000, message: 'a land in hand is offered' }).not.toEqual([]);
    const played = (await offered(alice.page))[0]!;
    const onBattlefield = alice.page.locator(`[data-zone="battlefield"][data-owner="you"] [data-board-card="${played}"]`);
    // A land is played by the lift-and-click gesture, not a bare click; the first act after a
    // scenario applies is sometimes dropped (the start race every scenario spec absorbs), so the
    // play is retried while the card is still offered, never once it has left the hand.
    for (let attempt = 0; attempt < 4 && (await onBattlefield.count()) === 0; attempt++) {
      if ((await offered(alice.page)).includes(played)) await clickHandCard(alice.page, played);
      await alice.page.waitForTimeout(1_500);
    }
    await expect(onBattlefield, 'the land drop resolved').toHaveCount(1, { timeout: 15_000 });
    await expect(hand, 'eight in hand').toHaveCount(8);

    // End Turn into cleanup: the discard is the turn's only question.
    await expect(endTurn, 'End Turn is offered in her own main').toBeEnabled({ timeout: 15_000 });
    await endTurn.click();
    await expect(alice.page.getByTestId('live-says'), 'the cleanup discard is asked').toHaveText(/discard/i, { timeout: 30_000 });
    await expect.poll(() => offered(alice.page), { timeout: 10_000, message: 'the hand is what is selectable' }).toHaveLength(8);
    const handIds = await hand.evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-board-card'))));
    const selectable = await offered(alice.page);
    expect(selectable.every((id) => handIds.includes(id)), 'every selectable card is in her hand').toBe(true);

    // Hover across the hand: no arrow on her screen at any moment, none mirrored to bob.
    const arrowsSeen: string[] = [];
    for (const id of handIds.slice(0, 4)) {
      const box = (await alice.page.locator(`[data-board-card="${id}"]`).boundingBox())!;
      await alice.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
      await alice.page.waitForTimeout(120);
      const n = await alice.page.getByTestId('targeter').count();
      const src = n === 0 ? null : await alice.page.getByTestId('targeter').getAttribute('data-source');
      arrowsSeen.push(`${id}:${n}${src === null ? '' : `←${src}`}`);
    }
    console.log(`[w62-discard] says="${(await says(alice.page)).replace(/\s+/g, ' ')}" played=${played} hover→targeter ${arrowsSeen.join(' ')}; bob arrows=${await bob.page.locator('.presence__arrow').count()}`);
    expect(arrowsSeen.every((s) => /:0$/.test(s)), `no targeter arrow while hovering the hand (${arrowsSeen.join(' ')})`).toBe(true);
    await expect(bob.page.locator('.presence__arrow'), 'bob sees no arrow either').toHaveCount(0);

    // The pick: one click discards it (Forge's own input OKs itself with all its targets).
    const pick = handIds[0]!;
    await alice.page.locator(`[data-board-card="${pick}"]`).click();
    await expect(graveyard, 'the picked card is in her graveyard').toHaveCount(1, { timeout: 15_000 });
    await expect(hand, 'seven in hand').toHaveCount(7);
    await expect(alice.page.getByTestId('targeter'), 'still no arrow').toHaveCount(0);
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});
