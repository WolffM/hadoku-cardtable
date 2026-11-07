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
import { fillWithAi, readyPod, sitPodAt } from './podSeats.ts';

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

/** When each of this seat's picks landed on its page: the first envelope whose pool reached each size, with the card it added. */
function picksLanded(p: Player): { at: number; cardId: string }[] {
  const out: { at: number; cardId: string }[] = [];
  const envelopes = draftEnvelopes({ name: p.name, seat: -1, envelopes: envelopesOf(p.captures.filter((c) => c.dir === 'in')) });
  for (const e of envelopes) {
    const v = (e.msg as { view?: View }).view;
    const pool = v?.viewer.kind === 'seat' ? (v.viewer.pool ?? []) : [];
    if (pool.length > out.length) out.push({ at: e.t, cardId: pool.at(-1)!.cardId });
  }
  return out;
}

/**
 * Watch the rope on this page: each time a drawn fuse first reaches empty, on the page's clock
 * (`Date.now()`, the same host clock the captures use). Read back with {@link ropeEmptied}.
 */
async function watchRope(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __ropeEmptied: number[] };
    w.__ropeEmptied = [];
    let emptied = false;
    const tick = (): void => {
      const fuse = document.querySelector<HTMLElement>('[data-testid="pick-rope"] .pick-rope__fuse');
      const state = fuse?.parentElement?.dataset.state;
      if (fuse === null || state === 'waiting') emptied = false;
      else if (!emptied && fuse.getBoundingClientRect().width < 0.5) {
        emptied = true;
        w.__ropeEmptied.push(Date.now());
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

const ropeEmptied = (page: Page): Promise<number[]> => page.evaluate(() => (window as unknown as { __ropeEmptied: number[] }).__ropeEmptied);

/** A point on the page where `cardId`'s pick button is what the pointer would be over, or null if none of it shows. */
async function pointOver(page: Page, cardId: string): Promise<{ x: number; y: number } | null> {
  return page.evaluate((id) => {
    const button = document.querySelector<HTMLElement>(`[data-testid="pack"] button[data-testid="card"][data-card-id="${id}"]`);
    if (button === null) return null;
    const box = button.getBoundingClientRect();
    for (const fx of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      for (const fy of [0.5, 0.3, 0.7]) {
        const x = box.left + box.width * fx;
        const y = box.top + box.height * fy;
        const under = document.elementFromPoint(x, y)?.closest<HTMLElement>('button[data-testid="card"]');
        if (under?.dataset.cardId === id) return { x, y };
      }
    }
    return null;
  }, cardId);
}

/** Picks this browser sent: any outbound draft event of type `pick`. */
function sentPicks(p: Player): number {
  return draftEnvelopes({ name: p.name, seat: -1, envelopes: envelopesOf(p.captures.filter((c) => c.dir === 'out')) }).filter(
    (e) => (e.msg as { type?: string }).type === 'pick',
  ).length;
}

/** Alice leads, switches the rope on at {@link SPEED}, both sit and ready, the AI fills the pod and it deals. */
async function dealtPod(browser: Browser): Promise<{ alice: Player; bob: Player; roomId: string }> {
  const alice = await join(browser, 'alice');
  const bob = await join(browser, 'bob');
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
    await sitPodAt(p.page, seat);
    await expect(p.page.getByTestId('seat-stand')).toBeVisible({ timeout: UI_TIMEOUT });
  }
  for (const p of [alice, bob]) await readyPod(p.page);
  await fillWithAi(alice.page, UI_TIMEOUT);
  for (const p of [alice, bob]) await expect(p.page.getByTestId('pod')).toBeVisible({ timeout: UI_TIMEOUT });
  return { alice, bob, roomId };
}

test('the draft rope: an idle drafter is picked for on timeout, and every pick is timed by the cards left', async ({ browser }) => {
  test.setTimeout(180_000);
  const { alice, bob, roomId } = await dealtPod(browser);
  try {
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

// The operator, 2026-11-07: "it finished its animation maybe ~10s before it actually picked a card." The
// rope must be empty when the server's pick lands — with other seats' picks arriving mid-pick, which is
// what moved the old animation (each envelope rewrote a running animation's delay).
test('the rope runs out when the timeout pick lands, however many envelopes arrive during the pick', async ({ browser }) => {
  test.setTimeout(180_000);
  const { alice, bob, roomId } = await dealtPod(browser);
  try {
    await watchRope(bob.page);
    await expect.poll(() => offers(bob)[0]?.timer?.totalMs, { timeout: UI_TIMEOUT }).toBe(expectedMs(15));
    // Alice picks part-way through each of bob's picks: each pick sends bob an envelope mid-pick.
    const aliceDrafts = (async () => {
      for (let n = 0; n < 2; n++) {
        await alice.page.waitForTimeout(expectedMs(15 - n) / 2);
        const card = alice.page.locator('[data-testid="pack"] button[data-testid="card"]:not([disabled])').first();
        await card.waitFor({ timeout: UI_TIMEOUT });
        await card.click();
        await expect.poll(() => poolSize(alice), { timeout: UI_TIMEOUT }).toBe(n + 1);
      }
    })();
    await expect.poll(() => poolSize(bob), { message: 'two timeouts pick for bob', timeout: expectedMs(15) + expectedMs(14) + 15_000, intervals: [250] }).toBe(2);
    await aliceDrafts;

    const landed = picksLanded(bob).slice(0, 2);
    const emptied = await ropeEmptied(bob.page);
    const timeouts = serverLog({ serverLogFile: resolve(RUN_DIR, 'server.jsonl') }).filter((l) => l.evt === 'pick-timeout' && l.draftId === roomId && l.seat === 1);
    const midPick = views(bob).length;
    console.log(`[w83b] rope emptied ${JSON.stringify(emptied)} picks landed ${JSON.stringify(landed)} gaps ${JSON.stringify(landed.map((l, i) => l.at - (emptied[i] ?? NaN)))} server lateMs ${JSON.stringify(timeouts.map((t) => t.lateMs))} bob views ${midPick}`);
    expect(emptied.length, 'the rope ran out once per pick').toBeGreaterThanOrEqual(2);
    for (const [i, l] of landed.entries()) {
      // Empty no earlier than a moment before the pick lands, and the pick lands no later than a moment after.
      const gap = l.at - emptied[i]!;
      expect(gap, `pick ${i + 1}: the pick landed ${gap} ms after the rope ran out`).toBeLessThan(750);
      expect(gap, `pick ${i + 1}: the rope ran out ${-gap} ms after the pick landed`).toBeGreaterThan(-750);
    }
    // The server's own timer fires on time: no waiting on a model, no held turn.
    for (const t of timeouts.slice(0, 2)) expect(t.lateMs as number).toBeLessThan(250);
  } finally {
    await alice.context.close();
    await bob.context.close();
  }
});

// The operator, 2026-11-07: "the card picked should be the one currently hovered."
test('a drafter whose time runs out gets the card under the pointer', async ({ browser }) => {
  test.setTimeout(120_000);
  const { alice, bob, roomId } = await dealtPod(browser);
  try {
    await expect.poll(() => offers(bob)[0]?.timer?.totalMs, { timeout: UI_TIMEOUT }).toBe(expectedMs(15));
    const pack = bob.page.locator('[data-testid="pack"] button[data-testid="card"]:not([disabled])');
    await expect(pack.first()).toBeVisible({ timeout: UI_TIMEOUT });
    // Not the first card: a fan opens on it, so it would be taken with no pointer at all.
    const ids = await pack.evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.cardId!));
    let target: string | null = null;
    let point: { x: number; y: number } | null = null;
    for (const id of ids.slice(1)) {
      point = await pointOver(bob.page, id);
      if (point !== null) {
        target = id;
        break;
      }
    }
    if (target === null || point === null) throw new Error('no card of bob’s pack is under any point');
    await bob.page.mouse.move(point.x, point.y);
    // Still over it after the move settles: the pointer is where the test says.
    await expect.poll(() => pointOver(bob.page, target!).then((p) => p !== null), { timeout: 2_000 }).toBe(true);

    await expect.poll(() => poolSize(bob), { message: 'the timeout picks for bob', timeout: expectedMs(15) + 10_000, intervals: [250] }).toBe(1);
    expect(picksLanded(bob)[0]!.cardId, 'bob got the card under his pointer').toBe(target);
    expect(sentPicks(bob), 'bob never sent a pick').toBe(0);
    const timeouts = serverLog({ serverLogFile: resolve(RUN_DIR, 'server.jsonl') }).filter((l) => l.evt === 'pick-timeout' && l.draftId === roomId && l.seat === 1);
    expect(timeouts.map((l) => l.chose)).toEqual(['lean']);
  } finally {
    await alice.context.close();
    await bob.context.close();
  }
});
