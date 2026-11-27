/**
 * The cards that change where a pack goes and what a seat may see of it, in a
 * real room (`@hadoku/draft`'s `actions/flow.ts`), one test a card:
 *
 * - Archdemon of Paliano is drafted by name and face up; its drafter then has
 *   no pack to look at, only a count and one button, and each press puts one
 *   card in her pool. After three cards (three more for another Archdemon that
 *   press happens to draft) it is face down and the next pack is hers to see.
 * - Canal Dredger is drafted face up; at the end of the round its drafter
 *   keeps the last card of her own pack and is passed other seats' last cards,
 *   so she ends the round with more cards than a round deals a seat.
 *
 * The cube holds the card under test in one card of eight, so a card drafted
 * at random is seldom another copy; alice looks for hers pack by pack.
 */
import { expect, test, type Page } from '@playwright/test';

import { dealPod, PACK_TIMEOUT, packCards, packNames, packOfSize, pickNamed, seedCube, UI_TIMEOUT } from './draftActions.ts';
import { makeTitled } from './play/board.ts';
import { openFriend, type Friend as Player } from './play/browser.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const ARCHDEMON = 'Archdemon of Paliano';
const DREDGER = 'Canal Dredger';
const PACK = 15;
/** Copies of the card under test in the cube of 360. */
const COPIES = 45;
/** How many packs alice looks through for her copy before the test gives up. */
const SEARCH = 6;

const poolCount = (page: Page) => page.getByTestId('pool-count');

/**
 * `page`'s drafter picks along, never a card named `not`, until `stop()`: the packs they hold reach the
 * next seat. Without it a test that drafts past seven picks waits on the human beside it for good
 * (CI, 11-23 and 11-24: a random pick drafted a second Archdemon, so alice needed an eighth pack, bob's).
 * Paced as `podSeats.ts`'s `draftUntilDone` is, under the server's pick rate limit.
 */
function draftAlong(page: Page, not: string): { stop: () => Promise<void> } {
  let on = true;
  const run = (async () => {
    let picks = 0;
    while (on) {
      const pick = (await packNames(page)).find((n) => n !== not);
      if (pick === undefined) {
        await page.waitForTimeout(200);
        continue;
      }
      await pickNamed(page, pick);
      picks += 1;
      await expect(poolCount(page), `drafting along: pick ${picks}`).toHaveText(String(picks), { timeout: UI_TIMEOUT });
      await page.waitForTimeout(400);
    }
  })();
  return {
    stop: async () => {
      on = false;
      await run;
    },
  };
}

/** How many cards named `name` lie face up in front of seat 0, off the table's own list. */
async function faceUpAtSeat0(page: Page, name: string): Promise<number> {
  const row = page.getByTestId('face-up-0');
  if ((await row.count()) === 0) return 0;
  return (await row.innerText()).split(name).length - 1;
}

/**
 * The viewer takes cards that are not `name`, one a pack, until a pack holds
 * `name`, and takes it. Returns how many picks that made.
 */
async function draftByName(page: Page, name: string): Promise<number> {
  for (let picks = 0; picks < SEARCH; picks++) {
    const pack = await packOfSize(page, PACK - picks, `pack ${picks + 1}`);
    const take = pack.includes(name) ? name : pack[0];
    if (take === undefined) throw new Error('an empty pack');
    await pickNamed(page, take);
    await expect(poolCount(page)).toHaveText(String(picks + 1), { timeout: UI_TIMEOUT });
    if (take === name) return picks + 1;
  }
  throw new Error(`no ${name} in the first ${SEARCH} packs`);
}

test(
  titled('Archdemon of Paliano hides its drafter\'s packs: one button drafts a card at random, three times, and then it is face down'),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(10 * 60_000);

    seedCube(ARCHDEMON, 0, COPIES);

    let bobDrafts: ReturnType<typeof draftAlong> | undefined;
    const stack = await startPlayStack(forge);
    try {
      const alice: Player = await openFriend(browser, 'alice');
      const bob: Player = await openFriend(browser, 'bob');
      const players = [alice, bob];
      await dealPod(alice, bob, stack.origin);

      /* ── alice drafts one by name: face up in front of her seat, on both screens ── */
      await expect(alice.page.getByTestId('draft-blind-pick'), 'she sees her packs until she holds one').toHaveCount(0);
      let picks = await draftByName(alice.page, ARCHDEMON);
      for (const p of players) await expect(p.page.getByTestId('face-up-0'), `${p.name}: sees alice's Archdemon face up`).toContainText(ARCHDEMON, { timeout: UI_TIMEOUT });
      await expect(bob.page.getByTestId('draft-blind-pick'), 'bob still sees his packs').toHaveCount(0);

      bobDrafts = draftAlong(bob.page, ARCHDEMON);

      /* ── every pack after it is a count and one button; a press is one card in her pool ── */
      // What each face-up Archdemon still demands: the one she named owes three,
      // and one a press drafts at random owes three of its own.
      let owed = [3];
      let faceUp = 1;
      const blind = alice.page.getByTestId('draft-blind-pick');
      while (owed.length > 0) {
        if (picks >= PACK - 2) throw new Error(`still drafting at random after ${picks} picks: the round would end inside this test`);
        const cards = PACK - picks;
        await expect(blind, `pick ${picks + 1}: the pack is a button`).toBeVisible({ timeout: PACK_TIMEOUT });
        await expect(blind, 'that says how many cards it holds').toHaveAttribute('data-cards', String(cards));
        await expect(packCards(alice.page), 'and no card of it is drawn').toHaveCount(0);
        await expect(alice.page.getByTestId('pack'), 'the pack is its count, not an empty pack').toHaveText(`${cards} cards`);
        await blind.click();
        picks += 1;
        await expect(poolCount(alice.page), 'one press, one card in her pool').toHaveText(String(picks), { timeout: UI_TIMEOUT });

        // The card counted for every Archdemon face up; one at its third is turned face down.
        const turned = owed.filter((n) => n === 1).length;
        owed = owed.map((n) => n - 1).filter((n) => n > 0);
        const now = await faceUpAtSeat0(alice.page, ARCHDEMON);
        const drafted = now - (faceUp - turned);
        expect([0, 1], `pick ${picks}: ${now} face up after ${faceUp}, with ${turned} turned down`).toContain(drafted);
        if (drafted === 1) owed.push(3);
        faceUp = now;
      }

      /* ── the last one is face down: nothing is face up in front of her, and the next pack is drawn ── */
      for (const p of players) await expect(p.page.getByTestId('face-up-0'), `${p.name}: no Archdemon is face up in front of alice`).toHaveCount(0, { timeout: UI_TIMEOUT });
      await packOfSize(alice.page, PACK - picks, 'the next pack, hers to look at');
      await expect(blind, 'and the button is gone').toHaveCount(0);
      await packCards(alice.page).first().click();
      await expect(poolCount(alice.page), 'she names a card again').toHaveText(String(picks + 1), { timeout: UI_TIMEOUT });
    } finally {
      await bobDrafts?.stop();
      await stack.stop();
    }
  },
);

test(
  titled('Canal Dredger: its drafter keeps her own pack\'s last card and is passed other seats\' last cards'),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(12 * 60_000);

    seedCube(DREDGER, 0, COPIES);

    const stack = await startPlayStack(forge);
    try {
      const alice: Player = await openFriend(browser, 'alice');
      const bob: Player = await openFriend(browser, 'bob');
      const players = [alice, bob];
      await dealPod(alice, bob, stack.origin);

      /* ── alice drafts a Dredger: face up in front of her seat, on both screens ── */
      const found = await draftByName(alice.page, DREDGER);
      for (const p of players) await expect(p.page.getByTestId('face-up-0'), `${p.name}: sees alice's Dredger face up`).toContainText(DREDGER, { timeout: UI_TIMEOUT });

      /* ── both draft down to a pack of two; bob never takes a Dredger, so he is not such a seat ── */
      const dredgerAsk = bob.page.locator(`[data-testid="draft-ask"][data-source="${DREDGER}"]`);
      for (let pick = 1; pick < PACK; pick++) {
        if (pick > found) {
          await packOfSize(alice.page, PACK - pick + 1, `alice's pack ${pick}`);
          await packCards(alice.page).first().click();
          // Her fourteenth pick leaves a last card, which is hers at once: the count may already be past it.
          if (pick < PACK - 1) await expect(poolCount(alice.page)).toHaveText(String(pick), { timeout: UI_TIMEOUT });
        }
        const pack = await packOfSize(bob.page, PACK - pick + 1, `bob's pack ${pick}`);
        const other = pack.find((n) => n !== DREDGER);
        if (other === undefined) throw new Error(`bob's pack ${pick} is nothing but Dredgers`);
        await pickNamed(bob.page, other);
        await expect(poolCount(bob.page)).toHaveText(String(pick), { timeout: UI_TIMEOUT });
      }

      /* ── the last cards: alice's own stays with her, and bob's goes to her ── */
      // An AI seat may have drafted a Dredger too; then bob is asked whose his last card is, and chooses
      // alice. A last card in front of alice is hers to take: a room with a pick timer takes it for her.
      await expect(async () => {
        if (await dredgerAsk.isVisible()) {
          expect(await dredgerAsk.getByTestId('card').count(), 'the question shows no card').toBe(0);
          await dredgerAsk.locator('[data-testid="draft-ask-option"][data-key="0"]').click();
        }
        const inFront = await packCards(alice.page).count();
        if (inFront === 1) await packCards(alice.page).first().click();
        expect(inFront, "alice's first pack of round two").toBe(PACK);
        expect(await packCards(bob.page).count(), "bob's first pack of round two").toBe(PACK);
      }).toPass({ timeout: 3 * 60_000, intervals: [500] });

      /* ── the round ended with every card taken: alice holds more than a round deals, bob one fewer ── */
      // Fourteen picks of his own; the fifteenth card he would have been passed is the one alice kept.
      await expect(poolCount(bob.page), 'bob was passed no last card').toHaveText(String(PACK - 1));
      // Fourteen picks, her own pack's last card and bob's; every other seat's too when no AI seat drafted a Dredger.
      const hers = Number(await poolCount(alice.page).innerText());
      expect(hers, 'alice holds last cards beside her own picks').toBeGreaterThanOrEqual(PACK - 1 + 2);
      expect(hers, "and no more than every pack's last card").toBeLessThanOrEqual(PACK - 1 + 8);
    } finally {
      await stack.stop();
    }
  },
);
