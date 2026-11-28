/**
 * A pick timer turned on mid-draft, two humans, the real UI against the real built server.
 *
 * The tournament fire drill, 2026-11-28: the runbook's fallback for a drafter who stopped picking is the
 * console's `draft/timer`, turned on mid-draft. No card moves when it is, so the server sends each screen its
 * table again at the same moment (`room/socket.ts` `resync`), and the page dropped that as a duplicate
 * (`draft/socket.ts` `ingest`): the drafter it was for lost picks to the bot with no rope on their screen.
 * Alice picks, bob never does, the leader turns the timer on, and bob's rope is there before his time is up.
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
/** The fastest speed: MTR's 40 s first pick in 10 s. */
const SPEED = 4;
const FIRST_PICK_MS = 10_000;

interface Viewer {
  kind: string;
  pool?: unknown[];
  timer?: { totalMs: number; msLeft: number };
}

interface Player {
  name: string;
  page: Page;
  captures: RawCapture[];
}

async function join(browser: Browser, name: string): Promise<Player> {
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
const seatViews = (p: Player): Viewer[] =>
  envelopes(p, 'in')
    .map((e) => (e.msg as { view?: { viewer: Viewer } }).view?.viewer)
    .filter((v): v is Viewer => v?.kind === 'seat');
const poolSize = (p: Player): number => seatViews(p).at(-1)?.pool?.length ?? 0;

test('a pick timer turned on mid-draft reaches the stalled drafter\'s screen at once', async ({ browser }) => {
  test.setTimeout(150_000);
  const alice = await join(browser, 'alice');
  const bob = await join(browser, 'bob');
  await alice.page.goto(`${EDGE_ORIGIN}${PREFIX}/`);
  await openCreateRoom(alice.page);
  await submitCreateRoom(alice.page, { name: `e2e timer midway ${Date.now()}`, gameType: 'draft' });
  const roomId = await roomIdFromAddress(alice.page);
  try {
    await bob.page.goto(`${EDGE_ORIGIN}${PREFIX}/#/room/${roomId}`);
    for (const [p, seat] of [[alice, 0], [bob, 1]] as const) {
      await expect(p.page.getByTestId('pod-seats')).toBeVisible({ timeout: UI_TIMEOUT });
      await sitPodAt(p.page, seat);
      await expect(p.page.getByTestId('seat-stand')).toBeVisible({ timeout: UI_TIMEOUT });
    }
    for (const p of [alice, bob]) await readyPod(p.page);
    await fillWithAi(alice.page, UI_TIMEOUT);

    const card = alice.page.locator('[data-testid="pack"] button[data-testid="card"]:not([disabled])').first();
    await card.waitFor({ timeout: UI_TIMEOUT });
    await card.click();
    await expect.poll(() => poolSize(alice), { timeout: UI_TIMEOUT }).toBe(1);
    const rope = bob.page.getByTestId('pick-rope');
    await expect(rope, 'no timer, no rope').toHaveCount(0);
    expect(seatViews(bob).at(-1)?.timer, "bob's pick came untimed").toBeUndefined();

    // The runbook's console command, as the leader.
    const set = await alice.page.request.post(`${EDGE_ORIGIN}${PREFIX}/api/rooms/${roomId}/draft/timer`, { data: { on: true, speed: SPEED } });
    expect(set.status(), 'draft/timer as the leader').toBe(200);

    // Bob has not picked, so nothing moved: the rope comes with the timer, not with his next pick.
    await expect(rope, "the rope is on bob's screen").toHaveCount(1, { timeout: 5_000 });
    expect(seatViews(bob).at(-1)?.timer?.totalMs, "bob's page holds the timer").toBe(FIRST_PICK_MS);
    await expect.poll(() => poolSize(bob), { message: 'his time runs out and the bot picks for him', timeout: FIRST_PICK_MS + 15_000, intervals: [250] }).toBe(1);
    expect(envelopes(bob, 'out').filter((e) => (e.msg as { type?: string }).type === 'pick').length, 'bob never sent a pick').toBe(0);
  } finally {
    // A draft on the rope keeps timing out for its absent seats until the room is gone.
    const closed = await alice.page.request.post(`${EDGE_ORIGIN}${PREFIX}/api/rooms/${roomId}/close`, { data: {} });
    await alice.page.context().close();
    await bob.page.context().close();
    expect(closed.status(), `room ${roomId} closed by its owner`).toBe(200);
  }
});
