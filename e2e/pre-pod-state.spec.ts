/**
 * A draft pod's state machine against the real built server and real Forge, the cells that matter most for
 * a big tournament night (`docs/planning/tournament-state-matrix.md`; the room's own bookkeeping for every
 * cell is `games/magic/server/src/room/tournament-state-matrix.test.ts`):
 *
 * - the server restarts mid-draft (a deploy) and every drafter is back on their pick;
 * - a drafter presses Leave mid-draft, with the pick timer off: their seat is picked for, the draft ends,
 *   and round 1 is their opponent's win, never a table waiting on nobody;
 * - the server restarts mid-round: both players are back in their match, which settles;
 * - the leader DQs a player between rounds: their next match is their opponent's, and the standings name
 *   everyone who left or was DQ'd.
 *
 * Two fields, four drafters and five (an odd field's bye), each at seats 0.. with the rest closed; carol is the
 * leaver in both. `[pre-pod]` lines are the evidence.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';

import { trimMainDeck } from './deckBuilder.ts';
import { PREFIX } from './identities.ts';
import { arrangePod, draftUntilDone, readyPod } from './podSeats.ts';
import { enterMyGames, makeTitled, pressIntoGame2, resizeWindow, roomIdFromAddress, ROOM_PAGE, sideboardFromTablePage } from './play/board.ts';
import { openFriend, type Friend } from './play/browser.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { openHub, openMyTable, submitCreateRoom } from './play/rooms.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const UI_TIMEOUT = 30_000;
const matchUrl = /#\/match\/(m-[0-9a-f]{12})$/;
const board = (f: Friend) => f.page.locator('[aria-label="Game board"]');

interface PodRead {
  phase: string;
  round: number;
  pairings: { tableId: string; players: [string, string] }[];
  results: { round: number; playerA: string; playerB: string | null; gamesA: number; gamesB: number }[];
  dropped: string[];
  drafters: string[];
  standings: { id: string }[];
  personas: Record<string, { name: string }>;
}

async function api<T>(f: Friend, origin: string, method: 'GET' | 'POST', path: string, data?: unknown): Promise<{ status: number; body: T }> {
  const res = await f.context.request.fetch(`${origin}${PREFIX}/api${path}`, { method, ...(method === 'GET' ? {} : { data: data ?? {} }) });
  return { status: res.status(), body: (await res.json().catch(() => null)) as T };
}

async function roomOf(f: Friend, origin: string, roomId: string): Promise<{ members: { id: string; name: string }[]; tables: { id: string; series: { phase: string } }[]; game: { pod: PodRead } }> {
  const r = await api<{ members: { id: string; name: string }[]; tables: { id: string; series: { phase: string } }[]; game: { pod: PodRead } }>(f, origin, 'GET', `/rooms/${roomId}`);
  expect(r.status, 'the room reads').toBe(200);
  return r.body;
}

/** A few picks, then stop: the draft is under way. */
async function pickSome(page: Page, n: number): Promise<void> {
  const grid = page.getByRole('group', { name: 'Pack layout' }).getByRole('button', { name: 'grid' });
  if ((await grid.getAttribute('aria-pressed')) !== 'true') await grid.click();
  for (let i = 0; i < n; i++) {
    const card = page.locator('[data-testid="pack"] button[data-testid="card"]:not([disabled])').first();
    await card.click({ timeout: UI_TIMEOUT });
    await page.waitForTimeout(400);
  }
}

/** `loser` concedes a pod table's Bo3 2–0, through the sideboard step between the games. */
async function concedeMatch(winner: Friend, loser: Friend, roomUrl: string): Promise<void> {
  for (let game = 0; game < 2; game++) {
    await loser.page.getByTestId('live-concede').click({ timeout: UI_TIMEOUT });
    await loser.page.getByTestId('live-concede-yes').click();
    await expect(winner.page.getByTestId('game-result'), `${winner.name}: game ${game + 1} ends`).toBeVisible({ timeout: UI_TIMEOUT });
    if (game === 1) return;
    for (const p of [winner, loser]) {
      await openMyTable(p.page, roomUrl);
      await sideboardFromTablePage(p.page, UI_TIMEOUT);
      await p.page.getByTestId('sideboard-ready').click({ timeout: UI_TIMEOUT });
    }
    // The next game exists once both are ready; each enters it by their own press.
    for (const p of [winner, loser]) await pressIntoGame2(p.page, matchUrl, UI_TIMEOUT);
    for (const p of [winner, loser]) await expect(board(p), `${p.name}: on game 2`).toBeVisible({ timeout: UI_TIMEOUT });
    const choose = loser.page.getByTestId('live-play-or-draw-play');
    await choose.click({ timeout: UI_TIMEOUT }).catch(() => undefined);
  }
}

/** Each table of the current round, as the two Friends at it. */
function tablesOf(pod: PodRead, friendOf: Map<string, Friend>): [Friend, Friend][] {
  return pod.pairings.map((x) => [friendOf.get(x.players[0])!, friendOf.get(x.players[1])!]);
}

/** Every entrant still in has exactly one place this round: a table, or a result already settled (a bye, a leaver's win). */
function placedOnce(pod: PodRead, active: string[], round: number): void {
  for (const id of active) {
    const tables = pod.pairings.filter((x) => x.players.includes(id)).length;
    const settled = pod.results.filter((r) => r.round === round && (r.playerA === id || r.playerB === id)).length;
    expect(tables + settled, `${id}: one place in round ${round}`).toBe(1);
  }
}

/**
 * One cell of the matrix on real Forge: `names` sit at seats 0.., the rest close, `leaver` presses Leave mid-draft,
 * the server restarts mid-draft and mid-round 1, and the leader (`names[0]`) DQs someone at a round-2 table.
 */
async function podCell(browser: Browser, jar: { jar: string; res: string }, names: string[], leaver: string): Promise<void> {
  const stack = await startPlayStack(jar);
  const origin = stack.origin;
  try {
    const players: Friend[] = [];
    for (const n of names) players.push(await openFriend(browser, n));
    const [leader] = players as [Friend];
    const gone = players.find((p) => p.name === leaver)!;
    const staying = players.filter((p) => p !== gone);

    /* ── the leader makes the pod, the others come in, the field sits, the rest close ── */
    await leader.page.goto(`${origin}${PREFIX}/`);
    await submitCreateRoom(leader.page, { name: `e2e pre-pod ${names.length} ${Date.now()}`, gameType: 'draft' });
    const roomId = await roomIdFromAddress(leader.page);
    const roomUrl = `${origin}${PREFIX}/#/room/${roomId}`;
    for (const p of players.slice(1)) {
      await p.page.goto(roomUrl);
      await expect(p.page.getByTestId('draft-lobby'), `${p.name}: joined the room`).toBeVisible({ timeout: UI_TIMEOUT });
    }
    // The lobby draws before its join lands, so wait on the room naming everyone.
    const wanted = players.map((p) => `e2e-${p.name}`);
    await expect
      .poll(async () => {
        const { members } = await roomOf(leader, origin, roomId);
        return wanted.filter((n) => !members.some((m) => m.name === n));
      }, { timeout: UI_TIMEOUT, message: 'every drafter is a member' })
      .toEqual([]);
    // `useWhoami()` reads the real `fk:` id, which this edge serves no `/session/whoami` for (`w72-pod.spec.ts`).
    const members = (await roomOf(leader, origin, roomId)).members;
    const idOf = new Map<Friend, string>();
    const friendOf = new Map<string, Friend>();
    for (const p of players) {
      const me = members.find((m) => m.name === `e2e-${p.name}`);
      if (me === undefined) throw new Error(`${p.name}: not among the room's members`);
      idOf.set(p, me.id);
      friendOf.set(me.id, p);
      await p.context.route('**/session/whoami', (route) => route.fulfill({ json: { valid: true, userId: me.id, userType: 'guest', name: `e2e-${p.name}` } }));
      await p.page.reload();
      await resizeWindow(p.page, { width: 1280, height: 800 });
    }
    for (const p of players) await expect(p.page.getByTestId('pod-seats'), `${p.name}: the pod's seats are up`).toBeVisible({ timeout: UI_TIMEOUT });
    await arrangePod(players.map((p, seat) => [p.page, seat] as [Page, number]));
    const closed = Array.from({ length: 8 - players.length }, (_, k) => players.length + k);
    for (const seat of closed) await leader.page.locator(`[data-testid="pod-seat-close"][data-seat="${seat}"]`).click();
    await expect(leader.page.locator('[data-testid^="pod-seat-"][data-closed]')).toHaveCount(closed.length);
    for (const p of players) await readyPod(p.page);
    for (const p of players) await expect(p.page.getByTestId('pod'), `${p.name}: the pod is dealt`).toBeVisible({ timeout: UI_TIMEOUT });

    /* ── a few picks, then a deploy mid-draft ─────────────────────────── */
    await Promise.all(players.map((p) => pickSome(p.page, 2)));
    await stack.restart();
    for (const p of players) {
      await expect(p.page.locator('[data-testid="pack"] button[data-testid="card"]:not([disabled])').first(), `${p.name}: back on a pick after the restart`).toBeVisible({ timeout: 60_000 });
    }
    console.log(`[pre-pod] ${names.length}: restart mid-draft, all ${names.length} back on a pick`);

    /* ── the leaver presses Leave mid-draft; the pick timer is off ────── */
    // Off the room screen first, as the real Leave does (`leaveRoomThen`): a room screen still drawn
    // when its viewer stops being a member joins them again on the next read.
    await gone.page.goto('about:blank');
    expect((await api(gone, origin, 'POST', `/rooms/${roomId}/leave`)).status, `${leaver} leaves`).toBe(200);
    await gone.page.close();
    // Their seat is picked for (the draft bot), or this never finishes and the test times out.
    await Promise.all(staying.map((p) => draftUntilDone(p.page)));
    console.log(`[pre-pod] ${names.length}: the draft finished without ${leaver}`);
    for (const p of staying) {
      await expect(p.page.getByTestId('deck-editor'), `${p.name}: the editor`).toBeVisible({ timeout: UI_TIMEOUT });
      await trimMainDeck(p.page, 40, p.name);
      await p.page.getByTestId('play-deck').click();
      await p.page.waitForURL(ROOM_PAGE, { timeout: UI_TIMEOUT });
    }

    /* ── round 1: the leaver is out and no table waits for them ───────── */
    let pod = (await roomOf(leader, origin, roomId)).game.pod;
    console.log(`[pre-pod] ${names.length}: round 1 pairings ${JSON.stringify(pod.pairings)} results ${JSON.stringify(pod.results)} dropped ${JSON.stringify(pod.dropped)}`);
    const goneId = idOf.get(gone)!;
    expect(pod.dropped, `${leaver} is out from round 1`).toContain(goneId);
    expect(pod.pairings.some((x) => x.players.includes(goneId)), `no table waits for ${leaver}`).toBe(false);
    placedOnce(pod, staying.map((p) => idOf.get(p)!), 1);
    const tables = tablesOf(pod, friendOf);
    const seated = tables.flat();
    await enterMyGames(seated.map((p) => p.page), matchUrl, UI_TIMEOUT);
    for (const p of seated) await expect(board(p), `${p.name}: on round 1's board`).toBeVisible({ timeout: UI_TIMEOUT });
    const matchOf = new Map(seated.map((p) => [p, matchUrl.exec(p.page.url())![1]!]));

    /* ── a deploy mid-round ───────────────────────────────────────────── */
    await stack.restart();
    for (const p of seated) {
      await expect(p.page.getByTestId('live-status'), `${p.name}: rejoined after the restart`).toHaveCount(0, { timeout: 60_000 });
      await expect(board(p)).toBeVisible({ timeout: UI_TIMEOUT });
      expect(matchUrl.exec(p.page.url())?.[1], `${p.name}: the same match`).toBe(matchOf.get(p));
    }
    console.log(`[pre-pod] ${names.length}: restart mid-round, ${seated.length} back on their matches`);
    for (const [a, b] of tables) await concedeMatch(a, b, roomUrl);

    /* ── round 2, and the leader DQs someone at a table before their game ── */
    await expect.poll(async () => (await roomOf(leader, origin, roomId)).game.pod.round, { timeout: UI_TIMEOUT, message: 'round 2 pairs' }).toBe(2);
    pod = (await roomOf(leader, origin, roomId)).game.pod;
    console.log(`[pre-pod] ${names.length}: round 2 pairings ${JSON.stringify(pod.pairings)} results ${JSON.stringify(pod.results)}`);
    placedOnce(pod, staying.map((p) => idOf.get(p)!), 2);
    const target = pod.pairings.flatMap((x) => x.players).find((id) => id !== idOf.get(leader));
    if (target === undefined) throw new Error('round 2 has no table without the leader');
    const dq = await api<{ tableId: string | null }>(leader, origin, 'POST', `/rooms/${roomId}/pod/dq`, { memberId: target });
    expect(dq.status, 'the leader DQs a player').toBe(200);
    pod = (await roomOf(leader, origin, roomId)).game.pod;
    expect(pod.dropped, 'the DQ is out').toContain(target);
    // Their forfeited table stays in the round's pairings until the round ends, settled; a pairing of theirs with no result would wait.
    const after = pod;
    const waiting = after.pairings.filter((x) => x.players.includes(target) && !after.results.some((r) => r.round === after.round && (r.playerA === target || r.playerB === target)));
    expect(waiting, 'no table waits for the DQ').toEqual([]);
    const theirs = pod.results.find((r) => r.round === 2 && (r.playerA === target || r.playerB === target));
    expect(theirs, 'the DQ concedes their round-2 match').toBeDefined();
    const own = theirs!.playerA === target ? theirs!.gamesA : theirs!.gamesB;
    const other = theirs!.playerA === target ? theirs!.gamesB : theirs!.gamesA;
    expect(other, 'the DQ concedes their round-2 match').toBeGreaterThan(own);
    console.log(`[pre-pod] ${names.length}: after DQ results ${JSON.stringify(pod.results)} dropped ${JSON.stringify(pod.dropped)}`);

    /* ── the hub names everyone, gone or not ─────────────────────────── */
    await openHub(leader.page, roomUrl);
    const standings = leader.page.getByTestId('pod-standings');
    await expect(standings, 'standings on the hub').toBeVisible({ timeout: UI_TIMEOUT });
    await expect(leader.page.getByTestId(/^pod-standings-row-\d+$/)).toHaveCount(players.length);
    for (const p of players) await expect(standings, `${p.name} is named`).toContainText(`e2e-${p.name}`);
    await expect(standings, 'no raw id').not.toContainText('fk:');
  } finally {
    await stack.stop();
  }
}

const title = (what: string): string => titled(`a draft pod (${what}) through a deploy mid-draft, the leaver, a deploy mid-round and a DQ between rounds: nobody is stranded and everyone is named`);

/** One cell: the forge check, then the run. Each cell's `test()` is its own line, since forge.yml re-runs a red by its file and line. */
async function runCell(browser: Browser, field: string[], leaver: string): Promise<void> {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(16 * 60_000);
  await podCell(browser, forge, field, leaver);
}

// An even field: the leaver's round-1 opponent has the win, one table plays.
test(title('four drafters, one leaves'), ({ browser }) => runCell(browser, ['alice', 'bob', 'carol', 'erin'], 'carol'));
// An odd field: a bye, and the leaver is either at a table (their opponent's win) or given the bye themselves.
test(title('five drafters, one leaves: an odd field and its bye'), ({ browser }) => runCell(browser, ['alice', 'bob', 'carol', 'erin', 'drafter3'], 'carol'));
