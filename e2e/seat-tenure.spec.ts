/**
 * A tournament draft seat never expires (the operator, 2026-11-28): only a DQ, a drop or the drafter's own
 * Leave ends it, and then the draft bot takes the seat. Three humans, the real UI against the real built
 * server, the pick timer off (the room's default).
 *
 * Bob closes his tab mid-draft and stays away past every hold the server has (the 5 s disconnect grace,
 * the 120 s seat hold): nobody picks for him, and when he opens the room again he is in his own seat and
 * picks. Carol is disqualified by the leader mid-draft: her seat is picked for at once, without her.
 */

import { expect, test, type Browser, type Page } from '@playwright/test';

import { envelopesOf, type RawCapture } from './frames.ts';
import { EDGE_ORIGIN, PREFIX, SESSION_COOKIE } from './identities.ts';
import { draftEnvelopes } from './isolation.ts';
import { keepPrefsLocal } from './prefsLocal.ts';
import { roomIdFromAddress } from './play/board.ts';
import { openCreateRoom, submitCreateRoom } from './play/rooms.ts';
import { fillWithAi, readyPod, sitPodAt } from './podSeats.ts';

const UI_TIMEOUT = 30_000;
/** Past the draft seat's 120 s hold (`draftRooms.ts` `reservationTtlMs`), with room to spare. */
const AWAY_MS = 130_000;

interface SeatRow {
  id: number;
  pickedCount: number;
}

interface View {
  seats: SeatRow[];
  viewer: { kind: string; seatId?: number };
}

interface Player {
  name: string;
  page: Page;
  captures: RawCapture[];
}

async function open(browser: Browser, name: string): Promise<Player> {
  const context = await browser.newContext();
  await context.addCookies([{ name: SESSION_COOKIE, value: name, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict' }]);
  await keepPrefsLocal(context, EDGE_ORIGIN);
  const page = await context.newPage();
  const player: Player = { name, page, captures: [] };
  page.on('websocket', (ws) => {
    ws.on('framereceived', (f) => player.captures.push({ t: Date.now(), dir: 'in', via: 'ws', text: String(f.payload) }));
    ws.on('framesent', (f) => player.captures.push({ t: Date.now(), dir: 'out', via: 'ws', text: String(f.payload) }));
  });
  return player;
}

const envelopes = (p: Player, dir: 'in' | 'out') => draftEnvelopes({ name: p.name, seat: -1, envelopes: envelopesOf(p.captures.filter((c) => c.dir === dir)) });
const views = (p: Player): View[] =>
  envelopes(p, 'in')
    .map((e) => (e.msg as { view?: View }).view)
    .filter((v): v is View => v !== undefined);
const lastView = (p: Player): View | undefined => views(p).at(-1);
/** The seat `p` drafts from, by their own screen. */
const seatOf = (p: Player): number | undefined => views(p).findLast((v) => v.viewer.kind === 'seat')?.viewer.seatId;
/** How many cards `seat` has drafted, as `watcher`'s screen last showed the table. */
const pickedAt = (watcher: Player, seat: number): number => lastView(watcher)?.seats.find((s) => s.id === seat)?.pickedCount ?? 0;
const picksSent = (p: Player): number => envelopes(p, 'out').filter((e) => (e.msg as { type?: string }).type === 'pick').length;

async function pickOne(p: Player): Promise<void> {
  const card = p.page.locator('[data-testid="pack"] button[data-testid="card"]:not([disabled])').first();
  await card.waitFor({ timeout: UI_TIMEOUT });
  const before = picksSent(p);
  await card.click();
  await expect.poll(() => picksSent(p), { timeout: UI_TIMEOUT }).toBe(before + 1);
}

test('an absent drafter keeps their seat past every hold and picks on return; a disqualified drafter’s seat is the bot’s at once', async ({ browser }) => {
  test.setTimeout(AWAY_MS + 180_000);
  const alice = await open(browser, 'alice');
  const bob = await open(browser, 'bob');
  const carol = await open(browser, 'carol');
  await alice.page.goto(`${EDGE_ORIGIN}${PREFIX}/`);
  await openCreateRoom(alice.page);
  await submitCreateRoom(alice.page, { name: `e2e seat tenure ${Date.now()}`, gameType: 'draft' });
  const roomId = await roomIdFromAddress(alice.page);
  const api = (path: string): string => `${EDGE_ORIGIN}${PREFIX}/api/rooms/${roomId}${path}`;
  let back: Player | null = null;
  try {
    for (const p of [bob, carol]) await p.page.goto(`${EDGE_ORIGIN}${PREFIX}/#/room/${roomId}`);
    for (const [p, seat] of [[alice, 0], [bob, 1], [carol, 2]] as const) {
      await expect(p.page.getByTestId('pod-seats')).toBeVisible({ timeout: UI_TIMEOUT });
      await sitPodAt(p.page, seat);
      await expect(p.page.getByTestId('seat-stand')).toBeVisible({ timeout: UI_TIMEOUT });
    }
    for (const p of [alice, bob, carol]) await readyPod(p.page);
    await fillWithAi(alice.page, UI_TIMEOUT);

    // Everyone takes their first card: the draft is under way, each seat on one.
    for (const p of [alice, bob, carol]) await pickOne(p);
    const bobSeat = seatOf(bob);
    const carolSeat = seatOf(carol);
    if (bobSeat === undefined || carolSeat === undefined) throw new Error('bob and carol are seated');
    await expect.poll(() => [pickedAt(alice, bobSeat), pickedAt(alice, carolSeat)], { timeout: UI_TIMEOUT }).toEqual([1, 1]);

    // Bob closes his tab.
    await bob.page.context().close();
    const bobGoneAt = Date.now();

    // The leader disqualifies carol: the draft bot picks for her seat at once, her own page sending nothing.
    const room = (await (await alice.page.request.get(api(''))).json()) as { members: { id: string; name: string }[] };
    const carolId = room.members.find((m) => m.name === 'carol')?.id;
    if (carolId === undefined) throw new Error(`carol is a member: ${JSON.stringify(room.members.map((m) => m.name))}`);
    const dq = await alice.page.request.post(api('/pod/dq'), { data: { memberId: carolId } });
    expect(dq.status(), 'the leader disqualifies carol mid-draft').toBe(200);
    const carolSent = picksSent(carol);
    await expect.poll(() => pickedAt(alice, carolSeat), { message: 'the bot picks for the seat carol was disqualified from', timeout: 15_000 }).toBeGreaterThanOrEqual(2);
    await expect.poll(() => lastView(carol)?.viewer.kind, { message: 'carol only watches', timeout: UI_TIMEOUT }).toBe('watcher');
    expect(picksSent(carol), 'carol never picked after the DQ').toBe(carolSent);

    // Bob stays away past the seat's hold. Alice drafts on as far as the packs let her; nothing is picked for bob.
    while (Date.now() - bobGoneAt < AWAY_MS) {
      const card = alice.page.locator('[data-testid="pack"] button[data-testid="card"]:not([disabled])').first();
      if (await card.isVisible()) await card.click();
      expect(pickedAt(alice, bobSeat), 'nothing is picked for an absent drafter').toBe(1);
      await alice.page.waitForTimeout(2_000);
    }
    console.log(`[seat-tenure] bob away ${Math.round((Date.now() - bobGoneAt) / 1000)} s; carol's seat at ${pickedAt(alice, carolSeat)} picks, alice's at ${pickedAt(alice, 0)}`);
    expect(pickedAt(alice, bobSeat), 'nothing was picked for bob while he was away').toBe(1);

    // Bob opens the room again: his own seat, his packs waiting, and the next pick is his.
    back = await open(browser, 'bob');
    await back.page.goto(`${EDGE_ORIGIN}${PREFIX}/#/room/${roomId}`);
    await expect.poll(() => seatOf(back!), { message: 'bob is back in his own seat', timeout: UI_TIMEOUT }).toBe(bobSeat);
    await pickOne(back);
    await expect.poll(() => pickedAt(alice, bobSeat), { message: 'bob’s own pick lands', timeout: UI_TIMEOUT }).toBe(2);
  } finally {
    const closed = await alice.page.request.post(api('/close'), { data: {} });
    for (const p of [alice, carol, ...(back === null ? [] : [back])]) await p.page.context().close();
    expect(closed.status(), `room ${roomId} closed by its owner`).toBe(200);
  }
});
