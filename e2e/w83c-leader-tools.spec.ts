/**
 * The room leader's tools in a tournament (the operator, 2026-10-30: *"there is no concept of an admin
 * for now. the room leader is the admin"*), against the real built server and real Forge:
 * - **DQ a player:** their current match is a loss, every remaining pairing is a bye for its opponent,
 *   and they stay in the standings with their record, marked dropped;
 * - **Reset a game:** the game in play restarts from scratch with the same decks, the series score kept;
 * - each works whether the leader is seated or watching, each asks for a confirmation in the page, and
 *   nobody else may use them;
 * - an entrant who leaves the room mid-round has dropped out the same way, and their opponent's board
 *   ends on the result.
 *
 * All Random tournaments, set up through each member's own API calls (`w79d-tournament.spec.ts`'s way):
 * the field locks on the last Ready and each entrant's table page starts its game by itself.
 *
 * `[w83c]` lines are the evidence: match ids before and after, the results and the standings.
 */
import { expect, test, type Page } from '@playwright/test';

import { openFriend, type Friend } from './play/browser.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';

const forge = forgeAvailability();
const titled = (t: string) => (forge.ok ? t : `${t} — SKIPPED: ${forge.reason}`);
const PREFIX = '/cardtable';
const UI_TIMEOUT = 30_000;
const matchUrl = /#\/match\/(m-[0-9a-f]{12})$/;

interface RoomBody {
  members: { id: string; name: string }[];
  tables: { id: string; matchId: string | null; players: { memberId: string }[]; series: { wins: [number, number]; games: unknown[]; phase: string } }[];
  pod: {
    phase: string;
    round: number;
    pairings: { tableId: string; players: [string, string] }[];
    results: { round: number; playerA: string; playerB: string | null; gamesA: number; gamesB: number }[];
    standings: { id: string }[];
    dropped?: string[];
  };
}

async function call<T>(f: Friend, origin: string, method: 'GET' | 'POST' | 'PATCH', path: string, data?: unknown): Promise<{ status: number; body: T }> {
  const res = await f.context.request.fetch(`${origin}${PREFIX}/api${path}`, { method, ...(method === 'GET' ? {} : { data: data ?? {} }) });
  return { status: res.status(), body: (await res.json().catch(() => null)) as T };
}

/** An All Random tournament `leader` creates; `entrants` sit at seats 0.. in order, then `ai` AI seats; everyone readies. */
async function tournament(origin: string, leader: Friend, members: Friend[], entrants: Friend[], ai: number): Promise<string> {
  await leader.page.goto(`${origin}${PREFIX}/`);
  const made = await call<{ id: string }>(leader, origin, 'POST', '/rooms', { name: `e2e w83c ${Date.now()}`, gameType: 'constructed-1v1', mode: 'random', modeOptions: { pool: 'modern' } });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  const roomId = made.body.id;
  expect((await call(leader, origin, 'PATCH', `/rooms/${roomId}`, { settings: { tournament: true, tournamentDecks: 'per-round' } })).status).toBe(200);
  for (const m of members) if (m !== leader) expect((await call(m, origin, 'POST', `/rooms/${roomId}/join`)).status).toBe(200);
  for (const [seat, e] of entrants.entries()) expect((await call(e, origin, 'POST', `/rooms/${roomId}/pod/sit`, { seat })).status).toBe(200);
  for (let seat = entrants.length; seat < entrants.length + ai; seat++) expect((await call(leader, origin, 'POST', `/rooms/${roomId}/pod/ai`, { seat, on: true })).status).toBe(200);
  // The e2e edge serves no `/session/whoami`: each browser is told its own member id, so its screens know whose seat and whose room it is.
  const { body } = await call<RoomBody>(leader, origin, 'GET', `/rooms/${roomId}`);
  for (const m of members) {
    const me = body.members.find((x) => x.name === `e2e-${m.name}`)!;
    await m.context.route('**/session/whoami', (route) => route.fulfill({ json: { valid: true, userId: me.id, userType: 'friend', name: me.name } }));
  }
  for (const e of entrants) expect((await call(e, origin, 'POST', `/rooms/${roomId}/ready`, { ready: true })).status).toBe(200);
  return roomId;
}

/** The entrant's own current table, from the room. */
function tableOf(room: RoomBody, memberId: string): RoomBody['tables'][number] {
  const pairing = room.pod.pairings.find((p) => p.players.includes(memberId));
  const table = room.tables.find((t) => t.id === pairing?.tableId);
  if (table === undefined) throw new Error(`${memberId}: no table this round`);
  return table;
}

/** Into my table's game: the table page starts it by itself; returns its match id. */
async function intoGame(p: Friend, origin: string, roomId: string, tableId: string): Promise<string> {
  await p.page.goto(`${origin}${PREFIX}/#/room/${roomId}/table/${tableId}`);
  // Between games of the series, the sideboard step first.
  const sideboard = p.page.getByTestId('sideboard-ready');
  await expect.poll(async () => matchUrl.test(p.page.url()) || (await sideboard.isVisible()), { timeout: UI_TIMEOUT, message: `${p.name}: a game or its sideboard step` }).toBe(true);
  if (!matchUrl.test(p.page.url())) await sideboard.click();
  await p.page.waitForURL(matchUrl, { timeout: UI_TIMEOUT });
  await expect(p.page.locator('[aria-label="Game board"]'), `${p.name}: in the game`).toBeVisible({ timeout: UI_TIMEOUT });
  return matchUrl.exec(p.page.url())![1]!;
}

/** The hub's card for the table `tableId`. */
const card = (page: Page, tableId: string) => page.locator(`[data-testid="pod-tables-row"][data-table-id="${tableId}"]`);

/** Offers, confirms and answers a leader tool on a table card. */
async function confirmOnCard(page: Page, tableId: string, offer: RegExp): Promise<void> {
  const row = card(page, tableId);
  await row.getByRole('button', { name: offer }).click();
  const confirm = row.locator('.table-card__confirm');
  await expect(confirm, 'a destructive tool asks first').toBeVisible();
  await confirm.locator('[data-testid$="-yes"]').click();
  await expect(confirm).toHaveCount(0, { timeout: UI_TIMEOUT });
}

test(titled('a watching leader resets a game (the score stands, a fresh game follows) and DQs a player (a loss, byes after, marked in the standings); nobody else may'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(8 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice');
    const bob = await openFriend(browser, 'bob');
    const carol = await openFriend(browser, 'carol');
    const roomId = await tournament(stack.origin, alice, [alice, bob, carol], [bob, carol], 2);
    const room = async () => (await call<RoomBody>(alice, stack.origin, 'GET', `/rooms/${roomId}`)).body;
    let r = await room();
    expect(r.pod.phase, 'the field locked').toBe('rounds');
    const id = (f: Friend) => r.members.find((m) => m.name === `e2e-${f.name}`)!.id;
    const [bobId, carolId] = [id(bob), id(carol)];
    const bobs = tableOf(r, bobId);
    const carols = tableOf(r, carolId);
    expect(bobs.id, 'each human plays an AI').not.toBe(carols.id);

    // Carol loses game 1, so a reset of game 2 has a score to keep.
    await intoGame(carol, stack.origin, roomId, carols.id);
    await carol.page.getByTestId('live-concede').click();
    await carol.page.getByTestId('live-concede-yes').click();
    await expect(carol.page.getByTestId('game-result')).toBeVisible({ timeout: UI_TIMEOUT });
    await expect.poll(async () => tableOf(await room(), carolId).series.wins, { timeout: UI_TIMEOUT }).toEqual([0, 1]);
    const game2 = await intoGame(carol, stack.origin, roomId, carols.id);
    const bobGame = await intoGame(bob, stack.origin, roomId, bobs.id);

    // Nobody but the leader: no tool on a player's hub, and the server refuses one asked for.
    expect((await call(carol, stack.origin, 'POST', `/rooms/${roomId}/pod/dq`, { memberId: bobId })).status, 'a player may not DQ').toBe(403);
    expect((await call(carol, stack.origin, 'POST', `/rooms/${roomId}/tables/${bobs.id}/reset`)).status, 'a player may not reset').toBe(403);

    // The leader, watching, resets Carol's game 2.
    await alice.page.goto(`${stack.origin}${PREFIX}/#/room/${roomId}`);
    await expect(card(alice.page, carols.id)).toBeVisible({ timeout: UI_TIMEOUT });
    await confirmOnCard(alice.page, carols.id, /^Reset game$/);
    // Carol is carried to a fresh game 2: a new match, the series still 0–1.
    await carol.page.waitForURL((u) => matchUrl.test(u.hash) && !u.hash.endsWith(game2), { timeout: UI_TIMEOUT });
    await expect(carol.page.locator('[aria-label="Game board"]'), 'carol: a fresh game').toBeVisible({ timeout: UI_TIMEOUT });
    r = await room();
    const afterReset = tableOf(r, carolId);
    console.log(`[w83c] reset: ${game2} -> ${afterReset.matchId} series ${JSON.stringify(afterReset.series)}`);
    expect(afterReset.matchId).not.toBe(game2);
    expect(afterReset.series).toMatchObject({ wins: [0, 1], phase: 'playing' });
    expect(afterReset.series.games, 'the reset game is not counted').toHaveLength(1);
    await expect(card(alice.page, carols.id).locator('.table-card__wins')).toHaveText('0–1');

    // The leader DQs Bob mid-game: his board ends on the result, his match a 0–2 loss.
    await confirmOnCard(alice.page, bobs.id, /^DQ e2e-bob$/);
    await expect(bob.page.getByTestId('game-result'), 'bob: his game ends at once').toBeVisible({ timeout: 15_000 });
    r = await room();
    console.log(`[w83c] after DQ: results ${JSON.stringify(r.pod.results)} dropped ${JSON.stringify(r.pod.dropped)} (game ${bobGame})`);
    expect(r.pod.dropped).toEqual([bobId]);
    const lost = r.pod.results.find((x) => x.round === 1 && (x.playerA === bobId || x.playerB === bobId))!;
    expect(lost.playerA === bobId ? [lost.gamesA, lost.gamesB] : [lost.gamesB, lost.gamesA], 'a loss').toEqual([0, 2]);

    // Carol finishes round 1; round 2 gives Bob no table — his opponent's pairing is a bye.
    await carol.page.getByTestId('live-concede').click();
    await carol.page.getByTestId('live-concede-yes').click();
    await expect.poll(async () => (await room()).pod.round, { timeout: UI_TIMEOUT }).toBeGreaterThan(1);
    r = await room();
    console.log(`[w83c] round 2: pairings ${JSON.stringify(r.pod.pairings)} results ${JSON.stringify(r.pod.results.filter((x) => x.round === 2))}`);
    expect(r.pod.pairings.flatMap((p) => p.players)).not.toContain(bobId);
    expect(r.pod.results.filter((x) => x.round === 2 && (x.playerA === bobId || x.playerB === bobId)), 'his record is kept as it was').toEqual([]);
    expect(r.pod.results.filter((x) => x.round === 2 && x.playerB === null), 'whoever drew him has a bye').toHaveLength(1);

    // The standings keep him, marked.
    await alice.page.goto(`${stack.origin}${PREFIX}/#/room/${roomId}`);
    const dropped = alice.page.locator('[data-testid^="pod-standings-row-"][data-dropped]');
    await expect(dropped, 'one row marked dropped').toHaveCount(1, { timeout: UI_TIMEOUT });
    await expect(dropped).toContainText('e2e-bob');
    await expect(alice.page.getByTestId(/^pod-standings-row-\d+$/)).toHaveCount(4);
  } finally {
    await stack.stop();
  }
});

test(titled('a seated leader resets their own game and both seats are back in a fresh one; an opponent who leaves the room is a drop, and the board ends on the result'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(6 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice');
    const bob = await openFriend(browser, 'bob');
    const roomId = await tournament(stack.origin, alice, [alice, bob], [alice, bob], 0);
    const room = async () => (await call<RoomBody>(alice, stack.origin, 'GET', `/rooms/${roomId}`)).body;
    const r = await room();
    const bobId = r.members.find((m) => m.name === 'e2e-bob')!.id;
    const table = tableOf(r, bobId);
    await Promise.all([intoGame(alice, stack.origin, roomId, table.id), intoGame(bob, stack.origin, roomId, table.id)]);
    const game1 = tableOf(await room(), bobId).matchId!;

    // Alice, seated, steps out to the hub and resets it there; Bob's board follows to the fresh game, and hers starts from her table.
    await alice.page.goto(`${stack.origin}${PREFIX}/#/room/${roomId}`);
    await expect(card(alice.page, table.id)).toBeVisible({ timeout: UI_TIMEOUT });
    await expect(card(alice.page, table.id).getByRole('button', { name: /^Drop match$/ }), 'her own tools beside the leader’s').toBeVisible();
    await confirmOnCard(alice.page, table.id, /^Reset game$/);
    await intoGame(alice, stack.origin, roomId, table.id);
    await bob.page.waitForURL((u) => matchUrl.test(u.hash) && !u.hash.endsWith(game1), { timeout: UI_TIMEOUT });
    await expect(bob.page.locator('[aria-label="Game board"]'), 'bob: carried to the fresh game').toBeVisible({ timeout: UI_TIMEOUT });
    expect(matchUrl.exec(alice.page.url())![1], 'both in the same fresh game').toBe(matchUrl.exec(bob.page.url())![1]);
    const after = tableOf(await room(), bobId);
    console.log(`[w83c] seated reset: ${game1} -> ${after.matchId} series ${JSON.stringify(after.series)}`);
    expect(after.series).toMatchObject({ wins: [0, 0], phase: 'playing' });

    // Bob leaves the room mid-game: a drop. Alice's board ends on her win within seconds.
    expect((await call(bob, stack.origin, 'POST', `/rooms/${roomId}/leave`)).status).toBe(200);
    await expect(alice.page.getByTestId('game-result'), 'alice: the game ends on the leave').toBeVisible({ timeout: 15_000 });
    await expect(alice.page.getByTestId('game-result')).toHaveAttribute('data-result', 'victory');
    const done = await room();
    console.log(`[w83c] after leave: ${JSON.stringify(done.pod)}`);
    expect(done.pod.dropped).toEqual([bobId]);
    expect(done.pod.results).toHaveLength(1);
    expect(done.pod.phase).toBe('done');
  } finally {
    await stack.stop();
  }
});
