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
 * Four drafters (alice, bob, carol, dave) at seats 0–3, the other four seats closed: round 1 pairs across
 * the table, alice–carol and bob–dave. `[pre-pod]` lines are the evidence.
 */
import { expect, test, type Page } from '@playwright/test';

import { trimMainDeck } from './deckBuilder.ts';
import { PREFIX } from './identities.ts';
import { arrangePod, draftUntilDone, readyPod } from './podSeats.ts';
import { enterMyGames, makeTitled, pressEnterGame, pressIntoGame2, resizeWindow, roomIdFromAddress, ROOM_PAGE, sideboardFromTablePage } from './play/board.ts';
import { openFriend, type Friend } from './play/browser.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { myTableThisRound, openHub, openMyTable, submitCreateRoom } from './play/rooms.ts';

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
    await pressEnterGame(winner.page);
    await pressIntoGame2(loser.page, matchUrl, UI_TIMEOUT);
    for (const p of [winner, loser]) await expect(board(p), `${p.name}: on game 2`).toBeVisible({ timeout: UI_TIMEOUT });
    const choose = loser.page.getByTestId('live-play-or-draw-play');
    await choose.click({ timeout: UI_TIMEOUT }).catch(() => undefined);
  }
}

test(
  titled('a draft pod through a deploy mid-draft, a leaver mid-draft, a deploy mid-round and a DQ between rounds: nobody is stranded and everyone is named'),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(14 * 60_000);
    const stack = await startPlayStack(forge);
    const origin = stack.origin;
    try {
      const alice = await openFriend(browser, 'alice');
      const bob = await openFriend(browser, 'bob');
      const carol = await openFriend(browser, 'carol');
      const dave = await openFriend(browser, 'dave');
      const players = [alice, bob, carol, dave];

      /* ── alice makes the pod, the others come in, four sit, the rest close ── */
      await alice.page.goto(`${origin}${PREFIX}/`);
      await submitCreateRoom(alice.page, { name: `e2e pre-pod ${Date.now()}`, gameType: 'draft' });
      const roomId = await roomIdFromAddress(alice.page);
      const roomUrl = `${origin}${PREFIX}/#/room/${roomId}`;
      for (const p of [bob, carol, dave]) {
        await p.page.goto(roomUrl);
        await expect(p.page.getByTestId('draft-lobby'), `${p.name}: joined the room`).toBeVisible({ timeout: UI_TIMEOUT });
      }
      // `useWhoami()` reads the real `fk:` id, which this edge serves no `/session/whoami` for (`w72-pod.spec.ts`).
      const members = (await roomOf(alice, origin, roomId)).members;
      const idOf = new Map<Friend, string>();
      for (const p of players) {
        const me = members.find((m) => m.name === `e2e-${p.name}`);
        if (me === undefined) throw new Error(`${p.name}: not among the room's members`);
        idOf.set(p, me.id);
        await p.context.route('**/session/whoami', (route) => route.fulfill({ json: { valid: true, userId: me.id, userType: 'guest', name: `e2e-${p.name}` } }));
        await p.page.reload();
        await resizeWindow(p.page, { width: 1280, height: 800 });
      }
      for (const p of players) await expect(p.page.getByTestId('pod-seats'), `${p.name}: the pod's seats are up`).toBeVisible({ timeout: UI_TIMEOUT });
      await arrangePod([
        [alice.page, 0],
        [bob.page, 1],
        [carol.page, 2],
        [dave.page, 3],
      ]);
      for (const seat of [4, 5, 6, 7]) await alice.page.locator(`[data-testid="pod-seat-close"][data-seat="${seat}"]`).click();
      await expect(alice.page.locator('[data-testid^="pod-seat-"][data-closed]')).toHaveCount(4);
      for (const p of players) await readyPod(p.page);
      for (const p of players) await expect(p.page.getByTestId('pod'), `${p.name}: the pod is dealt`).toBeVisible({ timeout: UI_TIMEOUT });

      /* ── a few picks, then a deploy mid-draft ─────────────────────────── */
      await Promise.all(players.map((p) => pickSome(p.page, 2)));
      await stack.restart();
      for (const p of players) {
        await expect(p.page.locator('[data-testid="pack"] button[data-testid="card"]:not([disabled])').first(), `${p.name}: back on a pick after the restart`).toBeVisible({ timeout: 60_000 });
      }
      console.log('[pre-pod] restart mid-draft: all four back on a pick');

      /* ── carol presses Leave mid-draft; the pick timer is off ─────────── */
      expect((await api(carol, origin, 'POST', `/rooms/${roomId}/leave`)).status, 'carol leaves').toBe(200);
      await carol.page.close();
      const drafting = [alice, bob, dave];
      // Her seat is picked for (the draft bot), or this never finishes and the test times out.
      await Promise.all(drafting.map((p) => draftUntilDone(p.page)));
      console.log('[pre-pod] the draft finished without carol');
      for (const p of drafting) {
        await expect(p.page.getByTestId('deck-editor'), `${p.name}: the editor`).toBeVisible({ timeout: UI_TIMEOUT });
        await trimMainDeck(p.page, 40, p.name);
        await p.page.getByTestId('play-deck').click();
        await p.page.waitForURL(ROOM_PAGE, { timeout: UI_TIMEOUT });
      }

      /* ── round 1: carol is out, alice has the win; bob plays dave ─────── */
      let pod = (await roomOf(alice, origin, roomId)).game.pod;
      console.log(`[pre-pod] round 1: pairings ${JSON.stringify(pod.pairings)} results ${JSON.stringify(pod.results)} dropped ${JSON.stringify(pod.dropped)}`);
      expect(pod.dropped, 'carol is out from round 1').toContain(idOf.get(carol));
      expect(pod.pairings.some((x) => x.players.includes(idOf.get(carol)!)), 'no table waits for carol').toBe(false);
      expect(pod.results.find((r) => r.round === 1 && r.playerA === idOf.get(alice)), 'alice has round 1').toMatchObject({ gamesA: 2, gamesB: 0 });
      expect(await myTableThisRound(alice.page, roomId), 'alice has no table in round 1').toBeNull();
      await enterMyGames([bob.page, dave.page], matchUrl, UI_TIMEOUT);
      for (const p of [bob, dave]) await expect(board(p), `${p.name}: on round 1's board`).toBeVisible({ timeout: UI_TIMEOUT });
      const matchId = matchUrl.exec(bob.page.url())![1]!;

      /* ── a deploy mid-round ───────────────────────────────────────────── */
      await stack.restart();
      for (const p of [bob, dave]) {
        await expect(p.page.getByTestId('live-status'), `${p.name}: rejoined after the restart`).toHaveCount(0, { timeout: 60_000 });
        await expect(board(p)).toBeVisible({ timeout: UI_TIMEOUT });
        expect(matchUrl.exec(p.page.url())?.[1], `${p.name}: the same match`).toBe(matchId);
      }
      console.log(`[pre-pod] restart mid-round: both back on ${matchId}`);
      await concedeMatch(bob, dave, roomUrl);

      /* ── round 2, and the leader DQs dave before his game ─────────────── */
      await expect.poll(async () => (await roomOf(alice, origin, roomId)).game.pod.round, { timeout: UI_TIMEOUT, message: 'round 2 pairs' }).toBe(2);
      pod = (await roomOf(alice, origin, roomId)).game.pod;
      console.log(`[pre-pod] round 2: pairings ${JSON.stringify(pod.pairings)} results ${JSON.stringify(pod.results)}`);
      const daveId = idOf.get(dave)!;
      const dq = await api<{ tableId: string | null }>(alice, origin, 'POST', `/rooms/${roomId}/pod/dq`, { memberId: daveId });
      expect(dq.status, 'the leader DQs dave').toBe(200);
      pod = (await roomOf(alice, origin, roomId)).game.pod;
      expect(pod.dropped, 'dave is out').toContain(daveId);
      const daves = pod.results.find((r) => r.round === 2 && (r.playerA === daveId || r.playerB === daveId));
      if (daves !== undefined && daves.playerB !== null) {
        const theirs = daves.playerA === daveId ? daves.gamesA : daves.gamesB;
        const other = daves.playerA === daveId ? daves.gamesB : daves.gamesA;
        expect(other, 'his round-2 match is conceded').toBeGreaterThan(theirs);
      }
      console.log(`[pre-pod] after DQ: results ${JSON.stringify(pod.results)} dropped ${JSON.stringify(pod.dropped)}`);

      /* ── the hub names everyone, gone or not ─────────────────────────── */
      await openHub(alice.page, roomUrl);
      const standings = alice.page.getByTestId('pod-standings');
      await expect(standings, 'standings on the hub').toBeVisible({ timeout: UI_TIMEOUT });
      await expect(alice.page.getByTestId(/^pod-standings-row-\d+$/)).toHaveCount(4);
      for (const p of players) await expect(standings, `${p.name} is named`).toContainText(`e2e-${p.name}`);
      await expect(standings, 'no raw id').not.toContainText('fk:');
    } finally {
      await stack.stop();
    }
  },
);
