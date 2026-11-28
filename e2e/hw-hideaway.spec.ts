/**
 * CoffeeTraveler, 2026-11-27 (prod match m-38558f39ec15): "Mosswort Bridge doesn't know when it has no card
 * under it and the secondary ability is still usable after casting the card under it." The operator, the
 * same day: Hideaway's face-down card is drawn under the land that exiled it (gone once played); and "for
 * karn, and all planeswalkers … show all abilities every time but only make the ones that are payable
 * clickable."
 *
 * Scenario `hw-hideaway`: alice's Mosswort Bridge with a face-down Grizzly Bears exiled with it, and Karn
 * Liberated at 1 loyalty.
 *   1. On both screens the hidden card is drawn in the bridge's pile, under it (`data-tucked`), a back on
 *      bob's, and the exile pile does not draw it again.
 *   2. A click on Karn opens the picker with three rows in card order, +4 enabled and −3, −14 greyed;
 *      a greyed row answers nothing, None backs out, and Karn's loyalty is still 1.
 *
 * Scenario `hw-hideaway-play`: alice plays Mosswort Bridge from her hand; its Hideaway exiles a card face
 * down, which Forge lets her look at: under the bridge she sees its face, and bob a back.
 *
 * Every step prints one `[hw]` line. Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`);
 * without one this SKIPS and the title says why. Serves the prebuilt `apps/ui/dist` — rebuild before running.
 */
import { expect, test, type Page } from '@playwright/test';

import { boardCard, clickHandCard, clickPermanent, enabledOk, handCardNamed, makeTitled, ownNamed } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { answerPrompt } from './play/prompts.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const log = (step: string, data: unknown): void => console.log(`[hw] ${JSON.stringify({ step, data })}`);

/** Each card drawn under `keeper` on `page`: its id, whether it is drawn as a back, and whether the exile pile draws it too. */
function tuckedUnder(page: Page, keeper: number): Promise<{ id: string; back: boolean; inExile: boolean }[]> {
  return page.evaluate((k) => {
    const under = [...document.querySelectorAll<HTMLElement>(`[data-board-card="${k}"] .board-card__pile [data-tucked="${k}"]`)];
    return under.map((el) => ({
      id: el.dataset.cardId ?? '',
      back: el.querySelector('[data-card-back]') !== null,
      inExile: document.querySelector(`[data-zone="exile"] [data-card-id="${el.dataset.cardId}"]`) !== null,
    }));
  }, keeper);
}

test(titled('a Hideaway card is drawn under its land on both screens, and a walker lists the abilities it cannot pay greyed'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice: a, bob: b } = await startScenarioMatch(browser, stack, 'hw-hideaway');
    const alice = a.page;
    const bob = b.page;
    const [bridge] = await expect
      .poll(() => ownNamed(alice, 'Mosswort Bridge'), { timeout: 30_000, message: 'Mosswort Bridge is on alice’s battlefield' })
      .toHaveLength(1)
      .then(() => ownNamed(alice, 'Mosswort Bridge'));

    const both = async () => ({ alice: await tuckedUnder(alice, bridge!), bob: await tuckedUnder(bob, bridge!) });
    try {
      await expect
        .poll(async () => {
          const seen = await both();
          return [seen.alice.length, seen.bob.length, seen.bob[0]?.back, seen.alice[0]?.inExile, seen.bob[0]?.inExile];
        }, { timeout: 20_000, message: 'one card under the bridge on each screen, a back on bob’s, not in either exile pile' })
        .toEqual([1, 1, true, false, false]);
    } finally {
      log('tucked', await both());
    }

    const [karn] = await ownNamed(alice, 'Karn Liberated');
    expect(await clickPermanent(alice, karn!), 'alice clicks Karn').toBe(true);
    const rows = alice.getByTestId('live-prompt').getByTestId('prompt-choice');
    await expect(rows, 'the picker opens with every loyalty ability').toHaveCount(3, { timeout: 15_000 });
    const drawn = await rows.evaluateAll((els) => els.map((el) => [(el.textContent ?? '').trim().slice(0, 3), (el as HTMLButtonElement).disabled]));
    log('picker', drawn);
    expect(drawn.map(([, disabled]) => disabled), '+4 enabled, −3 and −14 greyed').toEqual([false, true, true]);
    await rows.nth(1).click({ force: true });
    await expect(rows, 'a greyed row answers nothing').toHaveCount(3);
    await alice.getByTestId('live-prompt').getByTestId('prompt-cancel').click();
    await expect(rows, 'None backs out').toHaveCount(0, { timeout: 10_000 });
    await expect(boardCard(alice, karn!).locator('.board-card__pt'), 'Karn is still at 1').toHaveText('1');
  } finally {
    await stack.stop();
  }
});

test(titled('a real Hideaway: its owner sees the hidden card’s face under the land, the other player a back'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice: a, bob: b } = await startScenarioMatch(browser, stack, 'hw-hideaway-play');
    const alice = a.page;
    const bob = b.page;
    const inHand = await expect
      .poll(() => handCardNamed(alice, 'Mosswort Bridge'), { timeout: 30_000, message: 'Mosswort Bridge is in alice’s hand' })
      .not.toBeUndefined()
      .then(() => handCardNamed(alice, 'Mosswort Bridge'));
    expect(await clickHandCard(alice, inHand!), 'alice plays the bridge').toBe(true);

    const both = async (keeper: number) => ({ alice: await tuckedUnder(alice, keeper), bob: await tuckedUnder(bob, keeper) });
    let seen: Awaited<ReturnType<typeof both>> | null = null;
    try {
      // Pass the Hideaway trigger through and take the first card it offers, by state: answer
      // whichever seat is asked, press a live OK, until the bridge has a card under it on both screens.
      await expect
        .poll(
          async () => {
            const [bridge] = await ownNamed(alice, 'Mosswort Bridge');
            if (bridge === undefined) return null;
            seen = await both(bridge);
            if (seen.alice.length === 1 && seen.bob.length === 1) return [seen.alice[0]!.back, seen.bob[0]!.back];
            for (const page of [alice, bob]) {
              await answerPrompt(page).catch(() => null);
              await enabledOk(page).click({ timeout: 500 }).catch(() => undefined);
            }
            return null;
          },
          { timeout: 60_000, intervals: [250], message: 'the hidden card under the bridge: its face for alice, a back for bob' },
        )
        .toEqual([false, true]);
    } finally {
      log('real hideaway', seen);
    }
  } finally {
    await stack.stop();
  }
});
