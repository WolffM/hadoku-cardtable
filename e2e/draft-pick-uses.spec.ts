/**
 * Cards drafted face up and used with a later pick, in a real room
 * (`@hadoku/draft`'s `actions/pick-uses.ts`), one test a card:
 *
 * - Cogwork Grinder removes the card its drafter picks: the card is in no pool
 *   and no pack, the table is told a card was removed and never which, and
 *   the Grinder stays face up to be used again.
 * - Agent of Acquisitions takes a whole pack for one pick: nothing of that
 *   pack is passed, and every pack that reaches its drafter for the rest of
 *   the round goes on to the next seat whole, shown to her alone on the way.
 *
 * `draftActions.ts` has the seeded cube and the dealt pod every test here starts from.
 */
import { expect, test, type Page } from '@playwright/test';

import { dealPod, logLines, packCards, packOfSize, pickNamed, seedCube, UI_TIMEOUT, useOf } from './draftActions.ts';
import { makeTitled } from './play/board.ts';
import { openFriend, type Friend as Player } from './play/browser.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const GRINDER = 'Cogwork Grinder';
const AGENT = 'Agent of Acquisitions';

/** The names in a pack that are not the card under test: each occurs once in the whole draft. */
const others = (names: readonly string[], seeded: string) => names.filter((n) => n !== seeded);

/** Bob takes a card from his own first pack and from alice's first pack, so the next pack in front of him is whatever alice passes after those. */
async function bobTakesTwo(bob: Page, seeded: string): Promise<void> {
  const own = await packOfSize(bob, 15, "bob's own first pack");
  await pickNamed(bob, others(own, seeded)[0] ?? seeded);
  const passed = await packOfSize(bob, 14, "alice's first pack, passed to bob");
  await pickNamed(bob, others(passed, seeded)[0] ?? seeded);
}

test(
  titled('Cogwork Grinder removes the picked card from the draft: no pool, no pack, and the table is not told which'),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(8 * 60_000);

    seedCube(GRINDER);

    const stack = await startPlayStack(forge);
    try {
      const alice: Player = await openFriend(browser, 'alice');
      const bob: Player = await openFriend(browser, 'bob');
      const players = [alice, bob];
      await dealPod(alice, bob, stack.origin);

      /* ── alice drafts a Grinder: face up in front of her, on both screens ── */
      const first = await packOfSize(alice.page, 15, "alice's first pack");
      expect(first, 'the first pack holds a Grinder').toContain(GRINDER);
      await pickNamed(alice.page, GRINDER);
      for (const p of players) await expect(p.page.getByTestId('face-up-0'), `${p.name}: sees alice's Grinder face up`).toContainText(GRINDER, { timeout: UI_TIMEOUT });
      await expect(alice.page.getByTestId('pool-count')).toHaveText('1');

      /* ── her next pack: the Grinder pressed, and the card she picks leaves the draft ── */
      const second = await packOfSize(alice.page, 14, "alice's second pack");
      const gone = others(second, GRINDER)[0];
      if (gone === undefined) throw new Error(`the second pack is all Grinders: ${second.join(', ')}`);
      const control = useOf(alice.page, GRINDER);
      await expect(control, 'the Grinder offers itself').toHaveText(GRINDER, { timeout: UI_TIMEOUT });
      await expect(bob.page.getByTestId('draft-use'), 'only to its own drafter').toHaveCount(0);
      await control.click();
      await expect(control).toHaveAttribute('aria-pressed', 'true');
      await pickNamed(alice.page, gone);

      // The table is told a card was removed, and no screen's log names it: not bob's, and not her own.
      for (const p of players) {
        await expect(logLines(p.page).last(), `${p.name}: is told a card was removed`).toHaveText('e2e-alice removed a card from the draft face down', { timeout: UI_TIMEOUT });
        await expect(p.page.getByTestId('draft-log'), `${p.name}: and not which`).not.toContainText(gone);
      }
      // Her pool does not rise, and the card is not in it.
      await expect(alice.page.getByTestId('pool-count'), 'the pool count does not rise').toHaveText('1');
      await expect(alice.page.getByTestId('pool').getByText(gone, { exact: true }), 'the removed card is not in her pool').toHaveCount(0);
      // The Grinder is still face up, for both.
      for (const p of players) await expect(p.page.getByTestId('face-up-0'), `${p.name}: the Grinder stays face up`).toContainText(GRINDER);

      /* ── bob is passed that pack: thirteen cards, the removed card not among them ── */
      await bobTakesTwo(bob.page, GRINDER);
      const passedSecond = await packOfSize(bob.page, 13, "alice's second pack, passed to bob a card lighter");
      expect(passedSecond, 'the removed card is not in the pack').not.toContain(gone);
      expect([...passedSecond].sort(), 'and the pack is otherwise the one she picked from').toEqual(second.filter((_, i) => i !== second.indexOf(gone)).sort());
      await expect(bob.page.getByTestId('pool').getByText(gone, { exact: true }), 'nor in bob’s pool').toHaveCount(0);

      /* ── her third pack: the Grinder offers itself again ── */
      await packOfSize(alice.page, 13, "alice's third pack");
      await expect(useOf(alice.page, GRINDER), 'the Grinder is used on every later pick').toHaveAttribute('aria-pressed', 'false', { timeout: UI_TIMEOUT });
    } finally {
      await stack.stop();
    }
  },
);

test(
  titled('Agent of Acquisitions takes a whole pack, passes nothing from it, and its drafter passes every later pack of the round on whole'),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(8 * 60_000);

    seedCube(AGENT);

    const stack = await startPlayStack(forge);
    try {
      const alice: Player = await openFriend(browser, 'alice');
      const bob: Player = await openFriend(browser, 'bob');
      const players = [alice, bob];
      await dealPod(alice, bob, stack.origin);

      /* ── alice drafts an Agent; bob empties what is in front of him ── */
      const first = await packOfSize(alice.page, 15, "alice's first pack");
      expect(first, 'the first pack holds an Agent').toContain(AGENT);
      await pickNamed(alice.page, AGENT);
      for (const p of players) await expect(p.page.getByTestId('face-up-0'), `${p.name}: sees alice's Agent face up`).toContainText(AGENT, { timeout: UI_TIMEOUT });
      await bobTakesTwo(bob.page, AGENT);
      await expect(packCards(bob.page), 'bob waits on alice').toHaveCount(0, { timeout: UI_TIMEOUT });

      /* ── her second pack: the Agent pressed, one card pressed, the whole pack taken ── */
      const second = await packOfSize(alice.page, 14, "alice's second pack");
      const hers = others(second, AGENT);
      if (hers.length === 0) throw new Error(`the second pack is all Agents: ${second.join(', ')}`);
      const control = useOf(alice.page, AGENT);
      await expect(control, 'the Agent offers itself').toHaveText(AGENT, { timeout: UI_TIMEOUT });
      await control.click();
      await expect(control).toHaveAttribute('aria-pressed', 'true');
      await pickNamed(alice.page, hers[0]!);

      await expect(alice.page.getByTestId('pool-count'), 'her pool jumps by the pack’s size').toHaveText('15', { timeout: UI_TIMEOUT });
      const pool = alice.page.getByTestId('pool');
      // Fifteen cards stack in the pool's columns, so a name may be covered: it is asked for, not looked at.
      for (const name of hers) await expect(pool.getByText(name, { exact: true }), `${name} is in her pool`).not.toHaveCount(0);
      for (const p of players) {
        await expect(logLines(p.page).filter({ hasText: `e2e-alice turned face down ${AGENT}` }), `${p.name}: is told the Agent was turned face down`).toHaveCount(1, { timeout: UI_TIMEOUT });
        // An Agent among the cards she took is drafted face up in its own right; with none, nothing is face up any more.
        if (second.includes(AGENT)) await expect(p.page.getByTestId('face-up-0'), `${p.name}: the Agents she took lie face up`).toContainText(AGENT, { timeout: UI_TIMEOUT });
        else await expect(p.page.getByTestId('face-up'), `${p.name}: nothing is face up any more`).toHaveCount(0);
      }

      /* ── bob's next pack is not that one: it is the next pack to reach alice, passed on whole ── */
      const through = await packOfSize(bob.page, 13, 'the pack after it, passed through alice to bob');
      for (const name of hers) expect(through, `bob is passed nothing of the pack she took (${name})`).not.toContain(name);
      // Every pack waiting on alice went through her at once and she was shown each (the screen lists the
      // latest few; which pack each line is, is the unit suite's): no pack in front of her, the same pool.
      const shown = alice.page.getByTestId('draft-seen').locator(`li[data-source="${AGENT}"]`);
      await expect(shown, 'alice was shown the packs as they passed through her').not.toHaveCount(0, { timeout: UI_TIMEOUT });
      await expect(bob.page.getByTestId('draft-seen'), 'and nobody else was').toHaveCount(0);
      await expect(packCards(alice.page), 'she has no pack to pick from').toHaveCount(0);
      await expect(alice.page.getByTestId('draft-use'), 'and nothing to use').toHaveCount(0);
      await expect(alice.page.getByTestId('pool-count'), 'her pool has not grown').toHaveText('15');

      /* ── and so the pack after that: bob takes a card, and his next is again one alice never picked from ── */
      await pickNamed(bob.page, through[0]!);
      await packOfSize(bob.page, 12, 'the next pack, passed through alice whole');
      await expect(packCards(alice.page), 'she still has no pack').toHaveCount(0);
      await expect(alice.page.getByTestId('pool-count'), 'her pool still has not grown').toHaveText('15');
    } finally {
      await stack.stop();
    }
  },
);
