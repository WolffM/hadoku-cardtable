/**
 * The draft rope (wave 83 D3), two humans, the real UI against the real built
 * server.
 *
 * The operator, 2026-10-30: "a per-pick timer … On timeout, the seat gets the
 * draft bot's pick. … allow this to be configurable." The leader switches the
 * room's pick timer on at its fastest speed, alice and bob sit and ready, and
 * the pod deals. Alice picks; bob never touches a card. The server's deadline
 * runs out on each of bob's picks and the draft bot takes one for him — his
 * pool grows with nothing sent from his browser — and every pick he is offered
 * carries the time MTR Appendix B gives its pack, over the room's speed. The
 * rope burns on his screen for the last third of each pick.
 *
 * Everything asserted is read off the wire or the server's own log; the rope's
 * look is checked only for being there when it should be.
 */

import { resolve } from 'node:path';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

import { envelopesOf, type RawCapture } from './frames.ts';
import { EDGE_ORIGIN, PREFIX, SESSION_COOKIE } from './identities.ts';
import { draftEnvelopes } from './isolation.ts';
import { keepPrefsLocal } from './prefsLocal.ts';
import { roomIdFromHash, serverLog } from './play/board.ts';
import { openCreateRoom, submitCreateRoom } from './play/rooms.ts';
import { fillWithAi, readyPod } from './podSeats.ts';

const UI_TIMEOUT = 30_000;
const RUN_DIR = resolve(import.meta.dirname, '.run');
/** The fastest speed the room offers: MTR's 40 s first pick in 10 s. */
const SPEED = 4;
/** MTR Appendix B, by cards left — restated here, not imported, so the spec pins the table too. */
const MTR: Record<number, number> = { 15: 40, 14: 40, 13: 35, 12: 30, 11: 25, 10: 25, 9: 20, 8: 20, 7: 15, 6: 10, 5: 10, 4: 5, 3: 5, 2: 5 };
const expectedMs = (cardsLeft: number): number => Math.round((MTR[cardsLeft]! * 1000) / SPEED);

interface Card {
  cardId: string;
}
interface Viewer {
  kind: 'seat' | 'watcher' | 'spectator';
  seatId?: number;
  pack?: Card[];
  pool?: Card[];
  timer?: { totalMs: number; msLeft: number };
}
interface View {
  draftId: string;
  waitingOn: number[];
  viewer: Viewer;
}

interface Player {
  name: string;
  context: BrowserContext;
  page: Page;
  captures: RawCapture[];
}

async function join(browser: Browser, name: string): Promise<Player> {
  const context = await browser.newContext();
  await context.addCookies([{ name: SESSION_COOKIE, value: name, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict' }]);
  await keepPrefsLocal(context, EDGE_ORIGIN);
  const page = await context.newPage();
  const player: Player = { name, context, page, captures: [] };
  page.on('websocket', (ws) => {
    ws.on('framereceived', (f) => player.captures.push({ t: Date.now(), dir: 'in', via: 'ws', text: String(f.payload) }));
    ws.on('framesent', (f) => player.captures.push({ t: Date.now(), dir: 'out', via: 'ws', text: String(f.payload) }));
  });
  page.on('request', (req) => {
    if (req.url().includes('/socket.io/') && req.url().includes('transport=polling') && req.method() === 'POST') {
      player.captures.push({ t: Date.now(), dir: 'out', via: 'polling', text: req.postData() ?? '' });
    }
  });
  return player;
}

/** Every seat view this player received, oldest first. */
function views(p: Player): View[] {
  return draftEnvelopes({ name: p.name, seat: -1, envelopes: envelopesOf(p.captures.filter((c) => c.dir === 'in')) })
    .map((e) => (e.msg as { view?: View }).view)
    .filter((v): v is View => v !== undefined && v.viewer.kind === 'seat');
}

/** The pack this seat was offered at each pick, with the timer it came with: the first envelope per pool size. */
function offers(p: Player): { left: number; timer: Viewer['timer'] }[] {
  const out: { left: number; timer: Viewer['timer'] }[] = [];
  for (const v of views(p)) {
    const pack = v.viewer.pack ?? [];
    const pool = v.viewer.pool ?? [];
    if (pack.length === 0 || out[pool.length] !== undefined) continue;
    out[pool.length] = { left: pack.length, timer: v.viewer.timer };
  }
  return out;
}

const poolSize = (p: Player): number => views(p).at(-1)?.viewer.pool?.length ?? 0;

/** Picks this browser sent: any outbound draft event of type `pick`. */
function sentPicks(p: Player): number {
  return draftEnvelopes({ name: p.name, seat: -1, envelopes: envelopesOf(p.captures.filter((c) => c.dir === 'out')) }).filter(
    (e) => (e.msg as { type?: string }).type === 'pick',
  ).length;
}

test('the draft rope: an idle drafter gets the bot’s pick on timeout, and every pick is timed by the cards left', async ({ browser }) => {
  test.setTimeout(180_000);
  const alice = await join(browser, 'alice');
  const bob = await join(browser, 'bob');
  try {
    await alice.page.goto(`${EDGE_ORIGIN}${PREFIX}/`);
    await openCreateRoom(alice.page);
    await submitCreateRoom(alice.page, { name: `e2e rope ${Date.now()}`, gameType: 'draft' });
    const roomId = await roomIdFromHash(alice.page);
    await bob.page.goto(`${EDGE_ORIGIN}${PREFIX}/#/room/${roomId}`);

    // The leader's switch, then the fastest speed.
    const rule = alice.page.getByTestId('pick-timer');
    await expect(rule).toBeVisible({ timeout: UI_TIMEOUT });
    await rule.click();
    await expect(rule).toHaveAttribute('aria-pressed', 'true', { timeout: UI_TIMEOUT });
    await alice.page.getByTestId('pick-timer-speed').locator(`input[value="${SPEED}"]`).click({ force: true });
    await expect(alice.page.getByTestId('pick-timer-speed').locator(`input[value="${SPEED}"]`)).toBeChecked({ timeout: UI_TIMEOUT });
    // Bob reads the same rule, and cannot move it.
    await expect(bob.page.getByTestId('pick-timer')).toHaveAttribute('aria-pressed', 'true', { timeout: UI_TIMEOUT });
    await expect(bob.page.getByTestId('pick-timer')).toBeDisabled();

    for (const [p, seat] of [[alice, 0], [bob, 1]] as const) {
      await expect(p.page.getByTestId('pod-seats')).toBeVisible({ timeout: UI_TIMEOUT });
      await p.page.locator(`[data-testid="pod-seat-sit"][data-seat="${seat}"]`).click();
      await expect(p.page.getByTestId('pod-seat-stand')).toBeVisible({ timeout: UI_TIMEOUT });
    }
    for (const p of [alice, bob]) await readyPod(p.page);
    await fillWithAi(alice.page, UI_TIMEOUT);
    for (const p of [alice, bob]) await expect(p.page.getByTestId('pod')).toBeVisible({ timeout: UI_TIMEOUT });

    // The first pick is timed: 15 cards, 40 s over speed 4.
    await expect.poll(() => offers(bob)[0]?.timer?.totalMs, { message: "bob's first pick carries the server's time", timeout: UI_TIMEOUT }).toBe(expectedMs(15));

    // Alice drafts on; bob idles through three timeouts.
    const aliceDrafts = (async () => {
      for (let n = 0; n < 3; n++) {
        const card = alice.page.locator('[data-testid="pack"] button[data-testid="card"]:not([disabled])').first();
        await card.waitFor({ timeout: UI_TIMEOUT });
        await card.click();
        await expect.poll(() => poolSize(alice), { timeout: UI_TIMEOUT }).toBe(n + 1);
      }
    })();

    // The rope shows for the last third of a pick, and not before.
    const rope = bob.page.getByTestId('pick-rope');
    await expect(rope).toHaveAttribute('data-state', 'waiting', { timeout: UI_TIMEOUT });
    await expect(rope).toHaveAttribute('data-state', 'burning', { timeout: expectedMs(15) });

    await expect
      .poll(() => poolSize(bob), { message: 'the timeouts pick for bob', timeout: expectedMs(15) + expectedMs(14) + expectedMs(13) + 15_000, intervals: [250] })
      .toBe(3);
    await aliceDrafts;
    expect(sentPicks(bob), 'bob never sent a pick: the server picked for him').toBe(0);

    // Each pick bob was offered carried the table's time for the pack in front of him.
    const offered = offers(bob).slice(0, 4);
    console.log(`[w83b] bob's offers ${JSON.stringify(offered)}`);
    for (const [n, o] of offered.entries()) {
      expect(o, `bob was offered pick ${n + 1}`).toBeDefined();
      expect(o.timer?.totalMs, `pick ${n + 1}, ${o.left} cards left`).toBe(expectedMs(o.left));
    }

    // The server says why: three timeouts on bob's seat, with the times it gave.
    const timeouts = serverLog({ serverLogFile: resolve(RUN_DIR, 'server.jsonl') }).filter(
      (l) => l.evt === 'pick-timeout' && l.draftId === roomId && l.seat === 1,
    );
    expect(timeouts.map((l) => l.totalMs)).toEqual([expectedMs(15), expectedMs(14), expectedMs(13)]);
  } finally {
    await alice.context.close();
    await bob.context.close();
  }
});
