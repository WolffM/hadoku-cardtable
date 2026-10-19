/**
 * Two humans, one draft, end to end — through the ONE front door.
 *
 * Two independent browser contexts — separate cookie jars, separate
 * identities, separate sockets — drive the real UI bundle against the real
 * built server through a whole pod. The entry path is the product's only one
 * (w23): alice makes a **draft room** with the front page's create form, bob
 * finds that room in the **room list** and enters it, both mark themselves
 * ready, and only then is a pack dealt — with bots in whatever seats are still
 * empty. Then: pick, pass, wheel, refresh mid-draft, finish. Every draft
 * envelope each context receives is captured as raw text (websocket frames AND
 * long-polling bodies; see `frames.ts`) and checked by `isolation.ts`.
 *
 * ## The readiness gate is asserted at the SERVER, not only on screen
 *
 * "Joining deals nothing" is a claim about the room record, so it is checked
 * against `GET /api/rooms/:id`: bob is a member, alice is ready, bob is not,
 * and `draftStartedAt` is still null. Markup belongs to the room screen and can
 * be restyled; that field is the gate itself.
 *
 * ## What is NOT fixed any more, and what still is
 *
 * The room id is **server-minted** (`r-<hex>`, `lobby.ts` `mintRoomId`) and the
 * id IS the engine's seed, so the pools differ from run to run. Nothing here
 * asserts a pinned pool — the digests are REPORTED in `summary.json` and
 * nothing more, exactly as before.
 *
 * **Which browser gets which seat is a race**: both sockets connect the instant
 * the draft is dealt, so each player's seat is read off the wire
 * (`viewer.seatId`) and everything keyed on a seat — the tally, the refresh
 * check, `checkIsolation`'s `SeatLog` — is keyed on that. What is NOT a race is
 * the PAIR of seats: `createDraft({ humans: [] })` pads all eight seats with
 * bots, so `seatParticipant` (rooms-protocol `seats.js`) reaches its last
 * resort — the lowest bot's seat — for every arrival, and the two humans land
 * in seats 0 and 1. That is asserted, and it is what lets the wheel assertions
 * below still compare two ADJACENT seats.
 *
 * Still deterministic: the pick rule (the lowest card id in the pack), the
 * pacing under the server's rate limit, and every wait keyed on the SERVER's
 * confirmation of a pick rather than on a timer.
 *
 * ## The room list persists across runs, on purpose
 *
 * The harness leaves `CARDTABLE_ROOMS_DIR` unset, so the lobby's store lives
 * under `e2e/.run/data/` and yesterday's rooms are still listed. Every lookup
 * here is by the `data-room-id` of the room this run created — never by
 * position in the list, and never by name alone.
 *
 * What is written to `e2e/.run/` (gitignored): each context's full capture,
 * the server's structured log, and a summary — text only, and nothing here
 * takes a screenshot. The one exception is a video of alice's pick screen,
 * `e2e/.run/videos/<spec>/alice.webm` beside `bob.webm`, and only while
 * `CARDTABLE_E2E_VIDEO=1` (AE20, the operator's own acceptance gate: *"a
 * recorded video of the thing working must be shown to me before it
 * passes"*) — off in every other run, including a plain local one.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { fillWithAi } from './podSeats.ts';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

import { envelopesOf, type RawCapture } from './frames.ts';
import { EDGE_ORIGIN, FRIENDS, PREFIX, SERVER_PORT, SESSION_COOKIE } from './identities.ts';
import { checkIsolation, draftEnvelopes, type SeatLog } from './isolation.ts';
import { keepPrefsLocal } from './prefsLocal.ts';
import { makeTitled, resizeWindow, roomIdFromHash, serverLog as readServerLog } from './play/board.ts';
import { answerConfirm, confirmOpen } from './play/confirm.ts';
import { specVideoSlug } from './play/browser.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { openCreateRoom } from './play/rooms.ts';
import { turnNumber } from './play/turn.ts';

test.describe.configure({ mode: 'serial' });

/**
 * Only the full-journey test (§Acceptance, below) reads this: it is the one
 * spec in this file that touches Forge, through its own `play/harness.ts`
 * stack rather than the shared `../harness.ts` webServer every other test
 * here runs under (`../harness.ts` is deliberately built without a jar — a
 * draft does not touch Forge — so a stack of its own is what a match needs).
 */
const forge = forgeAvailability();
const titled = makeTitled(forge);

const RUN_DIR = resolve(import.meta.dirname, '.run');
/** What `lobby.ts` mints. The pod id is this, so nothing about it is pinned. */
const ROOM_ID = /^r-[0-9a-f]{12}$/;
const PACKS = 3;
const PACK_SIZE = 15;
const PICKS = PACKS * PACK_SIZE;
const SEATS = 8;
/** Picks after which alice's browser is refreshed. Mid pack 2, mid round. */
const REFRESH_AFTER = 20;
/** Per-participant pacing: the limiter refills one pick per 250 ms (`PICK_RATE_LIMIT`). */
const PICK_INTERVAL_MS = 400;
/** Hosts a card image may come from (CLAUDE.md, D15). Blocked in the test. */
const ART_HOSTS = new Set(['cdn.hadoku.me', 'cards.scryfall.io']);
/** A room poll or a socket handshake sits between a click and the next screen. */
const UI_TIMEOUT = 30_000;
/** The context's own default (no `use.viewport` override in `playwright.config.ts`). Same as `play/browser.ts`'s. */
const VIDEO_SIZE = { width: 1280, height: 720 };

/* ── the shapes read off the wire ────────────────────────────────────── */

interface Card {
  cardId: string;
  name: string;
}
interface Seat {
  id: number;
  occupant: { kind: 'human'; participantId: string } | { kind: 'bot'; botId: string } | null;
}
interface View {
  draftId: string;
  epoch: string;
  seq: number;
  packNumber: number;
  passDirection: 'left' | 'right';
  seats: Seat[];
  waitingOn: number[];
  viewer: { kind: 'seat'; seatId: number; pack: Card[]; pool: Card[] } | { kind: 'spectator' };
}
interface Msg {
  type: 'state' | 'update' | 'error';
  view?: View;
  error?: { code: string; detail?: string };
}

/** The room as the lobby describes it. The readiness gate lives in these two fields. */
interface RoomWire {
  id: string;
  gameType: string;
  draftStartedAt: string | null;
  members: { id: string; name: string; ready: boolean }[];
}

/* ── one person at the table ─────────────────────────────────────────── */

interface Player {
  name: string;
  context: BrowserContext;
  page: Page;
  captures: RawCapture[];
  /** Polling bodies still being read. Awaited before any capture is judged. */
  pending: Promise<void>[];
  captureErrors: string[];
  blocked: string[];
  picks: string[];
}

function isPolling(url: string): boolean {
  return url.includes('/socket.io/') && url.includes('transport=polling');
}

async function join(browser: Browser, name: string): Promise<Player> {
  // AE20, the operator's own acceptance gate: "a recorded video of the thing
  // working must be shown to me before it passes." Off by default; the same
  // `CARDTABLE_E2E_VIDEO=1` flag `play/browser.ts` reads.
  const recording = process.env.CARDTABLE_E2E_VIDEO === '1';
  const videoDir = recording ? resolve(RUN_DIR, 'videos', specVideoSlug()) : null;
  if (videoDir !== null) mkdirSync(videoDir, { recursive: true });
  // For the operator's eyes: their game is the dark theme, so the clip is too.
  const context = await browser.newContext(
    videoDir === null ? {} : { recordVideo: { dir: videoDir, size: VIDEO_SIZE }, colorScheme: 'dark' },
  );
  await context.addCookies([
    { name: SESSION_COOKIE, value: name, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict' },
  ]);
  await keepPrefsLocal(context, EDGE_ORIGIN);
  const page = await context.newPage();
  const player: Player = {
    name,
    context,
    page,
    captures: [],
    pending: [],
    captureErrors: [],
    blocked: [],
    picks: [],
  };

  // Nothing leaves the machine. Card art is the only thing that would try,
  // and where it tries to go is itself asserted below.
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1') return route.continue();
    player.blocked.push(url.href);
    return route.abort('blockedbyclient');
  });

  page.on('websocket', (ws) => {
    ws.on('framereceived', (f) => {
      player.captures.push({ t: Date.now(), dir: 'in', via: 'ws', text: String(f.payload) });
    });
    ws.on('framesent', (f) => {
      player.captures.push({ t: Date.now(), dir: 'out', via: 'ws', text: String(f.payload) });
    });
  });
  page.on('request', (req) => {
    if (!isPolling(req.url()) || req.method() !== 'POST') return;
    player.captures.push({ t: Date.now(), dir: 'out', via: 'polling', text: req.postData() ?? '' });
  });
  page.on('response', (res) => {
    if (!isPolling(res.url()) || res.request().method() !== 'GET') return;
    // Reserve the slot NOW so capture order is arrival order, then fill it.
    const slot: RawCapture = { t: Date.now(), dir: 'in', via: 'polling', text: '' };
    player.captures.push(slot);
    player.pending.push(
      res.text().then(
        (text) => {
          slot.text = text;
        },
        (err: unknown) => {
          player.captureErrors.push(`${res.url()}: ${String(err)}`);
        },
      ),
    );
  });

  return player;
}

/**
 * Close a player's context and, when recording, name its video `<name>.webm`
 * beside the other player's — the pair the operator watches for one run.
 *
 * `page.video()?.path()` only resolves once the context is closed, so the
 * close happens first; one page per context here, so there is no "which page
 * was the match" choice to make (`play/open-friends.ts` has that problem,
 * this file does not).
 */
async function finalizeVideo(p: Player): Promise<void> {
  await p.context.close();
  if (process.env.CARDTABLE_E2E_VIDEO !== '1') return;
  const path = await p.page.video()?.path().catch(() => undefined);
  if (path === undefined) return;
  const target = resolve(RUN_DIR, 'videos', specVideoSlug(), `${p.name}.webm`);
  try {
    renameSync(path, target);
  } catch (err) {
    // A rename failing is not a reason to fail the test over — but it is said, not swallowed.
    console.warn(`[video] ${p.name}: could not rename ${path}: ${String(err)}`);
  }
}

/** Every server→client draft message this context has received so far. */
function received(p: Player): Msg[] {
  return draftEnvelopes({ name: p.name, seat: -1, envelopes: envelopesOf(p.captures) }).map(
    (e) => e.msg as Msg,
  );
}

function views(p: Player): View[] {
  return received(p).flatMap((m) => (m.view === undefined ? [] : [m.view]));
}

function latestView(p: Player): View | null {
  const all = views(p);
  return all.length === 0 ? null : all[all.length - 1];
}

function seatViewer(view: View) {
  if (view.viewer.kind !== 'seat') throw new Error(`expected a seat view, got ${view.viewer.kind}`);
  return view.viewer;
}

/** The occupant of one seat, found by seat id rather than by array position. */
function occupantAt(view: View, seat: number): Seat['occupant'] {
  const row = view.seats.find((s) => s.id === seat);
  if (row === undefined) throw new Error(`the view has no seat ${seat}`);
  return row.occupant;
}

/**
 * The seat the SERVER put this browser in.
 *
 * Both sockets connect the instant the draft is dealt, so who gets seat 0 is a
 * race and nothing here may assume it. This is the one source of truth for it.
 */
async function seatFromWire(p: Player): Promise<number> {
  await expect
    .poll(
      () => {
        const v = latestView(p);
        return v !== null && v.viewer.kind === 'seat';
      },
      { message: `${p.name}: the server names a seat for them`, timeout: UI_TIMEOUT },
    )
    .toBe(true);
  const v = latestView(p);
  if (v === null) throw new Error(`${p.name}: no view after the seat poll`);
  return seatViewer(v).seatId;
}

/* ── the front door ──────────────────────────────────────────────────── */

/**
 * The room record, straight from the lobby. Not the markup: the gate itself.
 *
 * `origin` defaults to the shared room edge; the full-journey spec (§Acceptance)
 * passes a `play/harness.ts` stack's own origin instead, because that is the
 * one server in this file's reach that also has Forge.
 */
async function roomState(p: Player, roomId: string, origin: string = EDGE_ORIGIN): Promise<RoomWire> {
  const res = await p.context.request.get(`${origin}${PREFIX}/api/rooms/${roomId}`);
  expect(res.status(), `${p.name}: GET /api/rooms/${roomId}`).toBe(200);
  return (await res.json()) as RoomWire;
}


/**
 * Make a draft room through the create form itself.
 *
 * Draft was "(Coming Soon)" and unpickable from 2026-10-10 to 2026-10-17. It
 * is pickable now, so this drives the same form a person uses rather than
 * reaching around it with the API (`e2e/play/rooms.ts`'s `createRoomByApi`,
 * which this spec no longer calls). `origin` — see `roomState`.
 */
async function createDraftRoom(p: Player, name: string, origin: string = EDGE_ORIGIN): Promise<string> {
  await p.page.goto(`${origin}${PREFIX}/`);
  await expect(p.page.getByTestId('room-create-open')).toBeVisible();

  // ONE front door. The pod button and the paste-an-id box are gone, and this
  // is the spec that would notice them coming back.
  await expect(p.page.getByTestId('draft-pods')).toHaveCount(0);
  await expect(p.page.getByTestId('start-pod')).toHaveCount(0);
  await expect(p.page.getByTestId('join-id')).toHaveCount(0);

  await openCreateRoom(p.page);
  const draftOption = p.page.locator('[data-testid="room-create-type"] option[value="draft"]');
  await expect(draftOption).toBeEnabled();
  await expect(draftOption).toHaveText('Draft');
  await p.page.getByTestId('room-create-name').fill(name);
  await p.page.getByTestId('room-create-type').selectOption('draft');
  await p.page.getByTestId('room-create-submit').click();

  const id = await roomIdFromHash(p.page);
  expect(id, 'the room id is server-minted').toMatch(ROOM_ID);
  return id;
}

/**
 * Enter a room FROM THE LIST — §D's "from the room list alone".
 *
 * The list accumulates across runs (see the header), so the row is located by
 * the id this run created. `gameType` is what the row's own label must read —
 * `'Draft'` for a pod, `'Constructed 1v1'` for the room the full-journey spec
 * opens afterward to play the built decks. `origin` — see `roomState`.
 */
async function enterFromList(
  p: Player,
  roomId: string,
  roomName: string,
  options: { origin?: string; gameType?: string } = {},
): Promise<void> {
  const { origin = EDGE_ORIGIN, gameType = 'Draft' } = options;
  await p.page.goto(`${origin}${PREFIX}/`);
  const row = p.page.locator(`[data-testid="room-row"][data-room-id="${roomId}"]`);
  await expect(row).toBeVisible({ timeout: UI_TIMEOUT });
  await expect(row.getByTestId('room-name')).toHaveText(roomName);
  // The list says what game it is before anybody commits to entering.
  await expect(row.getByTestId('room-type')).toHaveText(gameType);
  await row.getByTestId('room-enter').click();
  expect(await roomIdFromHash(p.page), `${p.name} entered ${roomId}`).toBe(roomId);
}

/** The room's lobby phase: a Ready control, and no pack anywhere. */
async function expectLobbyNotPod(p: Player): Promise<void> {
  await expect(p.page.getByTestId('ready-toggle')).toBeVisible({ timeout: UI_TIMEOUT });
  await expect(p.page.getByTestId('pod')).toHaveCount(0);
}

const byCardId = (a: string, b: string): number => Number(a.slice(1)) - Number(b.slice(1)) || a.localeCompare(b);

const ENABLED_CARDS = '[data-testid="pack"] button[data-testid="card"]:not([disabled])';

async function domPackIds(page: Page): Promise<string[]> {
  const ids = await page.$$eval(ENABLED_CARDS, (bs) => bs.map((b) => b.getAttribute('data-card-id') ?? ''));
  return ids.sort(byCardId);
}

/**
 * Pick until the draft is over.
 *
 * Every pick waits for the server's own confirmation — an envelope whose pool
 * holds the card — before the next is considered. That is what makes the run
 * independent of timing: nothing here guesses how long a round trip takes.
 */
async function draftAll(p: Player, hooks: { afterPick?: (n: number) => Promise<void> } = {}): Promise<void> {
  let lastClick = 0;
  for (;;) {
    const next = await p.page.waitForFunction(
      (sel) => {
        if (window.location.hash.startsWith('#/deck/')) return 'done';
        return document.querySelectorAll(sel).length > 0 ? 'pick' : null;
      },
      ENABLED_CARDS,
      { timeout: 90_000, polling: 50 },
    );
    if ((await next.jsonValue()) === 'done') return;

    // What the page offers is exactly what the server sent THIS seat.
    const offered = await domPackIds(p.page);
    const latest = latestView(p);
    if (latest === null) throw new Error(`${p.name}: a pack is on screen before any envelope arrived`);
    expect(offered, `${p.name}: the pack on screen is the pack in the latest envelope`).toEqual(
      seatViewer(latest).pack.map((c) => c.cardId).sort(byCardId),
    );

    // The grid, not the fan: the fan overlaps its cards on purpose (only a
    // sliver of each shows until it is hovered), so a click at a card's centre
    // lands on its neighbour. The grid is the same tiles, a control a person
    // can use too, and what PackView's own header says the tests read. It is
    // per page, so it is re-chosen after the refresh.
    const grid = p.page.getByRole('group', { name: 'Pack layout' }).getByRole('button', { name: 'grid' });
    if ((await grid.getAttribute('aria-pressed')) !== 'true') await grid.click();

    const choice = offered[0];
    const wait = lastClick + PICK_INTERVAL_MS - Date.now();
    if (wait > 0) await p.page.waitForTimeout(wait);
    await p.page.click(`[data-testid="pack"] button[data-card-id="${choice}"]`);
    lastClick = Date.now();
    p.picks.push(choice);

    await expect
      .poll(
        () => {
          const v = latestView(p);
          return v !== null && v.viewer.kind === 'seat' && v.viewer.pool.some((c) => c.cardId === choice);
        },
        { message: `${p.name}: the server confirms pick ${p.picks.length} (${choice})`, timeout: 20_000 },
      )
      .toBe(true);

    await hooks.afterPick?.(p.picks.length);
  }
}

/**
 * The pack this seat was offered for each of its 45 picks, from the wire.
 *
 * An envelope offers pick `n` when the seat is in `waitingOn` with a
 * non-empty pack and `n - 1` cards already in its pool. The first such
 * envelope for each `n` is the offer.
 */
function offers(p: Player): string[][] {
  const out: string[][] = [];
  for (const v of views(p)) {
    if (v.viewer.kind !== 'seat') continue;
    const { seatId, pack, pool } = v.viewer;
    if (!v.waitingOn.includes(seatId) || pack.length === 0) continue;
    if (out[pool.length] === undefined) out[pool.length] = pack.map((c) => c.cardId);
  }
  return out;
}

const setEq = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().join() === [...b].sort().join();

function digest(ids: readonly string[]): string {
  return createHash('sha256').update(ids.join(',')).digest('hex').slice(0, 16);
}

/* ── the tests ───────────────────────────────────────────────────────── */

test('the friend gate still bites: no session, no page and no socket', async ({ browser, request }) => {
  // A browser with no session: the page itself is refused.
  const stranger = await browser.newContext();
  const page = await stranger.newPage();
  const res = await page.goto(`${EDGE_ORIGIN}${PREFIX}/`);
  expect(res?.status()).toBe(404);

  // Forged identity headers through the edge: stripped, still refused.
  const forged = await request.get(`${EDGE_ORIGIN}${PREFIX}/api/whoami`, {
    headers: { 'x-hadoku-tier': 'admin', 'x-user-key': FRIENDS.alice.key, 'x-edge-auth': 'guess' },
  });
  expect(forged.status()).toBe(404);

  // Forged headers straight at the app server, around the edge: the server's
  // own seal refuses them, because the secret is not the one it was given.
  const around = await request.get(`http://127.0.0.1:${SERVER_PORT}/api/whoami`, {
    headers: { 'x-hadoku-tier': 'friend', 'x-user-key': FRIENDS.alice.key, 'x-edge-auth': 'guess' },
  });
  expect(around.status()).toBe(404);

  // The socket: engine.io's handshake is below express, so the gate lives on
  // the namespace connect. No session → an error packet, not a connection.
  async function namespaceConnect(cookie: string | null): Promise<string> {
    const headers: Record<string, string> = cookie === null ? {} : { cookie: `${SESSION_COOKIE}=${cookie}` };
    const base = `${EDGE_ORIGIN}${PREFIX}/socket.io/?EIO=4&transport=polling`;
    const open = await request.get(base, { headers });
    expect(open.status()).toBe(200);
    const sid = (JSON.parse((await open.text()).slice(1)) as { sid: string }).sid;
    const sent = await request.post(`${base}&sid=${sid}`, {
      headers: { ...headers, 'content-type': 'text/plain;charset=UTF-8' },
      data: '40',
    });
    expect(sent.status()).toBe(200);
    return (await request.get(`${base}&sid=${sid}`, { headers })).text();
  }
  expect(await namespaceConnect(null)).toBe('44{"message":"not found"}');
  expect(await namespaceConnect('mallory')).toBe('44{"message":"not found"}');
  expect(await namespaceConnect('alice')).toMatch(/^40\{"sid":"/);

  // And a known session is let in, as the identity the edge stamped.
  const alice = await browser.newContext();
  await alice.addCookies([{ name: SESSION_COOKIE, value: 'alice', domain: '127.0.0.1', path: '/' }]);
  const who = await alice.request.get(`${EDGE_ORIGIN}${PREFIX}/api/whoami`);
  expect(who.status()).toBe(200);
  expect(await who.json()).toEqual({ userId: FRIENDS.alice.userId, tier: 'friend' });

  await stranger.close();
  await alice.close();
});

test('two friends draft a whole pod from the room list: ready, pick, pass, wheel, refresh, finish — and each sees only their own cards', async ({
  browser,
}) => {
  const alice = await join(browser, 'alice');
  const bob = await join(browser, 'bob');

  /* ── the front door: a draft room, made with the create form ─────── */

  const roomName = `e2e draft ${Date.now()}`;
  const roomId = await createDraftRoom(alice, roomName);

  // Entering a draft room deals NOTHING. Both halves of that: the screen shows
  // a lobby with a Ready control, and the room record has no draft.
  await expectLobbyNotPod(alice);
  const created = await roomState(alice, roomId);
  expect(created.gameType).toBe('draft');
  expect(created.draftStartedAt, 'creating a draft room does not deal a draft').toBeNull();

  /* ── bob arrives from the room list, and from nowhere else ────────── */

  await enterFromList(bob, roomId, roomName);
  await expectLobbyNotPod(bob);

  // Bob is a MEMBER before anybody readies. That ordering is load-bearing:
  // "every member ready" with one member would start the draft against seven
  // bots, and the "only alice ready" check below would be testing nothing.
  await expect
    .poll(async () => (await roomState(alice, roomId)).members.length, {
      message: 'the lobby has both members',
      timeout: UI_TIMEOUT,
    })
    .toBe(2);

  /* ── the readiness gate: one ready is not enough ──────────────────── */

  await alice.page.getByTestId('ready-toggle').click();
  await expect
    .poll(async () => (await roomState(alice, roomId)).members.filter((m) => m.ready).length, {
      message: 'the lobby records alice ready',
      timeout: UI_TIMEOUT,
    })
    .toBe(1);

  const halfway = await roomState(alice, roomId);
  expect(halfway.draftStartedAt, 'one ready member of two does not deal a draft').toBeNull();
  await expect(alice.page.getByTestId('pod')).toHaveCount(0);
  await expect(bob.page.getByTestId('pod')).toHaveCount(0);

  /* ── both ready: the pack appears, with bots in the empty seats ───── */

  await bob.page.getByTestId('ready-toggle').click();
  // Both seated and ready, six seats open: still no deal until the AI holds them.
  expect((await roomState(alice, roomId)).draftStartedAt, 'an open seat holds the deal').toBeNull();
  await fillWithAi(alice.page, UI_TIMEOUT);
  await expect(alice.page.getByTestId('pod')).toBeVisible({ timeout: UI_TIMEOUT });
  await expect(bob.page.getByTestId('pod')).toBeVisible({ timeout: UI_TIMEOUT });
  expect((await roomState(alice, roomId)).draftStartedAt, 'every seat filled and every player ready deals the draft').not.toBeNull();

  // Which seat each browser got is a race; that they are BOTH here is not.
  const aliceSeat = await seatFromWire(alice);
  const bobSeat = await seatFromWire(bob);
  expect(aliceSeat).not.toBe(bobSeat);

  await expect(alice.page.getByTestId('pod-tally')).toHaveText('2 people · 6 bots', { timeout: UI_TIMEOUT });
  await expect(bob.page.getByTestId('pod-tally')).toHaveText('2 people · 6 bots', { timeout: UI_TIMEOUT });

  // §C's "an invite link still works": the pod's invite is the ROOM's url —
  // the same url alice's mid-draft refresh reloads below, which is the
  // end-to-end proof that following it lands you back in your seat.
  expect(await alice.page.getByTestId('invite-url').inputValue()).toBe(
    `${EDGE_ORIGIN}${PREFIX}/#/room/${roomId}`,
  );

  // Alice's view must have caught bob's arrival before the seat table is read.
  await expect
    .poll(
      () => {
        const v = latestView(alice);
        return v === null ? -1 : v.seats.filter((s) => s.occupant?.kind === 'human').length;
      },
      { message: 'alice sees both humans seated', timeout: UI_TIMEOUT },
    )
    .toBe(2);

  const opening = latestView(alice);
  if (opening === null) throw new Error('alice has no view after the draft started');
  expect(opening.seats).toHaveLength(SEATS);

  // Carried over from the fixed-seat version, and still guaranteed: the humans
  // hold the two LOWEST seats. The draft is dealt with `humans: []`, so all
  // eight seats are bots and `seatParticipant` reaches its last resort — the
  // lowest bot's seat — for each arrival (rooms-protocol `seats.js`: step 2
  // finds no empty seat and step 3 no room to grow). So the pair is {0,1};
  // only which browser is which varies.
  const humanSeats = opening.seats.filter((s) => s.occupant?.kind === 'human').map((s) => s.id);
  expect(humanSeats, 'the two humans hold the two lowest seats').toEqual([0, 1]);
  expect([aliceSeat, bobSeat].sort((x, y) => x - y)).toEqual(humanSeats);
  // …and therefore they are neighbours around the ring of eight, which is what
  // the wheel assertions at the bottom compare.
  const gap = (bobSeat - aliceSeat + SEATS) % SEATS;
  expect(gap === 1 || gap === SEATS - 1, 'the two humans sit in adjacent seats').toBe(true);

  const aliceId = occupantAt(opening, aliceSeat);
  const bobId = occupantAt(opening, bobSeat);
  expect(aliceId?.kind).toBe('human');
  expect(bobId?.kind).toBe('human');
  expect(aliceId).not.toEqual(bobId);

  /* ── pick, with a refresh in the middle of alice's draft ──────────── */

  const refresh: { before?: { seat: number; pool: string[] }; after?: { seat: number; pool: string[] }; guarded?: unknown[] } =
    {};

  await Promise.all([
    draftAll(alice, {
      afterPick: async (n) => {
        // The pick screen recorded at both a desktop width and the mobile
        // one — then back to desktop for the rest of the run, including the
        // refresh below. `resizeWindow` works here with no `[data-zone]`
        // boxes to measure: it waits for the viewport alone once none match.
        if (n === 2) {
          await resizeWindow(alice.page, { width: 390, height: 844 });
          // The PAGE itself must not need to scroll sideways at mobile width —
          // a bounded, deliberate scroll region (the pool's own colour row) is
          // a different thing and is not what this checks.
          const overflow = await alice.page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          );
          expect(overflow, 'no horizontal page scroll at 390px').toBeLessThanOrEqual(1);
          // Stacked at this width: the pack's last card ends above the pool,
          // never underneath it (the pool used to cover the pack's lower rows).
          const stacked = await alice.page.evaluate(() => {
            const cards = [...document.querySelectorAll('[data-testid="pack"] [data-testid="card"]')];
            const pool = document.querySelector('[data-testid="pool"]');
            return {
              packBottom: Math.max(...cards.map((c) => c.getBoundingClientRect().bottom)),
              poolTop: pool === null ? Infinity : pool.getBoundingClientRect().top,
            };
          });
          expect(stacked.packBottom, 'the pack ends above the pool at 390px').toBeLessThanOrEqual(stacked.poolTop);
        }
        if (n === 4) await resizeWindow(alice.page, { width: 1280, height: 720 });
        if (n !== REFRESH_AFTER) return;
        const before = latestView(alice);
        if (before === null) throw new Error('no view before refresh');
        refresh.before = { seat: seatViewer(before).seatId, pool: seatViewer(before).pool.map((c) => c.cardId) };
        const mark = received(alice).length;

        await alice.page.reload();

        // The first thing the new page is told is a full snapshot. It comes
        // after a room poll now — the pod is inside the room screen — so this
        // waits longer than it used to.
        await expect
          .poll(() => received(alice).slice(mark).some((m) => m.type === 'state'), {
            message: 'alice gets a snapshot after the refresh',
            timeout: UI_TIMEOUT,
          })
          .toBe(true);
        const snap = received(alice)
          .slice(mark)
          .find((m) => m.type === 'state');
        const v = snap?.view;
        if (v === undefined) throw new Error('snapshot without a view');
        refresh.after = { seat: seatViewer(v).seatId, pool: seatViewer(v).pool.map((c) => c.cardId) };

        // The seat is held and the pool is intact — in the payload and on screen.
        expect(refresh.after.seat).toBe(refresh.before.seat);
        expect(refresh.after.seat).toBe(aliceSeat);
        expect(refresh.after.pool).toEqual(refresh.before.pool);
        expect(occupantAt(v, aliceSeat)).toEqual(aliceId);
        await expect(alice.page.getByTestId('pool-count')).toHaveText(String(REFRESH_AFTER));
        await expect(alice.page.getByTestId('pod-tally')).toHaveText('2 people · 6 bots');
      },
    }),
    draftAll(bob),
  ]);

  /* ── finish ──────────────────────────────────────────────────────── */

  for (const p of [alice, bob]) {
    // The last pick lands the drafter in the room's deck builder: no screen
    // in between, nothing to press.
    await expect
      .poll(() => p.page.evaluate(() => window.location.hash), {
        message: `${p.name}: the finished draft goes straight to the deck builder`,
      })
      .toBe(`#/deck/${roomId}`);
    await Promise.all(p.pending);
    expect(p.captureErrors, `${p.name}: every polling body was readable`).toEqual([]);

    const final = latestView(p);
    if (final === null) throw new Error(`${p.name}: no final view`);
    const pool = seatViewer(final).pool;
    expect(pool).toHaveLength(PICKS);
    // The server's pool is exactly what this browser clicked, in click order.
    expect(pool.map((c) => c.cardId)).toEqual(p.picks);
    // The builder opens on exactly that pool: every pick in the sideboard,
    // nothing in the main deck yet.
    await expect(p.page.getByTestId('deck-editor')).toBeVisible({ timeout: UI_TIMEOUT });
    await expect(p.page.getByTestId('side-count')).toHaveText(String(PICKS));
    await expect(p.page.getByTestId('main-count')).toHaveText('0');

    // No pick was refused — not rate-limited, not stale, not out of turn.
    const errors = received(p).filter((m) => m.type === 'error');
    expect(errors, `${p.name}: the server refused nothing`).toEqual([]);
  }

  /* ── pass and wheel, read off the wire ───────────────────────────── */

  const aOffers = offers(alice);
  const bOffers = offers(bob);
  const directions: string[] = [];
  for (const [p, o] of [
    [alice, aOffers],
    [bob, bOffers],
  ] as const) {
    for (let i = 0; i < PICKS; i++) {
      const pack = o[i];
      expect(pack, `${p.name}: was offered pick ${i + 1}`).toBeDefined();
      expect(pack, `${p.name}: pick ${i + 1} pack size`).toHaveLength(PACK_SIZE - (i % PACK_SIZE));
      expect(pack, `${p.name}: pick ${i + 1} holds the card taken`).toContain(p.picks[i]);
      // The wheel: eight seats, so the pack a seat sees at pick k+8 is the one
      // it saw at pick k, less the eight cards taken around the table.
      if (i % PACK_SIZE >= SEATS) {
        const earlier = o[i - SEATS];
        expect(pack.every((id) => earlier.includes(id)), `${p.name}: pick ${i + 1} wheels pick ${i + 1 - SEATS}`).toBe(true);
        expect(earlier.length - pack.length).toBe(SEATS);
        expect(pack).not.toContain(p.picks[i - SEATS]);
      }
    }
  }
  for (let round = 0; round < PACKS; round++) {
    // The two humans are neighbours (asserted above), so one of them hands the
    // other its pack after every pick — and which one flips with the pass
    // direction. Deliberately measured rather than derived from a seat number:
    // it holds for whichever of the pair each browser landed in.
    let aToB = 0;
    let bToA = 0;
    for (let k = round * PACK_SIZE; k < (round + 1) * PACK_SIZE - 1; k++) {
      if (setEq(aOffers[k].filter((id) => id !== alice.picks[k]), bOffers[k + 1])) aToB += 1;
      if (setEq(bOffers[k].filter((id) => id !== bob.picks[k]), aOffers[k + 1])) bToA += 1;
    }
    const direction = aToB === PACK_SIZE - 1 && bToA === 0 ? 'alice→bob' : bToA === PACK_SIZE - 1 && aToB === 0 ? 'bob→alice' : `mixed(${aToB},${bToA})`;
    directions.push(direction);
  }
  expect(directions[0]).not.toMatch(/^mixed/);
  expect(directions).toEqual([directions[0], directions[0] === 'alice→bob' ? 'bob→alice' : 'alice→bob', directions[0]]);

  /* ── isolation, over every envelope either browser received ──────── */

  // The seats come off the wire, so a run in which bob got seat 0 is checked
  // against bob's real seat rather than failing rule 2 on a hardcoded one.
  const logs: SeatLog[] = [
    { name: 'alice', seat: aliceSeat, envelopes: envelopesOf(alice.captures) },
    { name: 'bob', seat: bobSeat, envelopes: envelopesOf(bob.captures) },
  ];
  const report = checkIsolation(logs);

  // ── the image boundary, while we are here: only art hosts were asked for.
  const offHosts = [...alice.blocked, ...bob.blocked].filter((u) => !ART_HOSTS.has(new URL(u).hostname));

  // ── evidence, written before anything below can fail.
  const serverLog = readServerLog({ serverLogFile: resolve(RUN_DIR, 'server.jsonl') });
  const aliceParticipant = aliceId?.kind === 'human' ? aliceId.participantId : '';
  refresh.guarded = serverLog
    .filter((l) => l.evt === 'disconnected' && l.participantId === aliceParticipant)
    .map((l) => ({ reason: l.reason, guarded: l.guarded }));
  const rejoins = serverLog.filter((l) => l.evt === 'join' && l.participantId === aliceParticipant);

  for (const p of [alice, bob]) {
    writeFileSync(resolve(RUN_DIR, `${p.name}.captures.json`), JSON.stringify(p.captures));
  }
  const summary = {
    // The room id IS the pod id and the engine's seed, and it is minted per
    // run — so the pools below differ every run. Reported, never asserted.
    roomId,
    seats: { alice: aliceSeat, bob: bobSeat },
    isolation: report,
    pools: { alice: digest(alice.picks), bob: digest(bob.picks) },
    passDirections: directions,
    refresh: { ...refresh, rejoins: rejoins.map((l) => ({ seat: l.seat, changed: l.changed })) },
    transports: Object.fromEntries(
      [alice, bob].map((p) => {
        const env = draftEnvelopes({ name: p.name, seat: -1, envelopes: envelopesOf(p.captures) });
        return [p.name, { ws: env.filter((e) => e.via === 'ws').length, polling: env.filter((e) => e.via === 'polling').length }];
      }),
    ),
    // Not asserted — reported. Every round that bots finish advances `seq` by
    // more than one while the room emits one update, so each browser sees a
    // gap, drops the update, and asks for a snapshot. See README "Findings".
    resyncsRequested: Object.fromEntries(
      [alice, bob].map((p) => [
        p.name,
        envelopesOf(p.captures).filter(
          (e) => e.dir === 'out' && (e.msg as { type?: string } | null)?.type === 'resync',
        ).length,
      ]),
    ),
    serverResyncs: serverLog.filter((l) => l.evt === 'resync').length,
    serverPicks: serverLog.filter((l) => l.evt === 'pick').length,
    blockedArtRequests: alice.blocked.length + bob.blocked.length,
  };
  writeFileSync(resolve(RUN_DIR, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));

  expect(report.violations).toEqual([]);
  expect(report.ok).toBe(true);
  // A check that examined nothing passes too. It must have examined a draft.
  expect(report.counts.views).toBeGreaterThanOrEqual(2 * PICKS);
  expect(report.counts.pairs).toBeGreaterThanOrEqual(PICKS);
  expect(report.counts.probes).toBeGreaterThan(0);
  expect(offHosts).toEqual([]);
  // The refresh really did drop a socket, and the server saw it.
  expect(refresh.guarded.length).toBeGreaterThanOrEqual(1);

  await finalizeVideo(alice);
  await finalizeVideo(bob);
});

/* ── §Acceptance: draft, build, leave and return, then real Forge ────── */

/**
 * Move cards from the sideboard into the maindeck, one click per card (the
 * editor's own gesture — `DeckEditor.tsx`'s header), until the maindeck
 * reaches `n`; then wait for the debounced save to actually land
 * (the editor's own `data-save` state, not a sleep — the save fires `saveDelayMs`
 * after the LAST move, not after each one).
 */
async function buildMainDeck(p: Player, n: number): Promise<void> {
  const mainCount = p.page.getByTestId('main-count');
  const sideCard = p.page.locator('[data-testid="side-grid"] button[data-testid="card"]').first();
  for (let i = 0; i < n; i++) await sideCard.click();
  await expect(mainCount, `${p.name}: the maindeck reaches ${n}`).toHaveText(String(n));
  await expect(p.page.getByTestId('deck-editor'), `${p.name}: the build is saved`).toHaveAttribute('data-save', 'saved', { timeout: UI_TIMEOUT });
}

/**
 * The room leave the UI has no button for (`PodScreen`'s "← Lobby" only
 * navigates away; it never calls this) — the same route `rooms/api.ts`'s
 * `leave()` sends, by the caller's own page so the identity is theirs. This
 * is what C's "owns their pool for good… through leave" actually exercises.
 */
async function leavePod(p: Player, podId: string): Promise<void> {
  const status = await p.page.evaluate(async (id) => {
    const res = await fetch(`${window.location.pathname.replace(/\/?$/, '/')}api/rooms/${id}/leave`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    return res.status;
  }, podId);
  expect(status, `${p.name}: POST .../rooms/${podId}/leave`).toBe(200);
}

/**
 * Press through whatever opening questions a fresh match asks — the
 * coin-toss's play-or-draw, each seat's keep-or-mulligan — until every page's
 * own turn counter reads a real turn. Always answers 'yes' (play, keep):
 * hand smoothing is on by default (room settings), so a real mulligan is the
 * exception here, not the rule, and this is not a spec about mulligan
 * decisions.
 *
 * Two different prompts, on purpose: the coin toss is its OWN component
 * (`live-play-or-draw-play`), never `ConfirmPrompt` — "the two pop-ups are
 * mutually exclusive by construction" — so `confirm.ts`'s generic
 * `confirmOpen`/`answerConfirm` only covers the keep/mulligan half; a first
 * version of this function answered only that half and hung the full 60 s on
 * bob's own "you have won the coin toss" prompt, confirmed from the real
 * server log (`showPromptMessage`/`updateButtons` for seat 1, nothing for
 * seat 0 beyond "Waiting for e2e-bob…"). Both testids are public and
 * `Page`-typed, which is why this reaches for them directly rather than
 * copying `scenario.ts`'s own (unexported, and `Friend`-typed rather than
 * this file's own `Player`) `keepBothHands`.
 *
 * A seat parked on a LONDON MULLIGAN BOTTOM-PICK (an actual card selection,
 * not a yes/no) is not answered here — neither check matches it, so this
 * keeps polling turn 1 and times out loudly rather than guessing at a
 * selection, which hand smoothing makes rare enough not to script for yet.
 */
async function pressIntoTurnOne(pages: readonly Page[]): Promise<void> {
  await expect
    .poll(
      async () => {
        for (const page of pages) {
          // The coin toss is its OWN prompt, not a `ConfirmPrompt` — "the two
          // pop-ups are mutually exclusive by construction" (T4's own note) —
          // so it needs its own testid, never `confirm.ts`'s. Whoever wins it
          // gets asked; the other seat shows nothing here and falls through to
          // the `confirmOpen` check below once dealt its own keep/mulligan.
          const playOrDraw = page.getByTestId('live-play-or-draw-play');
          if ((await playOrDraw.count()) > 0) {
            await playOrDraw.click({ timeout: 2_000 }).catch(() => undefined);
          } else if (await confirmOpen(page)) {
            await answerConfirm(page, 'yes');
          }
        }
        const turns = await Promise.all(pages.map((page) => page.getByTestId('live-turn-n').textContent().then(turnNumber)));
        return Math.min(...turns);
      },
      { message: 'both seats reach turn 1', timeout: 60_000, intervals: [250] },
    )
    .toBeGreaterThanOrEqual(1);
}

test(
  titled(
    'the operator’s full sequence: draft a pod, build and save decks, leave and return, press Play, and land in turn 1 in real Forge',
  ),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(7 * 60_000);

    const stack = await startPlayStack(forge);
    let alice: Player | undefined;
    let bob: Player | undefined;
    try {
      const origin = stack.origin;
      alice = await join(browser, 'alice');
      bob = await join(browser, 'bob');

      /* ── draft the pod, through the front door, on this stack ────── */
      const podName = `e2e full ${Date.now()}`;
      const podId = await createDraftRoom(alice, podName, origin);
      await expectLobbyNotPod(alice);
      await enterFromList(bob, podId, podName, { origin });
      await expectLobbyNotPod(bob);

      await alice.page.getByTestId('ready-toggle').click();
      await bob.page.getByTestId('ready-toggle').click();
      await fillWithAi(alice.page, UI_TIMEOUT);
      await expect(alice.page.getByTestId('pod')).toBeVisible({ timeout: UI_TIMEOUT });
      await expect(bob.page.getByTestId('pod')).toBeVisible({ timeout: UI_TIMEOUT });

      await Promise.all([draftAll(alice), draftAll(bob)]);

      /* ── both land in the builder, and build and save a 40-card deck ── */
      for (const p of [alice, bob]) {
        await expect(p.page.getByTestId('deck-editor'), `${p.name}: the editor opens`).toBeVisible({ timeout: UI_TIMEOUT });
        await buildMainDeck(p, 40);
      }

      /* ── alice leaves the pod and comes back: her build is still there ── */
      await leavePod(alice, podId);
      await alice.page.goto(`${origin}${PREFIX}/#/deck/${podId}`);
      await expect(alice.page.getByTestId('deck-no-seat'), 'a finished pod keeps the drafter’s seat for good').toHaveCount(0);
      await expect(alice.page.getByTestId('deck-editor')).toBeVisible({ timeout: UI_TIMEOUT });
      await expect(alice.page.getByTestId('main-count'), 'the build alice left is the build she finds').toHaveText('40');

      /* ── Play, and straight into the game: no room to make, no Ready ── */
      // alice is done first: back in the room (she had left it), and handed
      // back to the builder, which shows her ready. bob's Play deals round 1,
      // and the pod screen starts their table by itself.
      await alice.page.getByTestId('play-deck').click();
      await expect(alice.page.getByTestId('pod-built').locator('[data-built]'), 'alice waits, shown as ready').toHaveCount(1, { timeout: UI_TIMEOUT });
      await bob.page.getByTestId('play-deck').click();

      const matchUrl = /#\/match\/(m-[0-9a-f]{12})$/;
      await alice.page.waitForURL(matchUrl, { timeout: 120_000 });
      await bob.page.waitForURL(matchUrl, { timeout: 120_000 });
      for (const p of [alice, bob]) {
        await expect(p.page.locator('[aria-label="Game board"]'), `${p.name}: the board is drawn`).toBeVisible({ timeout: 30_000 });
      }
      await pressIntoTurnOne([alice.page, bob.page]);
    } finally {
      if (alice) await finalizeVideo(alice);
      if (bob) await finalizeVideo(bob);
      await stack.stop();
    }
  },
);

test(
  titled('one drafter and seven bots, the whole way: draft, build, Play, lose game 1, sideboard, lose game 2, and the pod’s standings say so'),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(11 * 60_000);

    const stack = await startPlayStack(forge);
    let alice: Player | undefined;
    try {
      alice = await join(browser, 'alice');
      await createDraftRoom(alice, `e2e solo ${Date.now()}`, stack.origin);
      await expectLobbyNotPod(alice);
      await alice.page.getByTestId('ready-toggle').click();
      await fillWithAi(alice.page, UI_TIMEOUT);
      await expect(alice.page.getByTestId('pod')).toBeVisible({ timeout: UI_TIMEOUT });

      // The fan, as it opens: drawn as a fan, inside its half, and the page
      // does not scroll either way (the operator's screenshot, 2026-10-19).
      await expect(alice.page.locator('[data-testid="pack"].pack--fan')).toBeVisible({ timeout: UI_TIMEOUT });
      const fit = await alice.page.evaluate(() => {
        const pack = document.querySelector('[data-testid="pack"]')!.getBoundingClientRect();
        const cards = [...document.querySelectorAll('[data-testid="pack"] .pack__slot')].map((c) => c.getBoundingClientRect());
        return {
          x: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          y: document.documentElement.scrollHeight - document.documentElement.clientHeight,
          outside: cards.filter((c) => c.left < pack.left - 1 || c.right > pack.right + 1 || c.bottom > pack.bottom + 1).length,
        };
      });
      expect(fit, 'no page scroll, every fanned card inside the pack').toEqual({ x: 0, y: 0, outside: 0 });

      // A deploy mid-draft (every land restarts the server) resumes the pod
      // where it was, not back in its lobby — the audit of 2026-10-19.
      let restartedAt: number | null = null;
      await draftAll(alice, {
        afterPick: async (n) => {
          if (n !== 5) return;
          await stack.restart();
          restartedAt = n;
          await alice!.page.reload();
          await expect(alice!.page.getByTestId('pod'), 'the pod is still there after a restart').toBeVisible({ timeout: UI_TIMEOUT });
          await expect(alice!.page.getByTestId('draft-lobby'), 'not back in its lobby').toHaveCount(0);
        },
      });
      expect(restartedAt, 'the restart happened mid-draft').toBe(5);
      await expect(alice.page.getByTestId('deck-editor'), 'the finished draft opens the editor').toBeVisible({ timeout: UI_TIMEOUT });
      await buildMainDeck(alice, 40);
      // And mid-build: the saved build and the pod both come back.
      await stack.restart();
      await alice.page.reload();
      await expect(alice.page.getByTestId('main-count'), 'the build survives a restart').toHaveText('40', { timeout: UI_TIMEOUT });
      await alice.page.getByTestId('play-deck').click();

      // Play → the pod → its one table, against the AI, started by itself.
      const matchUrl = /#\/match\/(m-[0-9a-f]{12})$/;
      await alice.page.waitForURL(matchUrl, { timeout: 120_000 });
      const game1 = alice.page.url();
      await expect(alice.page.locator('[aria-label="Game board"]')).toBeVisible({ timeout: 30_000 });
      await expect(alice.page.getByTestId('room-create'), 'no create-room form on the way').toHaveCount(0);
      await pressIntoTurnOne([alice.page]);

      /* ── game 1 lost: straight to sideboarding, and nothing else first ── */
      // Anything the result screen shows on its way to the sideboard step is a
      // flash (the operator: "never show UI until its ready").
      await alice.page.evaluate(() => {
        const seen: string[] = [];
        (window as unknown as { __resultSeen: string[] }).__resultSeen = seen;
        new MutationObserver(() => {
          if (document.querySelector('[data-testid="game-result-rematch"]') !== null) seen.push('rematch');
          if (document.querySelector('[data-testid="game-result"]') !== null && document.querySelector('[data-testid="sideboard-step"]') === null && document.querySelector('[data-testid="game-result-next"]') === null) seen.push('result-without-next');
        }).observe(document.body, { childList: true, subtree: true });
      });
      await alice.page.getByTestId('live-concede').click();
      await alice.page.getByTestId('live-concede-yes').click();
      // The outcome first, with Next (the operator, 2026-10-19); Next opens the sideboard step.
      await alice.page.getByTestId('game-result-next').click({ timeout: UI_TIMEOUT });
      await expect(alice.page.getByTestId('sideboard-step'), 'Next opens the sideboard step').toBeVisible({ timeout: UI_TIMEOUT });
      expect(await alice.page.evaluate(() => [...new Set((window as unknown as { __resultSeen: string[] }).__resultSeen)]), 'shown before the sideboard step').toEqual([]);

      /* ── Ready: game 2, against the AI again ─────────────────────────── */
      await alice.page.getByTestId('sideboard-ready').click();
      await alice.page.waitForURL((url) => matchUrl.test(url.toString()) && url.toString() !== game1, { timeout: 120_000 });
      await expect(alice.page.locator('[aria-label="Game board"]'), 'game 2 is drawn').toBeVisible({ timeout: 30_000 });
      await pressIntoTurnOne([alice.page]);

      /* ── game 2 lost: the series is over, 0-2, and the pod says so ───── */
      await alice.page.getByTestId('live-concede').click();
      await alice.page.getByTestId('live-concede-yes').click();
      await expect(alice.page.getByTestId('game-result')).toBeVisible({ timeout: UI_TIMEOUT });
      await expect(alice.page.getByTestId('sideboard-step'), 'no sideboarding after the last game').toHaveCount(0);
      await alice.page.getByTestId('game-result-room').click();
      await expect(alice.page.getByTestId('pod-final'), 'the pod is done').toBeVisible({ timeout: UI_TIMEOUT });
      await expect(alice.page.getByTestId('pod-final').getByRole('heading'), 'the heading is Standings').toHaveText('Standings');
      await expect(alice.page.getByTestId(/^pod-standings-row-\d+$/), 'the AI she played is ranked beside her').toHaveCount(2);
      await expect(alice.page.getByTestId('pod-standings-row-1'), 'the AI won the series').toContainText('AI');
      const row = alice.page.getByTestId('pod-standings-row-2');
      await expect(row, 'her standing counts the series she lost').toContainText('(you)');
      const standing = await row.textContent();
      expect(standing, 'game win % from two lost games').toMatch(/0%/);

      /* ── the pool is her deck now, on the Decks page beside the trophy ── */
      await alice.page.getByRole('link', { name: '← Lobby' }).click();
      await alice.page.getByTestId('lobby-decks').click();
      // The 1v1 room's own deck tiles, drawn once their art has.
      const tile = alice.page.getByTestId('deck-option');
      await expect(tile, 'the finished draft is one deck').toHaveCount(1, { timeout: UI_TIMEOUT });
      await tile.click();
      await expect(alice.page.getByTestId('deck-editor'), 'the deck opens in the editor').toBeVisible({ timeout: UI_TIMEOUT });
      await expect(alice.page.getByTestId('play-deck'), 'outside a game there is nothing to play').toHaveCount(0);
      await expect(alice.page.getByTestId('main-count')).toHaveText('40');
      // Its tournament is over, so it can be renamed, over its editor.
      await alice.page.getByTestId('decks-rename').click();
      await alice.page.getByTestId('decks-name-input').fill('Solo cube');
      await alice.page.getByTestId('decks-name-save').click();
      await expect(alice.page.getByTestId('decks-name')).toHaveText('Solo cube');
      await alice.page.getByTestId('back-to-decks').click();
      await expect(tile.locator('.deckpick__name')).toHaveText('Solo cube', { timeout: UI_TIMEOUT });
    } finally {
      if (alice) await finalizeVideo(alice);
      await stack.stop();
    }
  },
);
