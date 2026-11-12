/**
 * From the Gauntlet's ban/pick board into choosing a deck, between two people (the operator,
 * 2026-11-02, on trailer cut 7: *"need a transition between the pick/ban phase and the 'choosing a
 * deck phase', it looks a bit cheap at the moment that it hard cuts to the next step there"*).
 *
 * The snake's last pick moves the server into `choose`, and both screens receive that one step. This
 * proves, at 1440×900:
 *
 *  - both screens arrive at the choose screen through the transition (`data-arriving`, the board it
 *    leaves drawn under it), and start it together;
 *  - it lasts about as long as it is meant to (0.6–1.2 s; a claw gets slack) and then the board is
 *    gone;
 *  - on no frame of it is there a second Gauntlet title or a pool anybody can find;
 *  - a press on a deck still in flight is a choice made: the motion holds still under the pointer
 *    and the server records the deck.
 *
 * Alice's page runs its animations at a tenth of their speed (DevTools' own playback rate), so a
 * press can be aimed at a deck mid-flight from outside the page; Bob's runs at full speed, and is the
 * one timed. No Forge: the snake and the choice are the server's own logic, and nobody starts a game.
 *
 * `[gauntlet-arrive]` lines are the evidence.
 */
import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test';

import type { GauntletView } from '../packages/shared/src/gauntlet.ts';
import { EDGE_ORIGIN, PREFIX, SESSION_COOKIE } from './identities.ts';
import { keepPrefsLocal } from './prefsLocal.ts';

const ERA = 'modern-2012-07-13';

interface Seat {
  context: BrowserContext;
  page: Page;
  call: <T>(method: 'GET' | 'POST', path: string, data?: unknown) => Promise<{ status: number; body: T }>;
}

async function send<T>(request: APIRequestContext, method: 'GET' | 'POST', path: string, data?: unknown): Promise<{ status: number; body: T }> {
  const res = method === 'GET' ? await request.get(`${EDGE_ORIGIN}${PREFIX}/api${path}`) : await request.post(`${EDGE_ORIGIN}${PREFIX}/api${path}`, { data: data ?? {} });
  return { status: res.status(), body: (await res.json()) as T };
}

/** Every frame the choose screen is drawn, from before the page loads: whether it is arriving, what lies under it, and what can be found. */
function recordArrival(): void {
  const w = window as unknown as { arrival: { at: number; sig: string }[]; pressedArriving: boolean | null };
  w.arrival = [];
  w.pressedArriving = null;
  let last = '';
  const frame = (): void => {
    const choose = document.querySelector<HTMLElement>('[data-testid="gauntlet-choose"]');
    if (choose !== null) {
      const sig = [
        choose.dataset.arriving === undefined ? '' : 'arriving',
        document.querySelector('.gauntlet--leaving') === null ? '' : 'board',
        `titles=${document.querySelectorAll('[data-testid="gauntlet-title"]').length}`,
        `pools=${document.querySelectorAll('[data-testid="gauntlet-pool"]').length}`,
      ].join('|');
      if (sig !== last) w.arrival.push({ at: Date.now(), sig });
      last = sig;
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  document.addEventListener('pointerdown', () => (w.pressedArriving = document.querySelector('[data-testid="gauntlet-choose"][data-arriving]') !== null), true);
}

async function seatFor(browser: Browser, name: string): Promise<Seat> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies([{ name: SESSION_COOKIE, value: name, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict' }]);
  await keepPrefsLocal(context, EDGE_ORIGIN);
  await context.addInitScript(recordArrival);
  const page = await context.newPage();
  return { context, page, call: (method, path, data) => send(context.request, method, path, data) };
}

const framesOf = (page: Page): Promise<{ at: number; sig: string }[]> => page.evaluate(() => (window as unknown as { arrival: { at: number; sig: string }[] }).arrival);
/**
 * The frames once the recorder has drawn the settled choose screen. The recorder samples on
 * `requestAnimationFrame`, so the DOM can show the settled screen before the next frame has
 * recorded it — most of all on a page whose animations run at a tenth of their speed.
 */
const settledFramesOf = async (page: Page, who: string): Promise<{ at: number; sig: string }[]> => {
  await expect.poll(async () => (await framesOf(page)).at(-1)?.sig, { timeout: 5_000, message: `${who}: the recorder draws the choose screen alone` }).toBe('||titles=1|pools=0');
  return framesOf(page);
};

test('the Gauntlet’s last pick: both screens arrive at the choice together, through the transition, and a press mid-flight is a choice made', async ({ browser }) => {
  test.setTimeout(2 * 60_000);
  const alice = await seatFor(browser, 'alice');
  const bob = await seatFor(browser, 'bob');
  try {
    await alice.page.goto(`${PREFIX}/`);
    const created = await alice.call<{ id: string }>('POST', '/rooms', {
      name: `e2e gauntlet arrive ${Date.now()}`,
      gameType: 'constructed-1v1',
      mode: 'gauntlet',
      modeOptions: { family: 'modern', era: ERA },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const roomId = created.body.id;
    expect((await bob.call('POST', `/rooms/${roomId}/join`)).status).toBe(200);
    for (const seat of [alice, bob]) expect((await seat.call('POST', `/tables/rooms/${roomId}/sit`)).status).toBe(200);
    await alice.page.goto(`${PREFIX}/#/room/${roomId}`);
    await bob.page.goto(`${PREFIX}/#/room/${roomId}`);
    for (const seat of [alice, bob]) expect((await seat.call<GauntletView>('POST', `/tables/rooms/${roomId}/gauntlet/ready`, { ready: true })).status).toBe(200);
    for (const seat of [alice, bob]) await expect(seat.page.getByTestId('gauntlet-pool').getByTestId('gauntlet-deck')).toHaveCount(10, { timeout: 20_000 });

    // Alice's motion at a tenth of its speed, so a deck in flight can be aimed at from here.
    const cdp = await alice.context.newCDPSession(alice.page);
    await cdp.send('Animation.enable');
    await cdp.send('Animation.setPlaybackRate', { playbackRate: 0.1 });

    // The snake, each seat acting on its own turn over the room's own API, up to the last pick.
    const view = (seat: Seat) => seat.call<GauntletView>('GET', `/tables/rooms/${roomId}/gauntlet`).then((r) => r.body);
    await expect.poll(async () => (await view(alice)).phase, { timeout: 20_000, message: 'the reveal ends in the ban/pick' }).toBe('banpick');
    for (let acts = 0; acts < 10; acts++) {
      const v = await view(alice);
      expect(v.phase).toBe('banpick');
      const seat = v.step!.seat === v.you ? alice : bob;
      const deck = v.decks.find((d) => d.status === 'open')!.id;
      expect((await seat.call('POST', `/tables/rooms/${roomId}/gauntlet/act`, { act: v.step!.act, deck })).status).toBe(200);
    }
    expect((await view(alice)).phase).toBe('choose');

    // Alice presses one of her decks while it is still in flight.
    await alice.page.waitForSelector('[data-testid="gauntlet-choose"][data-arriving]', { timeout: 10_000 });
    // The first of her decks whose middle is on screen where it is now, wherever its flight has got to.
    const mine = alice.page.getByTestId('gauntlet-choose-mine').getByTestId('gauntlet-deck');
    const onScreen = await mine.evaluateAll((tiles) =>
      tiles.findIndex((t) => {
        const r = t.getBoundingClientRect();
        return r.top + r.height / 2 > 0 && r.top + r.height / 2 < innerHeight && r.left + r.width / 2 > 0 && r.left + r.width / 2 < innerWidth;
      }),
    );
    expect(onScreen, 'one of her decks is on screen as it flies').toBeGreaterThanOrEqual(0);
    const tile = mine.nth(onScreen);
    const id = (await tile.getAttribute('data-deck-id'))!;
    const box = (await tile.boundingBox())!;
    console.log(`[gauntlet-arrive] alice presses ${id} mid-flight at ${JSON.stringify(box)}`);
    await alice.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(tile).toHaveAttribute('aria-checked', 'true', { timeout: 10_000 });
    expect(await alice.page.evaluate(() => (window as unknown as { pressedArriving: boolean | null }).pressedArriving), 'the press came while the choose screen was arriving').toBe(true);
    expect((await view(alice)).choice?.mine, 'the server has her choice').toBe(id);

    // Bob's screen, at full speed, is the one timed: it arrives, and then is the choose screen alone.
    await expect(bob.page.locator('[data-testid="gauntlet-choose"]:not([data-arriving])')).toBeVisible({ timeout: 10_000 });
    await expect(alice.page.locator('[data-testid="gauntlet-choose"]:not([data-arriving])')).toBeVisible({ timeout: 30_000 });
    const [a, b] = [await settledFramesOf(alice.page, 'alice'), await settledFramesOf(bob.page, 'bob')];
    console.log(`[gauntlet-arrive] alice frames: ${JSON.stringify(a)}`);
    console.log(`[gauntlet-arrive] bob frames: ${JSON.stringify(b)}`);
    for (const [who, frames] of [
      ['alice', a],
      ['bob', b],
    ] as const) {
      expect(frames[0]?.sig, `${who}: the choose screen’s first frame is the arrival, over the board`).toBe('arriving|board|titles=1|pools=0');
      expect(frames.at(-1)?.sig, `${who}: and its last is the choose screen alone`).toBe('||titles=1|pools=0');
      expect(frames.filter((f) => !f.sig.endsWith('titles=1|pools=0')), `${who}: never a second title, never a pool to find`).toEqual([]);
    }
    const lasted = b.at(-1)!.at - b[0]!.at;
    console.log(`[gauntlet-arrive] bob's arrival lasted ${lasted} ms; the two screens started ${Math.abs(a[0]!.at - b[0]!.at)} ms apart`);
    expect(lasted, 'about 0.6–1.2 s').toBeGreaterThanOrEqual(600);
    expect(lasted, 'about 0.6–1.2 s, with a claw’s slack').toBeLessThanOrEqual(2500);
    expect(Math.abs(a[0]!.at - b[0]!.at), 'both screens start it together').toBeLessThanOrEqual(500);
  } finally {
    await alice.context.close();
    await bob.context.close();
  }
});
