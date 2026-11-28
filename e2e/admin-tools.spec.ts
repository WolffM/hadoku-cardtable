/**
 * Sunday's emergency tools, against the real built server and real Forge: an operator (the edge's
 * `wife` or `admin`, the operator's 2026-11-27 ruling: the raw edge tier, never a promoted member)
 * has the room leader's tools in a tournament they neither lead nor play in, and a member has none.
 *
 * - before the lock, a no-show's seat goes to the AI (`/seats/bot`), so the field can lock;
 * - Re-send asks: Forge says what it waits on for each human seat and sends it again;
 * - Restart turn: the game in play goes back to the start of its turn on a new JVM, the same match,
 *   and the game as it was before is kept as its own recording (`<matchId>-e1`);
 * - Game to a player: the other seat (here the AI) concedes it, so both screens end and it counts;
 * - Match to a player: the series ends at the majority, the standings take it, the boards end;
 * - Replay match: 0–0 again, no result;
 * - the room's live matches (`GET …/admin/live`): whose turn, the open ask, the clock.
 *
 * `[admin]` lines are the evidence.
 */
import { expect, test, type Page } from '@playwright/test';

import { door } from './play/board.ts';
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
  game: {
    pod: {
      phase: string;
      round: number;
      seats: ({ memberId: string } | null)[];
      pairings: { tableId: string; players: [string, string] }[];
      results: { round: number; playerA: string; playerB: string | null; gamesA: number; gamesB: number }[];
    };
  };
}

interface Live {
  tables: { tableId: string; matchId: string | null; epochs: string[]; match: { status: string; turn: number | null; restoreTurn: number | null; seats: { ai: boolean; asks: { method: string }[]; clock: unknown }[] } | null }[];
}

async function call<T>(f: Friend, origin: string, method: 'GET' | 'POST' | 'PATCH', path: string, data?: unknown): Promise<{ status: number; body: T }> {
  const res = await f.context.request.fetch(`${origin}${PREFIX}/api${path}`, { method, ...(method === 'GET' ? {} : { data: data ?? {} }) });
  return { status: res.status(), body: (await res.json().catch(() => null)) as T };
}

/** The hub's card for the table `tableId`. */
const card = (page: Page, tableId: string) => page.locator(`[data-testid="pod-tables-row"][data-table-id="${tableId}"]`);

/** Offers, confirms and answers a leader tool on a table card, behind its ⋯. */
async function confirmOnCard(page: Page, tableId: string, offer: RegExp): Promise<void> {
  const more = card(page, tableId).getByTestId('pod-tables-row-more');
  if ((await more.getAttribute('aria-expanded')) !== 'true') await more.click();
  await page.getByTestId('pod-tables-row-tools').getByRole('menu').getByRole('menuitem', { name: offer }).click();
  const confirm = page.getByTestId('pod-tables-row-tools').locator('.table-card__confirm');
  await expect(confirm, 'a destructive tool asks first').toBeVisible();
  await confirm.locator('[data-testid$="-yes"]').click();
  await expect(confirm).toHaveCount(0, { timeout: UI_TIMEOUT });
  await page.keyboard.press('Escape');
}

/** Into my table's game by its page's one way on; returns its match id. */
async function intoGame(p: Friend, origin: string, roomId: string, tableId: string): Promise<string> {
  await p.page.goto(`${origin}${PREFIX}/#/room/${roomId}/table/${tableId}`);
  const way = door(p.page);
  await expect(way, `${p.name}: the table page's one way on`).toHaveCount(1, { timeout: UI_TIMEOUT });
  await way.click();
  await p.page.waitForURL(matchUrl, { timeout: UI_TIMEOUT });
  await expect(p.page.locator('[aria-label="Game board"]'), `${p.name}: in the game`).toBeVisible({ timeout: UI_TIMEOUT });
  return matchUrl.exec(p.page.url())![1]!;
}

test(titled('an operator who neither leads nor plays replaces a no-show, restarts a turn, awards a game and a match and replays one; a member may not'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(10 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const [alice, bob, carol, third, erin, wife, admin] = await Promise.all(['alice', 'bob', 'carol', 'drafter3', 'erin', 'wife', 'admin'].map((n) => openFriend(browser, n)));
    const origin = stack.origin;
    await alice.page.goto(`${origin}${PREFIX}/`);
    const made = await call<{ id: string }>(alice, origin, 'POST', '/rooms', { name: `e2e admin ${Date.now()}`, gameType: 'constructed-1v1', mode: 'random', modeOptions: { pool: 'modern' } });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const roomId = made.body.id;
    expect((await call(alice, origin, 'PATCH', `/rooms/${roomId}`, { settings: { tournament: true, tournamentDecks: 'per-round' } })).status).toBe(200);
    // Bob, Carol, a third member and Erin (a member who will not show) take the four seats; the leader watches.
    const entrants = [bob, carol, third, erin];
    for (const m of [bob, carol, third, erin, admin]) expect((await call(m, origin, 'POST', `/rooms/${roomId}/join`)).status).toBe(200);
    for (const m of [alice, bob, carol, third, erin, admin]) expect((await call(m, origin, 'POST', `/rooms/${roomId}/pod/stand`)).status).toBe(200);
    for (const [seat, e] of entrants.entries()) expect((await call(e, origin, 'POST', `/rooms/${roomId}/pod/sit`, { seat })).status).toBe(200);
    const room = async () => (await call<RoomBody>(alice, origin, 'GET', `/rooms/${roomId}`)).body;
    let r = await room();
    const id = (f: Friend) => r.members.find((m) => m.name === `e2e-${f.name}`)!.id;
    for (const [f, tier] of [[alice, 'guest'], [bob, 'guest'], [carol, 'guest'], [third, 'guest'], [erin, 'member'], [admin, 'admin']] as const) {
      const me = r.members.find((x) => x.name === `e2e-${f.name}`)!;
      await f.context.route('**/session/whoami', (route) => route.fulfill({ json: { valid: true, userId: me.id, userType: tier, name: me.name } }));
    }

    // Erin is a member, not an operator: no seat tool of the leader's is hers. The wife-tier operator, who is not even in the room, puts the AI in Erin's seat.
    expect((await call(erin, origin, 'POST', `/rooms/${roomId}/seats/bot`, { seat: 0 })).status, 'a member may not').toBe(403);
    expect((await call(wife, origin, 'POST', `/rooms/${roomId}/seats/bot`, { seat: 3 })).status, 'an operator, from outside the room').toBe(200);
    r = await room();
    console.log(`[admin] seats after the operator's bot: ${JSON.stringify(r.game.pod.seats.slice(0, 4))}`);
    expect(r.game.pod.seats[3]?.memberId.startsWith('ai:'), 'the no-show’s seat is the AI’s').toBe(true);
    for (const e of [bob, carol, third]) expect((await call(e, origin, 'POST', `/rooms/${roomId}/ready`, { ready: true })).status).toBe(200);
    await expect.poll(async () => (await room()).game.pod.phase, { timeout: UI_TIMEOUT, message: 'the field locks with the AI in' }).toBe('rounds');
    r = await room();
    const [bobId, carolId, thirdId] = [id(bob), id(carol), id(third)];
    const tableOf = (who: string) => r.tables.find((t) => t.id === r.game.pod.pairings.find((p) => p.players.includes(who))!.tableId)!;
    const carols = tableOf(carolId);
    const bobs = tableOf(bobId);
    expect(r.game.pod.pairings.find((p) => p.tableId === carols.id)!.players.some((x) => x.startsWith('ai:')), 'carol plays the AI').toBe(true);
    expect(bobs.players.map((p) => p.memberId).sort()).toEqual([bobId, thirdId].sort());

    // A member refused every tool, a non-member member-tier caller told there is no such room.
    for (const [path, body] of [[`tables/${carols.id}/award`, { seat: 0 }], [`tables/${carols.id}/restore`, {}], [`tables/${carols.id}/replay`, {}], ['pod/dq', { memberId: bobId }]] as const) {
      expect((await call(erin, origin, 'POST', `/rooms/${roomId}/${path}`, body)).status, `a member: ${path}`).toBe(403);
    }
    expect((await call(erin, origin, 'GET', `/rooms/${roomId}/admin/live`)).status).toBe(403);

    // Carol's game against the AI. The admin, watching from the hub, restarts its turn.
    const carolGame = await intoGame(carol, origin, roomId, carols.id);
    await admin.page.goto(`${origin}${PREFIX}/#/room/${roomId}`);
    await expect(card(admin.page, carols.id)).toBeVisible({ timeout: UI_TIMEOUT });
    const live = async () => (await call<Live>(admin, origin, 'GET', `/rooms/${roomId}/admin/live`)).body.tables;
    await expect.poll(async () => (await live()).find((t) => t.tableId === carols.id)?.match?.status, { timeout: UI_TIMEOUT }).toBe('running');
    console.log(`[admin] live before restore: ${JSON.stringify((await live()).find((t) => t.tableId === carols.id))}`);
    await confirmOnCard(admin.page, carols.id, /^Restart turn$/);
    // The same match on a new JVM, and the game as it was before kept as its own recording.
    await expect
      .poll(async () => (await live()).find((t) => t.tableId === carols.id)?.epochs, { timeout: UI_TIMEOUT, message: 'the earlier epoch is kept' })
      .toEqual([`${carolGame}-e1`]);
    await expect.poll(async () => (await live()).find((t) => t.tableId === carols.id)?.match?.status, { timeout: UI_TIMEOUT }).toBe('running');
    r = await room();
    expect(r.tables.find((t) => t.id === carols.id)!.matchId, 'the same match').toBe(carolGame);
    await expect(carol.page.locator('[aria-label="Game board"]'), 'carol: still in her game').toBeVisible({ timeout: UI_TIMEOUT });
    const replayed = await call<{ header: unknown }>(admin, origin, 'GET', `/replays/${carolGame}-e1`);
    console.log(`[admin] earlier epoch replay: ${replayed.status}`);
    expect(replayed.status, 'the game before the restart is a replay').toBe(200);

    // Re-send asks: Forge answers what it waits on for Carol (the one human seat), the game goes on, and a member may not.
    expect((await call(erin, origin, 'POST', `/rooms/${roomId}/tables/${carols.id}/unstick`)).status).toBe(403);
    const resent = await call<{ seats: { seat: number; forge: string[] | null; shown: string[] }[] }>(admin, origin, 'POST', `/rooms/${roomId}/tables/${carols.id}/unstick`);
    console.log(`[admin] re-send asks: ${JSON.stringify(resent.body)}`);
    expect(resent.status).toBe(200);
    expect(resent.body.seats.map((x) => Array.isArray(x.forge)), 'the bridge said what it waits on').toEqual([true]);
    await expect(carol.page.locator('[aria-label="Game board"]'), 'carol: still in her game').toBeVisible({ timeout: UI_TIMEOUT });

    // Game to Carol: the AI concedes it, her board ends on the win, and it counts.
    await confirmOnCard(admin.page, carols.id, /^Game to e2e-carol$/);
    await expect(carol.page.getByTestId('game-result'), 'carol: the game ends').toBeVisible({ timeout: UI_TIMEOUT });
    await expect(carol.page.getByTestId('game-result')).toHaveAttribute('data-result', 'victory');
    await expect.poll(async () => (await room()).tables.find((t) => t.id === carols.id)!.series.wins, { timeout: UI_TIMEOUT }).toEqual([1, 0]);

    // Bob and the third member play; the wife-tier operator gives the third member the match. Both boards end.
    await Promise.all([intoGame(bob, origin, roomId, bobs.id), intoGame(third, origin, roomId, bobs.id)]);
    const thirdSeat = bobs.players.findIndex((p) => p.memberId === thirdId);
    expect((await call<{ wins: number[] }>(wife, origin, 'POST', `/rooms/${roomId}/tables/${bobs.id}/award`, { seat: thirdSeat, match: true })).status).toBe(200);
    await expect(bob.page.getByTestId('game-result'), 'bob: his board ends').toBeVisible({ timeout: UI_TIMEOUT });
    await expect(bob.page.getByTestId('game-result')).toHaveAttribute('data-result', 'defeat');
    r = await room();
    const awarded = r.game.pod.results.find((x) => x.round === 1 && (x.playerA === bobId || x.playerB === bobId))!;
    console.log(`[admin] match awarded: ${JSON.stringify(awarded)}`);
    expect(awarded.playerA === thirdId ? [awarded.gamesA, awarded.gamesB] : [awarded.gamesB, awarded.gamesA]).toEqual([2, 0]);

    // Replay Carol's match: 0–0 again, no result.
    await admin.page.goto(`${origin}${PREFIX}/#/room/${roomId}`);
    await confirmOnCard(admin.page, carols.id, /^Replay match$/);
    await expect.poll(async () => (await room()).tables.find((t) => t.id === carols.id)!.series, { timeout: UI_TIMEOUT }).toMatchObject({ wins: [0, 0], games: [], phase: 'seating' });
    r = await room();
    expect(r.game.pod.results.filter((x) => x.round === 1 && (x.playerA === carolId || x.playerB === carolId)), 'no result for a replayed match').toEqual([]);
    console.log(`[admin] after replay: ${JSON.stringify(r.tables.find((t) => t.id === carols.id))}`);
  } finally {
    await stack.stop();
  }
});
