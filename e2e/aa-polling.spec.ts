/**
 * Request volume — hadoku_site's request log, 6 h to 2026-10-10 23:28Z: every
 * open room tab, lobby tab and result screen read `GET /api/rooms/<id>`,
 * `GET /api/rooms` and `GET /api/tables/rooms/<id>` about once a second and a
 * half, for as long as it stayed open (~7,500 requests from 5 rooms), and a
 * signed-out viewer read the four `/prefs/api/v1/_games/cardtable/*` stats
 * endpoints ~6.5 times a minute, every answer a 401.
 *
 * What a screen may do instead: read once, then read again when the server
 * says the room changed, plus one slow resilience read while the tab is
 * visible. A hidden tab reads nothing until it is shown again. A signed-out
 * viewer never asks the stats store, and a 401 is not asked again.
 *
 * The operator's rematch (room r-cae3103a30ac, 2026-10-11 06:21Z): one result
 * screen followed the new match, the other stayed put with Rematch greyed —
 * it did not know its room. Here one result screen is reloaded and both
 * players press Rematch.
 *
 * `[aa-poll]` lines are the evidence: request counts per screen and window,
 * and how long a change took to reach the other screen.
 */
import { expect, test, type Browser, type BrowserContext, type Page, type Request } from '@playwright/test';

import { EDGE_ORIGIN, SESSION_COOKIE } from './identities.ts';
import { keepPrefsLocal } from './prefsLocal.ts';
import { enterMatch, makeTitled } from './play/board.ts';
import { openFriend, type Friend } from './play/browser.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { openCreateRoom } from './play/rooms.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const PREFIX = '/cardtable';
const MATCH_URL = /#\/match\/(m-[0-9a-f]{12})$/;
/** How long a screen is left alone while its requests are counted. */
const IDLE_MS = 60_000;
/** A change must reach the other screen within this. */
const PUSH_MS = 1_500;

/** A room read: the list, a room, or a room's table. Socket.io traffic is not one. */
function isRoomRead(req: Request): boolean {
  const path = new URL(req.url()).pathname;
  return /\/cardtable\/api\/rooms(\/|$)/.test(path) || /\/cardtable\/api\/tables\/rooms\//.test(path);
}

/** Every room request `page` makes from now on, as `METHOD path`. */
function countRoomReads(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (req) => {
    if (isRoomRead(req)) seen.push(`${req.method()} ${new URL(req.url()).pathname.replace(/^\/cardtable/, '')}`);
  });
  return seen;
}

/** Requests in `log` after index `from`, as one line. */
const since = (log: string[], from: number): string => `${log.length - from} [${log.slice(from).join(', ')}]`;

/** The page reports itself hidden (or shown again) and says so, as a backgrounded tab does. */
async function setHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((h) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

async function friendContext(browser: Browser, name: string): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies([{ name: SESSION_COOKIE, value: name, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict' }]);
  await keepPrefsLocal(context, EDGE_ORIGIN);
  return context;
}

/** How long `check` took to pass, counted from `t0`. */
async function arrival(t0: number, check: () => Promise<void>): Promise<number> {
  await check();
  return Date.now() - t0;
}

test('an open room, the lobby and a hidden tab: no polling, and a change arrives in about a second', async ({ browser }) => {
  test.setTimeout(4 * 60_000);
  const alice = await friendContext(browser, 'alice');
  const bob = await friendContext(browser, 'bob');
  try {
    // Alice's room, open in two tabs; one of them goes to the background.
    const room = await alice.newPage();
    await room.goto(`${EDGE_ORIGIN}${PREFIX}/`);
    await openCreateRoom(room);
    await room.getByTestId('room-create-name').fill(`aa poll ${Date.now()}`);
    await room.getByTestId('room-create-type').selectOption('constructed-1v1');
    await room.getByTestId('room-create-submit').click();
    await room.waitForURL(/#\/room\/r-[0-9a-f]{12}$/, { timeout: 30_000 });
    const roomUrl = room.url();
    await expect(room.getByTestId('play-vs-bot'), 'alice is alone in her room').toBeVisible({ timeout: 30_000 });
    const roomHidden = await alice.newPage();
    await roomHidden.goto(roomUrl);
    await expect(roomHidden.getByTestId('play-vs-bot')).toBeVisible({ timeout: 30_000 });

    // Bob's lobby, open in two tabs; one of them goes to the background.
    const lobby = await bob.newPage();
    await lobby.goto(`${EDGE_ORIGIN}${PREFIX}/`);
    await expect(lobby.getByTestId('rooms')).toBeVisible({ timeout: 30_000 });
    const lobbyHidden = await bob.newPage();
    await lobbyHidden.goto(`${EDGE_ORIGIN}${PREFIX}/`);
    await expect(lobbyHidden.getByTestId('rooms')).toBeVisible({ timeout: 30_000 });
    await setHidden(roomHidden, true);
    await setHidden(lobbyHidden, true);
    await room.waitForTimeout(2_000);

    const roomLog = countRoomReads(room);
    const roomHiddenLog = countRoomReads(roomHidden);
    const lobbyLog = countRoomReads(lobby);
    const lobbyHiddenLog = countRoomReads(lobbyHidden);
    await room.waitForTimeout(IDLE_MS);
    console.log(`[aa-poll] idle ${IDLE_MS / 1000}s: room=${since(roomLog, 0)}`);
    console.log(`[aa-poll] idle ${IDLE_MS / 1000}s: lobby=${since(lobbyLog, 0)}`);
    console.log(`[aa-poll] idle ${IDLE_MS / 1000}s: hidden room=${since(roomHiddenLog, 0)} hidden lobby=${since(lobbyHiddenLog, 0)}`);
    // Two reads (the room and its table) per refresh; at most three slow refreshes fit in a minute.
    expect.soft(roomLog.length, 'an idle room screen reads the room at most a few times a minute').toBeLessThanOrEqual(6);
    expect.soft(lobbyLog.length, 'an idle lobby reads the list at most a few times a minute').toBeLessThanOrEqual(3);
    expect.soft(roomHiddenLog.length, 'a hidden room tab reads nothing').toBe(0);
    expect.soft(lobbyHiddenLog.length, 'a hidden lobby tab reads nothing').toBe(0);

    // Bob walks into alice's room: her open screen shows it without a poll.
    const roomBefore = roomLog.length;
    const bobInRoom = await bob.newPage();
    const joined = bobInRoom.waitForResponse((r) => r.request().method() === 'POST' && /\/api\/rooms\/[^/]+\/join$/.test(r.url()));
    await bobInRoom.goto(roomUrl);
    await joined;
    const joinedAt = Date.now();
    // The member count, not the bot button: since 2026-10-12 that button is
    // gated on the seat, and a second member in the room does not take it away.
    const joinMs = await arrival(joinedAt, () => expect(room.getByTestId('constructed'), 'alice sees bob arrive').toHaveAttribute('data-members', '2', { timeout: 10_000 }));
    console.log(`[aa-poll] bob joined: alice's screen showed it after ${joinMs}ms, reads since=${since(roomLog, roomBefore)}`);
    expect.soft(joinMs, 'the join reaches alice within about a second').toBeLessThanOrEqual(PUSH_MS);

    // Alice moves the pool: bob's screen follows without a poll.
    await expect(bobInRoom.getByTestId('format-fixed')).toBeVisible({ timeout: 30_000 });
    const current = await room.getByTestId('format').inputValue();
    const other = (await room.getByTestId('format').locator('option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value))).find(
      (v) => v !== '' && v !== current,
    );
    if (other === undefined) throw new Error(`the format picker offers nothing but ${current}`);
    const bobLog = countRoomReads(bobInRoom);
    await bobInRoom.waitForTimeout(3_000);
    const bobIdle = bobLog.length;
    const patched = room.waitForResponse((r) => r.request().method() === 'PATCH' && /\/api\/rooms\/[^/]+$/.test(r.url()));
    await room.getByTestId('format').selectOption(other);
    await patched;
    const patchedAt = Date.now();
    const formatMs = await arrival(patchedAt, () =>
      expect(bobInRoom.getByTestId('format-fixed'), "bob's screen shows alice's pool").toHaveAttribute('data-format', other, { timeout: 10_000 }),
    );
    console.log(`[aa-poll] alice moved the pool to ${other}: bob's screen after ${formatMs}ms; bob's reads in the 3s before=${bobIdle} after=${since(bobLog, bobIdle)}`);
    expect.soft(bobIdle, 'bob read nothing while nothing changed').toBe(0);
    expect.soft(formatMs, 'the pool reaches bob within about a second').toBeLessThanOrEqual(PUSH_MS);

    // Both changes happened while the hidden tabs were hidden: they read nothing, then one refresh when shown.
    console.log(`[aa-poll] while hidden, through both changes: room=${since(roomHiddenLog, 0)} lobby=${since(lobbyHiddenLog, 0)}`);
    expect.soft(roomHiddenLog.length, 'the hidden room tab read nothing through two changes').toBe(0);
    expect.soft(lobbyHiddenLog.length, 'the hidden lobby tab read nothing through two changes').toBe(0);
    await setHidden(roomHidden, false);
    await setHidden(lobbyHidden, false);
    await expect(roomHidden.getByTestId('play-vs-bot'), 'shown again, the room tab catches up').toHaveCount(0, { timeout: 5_000 });
    await roomHidden.waitForTimeout(3_000);
    console.log(`[aa-poll] shown again: room=${since(roomHiddenLog, 0)} lobby=${since(lobbyHiddenLog, 0)}`);
    expect.soft(roomHiddenLog.length, 'shown again: one refresh (two reads)').toBeLessThanOrEqual(2);
    expect.soft(lobbyHiddenLog.length, 'shown again: one list read').toBeLessThanOrEqual(1);
  } finally {
    await alice.close();
    await bob.close();
  }
});

test(titled('two result screens left open read nothing; one reloaded still rematches into the same new match'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(6 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice');
    const bob = await openFriend(browser, 'bob');
    const { matchId } = await enterMatch(alice, bob, stack.origin);
    await bob.page.getByTestId('live-concede').click();
    await bob.page.getByTestId('live-concede-yes').click();
    for (const f of [alice, bob]) await expect(f.page.getByTestId('game-result'), `${f.name}'s result screen`).toBeVisible({ timeout: 45_000 });
    await alice.page.waitForTimeout(3_000);

    const logs = new Map<Friend, string[]>([alice, bob].map((f) => [f, countRoomReads(f.page)]));
    await alice.page.waitForTimeout(IDLE_MS);
    for (const [f, log] of logs) {
      console.log(`[aa-poll] result screen idle ${IDLE_MS / 1000}s: ${f.name}=${since(log, 0)}`);
      expect.soft(log.length, `${f.name}'s idle result screen reads the room at most a few times a minute`).toBeLessThanOrEqual(3);
    }

    // Alice reloads on her result screen: it still knows its room.
    await alice.page.reload();
    await expect(alice.page.getByTestId('game-result'), "alice's result screen after a reload").toBeVisible({ timeout: 45_000 });
    await expect(alice.page.getByTestId('game-result-rematch'), 'alice can still ask for a rematch').toBeEnabled({ timeout: 15_000 });
    const t0 = Date.now();
    await alice.page.getByTestId('game-result-rematch').click();
    await expect(bob.page.locator('[data-testid="game-result-face"][data-you="false"]').getByTestId('game-result-check'), "alice's check reaches bob").toBeVisible({
      timeout: 10_000,
    });
    console.log(`[aa-poll] alice (reloaded) pressed Rematch: bob's screen drew her check after ${Date.now() - t0}ms`);
    await bob.page.getByTestId('game-result-rematch').click();
    for (const f of [alice, bob]) {
      await expect.poll(() => MATCH_URL.exec(f.page.url())?.[1], { message: `${f.name} reaches a new match`, timeout: 120_000 }).not.toBe(matchId);
    }
    const a = MATCH_URL.exec(alice.page.url())?.[1];
    const b = MATCH_URL.exec(bob.page.url())?.[1];
    console.log(`[aa-poll] rematch after a reload: alice in ${a}, bob in ${b} (was ${matchId})`);
    expect(b, 'both screens are in the same new match').toBe(a);
    for (const f of [alice, bob]) await expect(f.page.locator('[aria-label="Game board"]')).toBeVisible({ timeout: 60_000 });
  } finally {
    await stack.stop();
  }
});

/** The lobby, with the stats store answering 401. */
async function statsUnder(browser: Browser, who: 'signed-out' | 'signed-in'): Promise<{ asked: string[]; page: Page; context: BrowserContext }> {
  const context = await friendContext(browser, 'alice');
  await context.route('**/session/whoami', (route) =>
    route.fulfill({ json: who === 'signed-in' ? { valid: true, userId: 'e2e-alice-id', userType: 'friend', name: 'e2e-alice' } : { valid: false } }),
  );
  const asked: string[] = [];
  await context.route('**/prefs/api/v1/_games/**', (route) => {
    const url = new URL(route.request().url());
    asked.push(`${url.pathname.replace(/^.*\/_games\//, '')}${url.search}`);
    return route.fulfill({ status: 401, json: { error: 'unauthorized' } });
  });
  const page = await context.newPage();
  await page.goto(`${EDGE_ORIGIN}${PREFIX}/`);
  await expect(page.getByTestId('lobby')).toBeVisible({ timeout: 30_000 });
  // Open it from the trophy, close it, three times over: each hover of the trophy warms every read
  // again, and each open draws the popout's reads.
  for (let i = 0; i < 3; i += 1) {
    await page.getByTestId('lobby-stats').click();
    await expect(page.getByTestId('stats')).toBeVisible();
    await expect(page.getByTestId('stats')).toContainText('Sign in to see stats.', { timeout: 10_000 });
    await page.waitForTimeout(1_000);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('stats')).toHaveCount(0);
    await page.mouse.move(0, 0);
  }
  await page.waitForTimeout(5_000);
  return { asked, page, context };
}

test('a signed-out viewer never asks the stats store, and a 401 is never asked again', async ({ browser }) => {
  test.setTimeout(3 * 60_000);
  const out = await statsUnder(browser, 'signed-out');
  try {
    console.log(`[aa-poll] stats, signed out: ${out.asked.length} reads [${out.asked.join(', ')}]`);
    expect.soft(out.asked, 'a signed-out viewer never reads the stats store').toEqual([]);
  } finally {
    await out.context.close();
  }
  const signedIn = await statsUnder(browser, 'signed-in');
  try {
    const repeats = signedIn.asked.filter((p, i) => signedIn.asked.indexOf(p) !== i);
    console.log(`[aa-poll] stats, signed in but refused: ${signedIn.asked.length} reads [${signedIn.asked.join(', ')}] repeated=[${repeats.join(', ')}]`);
    expect.soft(repeats, 'no stats read is asked again after its 401').toEqual([]);
  } finally {
    await signedIn.context.close();
  }
});
