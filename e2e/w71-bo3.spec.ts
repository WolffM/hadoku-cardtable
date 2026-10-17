/**
 * Wave 71 §D, the operator's bo3 acceptance sentence:
 *
 *   > bo3 just means that rematch is forced after a round ends.
 *
 * API-driven, no new UI (the room screen's own bo3/sideboard controls are
 * wave 72's, built on this): every room, settings, deck and ready call here
 * goes straight to the HTTP API through each friend's own browser-context
 * identity, never through a form or a button that does not exist yet. Only
 * the MATCH board, the play-or-draw prompt and the concede button are
 * pressed — all three already shipped, used the same way `e2e/w31.spec.ts`
 * and `e2e/w69-rematch.spec.ts` use them.
 *
 * The sequence is the wave file's §Acceptance item 2, verbatim:
 *
 *   1. A room is set to `bo3`.
 *   2. Game 1 ends by concede, and the table goes to `sideboarding` with no
 *      Rematch press.
 *   3. Both players re-submit and ready up.
 *   4. Game 2 starts with the LOSER of game 1 asked play-or-draw — proof that
 *      lane E's `MatchSpec.chooser` reaches the bridge and rigs the toss.
 *   5. A second concede by the SAME player ends the series 2–0 (`phase: 'done'`).
 *
 * `[w71-bo3]` lines are the evidence: the series after each game, and the
 * seat asked play-or-draw.
 */

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { openFriend, type Friend } from './play/browser.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';

const forge = forgeAvailability();
const titled = (t: string) => (forge.ok ? t : `${t} — SKIPPED: ${forge.reason}`);
const PREFIX = '/cardtable';

interface RoomTableLike {
  matchId: string | null;
  series: {
    length: 1 | 3;
    wins: [number, number];
    games: { matchId: string; winner: 0 | 1 | null }[];
    phase: 'seating' | 'playing' | 'sideboarding' | 'done';
  };
}
interface RoomViewLike {
  tables: RoomTableLike[];
}

/** One friend's own identity, straight to the HTTP API — never a form, never a button. */
async function post<T>(request: APIRequestContext, origin: string, path: string, data: unknown): Promise<T> {
  const res = await request.post(`${origin}${PREFIX}/api${path}`, { data });
  if (!res.ok()) throw new Error(`POST ${path} -> ${res.status()}: ${await res.text()}`);
  return (await res.json()) as T;
}
async function patch<T>(request: APIRequestContext, origin: string, path: string, data: unknown): Promise<T> {
  const res = await request.patch(`${origin}${PREFIX}/api${path}`, { data });
  if (!res.ok()) throw new Error(`PATCH ${path} -> ${res.status()}: ${await res.text()}`);
  return (await res.json()) as T;
}
async function put<T>(request: APIRequestContext, origin: string, path: string, data: unknown): Promise<T> {
  const res = await request.put(`${origin}${PREFIX}/api${path}`, { data });
  if (!res.ok()) throw new Error(`PUT ${path} -> ${res.status()}: ${await res.text()}`);
  return (await res.json()) as T;
}
async function get<T>(request: APIRequestContext, origin: string, path: string): Promise<T> {
  const res = await request.get(`${origin}${PREFIX}/api${path}`);
  if (!res.ok()) throw new Error(`GET ${path} -> ${res.status()}: ${await res.text()}`);
  return (await res.json()) as T;
}

const matchUrl = (origin: string, matchId: string): string => `${origin}${PREFIX}/#/match/${matchId}`;

/**
 * Two decks legal in `format` — whatever a new room's own RANDOM era turned
 * out to be (`room/lobby.ts`'s `randomFormat`; a room created with no
 * `format` field is not pinned to any one era). `play/enter.ts`'s own
 * `twoLegalDecks` is fixed to `E2E_ERA` and is the wrong tool here for
 * exactly that reason — it read as green against a 2003 era while a 2025 one
 * (whatever this run actually landed on) refused "Wake (Marco Blume)" as
 * not legal in it. Asks the room's own catalogue, the way the room screen's
 * own picker does (`GET /tables/decks` + `GET /tables/legal/:format`).
 */
async function twoLegalDecksFor(request: APIRequestContext, origin: string, format: string): Promise<[string, string]> {
  const decks = (await get<{ decks: { id: string }[] }>(request, origin, '/tables/decks')).decks;
  const legal = new Set((await get<{ legal: string[] }>(request, origin, `/tables/legal/${encodeURIComponent(format)}`)).legal);
  const offered = decks.filter((d) => legal.has(d.id)).map((d) => d.id);
  if (offered.length < 2) throw new Error(`${format} offers ${String(offered.length)} legal deck(s), not two`);
  return [offered[0]!, offered[1]!];
}

async function boardUp(page: Page): Promise<void> {
  await expect(page.locator('[aria-label="Game board"]')).toBeVisible({ timeout: 60_000 });
}

/** Alice concedes or bob concedes — whoever is named plays the loser's part. */
async function concede(f: Friend): Promise<void> {
  await f.page.getByTestId('live-concede').click();
  await f.page.getByTestId('live-concede-yes').click();
}

test(titled('a bo3 series: concede ends game 1 into sideboarding with no Rematch press; game 2 asks the loser play-or-draw; a second concede ends it 2-0'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(6 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice');
    const bob = await openFriend(browser, 'bob');
    // Both contexts need one authenticated request against the app before
    // `twoLegalDecks`'s bare API calls resolve under the edge's own origin —
    // same as every other API-only spec (`play/enter.ts`'s own `twoLegalDecks`
    // caller does this by navigating first).
    await alice.page.goto(`${stack.origin}${PREFIX}/`);
    await bob.page.goto(`${stack.origin}${PREFIX}/`);

    // 1. A room, set to bo3 — entirely through the API. A new room's own
    // format is RANDOM (`room/lobby.ts`'s `randomFormat`), so the decks have
    // to be picked for WHATEVER era this one actually got, not a fixed one.
    const created = await post<{ id: string; format: string }>(alice.context.request, stack.origin, '/rooms', {
      name: `e2e w71-bo3 ${Date.now()}`,
      gameType: 'constructed-1v1',
    });
    const roomId = created.id;
    await patch(alice.context.request, stack.origin, `/rooms/${roomId}`, { settings: { matchLength: 'bo3' } });
    await post(bob.context.request, stack.origin, `/rooms/${roomId}/join`, {});

    const decks = await twoLegalDecksFor(alice.context.request, stack.origin, created.format);
    console.log(`[w71-bo3] room ${roomId} on ${created.format}: decks ${decks.join(', ')}`);
    const loadAndReady = async (f: Friend, deck: string): Promise<void> => {
      await put(f.context.request, stack.origin, `/tables/rooms/${roomId}/deck`, { deck: { library: deck } });
      await post(f.context.request, stack.origin, `/tables/rooms/${roomId}/ready`, { ready: true });
    };
    await loadAndReady(alice, decks[0]); // seat 0: alice loads and sits first
    await loadAndReady(bob, decks[1]); // seat 1: bob

    const game1 = await post<{ matchId: string }>(alice.context.request, stack.origin, '/play/matches', { room: roomId });
    await alice.page.goto(matchUrl(stack.origin, game1.matchId));
    await bob.page.goto(matchUrl(stack.origin, game1.matchId));
    await boardUp(alice.page);
    await boardUp(bob.page);
    console.log(`[w71-bo3] game 1 started: ${game1.matchId}`);

    // 2. Bob concedes: the table goes to `sideboarding` AT ONCE, no Rematch press.
    await concede(bob);
    await expect(alice.page.getByTestId('game-result'), "alice's result screen").toBeVisible({ timeout: 45_000 });
    await expect(bob.page.getByTestId('game-result'), "bob's result screen").toBeVisible({ timeout: 45_000 });

    const afterGame1 = await get<RoomViewLike>(alice.context.request, stack.origin, `/rooms/${roomId}`);
    const table = afterGame1.tables[0]!;
    console.log(`[w71-bo3] after game 1 (bob conceded): ${JSON.stringify(table.series)}`);
    expect(table.matchId, 'no live match between games').toBeNull();
    expect(table.series.phase, 'straight to sideboarding — no Rematch press happened').toBe('sideboarding');
    expect(table.series.wins, 'alice (seat 0) won the game bob conceded').toEqual([1, 0]);
    expect(table.series.games).toEqual([{ matchId: game1.matchId, winner: 0 }]);

    // 3. Both players re-submit (the same deck — a legal sideboard move of
    // itself) and ready up, through the API, during `sideboarding`.
    await loadAndReady(alice, decks[0]);
    await loadAndReady(bob, decks[1]);

    const game2 = await post<{ matchId: string }>(alice.context.request, stack.origin, '/play/matches', { room: roomId });
    expect(game2.matchId, 'a fresh Forge match for game 2').not.toBe(game1.matchId);
    await alice.page.goto(matchUrl(stack.origin, game2.matchId));
    await bob.page.goto(matchUrl(stack.origin, game2.matchId));

    // 4. Game 2: the LOSER of game 1 (bob, seat 1) is asked play-or-draw —
    // lane E's `MatchSpec.chooser` rigging Forge's own coin toss.
    await expect(bob.page.getByTestId('live-says'), "bob (game 1's loser) is asked").toContainText(/play or draw/i, { timeout: 30_000 });
    await expect(bob.page.getByTestId('live-play-or-draw-play')).toBeVisible({ timeout: 10_000 });
    await expect(alice.page.getByTestId('live-play-or-draw-play'), 'alice is not asked — she won game 1').toHaveCount(0);
    console.log('[w71-bo3] game 2: bob (the loser) was asked play-or-draw, not alice');
    await bob.page.getByTestId('live-play-or-draw-play').click();
    await boardUp(alice.page);
    await boardUp(bob.page);

    // 5. Bob concedes AGAIN: the series ends 2-0, phase `done`.
    await concede(bob);
    await expect(alice.page.getByTestId('game-result')).toBeVisible({ timeout: 45_000 });
    await expect(bob.page.getByTestId('game-result')).toBeVisible({ timeout: 45_000 });

    const afterGame2 = await get<RoomViewLike>(alice.context.request, stack.origin, `/rooms/${roomId}`);
    const finalTable = afterGame2.tables[0]!;
    console.log(`[w71-bo3] after game 2 (bob conceded again): ${JSON.stringify(finalTable.series)}`);
    expect(finalTable.matchId).toBeNull();
    expect(finalTable.series.phase, 'the series is over, 2-0').toBe('done');
    expect(finalTable.series.wins).toEqual([2, 0]);
    expect(finalTable.series.games.map((g) => g.winner)).toEqual([0, 0]);
  } finally {
    await stack.stop();
  }
});
