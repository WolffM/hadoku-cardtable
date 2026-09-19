/**
 * Two humans, one Forge match, end to end.
 *
 * The play analogue of `draft.spec.ts`. Two independent browser contexts —
 * separate cookie jars, identities and sockets — start a constructed match
 * from the product UI (lobby → `#/play` → `#/match/<id>`), seat both friends
 * by the invite link, and play a real Forge game against the REAL built
 * server, with a real Forge in a child JVM. Every byte of each browser's match
 * socket is captured (`play/browser.ts`) and checked by `play/isolation.ts`.
 *
 * Needs a Forge build: `CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`, exactly
 * as the server's `jvm.test.ts`. Without them the live test SKIPS, and its
 * title says why. CI has no Forge, so in CI only the first test runs: the
 * checker against committed fixtures, which needs nothing.
 *
 * ## What the browser cannot do, measured first
 *
 * The board answers asks and cannot act (`play/hands.ts` has the file-and-line
 * account). The spec records that before anything else: both boards drawn,
 * Forge waiting on a button at the coin toss, and no control on either page.
 * Then it connects `play/hands.ts` — one extra socket per friend that sends
 * the acts the board cannot (OK, a land, a spell, a target, a discard) — so the
 * game can reach the questions Forge ASKS, and every one of those is answered
 * by the browser's own board, clicked (`play/prompts.ts`).
 *
 * The game is played to turn 5 at least, and until each side has answered by
 * CLICK at least one ask the game raised — not only the zone asks the board
 * answers by itself on mount.
 *
 * ## What is asserted
 *
 * - **Seats.** Alice starts the match from `#/play`; Bob opens her invite link.
 *   Seat 1 and seat 2, distinct players, each told so by its own snapshot.
 * - **Prompts, from both sides.** Each browser answers at least one ask the
 *   GAME raised, through its board (`LiveBoard` → prompt component →
 *   `answerAsk` → `forge:c2s`), and the server accepted every reply. Then each
 *   is put a `showConfirmDialog` by Forge's server side (the probe) and clicks
 *   the button Forge did NOT default to — so Forge's `true` can only have come
 *   from that click.
 * - **Refresh mid-match, with a question open.** Alice's probe is left open and
 *   her page reloads. Her seat, her board and the SAME ask (same `callId`) come
 *   back, she answers it after the reload, and Forge's call returns her answer.
 *   The server's log must show the seat had no connection at all in between —
 *   the reconnect grace, not a second socket, held it.
 * - **The board agrees with the server.** With the game quiet, each browser's
 *   stream folded as its client folds it equals the server's own fold of that
 *   seat (`GET …/seats/:seat/state`), object for object, at the same cursor;
 *   and what the page DRAWS — turn, phase, life, hand and library counts, and
 *   every card id in every zone — equals the UI's adapter over the SERVER's
 *   objects.
 * - **Isolation, over every envelope and every snapshot** (`play/isolation.ts`),
 *   with minimum counts so a check that examined nothing cannot pass.
 *
 * Evidence (gitignored, text only) goes to `e2e/.run/`: `play-*.captures.json`,
 * `play-server.jsonl`, `play-summary.json`.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test, type APIRequestContext } from '@playwright/test';

import { toBoardView } from '../apps/ui/src/play/adapter.ts';
import type { WireObject } from '../apps/ui/src/play/wire.ts';
import { messages, openFriend, type Friend } from './play/browser.ts';
import { isSnapshot, type Frame, type PlayMessage, type ServerEnvelope } from './play/frames.ts';
import { connectHands, type Hands } from './play/hands.ts';
import { answerPrompt, SELF_ANSWERING } from './play/prompts.ts';
import { forgeAvailability, RUN_DIR, startPlayStack, type PlayStack } from './play/harness.ts';
import { checkPlayIsolation, foldStream, type PlaySeatLog } from './play/isolation.ts';
import { FIXTURE_FILE, load, mutations } from './play/fixture.ts';

test.describe.configure({ mode: 'serial' });

const PREFIX = '/cardtable';
/** How long the game may take to put a question to each side. */
const PLAY_BUDGET_MS = 5 * 60_000;
/** Play at least this far, so the check covers draws, casts and a discard, not just the opening. */
const MIN_TURN = 5;
/** Marks the asks the probe raises, so they are never counted as "the game asked". */
const PROBE_TEXT = 'e2e probe';

const forge = forgeAvailability();
const LIVE_TITLE = forge.ok
  ? 'two friends play one Forge match: seats, prompts from both sides, a refresh with a question open, the board agrees with the server, isolation per envelope'
  : `two friends play one Forge match — SKIPPED: ${forge.reason}`;

/* ── reading the captures ────────────────────────────────────────────── */

function inbound(f: Friend): PlayMessage[] {
  return messages(f).filter((m) => m.dir === 'in');
}

function framesIn(f: Friend): Frame[] {
  return inbound(f).flatMap((m) => {
    if (m.kind === 's2c') return [(m.msg as ServerEnvelope).frame];
    if (m.kind === 'ack' && isSnapshot(m.msg)) return m.msg.frames;
    return [];
  });
}

/** Every ask this browser was sent, by callId (a re-send keeps its callId). */
function asksIn(f: Friend): Map<string, Frame> {
  const out = new Map<string, Frame>();
  for (const m of inbound(f)) {
    if (m.kind !== 's2c') continue;
    const frame = (m.msg as ServerEnvelope).frame;
    if (frame.kind === 'ask' && typeof frame.callId === 'string') out.set(frame.callId, frame);
  }
  return out;
}

/** Every reply / abort this browser SENT. */
function answersFrom(f: Friend): { kind: string; callId: string; method?: string; result?: unknown; reason?: string }[] {
  return messages(f)
    .filter((m) => m.dir === 'out' && m.kind === 'c2s')
    .map((m) => (m.msg as { frame: { kind: string; callId: string; method?: string; result?: unknown; reason?: string } }).frame)
    .filter((fr) => fr.kind === 'reply' || fr.kind === 'abort');
}

function isProbe(ask: Frame | undefined): boolean {
  return typeof ask?.message === 'string' && ask.message.startsWith(PROBE_TEXT);
}

/** Replies to asks the GAME raised (not the probe), by method. */
function gameAnswers(f: Friend): { callId: string; method: string }[] {
  const asks = asksIn(f);
  return answersFrom(f)
    .filter((a) => a.kind === 'reply' && !isProbe(asks.get(a.callId)))
    .map((a) => ({ callId: a.callId, method: a.method ?? '?' }));
}

function lastNotify(f: Friend, method: string): Frame | null {
  const all = framesIn(f).filter((fr) => fr.method === method);
  return all[all.length - 1] ?? null;
}

function serverLog(stack: PlayStack): Record<string, unknown>[] {
  return readFileSync(stack.serverLogFile, 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

async function quiet(friends: Friend[], ms: number, budget = 60_000): Promise<void> {
  const deadline = Date.now() + budget;
  let last = friends.map((f) => f.captures.length).join();
  let since = Date.now();
  while (Date.now() - since < ms) {
    if (Date.now() > deadline) throw new Error(`the match never went quiet for ${ms} ms`);
    await new Promise((r) => setTimeout(r, 100));
    const now = friends.map((f) => f.captures.length).join();
    if (now !== last) {
      last = now;
      since = Date.now();
    }
  }
  await Promise.all(friends.flatMap((f) => f.pending));
}

/* ── choosing a legal pair of decks, the way the screen would ────────── */

interface Choice {
  format: string;
  decks: [string, string];
}

async function legalChoice(api: APIRequestContext, origin: string): Promise<Choice> {
  const base = `${origin}${PREFIX}/api/tables`;
  const formats = ((await (await api.get(`${base}/formats`)).json()) as { formats: { id: string }[] }).formats;
  const decks = ((await (await api.get(`${base}/decks`)).json()) as { decks: { id: string; name: string; date: string }[] }).decks;
  // Draw-go decks first: Preordain scries, Squadron Hawk and Stoneforge Mystic
  // search — questions Forge ASKS, which is what this test needs to reach.
  decks.sort((a, b) => Number(/Caw/.test(b.name)) - Number(/Caw/.test(a.name)));
  const legal = async (deck: string, format: string): Promise<boolean> => {
    const res = await api.post(`${base}/check`, { data: { deck: { library: deck }, rules: { kind: 'standard', format } } });
    return res.status() === 200 && ((await res.json()) as { legal: boolean }).legal;
  };
  for (const f of formats) {
    // A deck is dated by the event it was played at; a format is dated by its pool.
    const candidates = [...decks.filter((d) => d.date === f.id), ...decks.filter((d) => d.date !== f.id)];
    const ok: string[] = [];
    for (const d of candidates) {
      if (await legal(d.id, f.id)) ok.push(d.id);
      if (ok.length === 2) return { format: f.id, decks: [ok[0], ok[1]] };
    }
  }
  throw new Error(`no format has two legal library decks (${formats.length} formats, ${decks.length} decks)`);
}

/* ── the checker, biting — no Forge needed ───────────────────────────── */

test('the play isolation check FAILS when one seat is sent the other seat’s hand (committed fixture)', () => {
  const fixture = load(JSON.parse(readFileSync(FIXTURE_FILE, 'utf8')) as Parameters<typeof load>[0]);

  const clean = checkPlayIsolation(fixture.logs);
  console.log(`[play-isolation] real capture: ${JSON.stringify(clean.counts)} → ${clean.ok ? 'pass' : 'FAIL'}`);
  expect(clean.violations).toEqual([]);
  expect(clean.counts.secrets).toBeGreaterThan(0);
  expect(clean.counts.opponentHandCards).toBeGreaterThan(0);

  for (const m of mutations(fixture)) {
    const report = checkPlayIsolation(m.logs);
    console.log(`[play-isolation] ${m.name}: ${report.ok ? 'pass' : 'FAIL'} — ${report.violations.length} violations, first: ${report.violations[0] ?? '-'}`);
    expect(report.ok, `${m.name} must fail the check`).toBe(false);
    expect(report.violations.join('\n')).toMatch(m.expect);
  }
});

/* ── the match ───────────────────────────────────────────────────────── */

test(LIVE_TITLE, async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(12 * 60_000);
  const started = Date.now();

  const stack = await startPlayStack(forge);
  const hands: Hands[] = [];
  const summary: Record<string, unknown> = {};
  let alice: Friend | null = null;
  let bob: Friend | null = null;

  try {
    alice = await openFriend(browser, 'alice');
    bob = await openFriend(browser, 'bob');
    const origin = stack.origin;

    // ── start: alice, from the lobby, through #/play.
    const choice = await legalChoice(alice.context.request, origin);
    summary.choice = choice;
    await alice.page.goto(`${origin}${PREFIX}/`);
    await alice.page.getByTestId('play-constructed').click();
    await alice.page.getByTestId('format').selectOption(choice.format);
    await alice.page.getByTestId('deck-0').selectOption(choice.decks[0]);
    await alice.page.getByTestId('opponent-human').check();
    await alice.page.getByTestId('deck-1').selectOption(choice.decks[1]);
    await expect(alice.page.getByTestId('verdict-0')).toContainText('Legal in');
    await expect(alice.page.getByTestId('verdict-1')).toContainText('Legal in');
    const t0 = Date.now();
    await alice.page.getByTestId('start-match').click();
    await alice.page.waitForURL(/#\/match\/m-[0-9a-f]{12}$/, { timeout: 90_000 });
    summary.startMs = Date.now() - t0;
    const invite = await alice.page.getByTestId('match-invite').inputValue();
    const matchId = /#\/match\/(m-[0-9a-f]{12})$/.exec(invite)?.[1];
    if (matchId === undefined) throw new Error(`no match id in the invite ${invite}`);
    expect(invite).toBe(`${origin}${PREFIX}/#/match/${matchId}`);
    summary.matchId = matchId;

    // ── seat: bob opens the invite link.
    await bob.page.goto(invite);
    await expect(alice.page.getByTestId('live-status')).toHaveText('Seat 1, live.', { timeout: 30_000 });
    await expect(bob.page.getByTestId('live-status')).toHaveText('Seat 2, live.', { timeout: 30_000 });
    await expect(alice.page.locator('[aria-label="Game board"]')).toBeVisible();
    await expect(bob.page.locator('[aria-label="Game board"]')).toBeVisible();

    const firstSnapshot = (f: Friend) => {
      const ack = inbound(f).find((m) => m.kind === 'ack' && isSnapshot(m.msg));
      if (ack === undefined || !isSnapshot(ack.msg)) throw new Error(`${f.name}: no snapshot`);
      return ack.msg;
    };
    const aSnap = firstSnapshot(alice);
    const bSnap = firstSnapshot(bob);
    expect(aSnap.seat).toBe(0);
    expect(bSnap.seat).toBe(1);
    expect(aSnap.playerId).not.toBe(bSnap.playerId);
    const status = (await (await alice.context.request.get(`${origin}${PREFIX}/api/play/matches/${matchId}`)).json()) as {
      status: string;
      seats: { claimedBy: string | null }[];
    };
    expect(status.status).toBe('running');
    expect(status.seats.every((s) => s.claimedBy !== null)).toBe(true);

    // ── the gap: what the product UI alone can do at this point.
    await quiet([alice, bob], 2_000);
    const gap = Object.fromEntries(
      await Promise.all(
        [alice, bob].map(async (f) => {
          const prompt = lastNotify(f, 'showPromptMessage');
          const buttons = lastNotify(f, 'updateButtons');
          return [
            f.name,
            {
              forgeSays: prompt?.message ?? null,
              forgeButtons: buttons === null ? null : { label1: buttons.label1, enable1: buttons.enable1, label2: buttons.label2, enable2: buttons.enable2 },
              openAsks: [...asksIn(f).keys()].filter((id) => !answersFrom(f).some((a) => a.callId === id)).length,
              controlsOnPage: await f.page.locator('[data-testid="match"] .live button, [data-testid="match"] .live input, [data-testid="match"] .live select').count(),
              promptOnPage: await f.page.getByTestId('live-prompt').count(),
              turnOnPage: await f.page.getByTestId('turn').textContent(),
            },
          ];
        }),
      ),
    );
    summary.uiAloneAtStart = gap;
    console.log(`[play] the board alone, at the start: ${JSON.stringify(gap)}`);

    // ── The coin toss, through the BOARD. Not through the scaffolding.
    //
    // This is the assertion whose absence let the suite go green while every
    // production match sat at Turn 0. Forge opens with showPromptMessage +
    // updateButtons, which is not a blocking ask, and the board drew only
    // asks — so `gap` above used to read controlsOnPage 0, promptOnPage 0,
    // turnOnPage "Turn 0", and the spec shrugged and let `hands` press it.
    //
    // Whoever holds the enabled bar must be able to answer it by clicking
    // their own page. If this fails, a human is stuck exactly where the
    // operator was on 2026-09-19.
    const withBar = await Promise.all(
      [alice, bob].map(async (f) => ({ f, n: await f.page.getByTestId('live-buttons').count() })),
    );
    const decider = withBar.find((w) => w.n > 0);
    expect(decider, 'neither board drew Forge\'s button bar — the match cannot be started by a human').toBeTruthy();

    const boardButton = decider!.f.page.getByTestId('live-button-ok');
    await expect(boardButton).toBeEnabled();
    const saysBefore = await decider!.f.page.getByTestId('live-says').textContent();
    await boardButton.click();
    summary.coinTossThroughBoard = { who: decider!.f.name, says: saysBefore };
    console.log(`[play] ${decider!.f.name} answered the opening prompt on their own board: ${JSON.stringify(saysBefore)}`);

    // The click must MOVE THE GAME: Forge deals opening hands once the toss is
    // answered, so a library that never leaves 60 means nothing happened.
    await expect
      .poll(
        async () => {
          const txt = await decider!.f.page.textContent('body');
          const m = /library (\d+)/.exec(txt ?? '');
          return m === null ? 60 : Number(m[1]);
        },
        { timeout: 30_000, message: 'the opening hand was never dealt after the board answered the coin toss' },
      )
      .toBeLessThan(60);

    // ── play: hands click CARDS, which the board still cannot do (a known gap).
    //    Buttons are no longer among them — those go through the board, above.
    for (const f of [alice, bob]) hands.push(await connectHands(origin, f.name, matchId));
    expect(hands.map((h) => h.seat)).toEqual([0, 1]);

    // Until each side has answered a question the GAME asked by clicking its
    // board — not only one the board answers by itself on mount.
    const clicked = (f: Friend) => gameAnswers(f).filter((a) => !SELF_ANSWERING.has(a.method));
    const clicks: { name: string; method: string; callId: string }[] = [];
    const answerBoth = async (): Promise<void> => {
      for (const f of [alice!, bob!]) {
        const done = await answerPrompt(f.page);
        if (done !== null) clicks.push({ name: f.name, ...done });
      }
    };
    const turnOnPage = async (): Promise<number> => Number(/Turn (\d+)/.exec((await alice!.page.getByTestId('turn').textContent()) ?? '')?.[1] ?? 0);
    const deadline = Date.now() + PLAY_BUDGET_MS;
    while (clicked(alice).length === 0 || clicked(bob).length === 0 || (await turnOnPage()) < MIN_TURN) {
      if (Date.now() > deadline) {
        throw new Error(
          `within ${PLAY_BUDGET_MS} ms (turn ${await turnOnPage()}, wanted ${MIN_TURN}), clicked game asks: alice ${clicked(alice).length}, bob ${clicked(bob).length}; ` +
            `all game asks: alice ${JSON.stringify(gameAnswers(alice))}, bob ${JSON.stringify(gameAnswers(bob))}; ` +
            `turn ${await alice.page.getByTestId('turn').textContent()}; cast: ${JSON.stringify(hands.map((h) => h.cast))}; ` +
            `hands: ${hands.map((h) => h.log.slice(-6).join(' | ')).join(' || ')}`,
        );
      }
      if ((await alice.page.locator('.board__over').count()) > 0) throw new Error('the game ended before both sides were asked');
      await answerBoth();
      await new Promise((r) => setTimeout(r, 250));
    }
    for (const h of hands) h.pause();
    // Anything asked on the way to the pause is still the board's to answer.
    for (let i = 0; i < 20; i++) {
      await answerBoth();
      await new Promise((r) => setTimeout(r, 250));
    }
    await quiet([alice, bob], 2_000);
    summary.turnReached = await alice.page.getByTestId('turn').textContent();
    summary.gameAnswers = { alice: gameAnswers(alice), bob: gameAnswers(bob) };
    summary.clicks = clicks;
    summary.cast = hands.map((h) => h.cast);
    summary.handsActs = hands.map((h) => h.acts);

    // Every game ask either browser was sent was answered by it, nothing was
    // aborted, and the game moved on after each answer.
    for (const f of [alice, bob]) {
      const ms = messages(f);
      for (const a of gameAnswers(f)) {
        const sentAt = ms.findIndex((m) => m.dir === 'out' && m.kind === 'c2s' && (m.msg as { frame: { callId?: string } }).frame.callId === a.callId);
        const after = ms.slice(sentAt + 1).filter((m) => m.dir === 'in' && m.kind === 's2c').length;
        expect(after, `${f.name}: frames after answering ${a.method} ${a.callId}`).toBeGreaterThan(0);
      }
      const sent = answersFrom(f);
      expect(sent.filter((a) => a.kind === 'abort'), `${f.name}: the board aborted no ask`).toEqual([]);
      const asked = [...asksIn(f).keys()];
      expect(asked.filter((id) => !sent.some((a) => a.callId === id)), `${f.name}: every ask answered`).toEqual([]);
    }

    // ── the probe, to bob: answered AGAINST Forge's default.
    const probe = (seat: number, message: string) =>
      alice!.context.request
        .post(`${origin}${PREFIX}/api/play/matches/${matchId}/probe`, { data: { seat, message }, timeout: 120_000 })
        .then(async (r) => ({ status: r.status(), body: (await r.json()) as { answer?: boolean; ms?: number; error?: string } }));

    const bobProbe = probe(1, `${PROBE_TEXT}: bob, press the button that is not the default`);
    const bobDialog = bob.page.getByTestId('confirm-dialog');
    await expect(bobDialog).toContainText(`${PROBE_TEXT}: bob`);
    expect(await bobDialog.locator('[data-answer="no"]').getAttribute('data-default')).toBe('true');
    await bobDialog.locator('[data-answer="yes"]').click();
    const bobAnswer = await bobProbe;
    expect(bobAnswer).toMatchObject({ status: 200, body: { answer: true } });
    summary.bobProbe = bobAnswer.body;

    // ── the refresh, with alice's probe OPEN.
    await hands[0].close();
    const aliceProbe = probe(0, `${PROBE_TEXT}: alice, across a refresh`);
    const aliceDialog = alice.page.getByTestId('confirm-dialog');
    await expect(aliceDialog).toContainText(`${PROBE_TEXT}: alice`);
    const callIdBefore = await aliceDialog.getAttribute('data-call-id');
    const boardBefore = await alice.page.locator('[aria-label="Game board"]').innerText();
    const mark = alice.captures.length;
    const logMark = serverLog(stack).length;
    const reloadAt = Date.now();
    await alice.page.reload();
    await expect(alice.page.getByTestId('live-status')).toHaveText('Seat 1, live.', { timeout: 30_000 });
    await expect(aliceDialog).toContainText(`${PROBE_TEXT}: alice`);
    const callIdAfter = await aliceDialog.getAttribute('data-call-id');
    expect(callIdAfter).toBe(callIdBefore);
    const boardAfter = await alice.page.locator('[aria-label="Game board"]').innerText();
    expect(boardAfter).toBe(boardBefore);
    const rejoin = playMessagesSince(alice, mark).find((m) => m.kind === 'ack' && isSnapshot(m.msg));
    if (rejoin === undefined || !isSnapshot(rejoin.msg)) throw new Error('alice got no snapshot after the refresh');
    expect(rejoin.msg.seat).toBe(0);
    expect(rejoin.msg.playerId).toBe(aSnap.playerId);
    const clickAt = Date.now();
    await aliceDialog.locator('[data-answer="yes"]').click();
    const aliceAnswer = await aliceProbe;
    expect(aliceAnswer).toMatchObject({ status: 200, body: { answer: true } });
    const across = serverLog(stack).slice(logMark);
    const left = across.filter((l) => l.evt === 'left' && l.matchId === matchId && l.seat === 0);
    const rejoined = across.filter((l) => l.evt === 'joined' && l.matchId === matchId && l.seat === 0);
    const aborted = across.filter((l) => String(l.evt).includes('abort'));
    const departing = across.filter((l) => l.evt === 'seat-departing' && l.matchId === matchId && l.seat === 0);
    const returned = across.filter((l) => l.evt === 'seat-returned' && l.matchId === matchId && l.seat === 0);
    summary.refresh = {
      reloadToClickMs: clickAt - reloadAt,
      probe: aliceAnswer.body,
      callId: callIdAfter,
      left: left.map((l) => ({ reason: l.reason, stillHere: l.stillHere })),
      rejoined: rejoined.map((l) => ({ fresh: l.fresh })),
      departing: departing.map((l) => ({ graceMs: l.graceMs, openAsks: l.openAsks })),
      returned: returned.map((l) => ({ openAsks: l.openAsks })),
      abortsLogged: aborted,
    };
    // The reload really left the seat with nobody, and the grace held it.
    expect(left.some((l) => l.stillHere === false)).toBe(true);
    expect(rejoined.length).toBeGreaterThanOrEqual(1);
    expect(rejoined.every((l) => l.fresh === false)).toBe(true);
    expect(aborted).toEqual([]);
    // The server armed the grace with the question open, and disarmed it on the rejoin.
    expect(departing.map((l) => l.openAsks)).toEqual([1]);
    expect(returned.map((l) => l.openAsks)).toEqual([1]);
    // Forge's own call was parked across the whole reload: it was opened before
    // the reload began, so it measured at least reload → click.
    expect(aliceAnswer.body.ms ?? 0).toBeGreaterThanOrEqual(clickAt - reloadAt - 50);

    // ── the board agrees with the server.
    await quiet([alice, bob], 2_000);
    const agreement: Record<string, unknown> = {};
    for (const [f, seat, playerId] of [
      [alice, 0, aSnap.playerId],
      [bob, 1, bSnap.playerId],
    ] as const) {
      const res = await alice.context.request.get(`${origin}${PREFIX}/api/play/matches/${matchId}/seats/${seat}/state`);
      expect(res.status()).toBe(200);
      const server = (await res.json()) as { cursor: { epoch: string; seq: number }; objects: Record<string, WireObject> };
      const folded = foldStream(messages(f));
      expect(folded.cursor, `${f.name}: same cursor as the server`).toEqual(server.cursor);
      expect(Object.fromEntries(folded.final), `${f.name}: same objects as the server`).toEqual(server.objects);

      const view = toBoardView(new Map(Object.entries(server.objects)), 0, { viewerPlayerId: playerId });
      const drawn = await f.page.evaluate(() => {
        const text = (el: Element | null) => el?.textContent ?? null;
        const players = Array.from(document.querySelectorAll('[data-testid="player"]')).map((p) => ({
          id: Number(p.getAttribute('data-player-id')),
          life: text(p.querySelector('[data-testid="life"]')),
          hand: text(p.querySelector('[data-testid="hand-count"]')),
          library: text(p.querySelector('[data-testid="library-count"]')),
          zones: Object.fromEntries(
            ['battlefield', 'graveyard', 'exile', 'hand'].map((z) => [
              z,
              Array.from(p.querySelectorAll(`[data-zone="${z}"] [data-board-card]`)).map((c) => Number(c.getAttribute('data-board-card'))),
            ]),
          ),
        }));
        return {
          turn: text(document.querySelector('[data-testid="turn"]')),
          phase: document.querySelector('[data-testid="phase"]')?.getAttribute('data-phase') ?? null,
          players: players.sort((a, b) => a.id - b.id),
        };
      });
      const expected = {
        turn: `Turn ${view.turn}`,
        phase: view.phase ?? '',
        players: view.players
          .map((p) => ({
            id: p.id,
            life: String(p.life),
            hand: `hand ${p.handCount}`,
            library: `library ${p.libraryCount}`,
            zones: {
              battlefield: p.battlefield.map((c) => c.id),
              graveyard: p.graveyard.map((c) => c.id),
              exile: p.exile.map((c) => c.id),
              hand: (p.hand ?? []).map((c) => c.id),
            },
          }))
          .sort((a, b) => a.id - b.id),
      };
      expect(drawn, `${f.name}: the page draws the server's board`).toEqual(expected);
      agreement[f.name] = { cursor: server.cursor, objects: Object.keys(server.objects).length, turn: expected.turn, phase: expected.phase };
    }
    summary.agreement = agreement;

    // ── isolation, over every envelope and snapshot each browser received.
    await Promise.all([alice, bob].flatMap((f) => f.pending));
    for (const f of [alice, bob]) expect(f.captureErrors, `${f.name}: every polling body was readable`).toEqual([]);
    const logs: PlaySeatLog[] = [
      { name: 'alice', seat: 0, messages: messages(alice) },
      { name: 'bob', seat: 1, messages: messages(bob) },
    ];
    const report = checkPlayIsolation(logs);
    summary.isolation = report;
    summary.perSeat = Object.fromEntries(
      [alice, bob].map((f) => {
        const ms = messages(f);
        return [
          f.name,
          {
            s2c: ms.filter((m) => m.dir === 'in' && m.kind === 's2c').length,
            snapshots: ms.filter((m) => m.dir === 'in' && m.kind === 'ack' && isSnapshot(m.msg)).length,
            viaPolling: ms.filter((m) => m.dir === 'in' && m.via === 'polling').length,
            joins: ms.filter((m) => m.dir === 'out' && m.kind === 'join').length,
            resyncs: ms.filter((m) => m.dir === 'out' && m.kind === 'resync').length,
            asks: [...asksIn(f).values()].map((a) => a.method),
            replies: answersFrom(f).filter((a) => a.kind === 'reply').length,
          },
        ];
      }),
    );
    const offHosts = [...alice.blocked, ...bob.blocked].filter((u) => !['cdn.hadoku.me', 'cards.scryfall.io'].includes(new URL(u).hostname));
    summary.blockedArtRequests = alice.blocked.length + bob.blocked.length;
    summary.durationMs = Date.now() - started;

    expect(report.violations).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.counts.snapshots).toBeGreaterThanOrEqual(3); // two joins and a rejoin
    expect(report.counts.secrets).toBeGreaterThan(0);
    expect(report.counts.opponentHandCards).toBeGreaterThan(0);
    expect(report.counts.probes).toBeGreaterThan(0);
    expect(offHosts).toEqual([]);
    const refused = serverLog(stack).filter((l) => l.evt === 'c2s-refused' || l.evt === 'c2s-malformed' || l.evt === 'c2s-not-joined');
    summary.serverRefused = refused;
    expect(refused).toEqual([]);
    // And Forge's side of every answer: the server handed each reply to its ask.
    const handed = serverLog(stack).filter((l) => l.evt === 'ask-answered' && l.matchId === matchId);
    for (const [f, seat] of [
      [alice, 0],
      [bob, 1],
    ] as const) {
      const replies = answersFrom(f).filter((x) => x.kind === 'reply').map((x) => x.callId);
      const got = handed.filter((l) => l.seat === seat).map((l) => l.callId);
      expect(got, `${f.name}: the server handed every reply to Forge`).toEqual(replies);
    }
  } finally {
    for (const h of hands) await h.close();
    for (const f of [alice, bob]) {
      if (f === null) continue;
      await Promise.all(f.pending);
      writeFileSync(resolve(RUN_DIR, `play-${f.name}.captures.json`), JSON.stringify(f.captures));
      writeFileSync(resolve(RUN_DIR, `play-${f.name}.hands.log`), (hands.find((h) => h.seat === (f.name === 'alice' ? 0 : 1))?.log ?? []).join('\n'));
      await f.context.close();
    }
    await stack.stop();
    summary.jvmsLeft = await jvmsStillAlive(stack);
    writeFileSync(resolve(RUN_DIR, 'play-summary.json'), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary, null, 2));
  }
  expect(summary.jvmsLeft, 'no Forge JVM outlives the server').toEqual([]);
});

function playMessagesSince(f: Friend, mark: number): PlayMessage[] {
  return messages({ ...f, captures: f.captures.slice(mark) });
}

/** Bridge JVMs the server spawned that are still running after it stopped. SIGKILLed, and reported. */
async function jvmsStillAlive(stack: PlayStack): Promise<number[]> {
  const pids = serverLog(stack)
    .filter((l) => l.evt === 'jvm-spawned' && typeof l.pid === 'number')
    .map((l) => l.pid as number);
  const running = (pid: number): boolean => {
    try {
      return !readFileSync(`/proc/${pid}/stat`, 'utf8').includes(') Z ');
    } catch {
      return false; // no /proc entry: it has exited
    }
  };
  // A JVM whose stdin closes stops on its own; give it the bridge's stop grace.
  const deadline = Date.now() + 10_000;
  while (pids.some(running) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
  const alive = pids.filter(running);
  for (const pid of alive) process.kill(pid, 'SIGKILL');
  return alive;
}
