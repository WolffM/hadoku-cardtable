/**
 * Cards that let one seat see something hidden, in a real room (`@hadoku/draft`'s
 * `actions/peeks.ts`), one test a card:
 *
 * - Cogwork Spy is revealed as alice drafts it, and the next card drafted from
 *   that pack (bob's) is shown to alice alone.
 * - Illusionary Informant is drafted face up, is turned face down on bob from
 *   its own control while alice has no pack in front of her, and bob's next
 *   pick is shown to alice alone.
 *
 * `draftActions.ts` has the seeded cube and the dealt pod every test here starts from.
 */
import { expect, test } from '@playwright/test';

import { dealPod, logLines, packNames, packOfSize, pickNamed, seedCube, UI_TIMEOUT, useOf } from './draftActions.ts';
import { makeTitled } from './play/board.ts';
import { openFriend, type Friend as Player } from './play/browser.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const SPY = 'Cogwork Spy';
const INFORMANT = 'Illusionary Informant';

const seenLines = (player: Player) => player.page.getByTestId('draft-seen').locator('li');

/** A card of the pack that is not the card under test: a name that occurs once in the whole draft. */
function another(names: readonly string[], not: string): string {
  const name = names.find((n) => n !== not);
  if (name === undefined) throw new Error(`every card of the pack is ${not}`);
  return name;
}

test(
  titled('Cogwork Spy is revealed as it is drafted, and shows its drafter alone the next card drafted from that pack'),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(8 * 60_000);

    seedCube(SPY);

    const stack = await startPlayStack(forge);
    try {
      const alice: Player = await openFriend(browser, 'alice');
      const bob: Player = await openFriend(browser, 'bob');
      const players = [alice, bob];
      await dealPod(alice, bob, stack.origin);

      /* ── alice drafts a Spy: the table is told, and nothing is shown yet ── */
      const first = await packOfSize(alice.page, 15, "alice's first pack");
      expect(first, 'the first pack holds a Spy').toContain(SPY);
      await pickNamed(alice.page, SPY);
      for (const p of players) {
        await expect(logLines(p.page).filter({ hasText: `e2e-alice revealed ${SPY}` }), `${p.name}: is told she revealed it`).toHaveCount(1, { timeout: UI_TIMEOUT });
        await expect(p.page.getByTestId('face-up'), `${p.name}: it is not left face up`).toHaveCount(0);
        await expect(p.page.getByTestId('draft-seen'), `${p.name}: nothing has been shown yet`).toHaveCount(0);
      }

      /* ── bob drafts from his own pack: that is not the pack she marked ── */
      const own = await packOfSize(bob.page, 15, "bob's own first pack");
      await pickNamed(bob.page, another(own, SPY));
      const passed = await packOfSize(bob.page, 14, "alice's first pack, passed to bob");
      await expect(alice.page.getByTestId('draft-seen'), 'a card from another pack is not shown').toHaveCount(0);

      /* ── bob drafts a named card from her pack: alice alone is shown it ── */
      const taken = another(passed, SPY);
      await pickNamed(bob.page, taken);
      await expect(seenLines(alice), 'alice is shown the card bob drafted, and who drafted it').toHaveText([`${SPY}: ${taken} drafted by e2e-bob`], { timeout: UI_TIMEOUT });
      await expect(alice.page.getByTestId('draft-seen-card')).toHaveText([taken]);
      await expect(bob.page.getByTestId('pool-count'), "bob's second pick is in").toHaveText('2', { timeout: UI_TIMEOUT });
      await expect(bob.page.getByTestId('draft-seen'), 'bob is shown nothing').toHaveCount(0);
      for (const p of players) await expect(logLines(p.page).filter({ hasText: taken }), `${p.name}: the card is in no public line`).toHaveCount(0);
    } finally {
      await stack.stop();
    }
  },
);

test(
  titled('Illusionary Informant is turned face down on a seat from its own control, and shows its user alone that seat\'s next pick'),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(8 * 60_000);

    seedCube(INFORMANT);

    const stack = await startPlayStack(forge);
    try {
      const alice: Player = await openFriend(browser, 'alice');
      const bob: Player = await openFriend(browser, 'bob');
      const players = [alice, bob];
      await dealPod(alice, bob, stack.origin);

      /* ── alice drafts an Informant: face up in front of her seat, on both screens ── */
      const first = await packOfSize(alice.page, 15, "alice's first pack");
      expect(first, 'the first pack holds an Informant').toContain(INFORMANT);
      await expect(alice.page.getByTestId('draft-use'), 'nothing to use before she holds one').toHaveCount(0);
      await pickNamed(alice.page, INFORMANT);
      for (const p of players) await expect(p.page.getByTestId('face-up-0'), `${p.name}: sees alice's Informant face up`).toContainText(INFORMANT, { timeout: UI_TIMEOUT });

      /* ── its control is hers alone, whether or not a pack is in front of her; pressed, it offers the other seats ── */
      const control = useOf(alice.page, INFORMANT);
      await expect(control, 'the Informant offers itself').toHaveText(INFORMANT, { timeout: UI_TIMEOUT });
      await expect(control).toHaveAttribute('data-when', 'now');
      await expect(bob.page.getByTestId('draft-use'), 'only to its own drafter').toHaveCount(0);
      await expect(alice.page.getByTestId('draft-use-target'), 'no seat is offered before it is pressed').toHaveCount(0);
      await control.click();
      await expect(control).toHaveAttribute('aria-pressed', 'true');
      await expect(alice.page.getByTestId('draft-use-target'), 'every seat but her own').toHaveCount(7);
      const target = alice.page.locator('[data-testid="draft-use-target"][data-key="1"]');
      await expect(target, "bob's seat, by his name").toHaveText('e2e-bob');
      await target.click();

      /* ── it is turned face down: off the face-up list on both screens, and no longer offered ── */
      for (const p of players) await expect(p.page.getByTestId('face-up-0'), `${p.name}: nothing is face up in front of alice`).toHaveCount(0, { timeout: UI_TIMEOUT });
      await expect(control, 'it is used up').toHaveCount(0);
      await expect(alice.page.getByTestId('draft-seen'), 'nothing is shown until bob drafts').toHaveCount(0);

      /* ── bob's next pick: alice alone is shown it ── */
      await packOfSize(bob.page, 15, "bob's own first pack");
      const taken = another(await packNames(bob.page), INFORMANT);
      await pickNamed(bob.page, taken);
      await expect(seenLines(alice), 'alice is shown the card bob drafted').toHaveText([`${INFORMANT}: ${taken} drafted by e2e-bob`], { timeout: UI_TIMEOUT });
      await expect(bob.page.getByTestId('pool-count'), "bob's pick is in").toHaveText('1', { timeout: UI_TIMEOUT });
      await expect(bob.page.getByTestId('draft-seen'), 'bob is shown nothing').toHaveCount(0);
      for (const p of players) await expect(logLines(p.page).filter({ hasText: taken }), `${p.name}: the card is in no public line`).toHaveCount(0);

      /* ── one card only: bob's pick after that is not shown ── */
      const next = await packOfSize(bob.page, 14, "alice's first pack, passed to bob");
      await pickNamed(bob.page, another(next, INFORMANT));
      await expect(bob.page.getByTestId('pool-count')).toHaveText('2', { timeout: UI_TIMEOUT });
      await expect(seenLines(alice), 'still the one line').toHaveCount(1);
    } finally {
      await stack.stop();
    }
  },
);
