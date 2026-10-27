/**
 * The front page's hero shows a running match — wave 77 §B
 * (`docs/planning/wave77-2026-10-27.md`). A third visitor, on the lobby while
 * two friends play a real match, sees `FeaturedMatch` draw that match's
 * board, and never takes a seat.
 *
 * `[fp-featured]` lines are the evidence.
 */
import { expect, test } from '@playwright/test';

import { PREFIX } from './identities.ts';
import { makeTitled } from './play/board.ts';
import { openFriend } from './play/browser.ts';
import { enterMatch } from './play/enter.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { keepBothHands } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

test(titled('the front page features a running match, and the visitor holds no seat'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(5 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice');
    const bob = await openFriend(browser, 'bob');
    const { matchId } = await enterMatch(alice, bob, stack.origin);
    console.log(`[fp-featured] match ${matchId} is live; a few real plays to make it score as "something is happening"`);
    // Featured needs a dealt game (`Match.live()`): past the coin toss and both keeps.
    await keepBothHands(alice, bob, alice);

    // `Match.activity()` scores the last two minutes of state churn — pass a
    // couple of turns for real rather than asserting the instant it deals.
    for (let i = 0; i < 4 && !(await alice.page.getByTestId('game-result').isVisible().catch(() => false)); i++) {
      await alice.page.getByTestId('live-button-end-turn').click({ timeout: 10_000 }).catch(() => undefined);
      await bob.page.getByTestId('live-button-end-turn').click({ timeout: 10_000 }).catch(() => undefined);
    }

    const carol = await openFriend(browser, 'carol');
    // What the server picked, as evidence: a red below reads differently if this is null.
    const listed = (await (await carol.context.request.get(`${stack.origin}${PREFIX}/api/rooms`)).json()) as { featured: unknown; rooms: { id: string; matchId?: string | null; tableGames?: Record<string, { live: unknown }> }[] };
    const games = listed.rooms.map((r) => ({ id: r.id, matchId: r.matchId ?? null, live: Object.values(r.tableGames ?? {}).map((g) => g.live) }));
    console.log(`[fp-featured] GET /api/rooms featured: ${JSON.stringify(listed.featured)}; rooms: ${JSON.stringify(games)}`);
    await carol.page.goto(`${stack.origin}${PREFIX}/`);

    const featured = carol.page.getByTestId('featured-match');
    const appeared = await featured.isVisible({ timeout: 20_000 }).catch(() => false);
    console.log(`[fp-featured] featured-match visible on the lobby: ${appeared}`);
    await expect(featured, 'the front page features the running match').toBeVisible({ timeout: 20_000 });
    await expect(featured.getByTestId('featured-match-tag')).toHaveText('LIVE');

    // The visitor holds no seat: her own page never becomes a player's match URL.
    await expect(carol.page, 'carol is never seated in the match she is watching').not.toHaveURL(new RegExp(`#/match/${matchId}$`));
  } finally {
    await stack.stop();
  }
});
