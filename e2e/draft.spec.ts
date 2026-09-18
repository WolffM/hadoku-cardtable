/**
 * Two humans, one draft, end to end.
 *
 * Two independent browser contexts — separate cookie jars, separate
 * identities, separate sockets — drive the real UI bundle against the real
 * built server through a whole pod: join by invite link, pick, pass, wheel,
 * refresh mid-draft, finish. Every draft envelope each context receives is
 * captured as raw text (websocket frames AND long-polling bodies; see
 * `frames.ts`) and checked by `isolation.ts`.
 *
 * Deterministic by construction: a fixed pod id (the id IS the engine's seed),
 * a fixed pick rule (the lowest card id in the pack), picks paced under the
 * server's rate limit, and every wait keyed on the SERVER's confirmation of a
 * pick rather than on a timer. The two contexts interleave differently from
 * run to run; the pools they end with do not, and the run prints a digest of
 * them so that can be checked.
 *
 * What is written to `e2e/.run/` (gitignored): each context's full capture,
 * the server's structured log, and a summary. Text only — `.gitignore`
 * refuses image files and nothing here takes a screenshot.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

import { envelopesOf, type RawCapture } from './frames.ts';
import { EDGE_ORIGIN, FRIENDS, PREFIX, SERVER_PORT, SESSION_COOKIE } from './identities.ts';
import { checkIsolation, draftEnvelopes, type SeatLog } from './isolation.ts';

test.describe.configure({ mode: 'serial' });

const RUN_DIR = resolve(import.meta.dirname, '.run');
const DRAFT_ID = 'e2e-two-friends';
const PACKS = 3;
const PACK_SIZE = 15;
const PICKS = PACKS * PACK_SIZE;
const SEATS = 8;
/** Picks after which alice's browser is refreshed. Mid pack 2, mid round. */
const REFRESH_AFTER = 20;
/** Per-participant pacing: the limiter refills one pick per 1.5 s. */
const PICK_INTERVAL_MS = 1_600;
/** Hosts a card image may come from (CLAUDE.md, D15). Blocked in the test. */
const ART_HOSTS = new Set(['cdn.hadoku.me', 'cards.scryfall.io']);

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
  const context = await browser.newContext();
  await context.addCookies([
    { name: SESSION_COOKIE, value: name, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict' },
  ]);
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
        if (document.querySelector('.pod__done') !== null) return 'done';
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

test('two friends draft a whole pod: join, pick, pass, wheel, refresh, finish — and each sees only their own cards', async ({
  browser,
}) => {
  const alice = await join(browser, 'alice');
  const bob = await join(browser, 'bob');

  // ── join: alice through the lobby's join box, bob through her invite link.
  await alice.page.goto(`${EDGE_ORIGIN}${PREFIX}/`);
  await alice.page.getByTestId('join-id').fill(DRAFT_ID);
  await alice.page.getByRole('button', { name: 'Join', exact: true }).click();
  await expect(alice.page.getByTestId('pod-tally')).toContainText('you are seat 0');
  const invite = await alice.page.getByTestId('invite-url').inputValue();
  expect(invite).toBe(`${EDGE_ORIGIN}${PREFIX}/#/draft/${DRAFT_ID}`);

  await bob.page.goto(invite);
  await expect(bob.page.getByTestId('pod-tally')).toContainText('2 people · 6 bots of 8 seats · you are seat 1');
  await expect(alice.page.getByTestId('pod-tally')).toContainText('2 people · 6 bots of 8 seats · you are seat 0');

  const opening = latestView(alice);
  if (opening === null) throw new Error('alice has no view after joining');
  expect(opening.seats).toHaveLength(SEATS);
  const aliceId = opening.seats[0].occupant;
  const bobId = opening.seats[1].occupant;
  expect(aliceId?.kind).toBe('human');
  expect(bobId?.kind).toBe('human');
  expect(aliceId).not.toEqual(bobId);

  // ── pick, with a refresh in the middle of alice's draft.
  const refresh: { before?: { seat: number; pool: string[] }; after?: { seat: number; pool: string[] }; guarded?: unknown[] } =
    {};

  await Promise.all([
    draftAll(alice, {
      afterPick: async (n) => {
        if (n !== REFRESH_AFTER) return;
        const before = latestView(alice);
        if (before === null) throw new Error('no view before refresh');
        refresh.before = { seat: seatViewer(before).seatId, pool: seatViewer(before).pool.map((c) => c.cardId) };
        const mark = received(alice).length;

        await alice.page.reload();

        // The first thing the new page is told is a full snapshot.
        await expect
          .poll(() => received(alice).slice(mark).some((m) => m.type === 'state'), {
            message: 'alice gets a snapshot after the refresh',
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
        expect(refresh.after.pool).toEqual(refresh.before.pool);
        expect(v.seats[0].occupant).toEqual(aliceId);
        await expect(alice.page.getByTestId('pool-count')).toHaveText(String(REFRESH_AFTER));
        await expect(alice.page.getByTestId('pod-tally')).toContainText('2 people · 6 bots of 8 seats · you are seat 0');
      },
    }),
    draftAll(bob),
  ]);

  // ── finish.
  for (const p of [alice, bob]) {
    await expect(p.page.locator('.pod__done h1')).toHaveText('Draft complete');
    await Promise.all(p.pending);
    expect(p.captureErrors, `${p.name}: every polling body was readable`).toEqual([]);

    const final = latestView(p);
    if (final === null) throw new Error(`${p.name}: no final view`);
    const pool = seatViewer(final).pool;
    expect(pool).toHaveLength(PICKS);
    // The server's pool is exactly what this browser clicked, in click order.
    expect(pool.map((c) => c.cardId)).toEqual(p.picks);
    // And the finished screen lists that pool, and nothing else.
    await expect(p.page.locator('ol.pod__pool li')).toHaveText(pool.map((c) => c.name));

    // No pick was refused — not rate-limited, not stale, not out of turn.
    const errors = received(p).filter((m) => m.type === 'error');
    expect(errors, `${p.name}: the server refused nothing`).toEqual([]);
  }

  // ── pass and wheel, read off the wire.
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
    // Seats 0 and 1 are neighbours, so one of them hands the other its pack
    // after every pick — and which one flips with the pass direction.
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

  // ── isolation, over every envelope either browser received.
  const logs: SeatLog[] = [
    { name: 'alice', seat: 0, envelopes: envelopesOf(alice.captures) },
    { name: 'bob', seat: 1, envelopes: envelopesOf(bob.captures) },
  ];
  const report = checkIsolation(logs);

  // ── the image boundary, while we are here: only art hosts were asked for.
  const offHosts = [...alice.blocked, ...bob.blocked].filter((u) => !ART_HOSTS.has(new URL(u).hostname));

  // ── evidence, written before anything below can fail.
  const serverLog = readFileSync(resolve(RUN_DIR, 'server.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  const aliceParticipant = aliceId?.kind === 'human' ? aliceId.participantId : '';
  refresh.guarded = serverLog
    .filter((l) => l.evt === 'disconnected' && l.participantId === aliceParticipant)
    .map((l) => ({ reason: l.reason, guarded: l.guarded }));
  const rejoins = serverLog.filter((l) => l.evt === 'join' && l.participantId === aliceParticipant);

  for (const p of [alice, bob]) {
    writeFileSync(resolve(RUN_DIR, `${p.name}.captures.json`), JSON.stringify(p.captures));
  }
  const summary = {
    draftId: DRAFT_ID,
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

  await alice.context.close();
  await bob.context.close();
});
