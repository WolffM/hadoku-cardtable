// @vitest-environment jsdom
/*
 * Wave 20 lane B — turns that flow, against a REAL Forge match.
 *
 * The operator's second session said four things about the same machinery, and
 * each one is a claim about what a HUMAN had to do. So this suite counts human
 * acts and rendered prompts, not frames: every `it` below asserts exactly one
 * of them, over a scenario driven once in `beforeAll`.
 *
 *  - **#4 / #9** *"one choice shouldn't require this dialog at all"* — a card
 *    with one ability asks nothing. `rules.ts`'s `autoAnswer` answers the offer
 *    before `LiveBoard` would draw it.
 *  - **#6** *"Preordain asks how to tap lands with ONE land in play"* — a
 *    payment Forge can pay from one source is paid by pressing Forge's own Auto
 *    (`auto.ts`'s `autoPayReason`), so the land is never clicked and the
 *    two-ability "tap for U or for R" offer never exists.
 *  - **#5** *"creature sits on the stack though the opponent has no response …
 *    just resolve it"* — the priority windows either side of a resolution are
 *    passed by the server when Forge says the seat can do nothing, so a
 *    creature resolves with ZERO clicks from either player.
 *  - **#7** *"the whole TURN auto-passed … dont auto-pass peoples turns"* — a
 *    seat's own main phase with an empty stack is never passed for it, however
 *    little it can do. The game waits, indefinitely.
 *
 * And the escape hatch: with full control on, the one-ability offer is a
 * question again.
 *
 * ## The decks are chosen so the assertions can be unconditional
 *
 * `20 Volcanic Island` + `20 Merfolk of the Pearl Trident` (a {U} 1/1 vanilla,
 * `cardsfolder/m/merfolk_of_the_pearl_trident.txt` — no activated ability, so a
 * resolved one adds nothing actionable). One land in play, its drop spent, the
 * only spell costing the mana that land makes: after the cast neither seat has
 * a legal action, which is the whole of #5, and after the resolution the active
 * seat still has none, which is the whole of #7. The land is a DUAL on purpose
 * — it has two mana abilities that both `canPlay`, so clicking it during a
 * payment is exactly the "choose ability to play" of #6
 * (`InputPayMana.java:101-106`).
 *
 * The Preordain deck is the operator's own card, for the claim in their words:
 * a one-land Preordain reaches the stack with no prompt drawn at all.
 *
 * ## This suite runs the PRODUCT'S REAL DEFAULT, and that is why it is hardened
 *
 * `./combat-drag.jvm.test.ts` and `./prompts.jvm.test.ts` pin
 * `EVERY_PRIORITY_POLICY` and say why in their own headers: they are about a drag
 * and about fifteen prompt shapes, not about the stop set. This file IS about the
 * stop set — *"a turn never advances past a main phase unattended"* is its sixth
 * claim — so it is the one jar-gated suite left exercising wave 28's
 * `ARENA_STOP_POLICY` default, and it may not be pinned. Every timing problem it
 * has is therefore fixed rather than dialled out. Three of them, and each has its
 * fix documented where the fix is:
 *
 *   1. **The window has to have STOPPED MOVING before anything is decided from
 *      it** — {@link settle}. `jvm-harness.ts` bumps one version for four
 *      different frames, so a prompt can be a window behind its own buttons, and
 *      every decision here is Forge's prompt MESSAGE parsed.
 *   2. **A land drop is phase-safe, not time-safe** — {@link playLand}. "The seat
 *      was at its own main when the wait returned" is not "the seat is at its own
 *      main now", and under `skipNonStopPhases: 'always'` the gap between the two
 *      is where the drop used to go.
 *   3. **A selection remembers what it already picked** — see `advance`. Forge's
 *      offered set is what MAY be chosen, not what is left.
 *
 * (1) and (2) were measured as a real 2-in-2 red by the wave manager on
 * 2026-09-28, at both land-drop call sites; (3) was a pre-existing red that kept
 * all seven cases skipped.
 *
 * Skips visibly without `CARDTABLE_FORGE_JAR` / `CARDTABLE_FORGE_RES`, like
 * `prompts.jvm.test.ts` — and `CARDTABLE_PLAY_WORK_DIR` must point at scratch.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LiveBoard } from './LiveBoard.tsx';
import { boardInteraction, currentAsk, pressButton, selectCard, setFullControl, type LiveMatch } from './match.ts';
import { forgeAvailability, liveJvmCount, startLiveMatch, waitUntil, type LiveHarness, type SeatClient } from './jvm-harness.ts';
import { answerOpenPrompt } from './prompt-driver.ts';

const available = forgeAvailability();
const title = available.ok
  ? 'wave 20 lane B: turns that flow, against a real Forge match'
  : `wave 20 lane B: turns that flow — SKIPPED: ${available.reason}`;

function deck(name: string, lines: readonly string[]): string {
  return `[metadata]\nName=${name}\n[main]\n${lines.join('\n')}\n`;
}

/** One rendered seat: the board a person sees, and the acts they can send. */
interface Hands {
  seat: SeatClient;
  root: HTMLElement;
  /** Every act this test sent for the seat, in order. */
  acts: string[];
  /** Acts the board REFUSED to send — `boardInteraction` said the card was not clickable. */
  refused: string[];
  /**
   * Which cards this seat has already picked, per open selection.
   *
   * Keyed by the turn and the prompt, so a NEW question starts from nothing and
   * the same question asked again on a later turn does too. Without it a
   * selection with `min > 1` can never be satisfied — see `advance`, which is
   * where the whole of this is explained.
   */
  picked: Map<string, number[]>;
  /** `notes.version` as of the PREVIOUS tick — see {@link settle}. */
  lastVersion: number;
  /** The seat's window stopped moving between the last two ticks. */
  steady: boolean;
  /** When this seat last clicked its land to play it — {@link playLand} spaces its retries from it. */
  landClickAt: number;
}

function mount(h: LiveHarness, seat: number): Hands {
  const s = h.seats[seat]!;
  const root = document.createElement('div');
  root.dataset.seat = String(seat);
  document.body.appendChild(root);
  render(createElement(LiveBoard, { match: s.live }), { container: root });
  return { seat: s, root, acts: [], refused: [], picked: new Map(), lastVersion: -1, steady: false, landClickAt: 0 };
}

/**
 * One tick of "has this seat's window finished arriving?", written before any
 * decision is taken from it.
 *
 * **This is the guard the whole scenario rests on, and it exists because a
 * seat's prompt and its buttons do not arrive together.** `jvm-harness.ts:158-165`
 * bumps `notes.version` on ANY of `showPromptMessage`, `updateButtons`,
 * `setSelectables` or `clearSelectables` — so an `updateButtons` arriving alone
 * advances the version while `notes.prompt` still holds the PREVIOUS window's
 * message. Every decision below reads that message (`atOwnMain` is the message,
 * parsed), so a decision taken in that gap is a decision about a window that has
 * already gone: the seat presses OK into a window it never saw, or clicks a land
 * into a step Forge will refuse it in.
 *
 * Lane B measured what made that routine rather than occasional
 * (`docs/planning/wave28-evidence/B-tests-A-must-reaim.md`): with
 * `skipNonStopPhases: 'always'` the server passes upkeep, draw, beginning of
 * combat, combat damage, end of combat, the end step and cleanup in a BURST, so
 * the window under a reader changes several times inside one 100 ms tick. Under
 * the old default the seat stopped at every priority window and the gap was
 * effectively never hit.
 *
 * So: act on a seat only when its version did not move between two ticks. One
 * tick of latency, and the message and the bar are then the same window's by
 * construction — which is the "pair the prompt and the buttons before acting"
 * that `board-play.jvm.test.ts:265-278` does with `stats.replies` and this file
 * had no equivalent of.
 *
 * Run once per seat per tick from {@link until}'s own loop, so it runs whatever
 * `drive` a step passes — including `() => {}`.
 */
function settle(hands: readonly Hands[]): void {
  for (const p of hands) {
    const version = p.seat.notes.version;
    p.steady = version === p.lastVersion;
    p.lastVersion = version;
  }
}

/** "This seat holds priority in its own main phase, and the window has settled." */
function atSteadyOwnMain(p: Hands): boolean {
  return p.steady && atOwnMain(p.seat);
}

/** The method of the prompt this seat is showing, or null. */
function showing(hands: Hands): string | null {
  return hands.root.querySelector<HTMLElement>('[data-testid="live-prompt"]')?.dataset.method ?? null;
}

function click(hands: Hands, cardId: number, what: string): boolean {
  const sent = selectCard(hands.seat.live, cardId);
  (sent ? hands.acts : hands.refused).push(`${what} #${cardId}`);
  return sent;
}

/**
 * Click again, without counting a refusal.
 *
 * The server can replace the input under a click in flight — an ask opens, a
 * stop is passed — and the client then correctly sends nothing
 * (`boardInteraction`). That is not the double-click of item 9 and must not be
 * recorded as one, so the scenario's own retries go through here and only the
 * deliberate clicks above feed `refused`.
 */
function clickAgain(hands: Hands, cardId: number, what: string): void {
  if (selectCard(hands.seat.live, cardId)) hands.acts.push(`${what} #${cardId} (retry)`);
}

function ok(hands: Hands, what: string): void {
  if (pressButton(hands.seat.live, 'ok')) hands.acts.push(`ok:${what}`);
}

interface Seen {
  name: string;
  id: number;
  tapped: boolean;
}

function zoneOf(live: LiveMatch, zone: 'hand' | 'battlefield'): Seen[] {
  const me = live.view?.players.find((p) => p.isViewer);
  const cards = (zone === 'hand' ? me?.hand : me?.battlefield) ?? [];
  return cards.map((c) => ({ name: c.card.name, id: c.id, tapped: c.tapped === true }));
}

/** "This seat holds priority, in its own main phase, with an empty stack." */
function atOwnMain(s: SeatClient): boolean {
  const message = s.notes.prompt?.message ?? '';
  const view = s.live.view;
  if (view === null) return false;
  const me = view.players.find((p) => p.isViewer);
  if (me === undefined || view.activePlayerId !== me.id) return false;
  if (!/^Priority: /.test(message) || !/^Stack: Empty$/m.test(message)) return false;
  return /^Phase: Main phase/m.test(message);
}

/** A turn marker: what a stalled game must keep reporting. */
function marker(s: SeatClient): string {
  return `${s.live.view?.turn ?? '?'}/${s.live.view?.phase ?? '?'}`;
}

/** Everything a stuck scenario needs to be diagnosed from, without another run. */
/**
 * The server's last rows about asks, acts and the bridge — appended to a timeout
 * so the next red says whether Forge ever answered the click. Three reds on
 * 2026-10-08 (runs 37749032414-era, 37843949339, 37846230921: "the creature" /
 * "Preordain to reach the stack") showed only the seat states: priority held
 * at the seat's own main, the card still offered, no ask, nothing on the
 * stack — the shape of both a dropped click and of the fork's net layer
 * failing to encode the ability ask (ledger Incidents, the Signet row), and
 * the states alone cannot tell them apart.
 */
function serverTail(log: readonly Record<string, unknown>[]): string {
  const rows = log.filter((r) => /^(ask-|prompt-|bridge-|refused|act)/.test(String(r.evt ?? ''))).slice(-12);
  return rows.map((r) => JSON.stringify({ ...r, t: undefined })).join('\n');
}

function why(hands: readonly Hands[], log: readonly Record<string, unknown>[] = []): string {
  const tail = serverTail(log);
  return (tail === '' ? '' : `server: ${tail}\n`) + hands
    .map((p) => {
      const live = p.seat.live;
      return JSON.stringify({
        seat: p.seat.seat,
        at: marker(p.seat),
        prompt: p.seat.notes.prompt?.message,
        buttons: live.buttons,
        weaklySelectable: live.weaklySelectable === null ? null : [...live.weaklySelectable],
        selectables: live.selectables === null ? null : { cards: [...live.selectables.cards], min: live.selectables.min },
        inputLive: live.inputLive,
        asks: live.asks.map((x) => x.method),
        hand: zoneOf(live, 'hand').map((c) => `${c.name} #${c.id}`),
        battlefield: zoneOf(live, 'battlefield').map((c) => `${c.name} #${c.id}${c.tapped ? ' (tapped)' : ''}`),
        showing: showing(p),
        /* Was the window still arriving when this went wrong? See `settle`. */
        steady: p.steady,
        version: p.seat.notes.version,
        acts: p.acts.slice(-6),
        refused: p.refused,
      });
    })
    .join('\n');
}

const TICK_MS = 100;
/** How long {@link playLand} leaves a land click to land before it clicks again. */
const LAND_RETRY_MS = 3000;

/**
 * Drop the land, and keep trying until it is down — **phase-safe, not
 * time-safe**.
 *
 * A land may only be played in your own main phase with an empty stack, and
 * Forge refuses it anywhere else. Under the wave-28 default the seat is swept
 * from MAIN1 to the next stop the moment it passes, so "the seat was at its own
 * main when the wait returned" is not the same claim as "the seat is at its own
 * main now". Three things follow, and all three are this function:
 *
 *   - it re-checks {@link atSteadyOwnMain} at the instant it clicks, not before
 *     a wait — including for the FIRST drop, which is why the scenario calls this
 *     rather than clicking by hand;
 *   - it clicks nothing at all when the seat has drifted out of its main, so a
 *     refusal is never retried into the same closed window;
 *   - re-acquiring the main phase is somebody else's job and it has to be done:
 *     see the call sites, which drive the game onward as well as calling this, so
 *     a seat that drifted comes back round to its own main and drops there.
 *
 * The first click is a recorded {@link click} (a refusal is data — see *"a
 * refused click is rare"*); every later one is a {@link clickAgain}, which is
 * this scenario's own retry and not the double-click item 9 is about. A retry
 * waits {@link LAND_RETRY_MS} after the last click: one sent while the drop is
 * still on its way reaches Forge after the land is on the battlefield, as a
 * click on the dual land, whose two mana abilities are a real question that
 * then stands in front of the cast (runs 37999882698, 38008807020:
 * `acts` ending `play land #15 (retry)`, `showing: getAbilityToPlay`).
 */
function playLand(p: Hands): void {
  if (!atSteadyOwnMain(p)) return;
  if (zoneOf(p.seat.live, 'battlefield').some((c) => c.name === 'Volcanic Island')) return;
  const land = zoneOf(p.seat.live, 'hand').find((c) => c.name === 'Volcanic Island');
  if (land === undefined) return;
  if (Date.now() - p.landClickAt < LAND_RETRY_MS) return;
  p.landClickAt = Date.now();
  if (p.acts.some((a) => /play land/.test(a)) || p.refused.some((a) => /play land/.test(a))) {
    clickAgain(p, land.id, 'play land');
    return;
  }
  click(p, land.id, 'play land');
}

/**
 * One tick of "a person keeping the game moving": answer what is drawn, make a
 * selection Forge is waiting on (the cleanup discard is one, and it blocks the
 * whole game), otherwise press OK. `hold` is the ONE stop the scenario wants
 * left alone — pressing it would be the test doing what the product must not.
 *
 * **Nothing here acts on a seat whose window is still arriving** ({@link settle}).
 * That is not politeness: `hold` is `atOwnMain`, which is Forge's prompt MESSAGE
 * parsed, and a stale message makes `hold` answer false at the one stop the
 * scenario exists to keep — so this function would press OK and pass seat 0 out
 * of its own main, which is exactly the shape of the red the manager measured
 * (`acts` ending `ok:2/MAIN1`, the land still in hand at `3/…`).
 */
function advance(hands: readonly Hands[], hold: (p: Hands) => boolean): void {
  for (const p of hands) {
    if (showing(p) !== null) {
      answerOpenPrompt(p.root);
      continue;
    }
    if (currentAsk(p.seat.live) !== null) continue;
    // The window is still arriving: whatever `notes.prompt` says is the last
    // window's, and every decision below is taken from it.
    if (!p.steady) continue;
    // OK first: Forge enables it once a selection has what it needs, so this
    // finishes a discard rather than over-clicking one.
    if (p.seat.live.buttons?.enable1 === true) {
      if (hold(p)) continue;
      ok(p, marker(p.seat));
      continue;
    }
    /*
     * A selection Forge is waiting on, WITH A MEMORY — and the memory is the fix,
     * not a refinement.
     *
     * This used to take `[...selectable][0]` every tick and keep no record of it.
     * Forge does not remove a card from the offered set when you pick it (the set
     * is what MAY be chosen, not what is left), so a `min: 2` cleanup discard got
     * the same card clicked over and over, the selection never reached its
     * minimum, `enable1` never came alive, and the whole scenario died in
     * `beforeAll` with seat 1 parked at `5/CLEANUP` having sent `selection #53`
     * six times. That was a pre-existing defect in this file — it fails under the
     * wave-28 default and under the one before it alike — and it is why all seven
     * cases here skipped.
     *
     * `game-driver.ts:135-139` and `combat-drag.jvm.test.ts:391-394` both keep
     * this record; this is the same one, keyed the same way.
     */
    const selection = p.seat.live.selectables;
    if (selection === null || selection.min === 0) continue;
    const key = `${p.seat.live.view?.turn ?? '?'}:${p.seat.notes.prompt?.message ?? ''}`;
    const already = p.picked.get(key) ?? [];
    if (already.length >= selection.min) continue;
    const next = [...boardInteraction(p.seat.live).selectable].find((id) => !already.includes(id));
    if (next === undefined) continue;
    p.picked.set(key, [...already, next]);
    click(p, next, 'selection');
  }
}

/**
 * What the scenario observed. Every `it` reads this and asserts ONE field, so a
 * revert that breaks one claim fails one test.
 */
interface Observed {
  /** Prompt methods drawn between the spell's click and the spell reaching the stack. */
  promptsWhileCasting: string[];
  /** Acts either seat sent between the spell reaching the stack and leaving it. */
  actsWhileResolving: string[];
  /** Prompts drawn in the same window. */
  promptsWhileResolving: string[];
  /** The creature resolved onto the battlefield. */
  resolved: boolean;
  /** The turn marker before and after the unattended wait at the active seat's own main. */
  stalledFrom: string;
  stalledTo: string;
  /** Whether Forge was asked for the land's one ability at all (it must be — we answered it). */
  singleAbilityAsks: number;
  /** Prompt methods drawn once full control was on and a land was clicked. */
  promptsUnderFullControl: string[];
  /** Clicks the board refused, over the whole scenario — the shape of item 9. */
  refused: string[];
  /** Every act this test sent, per seat: the human clicks, counted. */
  acts: string[];
  /**
   * Offers Forge made TWICE in a row for the same card and the same ability —
   * item 9's *"choose ability often needs the click TWICE"*, as frames.
   */
  repeatedOffers: string[];
  /** Acts sent between the spell's click and the spell reaching the stack. */
  clicksForTheCast: string[];
  /** Whatever the server logged, for the report. */
  log: { [k: string]: unknown }[];
}

const record: Observed = {
  promptsWhileCasting: [],
  actsWhileResolving: [],
  promptsWhileResolving: [],
  resolved: false,
  stalledFrom: '',
  stalledTo: '',
  singleAbilityAsks: 0,
  promptsUnderFullControl: [],
  refused: [],
  acts: [],
  repeatedOffers: [],
  clicksForTheCast: [],
  log: [],
};

/** The Preordain run's own observations. */
const scry = {
  promptsWhileCasting: [] as string[],
  onStack: false,
  acts: [] as string[],
  /** Untapped lands seat 0 still had when Preordain reached the stack. */
  untappedLands: -1,
  refused: [] as string[],
};

/**
 * `CARDTABLE_PLAY_DUMP=<dir>` keeps every envelope both runs emitted, the same
 * hook `apps/server/src/play/jvm.test.ts` has. It is how
 * `apps/server/src/play/fixtures/w20-turn-flow.json` was cut: the committed
 * fixture is real frames off this run, and re-cutting it is one command.
 */
function dump(label: string, payload: unknown): void {
  const dir = process.env.CARDTABLE_PLAY_DUMP;
  if (dir === undefined) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `w20-flow-${label}.json`), JSON.stringify(payload, null, 1));
}

describe.skipIf(!available.ok)(title, () => {
  const running: LiveHarness[] = [];

  afterAll(async () => {
    cleanup();
    for (const h of running) h.stop();
    await waitUntil(() => liveJvmCount() === 0, 'every JVM to exit', 20_000);
    expect(liveJvmCount()).toBe(0);
  }, 60_000);

  beforeAll(async () => {
    /* ── The creature run ───────────────────────────────────────────── */
    const h = await startLiveMatch({
      seed: 20_260_925,
      seats: [
        { name: 'A', ai: false, deck: deck('Flow A', ['20 Volcanic Island', '20 Merfolk of the Pearl Trident']) },
        { name: 'B', ai: false, deck: deck('Flow B', ['20 Volcanic Island', '20 Merfolk of the Pearl Trident']) },
      ],
    });
    running.push(h);
    const hands: [Hands, Hands] = [mount(h, 0), mount(h, 1)];

    // Seat 0's own main phase is where the scenario acts; never press it.
    // Hold seat 0's own main phase — but only from turn 2, or the seat that goes
    // FIRST waits at turn 1 for a scenario that has not begun.
    const holdSeat0 = (p: Hands) => p.seat.seat === 0 && atSteadyOwnMain(p) && (p.seat.live.view?.turn ?? 0) >= 2;
    const keepMoving = () => advance(hands, holdSeat0);

    /*
     * `settle` FIRST, before the predicate and before `drive`, so both read a
     * window that has stopped moving — see its own docs. It runs whatever `drive`
     * a step passes, including `() => {}`, which is the point of putting it here
     * rather than inside `advance`.
     */
    async function until(done: () => boolean, label: string, ms: number, drive = keepMoving): Promise<void> {
      const deadline = Date.now() + ms;
      settle(hands);
      while (!done()) {
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for ${label}\n${why(hands, h.serverLog)}`);
        }
        drive();
        await new Promise((r) => setTimeout(r, TICK_MS));
        settle(hands);
      }
    }

    const a = hands[0];
    // 1. Reach seat 0's own precombat main with a land in hand.
    await until(
      () => atSteadyOwnMain(a) && (a.seat.live.view?.turn ?? 0) >= 2 && zoneOf(a.seat.live, 'hand').some((c) => c.name === 'Volcanic Island'),
      "seat 0's own main phase with a land in hand",
      180_000,
    );

    /*
     * 2. Play the land. Forge offers exactly one ability ("Play land"); nothing
     *    may be drawn for it.
     *
     *    The drop is inside the loop, not before it, and the loop KEEPS THE GAME
     *    MOVING as well as dropping. Both halves are load-bearing under the
     *    wave-28 default:
     *
     *      - `playLand` re-checks the phase at the instant it clicks, so a drop
     *        never goes into a step Forge will refuse it in;
     *      - `keepMoving` means a seat that has already drifted out of its main
     *        comes back round to the next one. The old loop drove with `retryLand`
     *        ALONE, so once seat 0 was past MAIN1 nothing advanced either seat and
     *        the wait could only run out its 60 s — which is the red the manager
     *        measured (`"refused":["play land #30"]` at `3/COMBAT_DECLARE_ATTACKERS`
     *        with an empty battlefield).
     *
     *    `holdSeat0` still holds seat 0 at its own main, so re-acquiring it does
     *    not race the drop.
     */
    await until(
      () => zoneOf(a.seat.live, 'battlefield').some((c) => c.name === 'Volcanic Island' && !c.tapped),
      'the land to be on the battlefield, untapped',
      120_000,
      () => {
        playLand(a);
        keepMoving();
      },
    );

    // 3. Cast the creature. From the click to the stack, nothing may be drawn:
    //    not the one-ability offer, not the payment.
    await until(() => atSteadyOwnMain(a), 'priority back at seat 0', 30_000, () => {});
    const spell = zoneOf(a.seat.live, 'hand').find((c) => c.name === 'Merfolk of the Pearl Trident')!;
    const onStack = () => (h.seats[0].live.view?.stack.length ?? 0) > 0 || zoneOf(a.seat.live, 'battlefield').some((c) => c.name === 'Merfolk of the Pearl Trident');
    const beforeTheCast = a.acts.length;
    click(a, spell.id, 'cast creature');
    // A click the server replaced the input under (an ask opening, a stop
    // passing) sends nothing, correctly — so while nothing is on the stack and
    // nothing is asked, the click is repeated every ten seconds through
    // `clickAgain` (a retry on record, never a refusal). A click Forge took
    // and could not answer (the encode error) stays visible: the retries pile
    // up in `acts` and the server's rows in the timeout message say so.
    let lastClick = Date.now();
    await until(
      onStack,
      'the creature to reach the stack',
      60_000,
      () => {
        for (const p of hands) {
          const method = showing(p);
          if (method !== null) record.promptsWhileCasting.push(`seat ${p.seat.seat}: ${method}`);
        }
        if (!onStack() && showing(a) === null && Date.now() - lastClick > 10_000) {
          clickAgain(a, spell.id, 'cast creature');
          lastClick = Date.now();
        }
      },
    );

    // 4. Resolution, unattended: nobody clicks anything until it has resolved.
    const before: [number, number] = [hands[0].acts.length, hands[1].acts.length];
    await until(
      () => zoneOf(a.seat.live, 'battlefield').some((c) => c.name === 'Merfolk of the Pearl Trident'),
      'the creature to resolve with nobody clicking',
      45_000,
      () => {
        for (const p of hands) {
          const method = showing(p);
          if (method !== null) record.promptsWhileResolving.push(`seat ${p.seat.seat}: ${method}`);
        }
      },
    );
    record.resolved = true;
    record.actsWhileResolving = [
      ...hands[0].acts.slice(before[0]).map((x) => `seat 0: ${x}`),
      ...hands[1].acts.slice(before[1]).map((x) => `seat 1: ${x}`),
    ];

    // 5. And then it WAITS. Seat 0 is at its own main phase with nothing to do;
    //    nobody touches anything for six seconds.
    await until(() => atSteadyOwnMain(a), 'priority back at seat 0 after the resolution', 30_000, () => {});
    record.stalledFrom = marker(a.seat);
    await new Promise((r) => setTimeout(r, 6000));
    record.stalledTo = marker(a.seat);

    record.clicksForTheCast = a.acts.slice(beforeTheCast);
    /*
     * Two asks in a row naming the same card and the same ability is ONE
     * decision asked twice. Recorded as frames rather than diagnosed: Forge has
     * exactly two `getAbilityToPlay` call sites (`InputPassPriority.java:340`
     * and `InputPayMana.java:106`), and this pair carries the SPELL's ability,
     * not a mana ability, so both came from the priority input — for one
     * `selectCard` (`record.clicksForTheCast`).
     */
    const offers = h.asks.filter((x) => x.method === 'getAbilityToPlay');
    for (let i = 1; i < offers.length; i++) {
      const key = (r: (typeof offers)[number]) => {
        const ask = r.ask as { hostCard: { id: number }; abilities: { id: number }[] };
        return `${ask.hostCard.id}:${ask.abilities.map((ab) => ab.id).join(',')}`;
      };
      if (key(offers[i]!) === key(offers[i - 1]!)) record.repeatedOffers.push(`${offers[i - 1]!.callId} then ${offers[i]!.callId}: ${key(offers[i]!)}`);
    }

    record.singleAbilityAsks = h.asks.filter(
      (x) => x.method === 'getAbilityToPlay' && (x.ask as { abilities: unknown[] }).abilities.length === 1,
    ).length;

    // 6. Full control: the same one-ability offer becomes a question again.
    setFullControl(a.seat.live, true);
    await until(() => a.seat.live.fullControl, 'full control on', 10_000, () => {});
    const turnThen = a.seat.live.view?.turn ?? 0;
    await until(
      () => (a.seat.live.view?.turn ?? 0) > turnThen && atSteadyOwnMain(a) && zoneOf(a.seat.live, 'hand').some((c) => c.name === 'Volcanic Island'),
      "seat 0's next own main phase, under full control",
      240_000,
      () => advance(hands, (p) => p.seat.seat === 0 && atSteadyOwnMain(p) && (p.seat.live.view?.turn ?? 0) > turnThen),
    );
    /*
     * The one click this step makes is deliberately NOT `playLand`: under full
     * control the land does NOT reach the battlefield until the one-ability offer
     * is answered, which is the claim this step exists to make, so a loop keyed on
     * "is the land down yet" would click again while the prompt was open. The
     * predicate above has already settled the window, which is the guard that
     * matters.
     */
    const land2 = zoneOf(a.seat.live, 'hand').find((c) => c.name === 'Volcanic Island')!;
    click(a, land2.id, 'play land under full control');
    await until(
      () => showing(a) !== null,
      'the one-ability offer to be DRAWN under full control',
      30_000,
      () => {},
    );
    record.promptsUnderFullControl.push(showing(a) ?? '?');

    record.refused = [...hands[0].refused, ...hands[1].refused];
    record.acts = [...hands[0].acts.map((x) => `seat 0: ${x}`), ...hands[1].acts.map((x) => `seat 1: ${x}`)];
    record.log = h.serverLog.filter((e) => /auto-p|auto-answer|ask-a/.test(String(e.evt))) as { [k: string]: unknown }[];
    dump('creature', { record, raw: h.raw.filter((l) => l.t !== 'frame'), emitted: h.emitted, asks: h.asks.map((x) => ({ seat: x.seat, method: x.method, ask: x.ask })), serverLog: h.serverLog });
    h.stop();
    cleanup();

    /* ── The Preordain run ──────────────────────────────────────────── */
    const p2 = await startLiveMatch({
      seed: 20_260_926,
      seats: [
        { name: 'A', ai: false, deck: deck('Scry A', ['20 Volcanic Island', '20 Preordain']) },
        { name: 'B', ai: false, deck: deck('Scry B', ['20 Volcanic Island', '20 Preordain']) },
      ],
    });
    running.push(p2);
    const two: [Hands, Hands] = [mount(p2, 0), mount(p2, 1)];

    const keepMoving2 = () => advance(two, (p) => p.seat.seat === 0 && atSteadyOwnMain(p) && (p.seat.live.view?.turn ?? 0) >= 2);
    async function until2(done: () => boolean, label: string, ms: number, drive = keepMoving2): Promise<void> {
      const deadline = Date.now() + ms;
      settle(two);
      while (!done()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}\n${why(two, p2.serverLog)}`);
        drive();
        await new Promise((r) => setTimeout(r, TICK_MS));
        settle(two);
      }
    }

    const b = two[0];
    await until2(
      () => atSteadyOwnMain(b) && (b.seat.live.view?.turn ?? 0) >= 2 && zoneOf(b.seat.live, 'hand').some((c) => c.name === 'Volcanic Island'),
      "seat 0's own main phase with a land in hand (Preordain run)",
      180_000,
    );
    // The same shape as step 2 above, and for the same reason — see it.
    await until2(
      () => zoneOf(b.seat.live, 'battlefield').some((c) => c.name === 'Volcanic Island' && !c.tapped),
      'the land to be on the battlefield, untapped (Preordain run)',
      120_000,
      () => {
        playLand(b);
        keepMoving2();
      },
    );
    await until2(() => atSteadyOwnMain(b), 'priority back at seat 0 (Preordain run)', 30_000, () => {});
    const pre = zoneOf(b.seat.live, 'hand').find((c) => c.name === 'Preordain')!;
    click(b, pre.id, 'cast Preordain');
    const preOnStack = () => (b.seat.live.view?.stack.length ?? 0) > 0;
    let lastPreClick = Date.now();
    await until2(
      preOnStack,
      'Preordain to reach the stack',
      60_000,
      () => {
        for (const p of two) {
          const method = showing(p);
          if (method !== null) scry.promptsWhileCasting.push(`seat ${p.seat.seat}: ${method}`);
        }
        // The same retry as the creature's, for the same reason.
        if (!preOnStack() && showing(b) === null && Date.now() - lastPreClick > 10_000) {
          clickAgain(b, pre.id, 'cast Preordain');
          lastPreClick = Date.now();
        }
      },
    );
    scry.onStack = true;
    scry.acts = two[0].acts.slice(-1);
    scry.untappedLands = zoneOf(b.seat.live, 'battlefield').filter((c) => c.name === 'Volcanic Island' && !c.tapped).length;
    scry.refused = [...two[0].refused, ...two[1].refused];
    dump('preordain', { scry, emitted: p2.emitted, asks: p2.asks.map((x) => ({ seat: x.seat, method: x.method, ask: x.ask })), serverLog: p2.serverLog });
    p2.stop();
    cleanup();
  }, 900_000);

  it('a card with one ability asks nothing — the offer arrives and is answered without a prompt', () => {
    // Forge DID ask (the ask is the control): it is the drawing that stopped.
    expect(record.singleAbilityAsks).toBeGreaterThan(0);
    expect(record.promptsWhileCasting).toEqual([]);
  });

  it('a one-land Preordain reaches the stack with no prompt drawn at all', () => {
    expect(scry.onStack).toBe(true);
    // ONE land: the payment Forge could pay from a single source (#6).
    expect(scry.untappedLands).toBe(0);
    expect(scry.promptsWhileCasting).toEqual([]);
  });

  it('a creature with no responses resolves with ZERO clicks from either player', () => {
    expect(record.resolved).toBe(true);
    expect(record.actsWhileResolving).toEqual([]);
    expect(record.promptsWhileResolving).toEqual([]);
  });

  it('a turn never advances past a main phase unattended', () => {
    expect(record.stalledFrom).toMatch(/^\d+\/MAIN[12]$/);
    expect(record.stalledTo).toBe(record.stalledFrom);
  });

  it('full control restores the stop the one-ability shortcut removed', () => {
    expect(record.promptsUnderFullControl).toEqual(['getAbilityToPlay']);
  });

  /*
   * Item 9, *"'choose ability' often needs the click TWICE"* — reproduced: Forge
   * asks the SAME one-ability offer twice for ONE `selectCard`. This test used
   * to prove that from the WIRE, asserting `record.repeatedOffers` (collected
   * from asks actually EMITTED to the seat) was non-empty. The server now
   * answers Forge's own repeat itself (`auto.ts`'s `repeatedAbilityToPlay`, read from
   * `SeatState.lastAbilityToPlay`), BEFORE it is ever emitted — so
   * `record.repeatedOffers` is empty by construction now, every run, and
   * asserting it non-empty is asserting a bug that was fixed. Today's
   * contract, proved from the two places that actually changed: the client
   * still sees one ask for one click (`record.repeatedOffers` empty,
   * `record.promptsWhileCasting` empty), and the server's own log shows it
   * intercepted and answered Forge's repeat rather than Forge simply never
   * repeating.
   */
  it("Forge's own re-ask of the one ability is answered server-side: one click, one ask, the player sees neither", () => {
    expect(record.clicksForTheCast).toHaveLength(1);
    expect(record.repeatedOffers).toEqual([]);
    const repeatAnswered = record.log.filter(
      (e) =>
        e.evt === 'ask-auto-answered' &&
        e.method === 'getAbilityToPlay' &&
        e.why === 'forge re-asked its own already-answered getAbilityToPlay',
    );
    expect(repeatAnswered.length, JSON.stringify(record.log)).toBeGreaterThan(0);
    expect(record.promptsWhileCasting).toEqual([]);
  });

  /*
   * The OTHER half of item 9, and it is not a bug: a click the board refuses.
   *
   * `boardInteraction` only offers what Forge named in the set that is live NOW,
   * and the server can replace the input under a click in flight — an auto-pass
   * lands, `clearWeaklySelectable` arrives — so the click correctly sends
   * nothing and the card has to be clicked again. Measured here: it happens, it
   * is rare, and the retry always lands (`playLand`; the scenario could not
   * have reached its other five claims otherwise). It is asserted as a bound
   * rather than as zero, because zero is not what the design promises.
   */
  it('a refused click is rare, and never the last word', () => {
    expect(record.refused.length, JSON.stringify(record.refused)).toBeLessThanOrEqual(2);
    expect(record.acts.some((a) => /play land/.test(a))).toBe(true);
  });
});
