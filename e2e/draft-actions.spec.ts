/**
 * Cards that change the draft itself, in a real room (`@hadoku/draft`'s
 * `actions/`), one test a card:
 *
 * - Cogwork Librarian is drafted face up for the whole table to see, buys its
 *   drafter a second card from a later pack, and goes into that pack, where
 *   the next seat finds it and drafts it face up in turn.
 * - Lore Seeker is revealed to the table, asks its drafter, and on Yes puts an
 *   unopened pack in front of them, which passes on and is drafted that round.
 *
 * `draftActions.ts` has the seeded cube and the dealt pod every test here starts from.
 */
import { expect, test } from '@playwright/test';

import { dealPod, logLines, packCards, packNames, packOfSize, pickNamed, seedCube, UI_TIMEOUT, useOf } from './draftActions.ts';
import { makeTitled } from './play/board.ts';
import { openFriend, type Friend as Player } from './play/browser.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const LIBRARIAN = 'Cogwork Librarian';
const SEEKER = 'Lore Seeker';

/** Alice's and bob's own entries in the table's face-up list (`DraftScreen.tsx`'s `FaceUpCards`): seats 0 and 1. */
const HUMAN_FACE_UP = '[data-testid="face-up-0"], [data-testid="face-up-1"]';

const librarians = (names: readonly string[]) => names.filter((n) => n === LIBRARIAN).length;

test(
  titled('Cogwork Librarian is drafted face up, buys a second card from a later pack, and goes into that pack for the next seat'),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(8 * 60_000);

    seedCube(LIBRARIAN);

    const stack = await startPlayStack(forge);
    const origin = stack.origin;
    try {
      const alice: Player = await openFriend(browser, 'alice');
      const bob: Player = await openFriend(browser, 'bob');
      const players = [alice, bob];

      await dealPod(alice, bob, origin);

      /* ── alice drafts a Librarian: it lies face up in front of her seat, on both screens ── */
      const first = await packOfSize(alice.page, 15, "alice's first pack");
      expect(librarians(first), 'the first pack holds a Librarian').toBeGreaterThan(0);
      await expect(alice.page.getByTestId('draft-use'), 'nothing to use before she holds one').toHaveCount(0);
      // The six AI seats draft from the same half-Librarian cube on their own clock, and what they draft face up is
      // public too, so every face-up check here reads alice's and bob's own seats, never the whole table's list.
      for (const p of players) await expect(p.page.locator(HUMAN_FACE_UP), `${p.name}: nothing is face up in front of alice or bob yet`).toHaveCount(0);
      await pickNamed(alice.page, LIBRARIAN);
      for (const p of players) {
        await expect(p.page.getByTestId('face-up-0'), `${p.name}: sees alice's Librarian face up`).toContainText(LIBRARIAN, { timeout: UI_TIMEOUT });
        await expect(p.page.getByTestId('face-up-1'), `${p.name}: and none in front of bob`).toHaveCount(0);
        await expect(logLines(p.page).filter({ hasText: `e2e-alice drafted face up ${LIBRARIAN}` }), `${p.name}: and is told so`).toHaveCount(1);
      }
      await expect(alice.page.getByTestId('pool-count')).toHaveText('1');

      /* ── her next pack: the Librarian's own control, two cards for one pick ── */
      const second = await packOfSize(alice.page, 14, "alice's second pack, one card lighter from the seat before her");
      const [a, b] = second.filter((n) => n !== LIBRARIAN);
      if (a === undefined || b === undefined) throw new Error(`the second pack has fewer than two cards that are not Librarians: ${second.join(', ')}`);
      const control = useOf(alice.page, LIBRARIAN);
      await expect(control, 'the Librarian offers itself').toHaveText(LIBRARIAN, { timeout: UI_TIMEOUT });
      await expect(control).toHaveAttribute('aria-pressed', 'false');
      await expect(bob.page.getByTestId('draft-use'), 'only to its own drafter').toHaveCount(0);
      await control.click();
      await expect(control).toHaveAttribute('aria-pressed', 'true');

      await pickNamed(alice.page, a);
      await expect(alice.page.locator('[data-testid="pack"] .pack__slot[data-chosen]'), 'the first card is held, not taken').toHaveCount(1);
      await expect(packCards(alice.page), 'the pack is still in front of her').toHaveCount(14);
      await expect(alice.page.getByTestId('pool-count')).toHaveText('1');
      await pickNamed(alice.page, b);

      // Two cards in, the Librarian out: a pool of two, neither of them the Librarian.
      await expect(alice.page.getByTestId('pool-count'), 'both cards are hers and the Librarian is gone').toHaveText('2', { timeout: UI_TIMEOUT });
      const pool = alice.page.getByTestId('pool');
      for (const name of [a, b]) await expect(pool.getByText(name, { exact: true }).first(), `${name} is in her pool`).toBeVisible();
      await expect(pool.getByText(LIBRARIAN, { exact: true }), 'the Librarian left her pool').toHaveCount(0);
      for (const p of players) await expect(p.page.getByTestId('face-up-0'), `${p.name}: nothing is face up in front of alice any more`).toHaveCount(0, { timeout: UI_TIMEOUT });

      /* ── bob is passed that pack: thirteen cards, one Librarian more, neither card she took ── */
      await packOfSize(bob.page, 15, "bob's own first pack");
      await packCards(bob.page).first().click();
      const passedFirst = await packOfSize(bob.page, 14, "alice's first pack, passed to bob");
      expect(librarians(passedFirst), 'less the Librarian she drafted').toBe(librarians(first) - 1);
      await pickNamed(bob.page, passedFirst.find((n) => n !== LIBRARIAN) ?? LIBRARIAN);
      const passedSecond = await packOfSize(bob.page, 13, "alice's second pack, passed to bob");
      expect(librarians(passedSecond), 'her Librarian is in it').toBe(librarians(second) + 1);
      expect(passedSecond, 'and the two cards she took are not').not.toEqual(expect.arrayContaining([a]));
      expect(passedSecond).not.toEqual(expect.arrayContaining([b]));

      /* ── bob drafts a Librarian from it: face up in front of his seat now, on both screens ── */
      await pickNamed(bob.page, LIBRARIAN);
      for (const p of players) {
        await expect(p.page.getByTestId('face-up-1'), `${p.name}: sees bob's Librarian face up`).toContainText(LIBRARIAN, { timeout: UI_TIMEOUT });
        await expect(p.page.getByTestId('face-up-0'), `${p.name}: and none in front of alice`).toHaveCount(0);
      }
    } finally {
      await stack.stop();
    }
  },
);

test(
  titled('Lore Seeker is revealed to the table, asks its drafter, and on Yes adds an unopened pack that is drafted that round'),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(8 * 60_000);

    // Fifteen cards more than the pod deals: one pack is left unopened.
    seedCube(SEEKER, 15);

    const stack = await startPlayStack(forge);
    try {
      const alice: Player = await openFriend(browser, 'alice');
      const bob: Player = await openFriend(browser, 'bob');
      const players = [alice, bob];
      await dealPod(alice, bob, stack.origin);

      /* ── alice drafts a Seeker: the table is told, and she alone is asked ── */
      const first = await packOfSize(alice.page, 15, "alice's first pack");
      expect(first, 'the first pack holds a Lore Seeker').toContain(SEEKER);
      await pickNamed(alice.page, SEEKER);
      for (const p of players) await expect(logLines(p.page).last(), `${p.name}: is told she revealed it`).toHaveText(`e2e-alice revealed ${SEEKER}`, { timeout: UI_TIMEOUT });
      for (const p of players) await expect(p.page.getByTestId('face-up'), `${p.name}: it is not left face up`).toHaveCount(0);
      const ask = alice.page.locator(`[data-testid="draft-ask"][data-source="${SEEKER}"]`);
      await expect(ask, 'the Seeker asks her').toBeVisible({ timeout: UI_TIMEOUT });
      await expect(bob.page.getByTestId('draft-ask'), 'and nobody else').toHaveCount(0);
      await expect(alice.page.getByTestId('pool-count')).toHaveText('1');

      /* ── Yes: a whole new pack is in front of her at once, ahead of the one being passed to her ── */
      await ask.locator('[data-testid="draft-ask-option"][data-key="yes"]').click();
      await expect(ask).toHaveCount(0, { timeout: UI_TIMEOUT });
      const added = await packOfSize(alice.page, 15, 'the added pack, whole');
      for (const p of players) await expect(logLines(p.page).last(), `${p.name}: is told a pack was added`).toHaveText('e2e-alice added a booster pack to the draft', { timeout: UI_TIMEOUT });
      const mine = added.find((n) => n !== SEEKER) ?? SEEKER;
      await pickNamed(alice.page, mine);
      await expect(alice.page.getByTestId('pool-count')).toHaveText('2', { timeout: UI_TIMEOUT });

      /* ── it passes on: bob's third pack is the added one, a card heavier than the round's own would be ── */
      await packOfSize(bob.page, 15, "bob's own first pack");
      await pickNamed(bob.page, (await packNames(bob.page)).find((n) => n !== SEEKER) ?? SEEKER);
      const passedFirst = await packOfSize(bob.page, 14, "alice's first pack, passed to bob");
      await pickNamed(bob.page, passedFirst.find((n) => n !== SEEKER) ?? SEEKER);
      const passedAdded = await packOfSize(bob.page, 14, 'the added pack, passed to bob with fourteen cards');
      const rest = [...added];
      rest.splice(rest.indexOf(mine), 1);
      expect([...passedAdded].sort(), 'and otherwise the pack she opened').toEqual(rest.sort());
    } finally {
      await stack.stop();
    }
  },
);
