/**
 * Two humans, one Forge match, end to end.
 *
 * The play analogue of `draft.spec.ts`. Two independent browser contexts —
 * separate cookie jars, identities and sockets — start a constructed match
 * from the product UI (room list → `#/room/<id>` → `#/match/<id>`) and play a
 * real Forge game against the REAL built server, with a real Forge in a child
 * JVM. Every byte of each browser's match socket is captured
 * (`play/browser.ts`) and checked by `play/isolation.ts`.
 *
 * ## The start, rewritten for Wave 13
 *
 * It used to be: alice opens `#/play`, picks a format and BOTH decks, presses
 * Start, and sends bob the invite link. The operator rejected that shape in
 * those words — *"this is not how any of this should work"* — and lanes A–C
 * replaced it. `play-constructed`, `deck-0`, `deck-1` and `opponent-human` are
 * gone from the product, so the old opening of this spec addressed a screen
 * that no longer exists.
 *
 * What it drives now is the product:
 *
 *   1. alice opens `/`, sees the room list, and creates a `constructed-1v1`
 *      room with a name and no password;
 *   2. bob opens `/` and sees ALICE's room in his own list — the operator's
 *      *"every friend sees every room"* — and enters it;
 *   3. each of them loads their OWN deck and readies up. Neither page has a
 *      control that names the other player's deck, and the spec asserts that
 *      the removed ones are absent rather than merely unused;
 *   4. the server starts the match once both are ready, and BOTH browsers land
 *      on `#/match/<id>` — including bob, who pressed nothing after Ready.
 *
 * ## Seat 1 plays alice's deck and seat 2 plays bob's
 *
 * That is the whole point of the inversion, so it is proved three ways, from
 * three different authorities:
 *
 *   - the ROOM says so before the match exists: `GET /api/tables/rooms/:id`
 *     read from each browser's own context names a different `you` seat, and
 *     a different `deckName`, for each of them;
 *   - FORGE says so after it opens the game: `GET /api/play/matches/:id`
 *     reports `seats[i].deck`, which is `Deck.getName()` of the deck Forge
 *     actually loaded into that seat (`play/bridge/PlayBridge.java`), not our
 *     own bookkeeping read back;
 *   - the CARDS say so: each seat's opening hand, folded from the server's own
 *     projection of that seat, holds only cards from the deck that player
 *     loaded, and none of the cards that are in the other deck alone.
 *
 * The two decks are chosen so that each holds a card the other does not, and
 * the run fails rather than picks a pair that could not tell the two apart.
 *
 * **The card check is corroboration, not the proof.** Two decks of the same
 * archetype overlap heavily, so a seven-card opening hand can land entirely
 * inside the intersection — `onlyThisDeckCouldDeal` in the summary says, per
 * run, whether it actually discriminated. It is asserted as a SUBSET (which
 * never flakes and does bite on most deals) and reported as evidence; the claim
 * that does not depend on the shuffle is Forge's own seat→deck mapping.
 *
 * ## The removed shape is proved closed, through the real edge
 *
 * `POST /api/play/matches` with `{ opponent: 'human', seats: [a, b] }` — one
 * person naming both people's decks — is refused 422 by the deployed bundle
 * behind the edge, not only by a unit test. The `{ opponent: 'ai', seats }`
 * arm is deliberately NOT exercised here: it would boot a second JVM for a
 * claim `apps/server/src/http/tables.test.ts` already makes.
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
 * - **A locked room needs its password, through the UI.** bob sees the room in
 *   his list, is asked for the password when he tries to enter, is refused with
 *   a wrong one (and is still on the room list, and still cannot read the
 *   room's table), and gets in with the right one.
 * - **Seats.** Both players reach the match from the room they were both in.
 *   Seat 1 and seat 2, distinct players, each told so by its own snapshot, each
 *   playing the deck they loaded themselves.
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

import { mkdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test, type APIRequestContext, type Locator } from '@playwright/test';

import { toBoardView } from '../apps/ui/src/play/adapter.ts';
import type { WireObject } from '../apps/ui/src/play/wire.ts';
import { messages, openFriend, type Friend } from './play/browser.ts';
import { isSnapshot, type Frame, type PlayMessage, type ServerEnvelope } from './play/frames.ts';
import { connectHands, type Hands } from './play/hands.ts';
import { answerPrompt, SELF_ANSWERING } from './play/prompts.ts';
import {
  forgeAvailability,
  JVM_RECORD_FILE,
  ORPHAN_MAX_MS,
  readJvmRecord,
  RUN_DIR,
  startPlayStack,
  type PlayStack,
} from './play/harness.ts';
import { checkPlayIsolation, foldStream, type PlaySeatLog } from './play/isolation.ts';
import { FIXTURE_FILE, load, mutations } from './play/fixture.ts';

test.describe.configure({ mode: 'serial' });

const PREFIX = '/cardtable';
/** How long the game may take to put a question to each side. */
const PLAY_BUDGET_MS = 5 * 60_000;
/** How long §B item 5 has to find a resolution nobody had to press a button for. */
const FLOW_BUDGET_MS = 2 * 60_000;
/** Play at least this far, so the check covers draws, casts and a discard, not just the opening. */
const MIN_TURN = 5;
/** Marks the asks the probe raises, so they are never counted as "the game asked". */
const PROBE_TEXT = 'e2e probe';

const forge = forgeAvailability();
const LIVE_TITLE = forge.ok
  ? 'two friends play one Forge match: seats, prompts from both sides, a refresh with a question open, the board agrees with the server, isolation per envelope'
  : `two friends play one Forge match — SKIPPED: ${forge.reason}`;

/* ── reading the captures ────────────────────────────────────────────── */

/*
 * `CARDTABLE_E2E_PLAY_SHOTS=<dir>` saves one screenshot per named moment, the
 * first time it happens. Off unless the directory is set, and nothing in the run
 * depends on it — it is how a person sees the question column that wave 26 §B.1
 * gave Forge's questions, including a real mana payment in it.
 *
 * `*.png` is refused by this repo's `.gitignore` outside `docs/`, so the
 * directory belongs outside the tree.
 */
const SHOTS = process.env.CARDTABLE_E2E_PLAY_SHOTS ?? '';
const shotsTaken = new Set<string>();
async function shotOnce(f: Friend, moment: string): Promise<void> {
  if (SHOTS === '' || shotsTaken.has(moment)) return;
  shotsTaken.add(moment);
  mkdirSync(SHOTS, { recursive: true });
  await f.page.screenshot({ path: resolve(SHOTS, `${moment}-${f.name}.png`) });
  console.log(`[play] shot ${moment} (${f.name})`);
}

/**
 * A payment window is open on this page: the one moment worth a picture.
 *
 * It is a poll and it will usually see nothing, and that is wave 26 §E rather
 * than a bug here: `unambiguousPayment: 'forgeAuto'` means the SERVER presses
 * Forge's Auto for a cost with one way to pay it, so the window a player would
 * have answered is never drawn (this spec's own server log records `auto-paid`
 * for each such cost). What still reaches a person — a cost with a choice, or a
 * seat running strict or in full control — is what this catches.
 */
async function shootPayment(f: Friend): Promise<void> {
  if (SHOTS === '' || shotsTaken.has('payment')) return;
  if ((await f.page.getByTestId('live-payment-host').count()) > 0) await shotOnce(f, 'payment');
}

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

/**
 * Every ask this browser has been sent and has not replied to or aborted.
 *
 * The probe reaches a seat on that seat's ONE client thread
 * (`PlayBridge.SeatGui.ui` — `BridgeGui`'s whole reason to exist), so an ask
 * already open on that seat holds the probe behind it and the probe's own text
 * never reaches the page. That is the first thing to know about a probe that did
 * not arrive, and it is a property of the moment the probe was raised, so it is
 * recorded then rather than reconstructed afterwards. See
 * `docs/planning/wave27-probe-race.md`.
 */
function openAsks(f: Friend): { callId: string; method: string; message: string }[] {
  const answered = new Set(answersFrom(f).map((a) => a.callId));
  return [...asksIn(f).entries()]
    .filter(([callId]) => !answered.has(callId))
    .map(([callId, frame]) => ({
      callId,
      method: String(frame.method ?? '?'),
      message: String(frame.message ?? '').slice(0, 80),
    }));
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

/* ── dragging on the board ───────────────────────────────────────────── */

/** How long the drag phase has to get a land and a spell down. */
const DRAG_BUDGET_MS = 3 * 60_000;

/** Every `selectCard` this browser SENT, oldest first. */
function cardActsFrom(f: Friend): number[] {
  return messages(f)
    .filter((m) => m.dir === 'out' && m.kind === 'c2s')
    .map((m) => (m.msg as { frame: { kind: string; method?: string; card?: { id: number } } }).frame)
    .filter((fr) => fr.kind === 'act' && fr.method === 'selectCard')
    .map((fr) => fr.card?.id ?? -1);
}

/** Every button press this browser SENT, with when — the clicks §B item 5 says nobody should need. */
function buttonPresses(ms: readonly PlayMessage[]): { t: number; method: string }[] {
  return ms
    .filter((m) => m.dir === 'out' && m.kind === 'c2s')
    .map((m) => ({ t: m.t, frame: (m.msg as { frame: { kind: string; method?: string } }).frame }))
    .filter((x) => x.frame.kind === 'act' && (x.frame.method === 'selectButtonOk' || x.frame.method === 'selectButtonCancel'))
    .map((x) => ({ t: x.t, method: x.frame.method ?? '?' }));
}

/**
 * A card this seat may click right now, with its own type line.
 *
 * `[data-selectable]` is `Board`'s rendering of what Forge offered, so this
 * only ever finds cards the rules engine named — which is the point of §B.
 */
async function offeredIn(f: Friend, zone: 'hand' | 'battlefield'): Promise<{ id: number; type: string; name: string }[]> {
  return f.page.evaluate((z) => {
    const sel = `[data-zone="${z}"][data-owner="you"] [data-board-card][data-selectable]`;
    return Array.from(document.querySelectorAll(sel)).map((el) => ({
      id: Number(el.getAttribute('data-board-card')),
      type: el.querySelector('.card__type')?.textContent ?? '',
      name: el.querySelector('.card__name')?.textContent ?? '',
    }));
  }, zone);
}

/** Ids in one order both sides can be read in. See the battlefield note in "the board agrees with the server". */
const byId = (ids: readonly number[]): number[] => ids.slice().sort((a, b) => a - b);

/**
 * Click an offered card when a CARD is the only thing Forge will take from this
 * seat — and do nothing at all otherwise.
 *
 * ## The wedge this exists for
 *
 * `chooseCardsToDiscardToMaximumHandSize`
 * (`forge/…/forge/player/PlayerControllerHuman.java:1722-1747`) builds an
 * anonymous `InputSelectCardsFromList`, min 1 max 1, with
 * `setCancelAllowed(false)`. `InputSelectManyBase.updateButtons`
 * (`:98`) keeps OK DISABLED until `hasEnoughTargets()`, and cancel is refused
 * outright — so Forge publishes a seat state in which **both buttons are dead
 * and the only legal act in the world is a click on one of the named cards**,
 * then parks its game thread in `showAndWait()`. Both seats stop.
 *
 * Measured, from this spec's own captures (2026-09-26 run, seat 1):
 * `setSelectables` seq 244 with 8 hand cards and `min: 1, max: 1`, then
 * `showPromptMessage` seq 246 "Cleanup Phase\nSelect 1 card(s) to discard…",
 * then `updateButtons` seq 247 with `enable1: false, enable2: false` — and 118
 * seconds in which the seat received NOTHING. The board had drawn the offer the
 * whole time (`data-selectable`, `Board.tsx:392`, and a selectable card's face
 * IS a button that sends `selectCard`, `:399-404`). Nothing clicked it: the
 * flow loop read only alice's hand, and both seats were otherwise driven by
 * `pressOk`, which asks for `:enabled` and finds nothing. The budget then
 * expired and the run failed at turn 4 of a wanted 5.
 *
 * ## What it keys on, and why "no pressable button" was NOT enough
 *
 * The trigger is **Forge's own words for this one input**, and that is a
 * correction, not a belt. The first version fired on the STATE — no enabled OK,
 * no enabled Cancel, something offered in hand — and that state is reachable in
 * the middle of an ordinary cast. So in the drag section it answered, with a
 * CLICK, the very lands and spells that section exists to play by DRAGGING: a
 * card consumed by `selectCard` is a card the drag never gets to drop, so
 * `wantLand()`/`wantSpell()` could never be satisfied and the loop burned its
 * whole budget while the game raced on. Measured on the manager's gate run:
 * turn **104**, 51 `selectCard` acts per seat, every `forcedCards` entry
 * `"where":"drag"` and among them a Squadron Hawk and a Sword of Feast and
 * Famine — the drag section's own quarry. The opposite failure to the wedge,
 * from the same helper.
 *
 * `FORCED_DISCARD` is therefore pinned to the message
 * `chooseCardsToDiscardToMaximumHandSize` sets at
 * `PlayerControllerHuman.java:1744-1745`, which is
 * `lblSelectCardsToDiscardHandDownMaximum` —
 * *"Select {0} card(s) to discard to bring your hand down to the maximum of {1}
 * cards."* — at `forge-gui/res/languages/en-US.properties:1574`. One string,
 * one call site, vendored and pinned. `live-says` renders `match.prompt`
 * (`LiveBoard.tsx:674`), which is the CURRENT `showPromptMessage` and not the
 * says feed, so this cannot match on something stale. At priority the prompt is
 * `Priority: …`; during payment it is `Pay Mana Cost`; neither can match, so the
 * cast hunt and the drag section are now untouchable from here.
 *
 * ## Why this is still not a loosened test
 *
 * It presses no button, answers no ask and invents no affordance: it clicks a
 * card the BOARD already offered, which is a card Forge itself named, in the one
 * published state where Forge will take nothing else. The button check stays as
 * the second condition — if either button is live the seat is not forced, and
 * this must not pre-empt it.
 *
 * Returns the card it clicked once the `selectCard` has crossed, else null.
 */
const FORCED_DISCARD = /to discard to bring your hand down to the maximum/;

async function clickForcedCard(f: Friend): Promise<{ id: number; name: string } | null> {
  const says = (await f.page.getByTestId('live-says').textContent()) ?? '';
  if (!FORCED_DISCARD.test(says)) return null;
  const pressable = await f.page.locator('[data-testid="live-button-ok"]:enabled, [data-testid="live-button-cancel"]:enabled').count();
  if (pressable > 0) return null;
  const offered = await offeredIn(f, 'hand');
  const pick = offered[0];
  if (pick === undefined) return null;
  const before = cardActsFrom(f).length;
  await f.page
    .locator(`[data-zone="hand"][data-owner="you"] [data-board-card="${pick.id}"] button`)
    .click({ timeout: 2_000 })
    .catch(() => {});
  // The offer can be replaced under the click, exactly as a drag's can; a click
  // that sent nothing is a normal outcome and the caller simply comes round again.
  for (let i = 0; i < 12; i++) {
    if (cardActsFrom(f).length > before) return { id: pick.id, name: pick.name };
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

/**
 * Drag a card onto this seat's own battlefield, with a real mouse.
 *
 * Chromium's input domain turns these into genuine `pointerdown` /
 * `pointermove` / `pointerup`, which is what `LiveBoard`'s gesture listens
 * for. The move is stepped so it passes the gesture's slop (`DRAG_SLOP_PX`)
 * rather than teleporting, exactly as a hand would.
 */
async function dragToBattlefield(f: Friend, cardId: number): Promise<void> {
  const card = f.page.locator(`[data-board-card="${cardId}"]`);
  const drop = f.page.locator('[data-zone="battlefield"][data-owner="you"]');
  const from = await card.boundingBox();
  const to = await drop.boundingBox();
  if (from === null || to === null) throw new Error(`${f.name}: no box for card ${cardId} or for their battlefield`);
  await f.page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await f.page.mouse.down();
  await f.page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
  await f.page.mouse.up();
}

/**
 * Did the drag's `selectCard` actually cross? False is a normal outcome now:
 * with the auto-pass shortcuts on, the server replaces the input under a
 * gesture in flight — an ask opens, a stop is passed — and the client then
 * CORRECTLY sends nothing. The caller re-reads what is offered and drags
 * again; only the budget, not a single attempt, is fatal.
 *
 * While waiting, anything Forge asked is answered by the board, because an
 * ask that opened under the gesture is the usual reason nothing crossed.
 */
async function dragLanded(f: Friend, before: number, cardId: number, name: string, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    await answerPrompt(f.page);
    const acts = cardActsFrom(f).slice(before);
    if (acts.length > 0) {
      expect(acts.every((a) => a === cardId), `${f.name}: every act the drag of ${name} sent was that card`).toBe(true);
      return true;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
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

/** One library deck a player can load, with the card names it is made of. */
interface DeckPick {
  id: string;
  /** The name `GET /api/tables/decks` gives it. Not necessarily the `.dck`'s own. */
  name: string;
  /** Every card name in the list, normalised by `cardKey`. */
  cards: Set<string>;
}

interface Choice {
  format: string;
  decks: [DeckPick, DeckPick];
  /** Cards the first deck holds and the second does not, and the other way round. */
  onlyFirst: string[];
  onlySecond: string[];
}

interface DeckLine {
  count: number;
  name: string;
}

/**
 * A card name as both sides spell it.
 *
 * Forge's view names a double-faced card by its FRONT face (`Delver of
 * Secrets`) while other sources write both (`Delver of Secrets // Insectile
 * Aberration`), and neither side is wrong — so the comparison is made on the
 * front face, lower-cased. This is the same front-face rule the cube resolver
 * needed (`packages/carddata`), for the same reason.
 */
function cardKey(name: string): string {
  return name.split('//')[0].trim().toLowerCase();
}

/**
 * A format and two decks that are legal in it AND tellable apart.
 *
 * "Tellable apart" is load-bearing, not tidiness: the opening-hand check below
 * proves each player is dealt their own deck, and it can only prove that if
 * each deck holds a card the other does not. A pair that fails the test is
 * skipped rather than used, and a run with no such pair FAILS — a check that
 * could not have distinguished the two decks must not report that it did.
 */
async function legalChoice(api: APIRequestContext, origin: string): Promise<Choice> {
  const base = `${origin}${PREFIX}/api/tables`;
  const formats = ((await (await api.get(`${base}/formats`)).json()) as { formats: { id: string }[] }).formats;
  const decks = (
    (await (await api.get(`${base}/decks`)).json()) as {
      decks: { id: string; name: string; date: string; main: DeckLine[]; sideboard: DeckLine[] }[];
    }
  ).decks;
  // Draw-go decks first: Preordain scries, Squadron Hawk and Stoneforge Mystic
  // search — questions Forge ASKS, which is what this test needs to reach.
  decks.sort((a, b) => Number(/Caw/.test(b.name)) - Number(/Caw/.test(a.name)));
  const legal = async (deck: string, format: string): Promise<boolean> => {
    const res = await api.post(`${base}/check`, { data: { deck: { library: deck }, rules: { kind: 'standard', format } } });
    return res.status() === 200 && ((await res.json()) as { legal: boolean }).legal;
  };
  const pickOf = (d: (typeof decks)[number]): DeckPick => ({
    id: d.id,
    name: d.name,
    cards: new Set([...d.main, ...d.sideboard].map((l) => cardKey(l.name))),
  });
  for (const f of formats) {
    // A deck is dated by the event it was played at; a format is dated by its pool.
    const candidates = [...decks.filter((d) => d.date === f.id), ...decks.filter((d) => d.date !== f.id)];
    let first: DeckPick | null = null;
    for (const d of candidates) {
      if (!(await legal(d.id, f.id))) continue;
      const pick = pickOf(d);
      if (first === null) {
        first = pick;
        continue;
      }
      const held = first;
      const onlyFirst = [...held.cards].filter((c) => !pick.cards.has(c));
      const onlySecond = [...pick.cards].filter((c) => !held.cards.has(c));
      if (onlyFirst.length === 0 || onlySecond.length === 0) continue;
      return { format: f.id, decks: [held, pick], onlyFirst, onlySecond };
    }
  }
  throw new Error(
    `no format has two legal library decks that hold different cards (${formats.length} formats, ${decks.length} decks)`,
  );
}

/**
 * The card names in this seat's own hand, as the SERVER holds them.
 *
 * Read through the probe route and folded by the UI's own adapter, so it is
 * the hand the board would draw, not a second reading of the wire.
 */
async function ownHand(
  api: APIRequestContext,
  origin: string,
  matchId: string,
  seat: number,
  playerId: number,
): Promise<string[]> {
  const res = await api.get(`${origin}${PREFIX}/api/play/matches/${matchId}/seats/${seat}/state`);
  expect(res.status(), `seat ${seat} state`).toBe(200);
  const { objects } = (await res.json()) as { objects: Record<string, WireObject> };
  const view = toBoardView(new Map(Object.entries(objects)), 0, { viewerPlayerId: playerId });
  const me = view.players.find((p) => p.id === playerId);
  if (me === undefined) throw new Error(`seat ${seat}: the server's own state names no player ${playerId}`);
  if (me.hand === null) throw new Error(`seat ${seat}: the server's own state hid this seat's hand from itself`);
  return me.hand.map((c) => cardKey(c.card.name));
}

/* ── what may legitimately leave 127.0.0.1 ───────────────────────────── */

/**
 * The off-origin requests this page is ALLOWED to make: card art, and nothing
 * else. Everything else that tries to leave `127.0.0.1` is a failure
 * (`play/browser.ts` aborts them all either way; this is what decides whether
 * that is news). `cdn.hadoku.me` and `cards.scryfall.io` are D15 and D18 — the
 * art is a lookup, the bytes are not ours, and they never come from our origin.
 *
 * **This list does not grow to accommodate a page that talks to production.**
 * A bare `hadoku.me` here would have masked exactly that, and it nearly did:
 * `RoomShell` used to hardcode `https://hadoku.me/watchparty` as watchparty's
 * origin and `@wolffm/themes` fetched its prefs from there, so both specs saw
 * four off-host calls. The answer was to fix the PAGE — `e08bb68` derives the
 * chrome's origin from the one that served it, and `../prefsLocal.ts` keeps the
 * prefs client local, which `play/browser.ts` already applies to every context
 * this spec opens. A widened allowlist would have left the real defect in the
 * product and called the test green.
 */
function isExpectedOffOrigin(url: string): boolean {
  const { hostname } = new URL(url);
  return hostname === 'cdn.hadoku.me' || hostname === 'cards.scryfall.io';
}

/* ── driving the product's room screens ──────────────────────────────── */

/** `#/room/<id>` ids, as `lobby.ts` mints them: `r-` and 12 hex characters. */
const ROOM_URL = /#\/room\/(r-[0-9a-f]{12})$/;

/**
 * Create a room from the front page's form, the way a person does, and return
 * the id the browser was navigated to. A password makes a locked room.
 */
async function createRoom(f: Friend, name: string, password?: string): Promise<string> {
  await f.page.getByTestId('room-create-name').fill(name);
  await f.page.getByTestId('room-create-type').selectOption('constructed-1v1');
  if (password !== undefined) await f.page.getByTestId('room-create-password').fill(password);
  await f.page.getByTestId('room-create-submit').click();
  await f.page.waitForURL(ROOM_URL, { timeout: 30_000 });
  const id = ROOM_URL.exec(f.page.url())?.[1];
  if (id === undefined) throw new Error(`${f.name}: created a room but landed on ${f.page.url()}`);
  return id;
}

/** One row of this browser's room list, found by the id the row carries. */
function roomRow(f: Friend, roomId: string): Locator {
  return f.page.locator(`[data-testid="room-row"][data-room-id="${roomId}"]`);
}

/**
 * Set the table's pool. The LEADER's control, and there is one of it.
 *
 * Wave 25: the pool is the room's, not the seat's — the leader moves it with a
 * `PATCH /api/rooms/:id` and everybody else reads it. So the wait is on the
 * select reading back what was asked for, which means the ROOM is on it: the
 * control is bound to the room record, so a refused or lost write snaps the
 * value back to whatever the table is actually on.
 */
async function setRoomPool(f: Friend, format: string): Promise<void> {
  await f.page.getByTestId('format').selectOption(format);
  await expect(f.page.getByTestId('format'), `${f.name}: the room is on the pool they chose`).toHaveValue(format);
}

/**
 * Choose a deck in the room's own picker. Yours only, and no format with it.
 *
 * Choosing the deck IS loading it — the Load button is gone (wave 22 §B), so
 * the `PUT .../deck` rides the dropdown's own `change`. That keeps this one
 * `PUT` per person, which is what makes the seat order below a claim: the
 * table seats people in the order their deck lands. The dropdown is dead
 * until the pool's legality sweep answers and then offers only that pool's
 * decks, so the wait is on it coming alive, not on an arbitrary delay.
 */
async function loadOwnDeck(f: Friend, deckId: string): Promise<void> {
  await expect(f.page.getByTestId('deck-mine')).toBeEnabled();
  // Wave 28 §C replaced the `<select>` with a `role="radiogroup"` of `role="radio"`
  // buttons (*"we cannot use a standard dropdown for this"*), so `selectOption`
  // throws `Element is not a <select> element`. `deck-mine` is still the root and
  // every row still carries its library id, so picking a deck is still one line:
  // `docs/planning/wave28-evidence/C-deck-chooser-e2e-recipe.md` is where that
  // shape was promised, and this is it taken up.
  await f.page.getByTestId('deck-mine').locator(`[data-deck-id="${deckId}"]`).click();
  await expect(f.page.getByTestId('verdict-mine'), `${f.name}: their own deck is legal`).toContainText('Legal in');
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
  /**
   * What each browser was holding when each probe was raised. Declared out here
   * so the `finally` can write it into the evidence even when the try threw
   * BEFORE the probe was answered — which is the one case anybody reads it in.
   */
  const probeWindows: Record<string, unknown>[] = [];
  let alice: Friend | null = null;
  let bob: Friend | null = null;

  try {
    alice = await openFriend(browser, 'alice');
    bob = await openFriend(browser, 'bob');
    const origin = stack.origin;

    const choice = await legalChoice(alice.context.request, origin);
    summary.choice = {
      format: choice.format,
      decks: choice.decks.map((d) => ({ id: d.id, name: d.name, cards: d.cards.size })),
      onlyFirst: choice.onlyFirst.length,
      onlySecond: choice.onlySecond.length,
    };
    summary.dirs = { rooms: stack.roomsDir, work: stack.workDir, serverLog: stack.serverLogFile };
    const onlyAlice = new Set(choice.onlyFirst);
    const onlyBob = new Set(choice.onlySecond);

    // ── the removed shape, refused through the REAL edge.
    //
    // One person naming both people's decks is what Wave 13 took out. A unit
    // test says the gate refuses it; this says the DEPLOYED bundle does, behind
    // the edge, with a friend's own identity stamped on the request.
    const twoDeckStart = await alice.context.request.post(`${origin}${PREFIX}/api/play/matches`, {
      data: {
        opponent: 'human',
        seats: choice.decks.map((d) => ({ deck: { library: d.id }, rules: { kind: 'standard', format: choice.format } })),
      },
    });
    const twoDeckBody = (await twoDeckStart.json()) as { error?: string };
    expect(twoDeckStart.status(), 'a match against a person cannot be started by naming both decks').toBe(422);
    expect(twoDeckBody.error ?? '').toContain('starts from a room');
    summary.twoDeckStartRefused = { status: twoDeckStart.status(), error: twoDeckBody.error };

    /* ── a locked room needs its password, through the UI ─────────────── */

    await alice.page.goto(`${origin}${PREFIX}/`);
    await expect(alice.page.getByTestId('rooms')).toBeVisible();
    const lockedId = await createRoom(alice, `e2e locked ${Date.now()}`, 'hunter2');
    await bob.page.goto(`${origin}${PREFIX}/`);
    const lockedRow = roomRow(bob, lockedId);
    await expect(lockedRow, 'bob sees a room he is not in').toBeVisible({ timeout: 20_000 });
    await expect(lockedRow.getByTestId('room-locked')).toHaveText('password');
    // Not a member, so the room's TABLE is not readable either — the lock is
    // not only a button that is hard to press.
    const lockedTable = await bob.context.request.get(`${origin}${PREFIX}/api/tables/rooms/${lockedId}`);
    expect(lockedTable.status(), 'a locked room a friend is not in has no readable table').toBe(404);
    await lockedRow.getByTestId('room-enter').click();
    await lockedRow.getByTestId('room-password').fill('not the password');
    await lockedRow.getByTestId('room-password-submit').click();
    await expect(lockedRow.getByTestId('room-join-error')).toContainText('No room with that name and password');
    expect(new URL(bob.page.url()).hash, 'a refused password leaves bob on the room list').not.toContain('/room/');
    // And the right one lets him in, so the refusal above was the password.
    await lockedRow.getByTestId('room-password').fill('hunter2');
    await lockedRow.getByTestId('room-password-submit').click();
    await bob.page.waitForURL(new RegExp(`#/room/${lockedId}$`), { timeout: 20_000 });
    summary.lockedRoom = { roomId: lockedId, tableWithoutMembership: lockedTable.status() };

    /* ── the match room: alice creates it, bob sees it and enters ─────── */

    await alice.page.goto(`${origin}${PREFIX}/`);
    const roomName = `e2e match ${Date.now()}`;
    const roomId = await createRoom(alice, roomName);
    summary.roomId = roomId;
    await expect(alice.page.getByTestId('constructed')).toBeVisible();
    await expect(alice.page.getByTestId('room-name')).toHaveText(roomName);

    await bob.page.goto(`${origin}${PREFIX}/`);
    const row = roomRow(bob, roomId);
    await expect(row, "bob's own list holds the room alice just made").toBeVisible({ timeout: 20_000 });
    await expect(row.getByTestId('room-name')).toHaveText(roomName);
    await expect(row.getByTestId('room-type')).toHaveText('Constructed 1v1');
    await expect(row.getByTestId('room-members')).toContainText('e2e-alice');
    expect(await row.getByTestId('room-locked').count(), 'an open room shows no lock').toBe(0);
    await row.getByTestId('room-enter').click();
    await bob.page.waitForURL(new RegExp(`#/room/${roomId}$`), { timeout: 20_000 });
    await expect(bob.page.getByTestId('constructed')).toBeVisible();

    /* ── the leader sets the table, once, for both seats ──────────────── */

    // Operator, 2026-09-27: *"room creator should be leader and be the one who
    // selects the room mode … people who join can only select from the deck
    // dropdown"*. Alice made the room, so the pool is hers; bob has no control
    // for it at all, and his screen follows hers without him pressing anything.
    await setRoomPool(alice, choice.format);
    await expect(alice.page.getByTestId('room-leader'), 'the leader is marked, not explained').toContainText(
      'e2e-alice',
    );
    const bobPool = bob.page.getByTestId('format-fixed');
    await expect(bobPool, "bob's screen follows the pool alice set").toHaveAttribute('data-format', choice.format);
    expect(await bob.page.getByTestId('format').count(), 'bob has no pool control, only a deck list').toBe(0);
    expect(await alice.page.getByTestId('format-fixed').count(), 'the leader has the control, not the text').toBe(0);
    summary.pool = { format: choice.format, bobReads: await bobPool.textContent() };

    /* ── each loads their OWN deck ────────────────────────────────────── */

    // Alice first: the table seats players in the order they load a deck
    // (`routes.ts` `playersOf`, by `seatedAt`), so this is what puts her deck
    // in seat 1 and makes the seat/deck mapping below a claim and not a flip.
    await loadOwnDeck(alice, choice.decks[0].id);
    await expect(alice.page.getByTestId('room-seat-0')).toContainText('e2e-alice (you)');
    await loadOwnDeck(bob, choice.decks[1].id);
    await expect(bob.page.getByTestId('room-seat-1')).toContainText('e2e-bob (you)');
    // Each sees the other at the other seat, and each page says who is waited on.
    await expect(alice.page.getByTestId('room-seat-1')).toContainText('e2e-bob');
    await expect(alice.page.getByTestId('room-seat-1')).not.toContainText('(you)');
    await expect(bob.page.getByTestId('room-seat-0')).toContainText('e2e-alice');

    // Nobody can pick anybody else's deck. The controls that used to let them
    // are asserted ABSENT, so this fails if the old screen comes back rather
    // than merely going unused.
    for (const f of [alice, bob]) {
      for (const gone of ['deck-0', 'deck-1', 'opponent-human', 'start-match', 'play-constructed']) {
        expect(await f.page.getByTestId(gone).count(), `${f.name}: ${gone} must not exist any more`).toBe(0);
      }
      expect(await f.page.getByTestId('deck-mine').count(), `${f.name}: one deck picker, their own`).toBe(1);
    }

    // The ROOM's own account of who plays what, read from each browser's own
    // context: the same two seats, and a different `you` in each.
    const tableFor = async (f: Friend) =>
      (await (await f.context.request.get(`${origin}${PREFIX}/api/tables/rooms/${roomId}`)).json()) as {
        players: { seat: number; name: string; you: boolean; deckName: string }[];
      };
    const aliceTable = await tableFor(alice);
    const bobTable = await tableFor(bob);
    const deckNames = aliceTable.players.map((p) => p.deckName);
    expect(aliceTable.players.map((p) => p.you), 'alice is seat 1 and bob is not').toEqual([true, false]);
    expect(bobTable.players.map((p) => p.you), 'bob is seat 2 and alice is not').toEqual([false, true]);
    expect(bobTable.players.map((p) => p.deckName), 'both browsers are told the same two decks').toEqual(deckNames);
    expect(deckNames[0], 'the two decks must be tellable apart by name').not.toBe(deckNames[1]);
    summary.roomTable = { deckNames, names: aliceTable.players.map((p) => p.name) };

    /* ── both ready; the SERVER starts the match; both land on it ─────── */

    await alice.page.getByTestId('ready-toggle').click();
    await expect(alice.page.getByTestId('ready-toggle')).toHaveAttribute('aria-pressed', 'true');
    const t0 = Date.now();
    await bob.page.getByTestId('ready-toggle').click();
    // Bob pressed Ready and nothing else; alice pressed nothing at all since.
    // Both pages must arrive at the match the server started.
    const matchUrl = /#\/match\/(m-[0-9a-f]{12})$/;
    await alice.page.waitForURL(matchUrl, { timeout: 120_000 });
    await bob.page.waitForURL(matchUrl, { timeout: 120_000 });
    summary.startMs = Date.now() - t0;
    const matchId = matchUrl.exec(alice.page.url())?.[1];
    if (matchId === undefined) throw new Error(`no match id in ${alice.page.url()}`);
    expect(matchUrl.exec(bob.page.url())?.[1], 'both players are in the SAME match').toBe(matchId);
    summary.matchId = matchId;
    // The match invite box is gone: a match is reached through its ROOM now,
    // and a second link to the same place was a row of chrome on a screen that
    // must not scroll. The URL still IS the route, which is what this checks.
    expect(alice.page.url()).toBe(`${origin}${PREFIX}/#/match/${matchId}`);

    /*
     * Live, and the signal is THE RAIL, WITH FORGE'S TURN COUNTER ON IT (wave 26
     * §B.5: `Seat N, live.` is deleted, and each of the three specs picks its own
     * signal).
     *
     * `live-phases` and the `live-turn-n` inside it are drawn from a `BoardView`
     * and from nothing else, so this is the same fact the deleted line stood for —
     * `liveStatus` returned `live` exactly when a seat AND a view had arrived. A
     * page that merely loaded has no rail, a join that was refused has no rail,
     * and a seat that was never sent a state has no rail; all three time out here.
     * The number is asserted as a number so an empty rail cannot satisfy it.
     *
     * What it deliberately does NOT wait for is a named PHASE: the match opens at
     * turn 0 with the coin toss still unanswered, and Forge has entered no phase
     * yet. That the rail says the same phase the view does is asserted late in the
     * run instead, against the whole folded view (`the board agrees with the
     * server`, below).
     *
     * The SEAT this page holds is asserted three ways just below, off the wire and
     * off the server: the snapshot's own `seat`, the room's table, and Forge's
     * seat→deck mapping. That is the other half of what the deleted line said.
     */
    const liveOnPage = async (f: Friend): Promise<void> => {
      await expect(f.page.locator('[aria-label="Game board"]')).toBeVisible();
      await expect(f.page.getByTestId('live-phases'), `${f.name}: no phase rail, so no state reached this page`).toBeVisible({
        timeout: 30_000,
      });
      await expect(f.page.getByTestId('live-turn-n'), `${f.name}: the rail carries no turn`).toHaveText(/^\d+$/, {
        timeout: 30_000,
      });
    };
    for (const f of [alice, bob]) await liveOnPage(f);

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
      seats: { deck: string | null; claimedBy: string | null }[];
    };
    expect(status.status).toBe('running');
    expect(status.seats.every((s) => s.claimedBy !== null)).toBe(true);
    expect(new Set(status.seats.map((s) => s.claimedBy)).size, 'two different people hold the two seats').toBe(2);

    // FORGE's own account of the seat→deck mapping: `seats[i].deck` is
    // `Deck.getName()` of what it loaded into seat i (`PlayBridge.java`), so
    // this is the engine agreeing with the room, not our record read back.
    expect(status.seats.map((s) => s.deck), 'Forge loaded each player’s own deck into their own seat').toEqual(deckNames);
    summary.seatDecks = status.seats.map((s, i) => ({ seat: i, deck: s.deck }));

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
              turnOnPage: await f.page.getByTestId('live-turn').textContent(),
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
    //
    // The bar itself is on BOTH pages in every frame now (it has a fixed
    // home and never comes and goes), so the seat Forge is asking is the one
    // whose OK is ENABLED — and it must be exactly one of them.
    const seats = [alice, bob];
    const enabledOk = async (f: Friend) => f.page.locator('[data-testid="live-button-ok"]:enabled').count();
    await expect
      .poll(async () => (await Promise.all(seats.map(enabledOk))).reduce((a, b) => a + b, 0), {
        timeout: 30_000,
        message: 'exactly one seat’s board must offer Forge’s opening OK',
      })
      .toBe(1);
    const withBar = await Promise.all(seats.map(async (f) => ({ f, n: await enabledOk(f) })));
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

    // ── the cards prove it too: each seat's opening hand is their OWN deck.
    //
    // The room said so and Forge said so; this is the third authority, and the
    // only one that reads actual game objects. Opening hands come off each
    // player's own library, so a hand holding a card that is in the OTHER deck
    // alone would mean the decks were dealt to the wrong seats — which is
    // exactly the bug `seatPlayers` exists to prevent (`routes.ts`), and which
    // a first-come-first-served `claim` would have produced silently.
    const handEvidence: Record<string, unknown> = {};
    for (const [f, seat, playerId, mine, theirs, theirsOnly] of [
      [alice, 0, aSnap.playerId, choice.decks[0], choice.decks[1], onlyBob],
      [bob, 1, bSnap.playerId, choice.decks[1], choice.decks[0], onlyAlice],
    ] as const) {
      const hand = await ownHand(alice.context.request, origin, matchId, seat, playerId);
      expect(hand.length, `${f.name}: an opening hand to check`).toBeGreaterThan(0);
      const foreign = hand.filter((c) => !mine.cards.has(c));
      expect(foreign, `${f.name}: every card in their opening hand is in the deck THEY loaded`).toEqual([]);
      const decisive = hand.filter((c) => theirsOnly.has(c));
      expect(decisive, `${f.name}: nothing from the other player's deck alone is in their hand`).toEqual([]);
      handEvidence[f.name] = {
        seat,
        deck: mine.name,
        hand,
        // Cards this hand holds that the OTHER deck does not contain at all:
        // each one is a card only this player's deck could have dealt.
        onlyThisDeckCouldDeal: hand.filter((c) => !theirs.cards.has(c)),
      };
    }
    summary.openingHands = handEvidence;
    console.log(`[play] each seat's opening hand, against the deck that seat loaded: ${JSON.stringify(handEvidence)}`);

    // ── play: a LAND and a SPELL, dragged on the board. Not clicked, not
    //    scaffolded — the pointer gesture `LiveBoard` added in Wave 19.
    //
    // The operator, 2026-09-24: *"cards are not dragable"*. This is that,
    // proved where it counts: the frames that LEFT the browser. A drag ends in
    // `selectCard`, the same act a click sends and the only one there is — so
    // what is asserted below is the act on the wire and the card arriving
    // where Forge put it, never a pixel.
    //
    // Only cards Forge offered are ever dragged (`[data-selectable]` is
    // `boardInteraction`'s answer), so this phase also exercises §B item 1: if
    // the board offered things Forge had not named, the drags would land on a
    // server that has nothing to do with them and nothing would move.
    const dragged: { name: string; id: number; card: string; type: string; where: string }[] = [];
    /** Every card clicked because Forge would take nothing else — the evidence for `clickForcedCard`. */
    const forcedCards: { name: string; id: number; card: string; where: string }[] = [];
    // Assigned by reference, and before the first budget that can throw: a run
    // that dies wedged must still say whether anything cleared a wedge.
    summary.forcedCards = forcedCards;
    const dragDeadline = Date.now() + DRAG_BUDGET_MS;
    const wantLand = () => !dragged.some((d) => /Land/.test(d.type));
    const wantSpell = () => !dragged.some((d) => !/Land/.test(d.type));

    /**
     * Every drag this loop ran that committed NOTHING, with what the board was
     * showing at the time — which is the difference between the two failures
     * this check can see.
     *
     * The budget running out means one of two things and only one is a bug.
     * Either the board offered a card, the gesture ran, and no act left the
     * browser — the affordance is broken, which is the operator's own report
     * (*"cards are not dragable"*) and the regression that reached production
     * for 35 minutes on 2026-09-27. Or the game never offered this kind of card
     * at all, which is the deal's doing and proves nothing either way.
     *
     * The DEAL IS FIXED (`e2e/playSeed.ts`), so neither case is luck any more:
     * both are reproducible from the seed, and a red here is a fact about this
     * game rather than about this run.
     *
     * What each silent drag was LOOKING AT is recorded, because a count cannot
     * tell the two apart and once read like the wrong one. The first seeded run
     * failed with "dragged 26x spell and none of them moved"; alice's hand held
     * six lands and one Preordain, she had a single Plains in play, and the
     * count had no way to say that the card the board kept offering was one she
     * could not pay for. The gesture was fine. The loop was not playing her
     * lands.
     *
     * Mutation-tested: forcing every drag to land nothing still fails here,
     * with "the drag affordance is broken".
     */
    const silent: { name: string; card: string; kind: string; prompt: string }[] = [];
    const attempts = { land: 0, spell: 0 };
    /**
     * Consecutive passes on which this seat dragged nothing out of hand, per seat.
     *
     * It gates the OK press for the reason the flow loop below already gives in
     * full: a seat's own main phase is a stop the server never passes, and that
     * stop is the ONE window in which Forge offers this hand anything — so
     * pressing the moment the bar lights up passes the window before the board
     * has drawn what is in it. **Wave 28 made that more true, not less**: with
     * `DEFAULT_STOP_POLICY` on Arena's stop set (`auto.ts`, item 5) the server
     * passes every phase outside the stop sets regardless of what the seat could
     * do there, so the main phases and declare-attackers are now the whole of
     * this seat's own turn as far as this loop can see it. This loop used to press on the
     * first enabled OK it saw, and a deal whose only spell needed three lands
     * therefore never got to drag one: measured 2026-09-26, `turn 58` reached
     * inside the 180 s budget with a single land dragged and no spell ever
     * offered. Racing the game forward is not the same as playing it.
     */
    const idle = new Map<string, number>();

    while (wantLand() || wantSpell()) {
      if (Date.now() > dragDeadline) {
        const turn = await alice.page.getByTestId('live-turn').textContent();
        const missing = ([['land', wantLand()], ['spell', wantSpell()]] as const)
          .filter(([, want]) => want)
          .map(([kind]) => kind);
        // Tried and nothing moved: the affordance is broken, and this is the
        // assertion worth having.
        const tried = missing.filter((kind) => attempts[kind] > 0);
        if (tried.length > 0) {
          // The last few are enough to read, and they are the ones nearest the
          // state the board was actually in when the budget ran out.
          const looking = silent.filter((d) => tried.includes(d.kind as 'land' | 'spell')).slice(-6);
          throw new Error(
            `dragged ${tried.map((k) => `${String(attempts[k])}x ${k}`).join(', ')} and none of them moved — ` +
              `the drag affordance is broken. landed: ${JSON.stringify(dragged)}; turn ${String(turn)}; ` +
              `the last silent drags were looking at ${JSON.stringify(looking)}`,
          );
        }
        // Never offered one: the scenario did not happen, so it proves
        // nothing. Reported loudly and NOT failed — a check whose
        // precondition the shuffle grants fails on luck, which is what this
        // one just did.
        console.warn(
          `[play] UNPROVEN: the game never offered ${missing.join(' or ')} to drag within ${DRAG_BUDGET_MS} ms, ` +
            `so drag-to-play was not exercised for ${missing.join('/')}. landed: ${JSON.stringify(dragged)}; turn ${String(turn)}`,
        );
        break;
      }
      if ((await alice.page.locator('.board__over').count()) > 0) throw new Error('the game ended before a card was dragged');
      for (const f of [alice, bob]) {
        // Anything Forge ASKS is still answered by the board, by clicking.
        await answerPrompt(f.page);
        // The cleanup discard stops the whole game, and this budget would
        // otherwise blame the drag for it. It can only ever fire on Forge's own
        // discard prompt, so it cannot consume a card this loop is trying to
        // drag — that regression is written up in `clickForcedCard`.
        const forced = await clickForcedCard(f);
        if (forced !== null) {
          forcedCards.push({ name: f.name, id: forced.id, card: forced.name, where: 'drag' });
          continue;
        }
        const inHand = await offeredIn(f, 'hand');
        /*
         * A land whenever one is offered, and a spell only when none is.
         *
         * Not "one land, then spells". Forge offers the land drop at most once a
         * turn, so this is the seat playing its mana out at the only rate the
         * rules allow — and without it the loop stopped at ONE land in play and
         * stayed there, which in a control deck means nothing in hand is ever
         * castable. Seed 7 deals alice six lands and a Preordain: with one
         * Plains down and no second land ever played, {U} never came, and the
         * spell half of this check could only ever have passed on a deal that
         * handed it a one-mana play in the opening hand. That is the luck the
         * seed was supposed to remove, one level further in.
         *
         * Every land dragged is recorded, and the per-card assertions below
         * re-check each one, so the extra drags are evidence rather than noise.
         */
        const landPick = inHand.find((c) => /Land/.test(c.type));
        const pick = landPick ?? inHand.find((c) => !/Land/.test(c.type));
        const kind = landPick === undefined ? 'spell' : 'land';
        if (pick !== undefined) {
          attempts[kind] += 1;
          idle.set(f.name, 0);
          const before = cardActsFrom(f).length;
          await dragToBattlefield(f, pick.id);
          // The affordance can go stale under the gesture; `dragLanded` retries
          // a drag that sent nothing on the next pass, against a freshly
          // read board, until the budget runs out.
          if (await dragLanded(f, before, pick.id, pick.name, 6_000)) {
            dragged.push({ name: f.name, id: pick.id, card: pick.name, type: pick.type, where: 'hand' });
          } else {
            // Nothing crossed. What the board was showing is the difference
            // between a stale offer and a broken one, and a count cannot say.
            // `live-says` is Forge's own prompt line (`match.prompt`), which is
            // what says whether this seat was at a stop or mid auto-pass.
            const prompt = (await f.page.getByTestId('live-says').textContent().catch(() => null)) ?? '(no prompt)';
            silent.push({ name: f.name, card: pick.name, kind, prompt });
          }
          continue;
        }
        // Paying for what was just cast is the same gesture on a land already
        // in play: Forge offers it, so it is draggable, so drag it.
        //
        // It does NOT `continue`, and that is the whole point of these lines.
        // It used to, and then a hand with nothing castable and an ACTIVATABLE
        // land in play — a fetchland, whose ability keeps it offered because it
        // is not a mana ability that tapping ends — took this branch on every
        // single pass. Dragging it onto its own battlefield is no legal
        // activation, so it sent nothing, the offer never changed, and the OK
        // press below was skipped forever. Measured 2026-09-26: alice at
        // "Priority: Seat 1 / Turn: 1 / Main phase, precombat / Stack: Empty"
        // with OK ENABLED, 175 seconds, 0 acts out of the browser, turn 1 of a
        // wanted 5. Falling through costs a real payment nothing — Forge's own
        // mana payment wants OK ("Auto"), which is what the press below sends.
        await shootPayment(f);
        const paying = await offeredIn(f, 'battlefield');
        if (paying.length > 0 && dragged.length > 0) await dragToBattlefield(f, paying[0]!.id);
        // This pass dragged nothing out of hand, so it made no progress — and
        // that, NOT "a button is live", is what earns a pass. A payment drag
        // deliberately does not reset the count: it is offered again the moment
        // it lands, which is exactly how the fetchland spin above never ended.
        const quiet = (idle.get(f.name) ?? 0) + 1;
        idle.set(f.name, quiet);
        if (quiet < 4) continue;
        // The bar flips with the auto-passes, so an OK seen enabled can be
        // disabled before the click lands. Best effort with a short leash:
        // a missed press costs one 250 ms pass, and the server presses the
        // stop for the seat anyway when it can.
        const ok = f.page.locator('[data-testid="live-button-ok"]:enabled');
        if ((await ok.count()) > 0) await ok.click({ timeout: 2_000 }).catch(() => {});
      }
      await new Promise((r) => setTimeout(r, 250));
    }

    // Each dragged card went where Forge put it: a land onto its controller's
    // battlefield, a spell off their hand and onto the stack or past it.
    for (const d of dragged) {
      const f = d.name === alice!.name ? alice! : bob!;
      const gone = f.page.locator(`[data-zone="hand"][data-owner="you"] [data-board-card="${d.id}"]`);
      await expect(gone, `${f.name}: ${d.card} left their hand after the drag`).toHaveCount(0, { timeout: 30_000 });
      if (/Land/.test(d.type)) {
        await expect(
          f.page.locator(`[data-zone="battlefield"][data-owner="you"] [data-board-card="${d.id}"]`),
          `${f.name}: ${d.card} was dragged onto their battlefield`,
        ).toHaveCount(1, { timeout: 30_000 });
      }
    }
    summary.draggedOntoTheBoard = dragged;
    console.log(`[play] played by DRAGGING, not clicking: ${JSON.stringify(dragged)}`);

    /*
     * ── §B item 5: a spell RESOLVES with nobody pressing a button.
     *
     * The operator, on a creature sitting on the stack while the opponent had no
     * response: *"ridiculous. just resolve it"*. What resolves it is the server
     * passing a priority window Forge itself said the seat can do nothing in
     * (`apps/server/src/play/auto.ts`, `autoPassReason`).
     *
     * It runs HERE, before `connectHands`, on purpose: the two browsers are the
     * only things in the world that can act at this point, so "nobody pressed
     * anything" is a complete statement rather than one about one of three
     * actors.
     *
     * The window starts when the card LEAVES THE HAND, not when it is clicked.
     * Announcing a spell — targets, and a payment with a choice of which land to
     * tap — is the player's, and is item 6's business, not item 5's; what item 5
     * is about is everything after, which is priority passing until the spell
     * resolves. `pressedSinceTheClick` reports the other half for the record, and
     * `apps/ui/src/play/live/flow.jvm.test.ts` pins the whole of it (a cast with
     * ZERO clicks and ZERO prompts) against a deck built for the case.
     *
     * What is NOT measured is the stack: with both seats passing a window they
     * can do nothing in, an uncontested spell's passage through it can be
     * coalesced away before the browsers are told — measured over a whole
     * recorded game, alice was sent no GameView `Stack`, no card in the `Stack`
     * zone and no `… to Resolve.` prompt at all. So the window is the two things
     * that are certainly observable: the card left the hand, and the card
     * arrived where it resolves.
     */
    const resolvedZones = ['battlefield', 'graveyard', 'exile'] as const;
    const inHand = async (id: number): Promise<boolean> =>
      (await alice!.page.locator(`[data-zone="hand"][data-owner="you"] [data-board-card="${id}"]`).count()) > 0;
    const arrived = async (id: number): Promise<boolean> => {
      for (const zone of resolvedZones) {
        if ((await alice!.page.locator(`[data-zone="${zone}"][data-owner="you"] [data-board-card="${id}"]`).count()) > 0) return true;
      }
      return false;
    };
    const pressesSince = (t0: number): string[] =>
      [alice!, bob!].flatMap((f) => buttonPresses(messages(f)).filter((p) => p.t >= t0).map((p) => `${f.name}:${p.method}`));
    const pressOk = async (): Promise<void> => {
      for (const f of [alice!, bob!]) {
        await answerPrompt(f.page);
        const ok = f.page.locator('[data-testid="live-button-ok"]:enabled');
        if ((await ok.count()) > 0) await ok.click({ timeout: 2_000 }).catch(() => {});
      }
    };

    let unattended: { card: string; ms: number; instant: boolean; pressedSinceTheClick: string[] } | null = null;
    const casts: { card: string; left: boolean; arrived: boolean; pressed: string[] }[] = [];
    const wontAnnounce = new Set<number>();
    /** Consecutive passes with nothing offered — see the press rule below. */
    let empty = 0;
    /** Every card Forge offered alice in hand while this ran — so a failure says what it had to work with. */
    const everOffered = new Set<string>();
    let passes = 0;
    const flowDeadline = Date.now() + FLOW_BUDGET_MS;
    while (unattended === null && Date.now() < flowDeadline) {
      if ((await alice.page.locator('.board__over').count()) > 0) break;
      for (const f of [alice, bob]) await answerPrompt(f.page);
      // BOTH seats, not only the one this section is measuring: the cleanup
      // discard leaves a seat nothing but a card to click, which stops the whole
      // game, and it puts seat 2 there every time its hand passes 7. See
      // `clickForcedCard`.
      for (const f of [alice, bob]) {
        const forced = await clickForcedCard(f);
        if (forced !== null) forcedCards.push({ name: f.name, id: forced.id, card: forced.name, where: 'flow' });
      }
      // Only cards Forge OFFERED are draggable, so an offered non-land in hand
      // is a spell this seat can cast right now.
      const offered = await offeredIn(alice, 'hand');
      passes += 1;
      for (const c of offered) everOffered.add(`${c.name} (${c.type})`);
      const spell = offered.find((c) => !/Land/.test(c.type) && !wontAnnounce.has(c.id));
      if (spell === undefined) {
        const land = offered.find((c) => /Land/.test(c.type));
        if (land !== undefined) {
          empty = 0;
          await dragToBattlefield(alice, land.id);
        } else {
          /*
           * A stop is NOT a reason to press OK yet. The seat's own main phase is
           * a stop the server never passes, and that is the one window where
           * Forge offers this hand anything — so pressing the moment the bar
           * lights up skips it before the board has drawn what is offered. Only
           * an idle board (nothing offered for ~1 s) is passed.
           *
           * Wave 28 (item 5) narrowed what ELSE this loop can be sitting in: the
           * default stop set is Arena's now, so the upkeep, draw, combat steps
           * and end-of-combat go past on their own whether or not the seat could
           * have acted there. An idle pass here is therefore a main phase with
           * nothing castable far more often than it used to be, which is the
           * board this counter was written to recognise.
           */
          empty += 1;
          if (empty >= 4) await pressOk();
        }
        await new Promise((r) => setTimeout(r, 300));
        continue;
      }
      empty = 0;
      const before = cardActsFrom(alice).length;
      const clickedAt = Date.now();
      await dragToBattlefield(alice, spell.id);
      if (!(await dragLanded(alice, before, spell.id, spell.name, 6_000))) continue;

      // Announce it: targets and payment, with whatever presses those want.
      const announcedBy = Date.now() + 15_000;
      while (Date.now() < announcedBy && (await inHand(spell.id))) {
        await pressOk();
        await new Promise((r) => setTimeout(r, 200));
      }
      if (await inHand(spell.id)) {
        // It wants something this phase cannot give it (a target to click).
        // Back out and try another card rather than jamming the game.
        const cancel = alice.page.locator('[data-testid="live-button-cancel"]:enabled');
        if ((await cancel.count()) > 0) await cancel.click({ timeout: 2_000 }).catch(() => {});
        wontAnnounce.add(spell.id);
        casts.push({ card: spell.name, left: false, arrived: false, pressed: [] });
        continue;
      }

      // ── Hands off. From here the only actor allowed is the server.
      const t0 = Date.now();
      const instant = await arrived(spell.id);
      let landed = instant;
      const watchUntil = Date.now() + 20_000;
      while (!landed && Date.now() < watchUntil) {
        for (const f of [alice, bob]) await answerPrompt(f.page);
        landed = await arrived(spell.id);
        if (!landed) await new Promise((r) => setTimeout(r, 250));
      }
      const pressed = pressesSince(t0);
      casts.push({ card: spell.name, left: true, arrived: landed, pressed });
      if (landed && pressed.length === 0) {
        unattended = { card: spell.name, ms: Date.now() - t0, instant, pressedSinceTheClick: pressesSince(clickedAt) };
      } else await pressOk();
    }
    summary.resolvedUnattended = { found: unattended, casts, passes, everOffered: [...everOffered] };
    console.log(
      `[play] spells that resolved with nobody pressing a button: ${JSON.stringify({ unattended, casts, passes, everOffered: [...everOffered] })}`,
    );
    // ── What this may and may not fail on ───────────────────────────────────
    //
    // The check above HUNTS: it casts whatever the game happens to offer and
    // watches whether it resolves with nobody pressing a button. That makes
    // the assertion's precondition the SHUFFLE's to grant, and a proof that
    // depends on luck fails on luck — CI drew a hand offering nothing but
    // lands (`casts: []`, `everOffered: ["Celestial Colonnade (Land)"]`) and
    // reddened a dependency-bump commit that could not have touched it.
    // Seeding narrows this but cannot close it: the seed fixes Forge's
    // shuffles and the coin toss, and explicitly NOT the AI or thread timing
    // (`apps/server/src/play/README.md`), which is what decides how far this
    // game actually gets.
    //
    // So the assertion is split by what it can honestly claim:
    //   - a spell WAS cast and did not resolve unattended → a real failure,
    //     and the one worth having;
    //   - nothing was ever castable → the scenario never happened, reported
    //     loudly and not failed.
    //
    // The BEHAVIOUR itself is not left to this test: `apps/server/src/play/
    // auto.test.ts` decides every captured priority window against real Forge
    // frames, deterministically, and the tracker mutation-tested it (removing
    // the guard fails 2 of 76). This test is the end-to-end demonstration,
    // not the proof of record.
    if (casts.length === 0) {
      console.warn(
        `[play] UNPROVEN: the game never offered a castable spell, so "resolves unattended" was not exercised. ` +
          `${passes} passes, offered in hand: ${JSON.stringify([...everOffered])}`,
      );
    } else {
      expect(
        unattended,
        `a spell left the hand and resolved with no button press from either browser; casts: ${JSON.stringify(casts)}; ` +
          `${passes} passes, offered in hand: ${JSON.stringify([...everOffered])}`,
      ).not.toBeNull();
    }

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
        // Not an ask, so not one of `clicks` — but the same wedge reaches this
        // loop, and `hands` cannot clear it: a connection that joins AFTER the
        // `setSelectables` is re-sent the says, the prompt and the buttons
        // (`Match.resendAfterSnapshot`) and NOT the selection, so it never
        // learns which cards the discard will take. The board was sent it live.
        const forced = await clickForcedCard(f);
        if (forced !== null) forcedCards.push({ name: f.name, id: forced.id, card: forced.name, where: 'play' });
        await shootPayment(f);
      }
    };
    // `live-turn-n` is Forge's own turn counter and nothing else (§B.2); the row
    // around it reads "14yours", and `.board__bar`'s "Turn 14" is gone (§A).
    const turnOnPage = async (): Promise<number> => Number((await alice!.page.getByTestId('live-turn-n').textContent()) ?? 0);
    const deadline = Date.now() + PLAY_BUDGET_MS;
    while (clicked(alice).length === 0 || clicked(bob).length === 0 || (await turnOnPage()) < MIN_TURN) {
      if (Date.now() > deadline) {
        throw new Error(
          `within ${PLAY_BUDGET_MS} ms (turn ${await turnOnPage()}, wanted ${MIN_TURN}), clicked game asks: alice ${clicked(alice).length}, bob ${clicked(bob).length}; ` +
            `all game asks: alice ${JSON.stringify(gameAnswers(alice))}, bob ${JSON.stringify(gameAnswers(bob))}; ` +
            `turn ${await alice.page.getByTestId('live-turn').textContent()}; cast: ${JSON.stringify(hands.map((h) => h.cast))}; ` +
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

    summary.turnReached = await alice.page.getByTestId('live-turn').textContent();
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

    /*
     * ── the probe, to bob: answered AGAINST Forge's default.
     *
     * A probe is raised and left in flight while the spec presses the button that
     * answers it, so its promise is FLOATING for as long as that takes. A floating
     * promise that rejects is the single most destructive thing this spec can hold,
     * and wave 26 held it: `f.context.close()` in the `finally` disposes the
     * browser context's `APIRequestContext`, which rejects every request still
     * pending on it (`playwright-core` `APIRequestContext._disposeImpl` →
     * `Events.Dispose` → `new TargetClosedError('Request context disposed.')`).
     * Playwright takes that unhandled rejection as the test's error and ABORTS the
     * test there — inside the `finally`, before `stack.stop()`, before the JVM
     * reaper, before the summary is written. So the error the reader is shown is
     * `apiRequestContext.post: Request context disposed.` at THIS line, the real
     * failure is gone, no evidence file exists, and the stack's Forge JVM is left
     * running. Wave 26's red (`docs/planning/wave27-probe-race.md`, run A) is
     * exactly that, and it named a line that had not failed.
     *
     * So a probe NEVER rejects: a request that does not come back is DATA, and the
     * `toMatchObject` below reports it as the probe's own failure. The one thing
     * this must not do is throw from a promise nobody is awaiting yet.
     */
    interface ProbeAnswer {
      status: number;
      body: { answer?: boolean; ms?: number; error?: string };
    }
    const probe = (seat: number, message: string): Promise<ProbeAnswer> => {
      probeWindows.push({
        seat,
        message,
        // What each browser was still holding when this probe was raised. A probe
        // queues behind an ask already open on ITS OWN seat and cannot be drawn.
        openAsks: { alice: openAsks(alice!), bob: openAsks(bob!) },
      });
      return alice!.context.request
        .post(`${origin}${PREFIX}/api/play/matches/${matchId}/probe`, { data: { seat, message }, timeout: 120_000 })
        .then(async (r): Promise<ProbeAnswer> => ({ status: r.status(), body: (await r.json()) as ProbeAnswer['body'] }))
        .catch((err: unknown): ProbeAnswer => ({ status: 0, body: { error: `the probe request never came back: ${String(err).split('\n')[0]}` } }));
    };

    const bobProbe = probe(1, `${PROBE_TEXT}: bob, press the button that is not the default`);
    const bobDialog = bob.page.getByTestId('confirm-dialog');
    await expect(bobDialog).toContainText(`${PROBE_TEXT}: bob`);
    // A question, in the column §B.1 gave it: the same host a payment is drawn in,
    // and the one moment in this spec that is guaranteed to have one open.
    await shotOnce(bob, 'question');
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
    /*
     * Take the pointer off the board before the board is read, on BOTH sides.
     *
     * `boardBefore` / `boardAfter` is the claim that the same board comes back,
     * and it is read with `innerText`, which is everything the board currently
     * DRAWS. The inspector draws inside it: hovering a card clones that card's
     * tile into lane A's `[data-board-overlay]`, the last element of
     * `<section class="board">` (`apps/ui/src/play/inspect/index.ts`, wave 20 §D).
     * A preview is POINTER state, not board state, and a reloaded page has had no
     * pointer event over it, so it can never have one — the equality was
     * comparing where the mouse happened to be resting.
     *
     * And it does rest on a card: the drag phase above leaves the pointer wherever
     * its last drop put it, which is over one of the viewer's own permanents. On a
     * contended host this failed 10 of 15 runs, always here, always the same way
     * — `boardBefore` carrying a second copy of one battlefield card, the preview,
     * which the reload cleared. The whole of what was read as "the probe race"
     * was that, plus a masked error (see the probe helper above);
     * `docs/planning/wave27-probe-race.md` has the runs.
     *
     * So the pointer moves off the board and the preview is asserted GONE at both
     * moments. The board comparison below stays total — byte for byte, the whole
     * board, nothing excluded — and an inspector that stopped dismissing fails
     * here, saying so, instead of surfacing as a diff in the board's text.
     */
    const noPreview = async (when: string): Promise<void> => {
      await alice!.page.mouse.move(0, 0);
      await expect(
        alice!.page.locator('[data-board-overlay] [data-inspect]'),
        `alice: no inspector preview ${when} — the pointer is off the board`,
      ).toHaveCount(0);
    };
    await noPreview('before the reload');
    const boardBefore = await alice.page.locator('[aria-label="Game board"]').innerText();
    const mark = alice.captures.length;
    const logMark = serverLog(stack).length;
    const reloadAt = Date.now();
    await alice.page.reload();
    // Live again, on the same signal as above: a rejoin that drew a page but was
    // sent no state back would satisfy anything weaker than this.
    await liveOnPage(alice);
    await expect(aliceDialog).toContainText(`${PROBE_TEXT}: alice`);
    const callIdAfter = await aliceDialog.getAttribute('data-call-id');
    expect(callIdAfter).toBe(callIdBefore);
    await noPreview('after the reload');
    const boardAfter = await alice.page.locator('[aria-label="Game board"]').innerText();
    summary.refreshBoard = { chars: boardAfter.length, same: boardAfter === boardBefore };
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
    // The server armed the grace with the question open, and every rejoin
    // found it still open.
    //
    // The COUNT is deliberately not pinned, and this is the one thing in this
    // block that changed with the room rewrite. `RoomShell` draws the table
    // bare while `GET /api/whoami` is in flight and inside watchparty's
    // `RoomChrome` once it answers — which REMOUNTS `MatchScreen`, so a freshly
    // loaded match page opens a match socket, drops it a moment later and opens
    // a second one. Depending on whether those two overlap, one reload produces
    // one depart/return cycle or two. `toEqual([1])` therefore passed on one run
    // and failed on the next against identical code; the property this test is
    // actually about is that the question survived EVERY one of them.
    //
    // (The remount itself is a product wart, not a test problem: every load of
    // a match page costs an extra join and a full snapshot resend. It is
    // `apps/ui/src/room/RoomShell.tsx`, it predates this wave, and it belongs
    // to whoever owns that file.)
    expect(departing.length, 'the reload armed the reconnect grace').toBeGreaterThanOrEqual(1);
    expect(departing.map((l) => l.openAsks), 'every departure was armed with the question open').toEqual(
      departing.map(() => 1),
    );
    expect(returned.length, 'the seat came back').toBeGreaterThanOrEqual(1);
    expect(returned.map((l) => l.openAsks), 'every return found the question still open').toEqual(returned.map(() => 1));
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
              (() => {
                const ids = Array.from(p.querySelectorAll(`[data-zone="${z}"] [data-board-card]`)).map((c) =>
                  Number(c.getAttribute('data-board-card')),
                );
                // The battlefield is drawn as FOUR labelled rows — lands,
                // artifacts, creatures, other — and a card's row comes from its
                // own type line (`Board.tsx` "The battlefield reads like a
                // table", `BOARD_ROWS`, `rowFor`), on top of whatever the player
                // arranged. So its DOM order is deliberately NOT the view's flat
                // order, and comparing the two passed only while a deal happened
                // to deal them already grouped: this run drew 10,2,48,19 against
                // a view that listed 10,48,2,19 — the same four cards, one of
                // them simply in a different row. Which cards are in which zone
                // is the claim here, so both sides are read by id. That the rows
                // themselves are right is `e2e/table-fit.spec.ts`'s measurement,
                // and the exact, ORDERED agreement is asserted just above this,
                // where the browser's folded objects must deep-equal the
                // server's.
                return z === 'battlefield' ? ids.slice().sort((a, b) => a - b) : ids;
              })(),
            ]),
          ),
        }));
        return {
          // Both off the phase rail, which is where they live now (§A deleted the
          // bar, §B.2 owns the rail): the turn number alone, and the phase as
          // Forge's own constant.
          turn: text(document.querySelector('[data-testid="live-turn-n"]')),
          phase: document.querySelector('[data-testid="live-phases"]')?.getAttribute('data-phase') ?? null,
          players: players.sort((a, b) => a.id - b.id),
        };
      });
      const expected = {
        turn: String(view.turn),
        phase: view.phase ?? '',
        players: view.players
          .map((p) => ({
            id: p.id,
            life: String(p.life),
            hand: `hand ${p.handCount}`,
            library: `library ${p.libraryCount}`,
            zones: {
              battlefield: byId(p.battlefield.map((c) => c.id)),
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
    const offOrigin = [...alice.blocked, ...bob.blocked];
    const offHosts = offOrigin.filter((u) => !isExpectedOffOrigin(u));
    summary.blockedArtRequests = offOrigin.length;
    summary.blockedOffOrigin = Object.fromEntries(
      Object.entries(
        offOrigin.reduce<Record<string, number>>((acc, u) => {
          const { hostname, pathname } = new URL(u);
          const key = `${hostname}${pathname.split('/').slice(0, 3).join('/')}`;
          acc[key] = (acc[key] ?? 0) + 1;
          return acc;
        }, {}),
      ).sort(),
    );
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
    summary.probeWindows = probeWindows;
    for (const h of hands) await h.close();
    for (const f of [alice, bob]) {
      if (f === null) continue;
      await Promise.all(f.pending);
      writeFileSync(resolve(RUN_DIR, `play-${f.name}.captures.json`), JSON.stringify(f.captures));
      writeFileSync(resolve(RUN_DIR, `play-${f.name}.hands.log`), (hands.find((h) => h.seat === (f.name === 'alice' ? 0 : 1))?.log ?? []).join('\n'));
      await f.context.close();
    }
    // `reap: false`: §E's contract is that a handed-over JVM SURVIVES its
    // server, and `jvmFates` has to see that from outside. So the stack's
    // reaper is held back until it has — and then run, before any expect
    // below can throw past it.
    await stack.stop({ reap: false });
    // The server's own account of its exit, kept beside the fates: which matches
    // it HANDED OVER and which it ENDED. A fate that faults is read against this
    // line, so the report says which of the two paths produced it instead of
    // leaving the next reader to infer it from an overwritten log.
    summary.serverShutdown = serverLog(stack).filter((l) => typeof l.evt === 'string' && l.evt.startsWith('shutdown-'));
    const fates = await jvmFates(stack);
    summary.jvmFates = fates;
    summary.jvmsLeft = fates.filter((f) => f.alive).map((f) => f.pid);
    summary.jvmsReaped = stack.reap();
    writeFileSync(resolve(RUN_DIR, 'play-summary.json'), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary, null, 2));
    // A run that spawned nothing would satisfy every clause below by having no
    // JVM to judge, so say out loud that there was one.
    expect(fates.length, 'the server ran at least one Forge JVM').toBeGreaterThan(0);
    expect(
      fates.flatMap((f) => f.faults.map((why) => `${f.id} (pid ${f.pid}): ${why}`)),
      'a handed-over Forge JVM is alive and re-attachable, and every other one is gone',
    ).toEqual([]);
  }
});

function playMessagesSince(f: Friend, mark: number): PlayMessage[] {
  return messages({ ...f, captures: f.captures.slice(mark) });
}

/** What became of one bridge JVM when the server stopped. `faults` empty is the contract met. */
interface JvmFate {
  /** The pool's own id for it — a match id, or `spare-<hex>`. */
  id: string;
  pid: number;
  run: string;
  /** The server said, on its way out, that a later server may take this one back. */
  handedOver: boolean;
  /** Its own record called it a `--spare`: no game, never re-attached. */
  spare: boolean;
  alive: boolean;
  /** Why this fate breaks the contract. Empty is the pass. */
  faults: string[];
}

/**
 * Every bridge JVM this server ran, and whether what became of it is what
 * wave 22 §E says it should be.
 *
 * **A match JVM is now MEANT to outlive its server.** Until §E the exit hook
 * SIGKILLed every one of them, which ended the operator's game on two docs-only
 * deploys; now a match is spawned detached, `<run>/jvm.json` is the handle, and
 * the next boot re-attaches it and replays `<run>/stream.jsonl`. So "no JVM
 * outlives the server" is no longer the contract — it is the bug §E fixed. What
 * this pins instead is stronger, and it runs both ways:
 *
 *  - a JVM the server **handed over** must still be alive AND re-attachable;
 *  - **every other** one — a `--spare`, or a match that ended — must be gone.
 *
 * Re-attachable is `host.ts`'s own definition, asked the way `orphans()` asks
 * it, and this reads the record with `readJvmRecord` rather than a second
 * parser that could drift from it:
 *
 *  - `jvm.json` parses as a record and names this pid;
 *  - that pid is still the process whose **cwd is the run dir** — the pid-reuse
 *    check, because a recycled pid is some other program;
 *  - it is not a spare, which holds no game;
 *  - it carries the match's `epoch` and both seats' owners, or a client could
 *    not resync on the cursor it already holds and seat 2 could come back as
 *    seat 1;
 *  - and it is inside `ORPHAN_MAX_MS` of its `orphanedAt`, past which the next
 *    boot kills it rather than taking it back.
 *
 * Proving a re-attach END TO END is `apps/server/src/play/host.test.ts` and the
 * jar-gated `jvm.test.ts`; this is the e2e's claim that the real server, killed
 * for real, left the real match in a state those can pick up.
 *
 * It only LOOKS. Ending what it found is `PlayStack.reap()`'s job — one guarded
 * reaper in `play/harness.ts` for every spec, which signals a pid only when
 * `/proc/<pid>/cwd` puts it inside this stack's own work dir. So the caller
 * stops the server with `reap: false`, reads the fates here while the
 * handed-over JVM is still up, and reaps immediately after; nothing is left
 * behind either way.
 */
async function jvmFates(stack: PlayStack): Promise<JvmFate[]> {
  const log = serverLog(stack);
  const ran = log.filter(
    (l) => (l.evt === 'jvm-spawned' || l.evt === 'jvm-attached') && typeof l.pid === 'number' && typeof l.run === 'string',
  );
  const handed = new Set(log.filter((l) => l.evt === 'jvm-handed-over' && typeof l.pid === 'number').map((l) => l.pid as number));
  /*
   * The matches the server ENDED on its way out rather than handing over —
   * `shutdown-matches` (`apps/server/src/index.ts:468`). `Match.handOver`
   * refuses a match whose status is no longer `starting`/`running`
   * (`play/match.ts`), so a game that FINISHED during the run lands here, is
   * sent the bridge's own `{t:'stop'}` and is then left to the SIGTERM/SIGKILL
   * escalation in `BridgeJvm.stop` — timers at `stopGraceMs` and twice it
   * (`play/host.ts:1199-1200`), both `unref`'d, inside a process that
   * `process.exit(0)`s within `SHUTDOWN_DEADLINE_MS` (5 s,
   * `index.ts:448,471`). Neither timer can ever fire. So this JVM is asked once,
   * politely, and nothing insists — which is why it can still be running when
   * the contract below says it should be gone. Naming it in the fault is what
   * tells a reader that they are looking at that path and not at a hand-over
   * that failed.
   */
  const endedAtShutdown = new Set(
    log
      .filter((l) => l.evt === 'shutdown-matches' && Array.isArray(l.ended))
      .flatMap((l) => (l.ended as unknown[]).filter((id): id is string => typeof id === 'string')),
  );
  /** Alive, and not a zombie waiting to be reaped. */
  const running = (pid: number): boolean => {
    try {
      return !readFileSync(`/proc/${pid}/stat`, 'utf8').includes(') Z ');
    } catch {
      return false; // no /proc entry: it has exited
    }
  };
  /** The cwd check `orphans()` uses: this pid is the process standing in `run`. */
  const standingIn = (pid: number, run: string): boolean => {
    try {
      return resolve(readlinkSync(`/proc/${pid}/cwd`)) === resolve(run);
    } catch {
      return false;
    }
  };

  // Only the ones that should be GONE are waited on; a handed-over match JVM
  // never exits by design, so waiting on it would just burn the grace.
  const shouldStop = ran.filter((l) => !handed.has(l.pid as number)).map((l) => l.pid as number);
  const deadline = Date.now() + 10_000;
  while (shouldStop.some(running) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));

  const fates = ran.map((l): JvmFate => {
    const pid = l.pid as number;
    const run = l.run as string;
    const id = typeof l.id === 'string' ? l.id : `pid-${pid}`;
    const handedOver = handed.has(pid);
    const alive = running(pid);
    const record = readJvmRecord(run);
    const faults: string[] = [];
    if (!handedOver) {
      // Not handed over: the server stopped it, so it must be gone.
      if (alive) {
        const why =
          record !== null && endedAtShutdown.has(record.matchId)
            ? `the server ENDED it at shutdown (shutdown-matches ended: ${record.matchId}) and it is STILL RUNNING: ` +
              `nothing insisted — see the note on endedAtShutdown, and ${JVM_RECORD_FILE} carries no orphanedAt, so no later server will take it back either`
            : 'the server did not hand it over, yet it is still running';
        faults.push(`${why} (run ${run})`);
      }
    } else if (!alive) {
      faults.push('the server handed it over, so a later server should be able to take it back — but it is gone');
    } else if (record === null) {
      faults.push(`alive with no readable ${JVM_RECORD_FILE} in ${run}: nothing can re-attach to it`);
    } else {
      if (record.pid !== pid) faults.push(`${JVM_RECORD_FILE} names pid ${record.pid}, not ${pid}`);
      if (!standingIn(pid, run)) faults.push(`pid ${pid} is not the process standing in ${run} (orphans() would skip it)`);
      if (record.spare) faults.push('a --spare holds no game and is never re-attached, so it must not survive');
      if (record.epoch === null) faults.push('no epoch in the record: a re-attached client could not resync on its own cursor');
      if (record.owners.length !== 2) faults.push(`${record.owners.length} seat owners recorded, not 2: a re-attach could seat someone at the wrong hand`);
      if (record.spec === null) faults.push('no match spec in the record: nothing to rebuild the match from');
      if (record.orphanedAt === null) faults.push('no orphanedAt in the record, so the next boot cannot bound how long it has been waiting');
      else {
        const waited = Date.now() - Date.parse(record.orphanedAt);
        if (!(waited < ORPHAN_MAX_MS)) faults.push(`orphaned ${waited} ms ago, past ORPHAN_MAX_MS (${ORPHAN_MAX_MS}): the next boot would kill it, not take it back`);
      }
    }
    return { id, pid, run, handedOver, spare: record?.spare ?? false, alive, faults };
  });
  return fates;
}
