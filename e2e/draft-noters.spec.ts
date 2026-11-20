/**
 * The cards that reveal themselves and note something for the match, in a real
 * room (`@hadoku/draft`'s `actions/noters.ts`):
 *
 * - Lurking Automaton, taken as its drafter's second card of the round, is
 *   revealed to the table and notes two, on both screens.
 * - Aether Searcher is revealed, and the next card its drafter takes is
 *   revealed to the table by name; the card after that is not.
 *
 * Half the seeded cube is the card under test, so the six AI seats reveal
 * theirs too. They take a card the moment a pack reaches them and stop once
 * every pack waits on a person, so each test lets the log settle first and bob
 * never picks: after that the only lines added are alice's own.
 */
import { expect, test, type Page } from '@playwright/test';

import { dealPod, logLines, packOfSize, pickNamed, seedCube, UI_TIMEOUT } from './draftActions.ts';
import { makeTitled } from './play/board.ts';
import { openFriend, type Friend as Player } from './play/browser.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const AUTOMATON = 'Lurking Automaton';
const SEARCHER = 'Aether Searcher';

/** The log's lines once two readings a moment apart agree: the AI seats have run out of packs. */
async function settledLog(page: Page): Promise<string[]> {
  let last: string[] | null = null;
  await expect
    .poll(
      async () => {
        const now = await logLines(page).allTextContents();
        const same = last !== null && now.join('\n') === last.join('\n');
        last = now;
        return same;
      },
      { message: 'the AI seats stop drafting once every pack waits on a person', timeout: UI_TIMEOUT, intervals: [1_500] },
    )
    .toBe(true);
  return last ?? [];
}

/** The log's last `n` lines. */
const tail = async (page: Page, n: number): Promise<string[]> => (await logLines(page).allTextContents()).slice(-n);

test(
  titled('Lurking Automaton is revealed to the table and notes how many cards its drafter has taken this round'),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(8 * 60_000);

    seedCube(AUTOMATON);

    const stack = await startPlayStack(forge);
    try {
      const alice: Player = await openFriend(browser, 'alice');
      const bob: Player = await openFriend(browser, 'bob');
      const players = [alice, bob];
      await dealPod(alice, bob, stack.origin);

      /* ── her first card is an ordinary one: nothing is said of her ── */
      const first = await packOfSize(alice.page, 15, "alice's first pack");
      const ordinary = first.find((n) => n !== AUTOMATON);
      if (ordinary === undefined) throw new Error('the first pack is all Automatons');
      const before = await settledLog(alice.page);
      await pickNamed(alice.page, ordinary);
      await expect(alice.page.getByTestId('pool-count')).toHaveText('1', { timeout: UI_TIMEOUT });
      expect(await settledLog(alice.page), 'an ordinary pick says nothing').toEqual(before);

      /* ── her second is the Automaton: revealed, and noted as her second card, on both screens ── */
      const second = await packOfSize(alice.page, 14, "alice's second pack, passed from the seat before her");
      expect(second, 'the second pack holds an Automaton').toContain(AUTOMATON);
      await pickNamed(alice.page, AUTOMATON);
      for (const p of players) {
        await expect
          .poll(() => tail(p.page, 2), { message: `${p.name}: is told she revealed it and what it noted`, timeout: UI_TIMEOUT })
          .toEqual([`e2e-alice revealed ${AUTOMATON}`, `e2e-alice noted ${AUTOMATON} 2`]);
        await expect(p.page.getByTestId('face-up'), `${p.name}: it is not left face up`).toHaveCount(0);
      }
      await expect(alice.page.getByTestId('pool-count')).toHaveText('2');
      await expect(alice.page.getByTestId('draft-ask'), 'it asks nothing').toHaveCount(0);
      await expect(alice.page.getByTestId('draft-use'), 'and offers nothing to use').toHaveCount(0);
    } finally {
      await stack.stop();
    }
  },
);

test(
  titled('Aether Searcher is revealed, and the next card its drafter takes is revealed to the table by name'),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(8 * 60_000);

    seedCube(SEARCHER);

    const stack = await startPlayStack(forge);
    try {
      const alice: Player = await openFriend(browser, 'alice');
      const bob: Player = await openFriend(browser, 'bob');
      const players = [alice, bob];
      await dealPod(alice, bob, stack.origin);

      /* ── alice drafts a Searcher: the table is told ── */
      const first = await packOfSize(alice.page, 15, "alice's first pack");
      expect(first, 'the first pack holds a Searcher').toContain(SEARCHER);
      await settledLog(alice.page);
      await pickNamed(alice.page, SEARCHER);
      for (const p of players) {
        await expect.poll(() => tail(p.page, 1), { message: `${p.name}: is told she revealed it`, timeout: UI_TIMEOUT }).toEqual([`e2e-alice revealed ${SEARCHER}`]);
      }

      /* ── her next card, an ordinary one that occurs once in the draft, is shown to the table by name ── */
      const second = await packOfSize(alice.page, 14, "alice's second pack");
      const next = second.find((n) => n !== SEARCHER);
      if (next === undefined) throw new Error('the second pack is all Searchers');
      await pickNamed(alice.page, next);
      for (const p of players) {
        await expect
          .poll(() => tail(p.page, 1), { message: `${p.name}: is shown the next card she drafted`, timeout: UI_TIMEOUT })
          .toEqual([`e2e-alice revealed and noted ${next} for ${SEARCHER}`]);
        await expect(p.page.getByTestId('face-up'), `${p.name}: nothing is left face up`).toHaveCount(0);
      }

      /* ── the card after that is hers alone ── */
      const third = await packOfSize(alice.page, 13, "alice's third pack");
      const hidden = third.find((n) => n !== SEARCHER && n !== next);
      if (hidden === undefined) throw new Error('the third pack is all Searchers');
      await pickNamed(alice.page, hidden);
      await expect(alice.page.getByTestId('pool-count')).toHaveText('3', { timeout: UI_TIMEOUT });
      for (const p of players) {
        expect(await settledLog(p.page), `${p.name}: nothing is said of her third card`).not.toEqual(expect.arrayContaining([expect.stringContaining(hidden)]));
        expect(await tail(p.page, 1)).toEqual([`e2e-alice revealed and noted ${next} for ${SEARCHER}`]);
      }
      await expect(bob.page.getByTestId('pool'), "bob's own pool shows none of it").not.toContainText(hidden);
    } finally {
      await stack.stop();
    }
  },
);
