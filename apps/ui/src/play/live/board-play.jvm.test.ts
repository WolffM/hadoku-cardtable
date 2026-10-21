// @vitest-environment jsdom
/*
 * A land played and spells cast by CLICKING THE BOARD, against a real Forge
 * match in a real child JVM.
 *
 * Two seats (`./jvm-harness.ts`), each a `LiveBoard` rendered into its own
 * container. Every action here is a DOM click on what the product draws: a
 * card's own button (`[data-board-card] button`, which `Board` renders only
 * for a card `boardInteraction` offers), a seat's button, or the button bar.
 * Nothing is sent through the harness's `act`, `game-driver.ts` or
 * `e2e/play/hands.ts`, so what reaches Forge is exactly what the product
 * sends. Blocking asks are answered by `answerOpenPrompt`, which also only
 * clicks.
 *
 * The plan, for whichever seat takes turn 1 (the actor):
 *
 *  1. Turn 1: click a Mountain in hand (Forge's `InputPassPriority` plays
 *     it), then click Raging Goblin. With ONE Mountain in play there is exactly
 *     one way to pay for it, so wave 20 §B has the server press Forge's own
 *     Auto (`apps/server/src/play/auto.ts`, `autoPayReason`) and the payment is
 *     over before a land could be clicked. **This driver does not click to pay
 *     in this phase at all** — see "Nothing here is granted by the shuffle".
 *  2. Then the card Forge's input IGNORES — a second land the same turn. There
 *     is no longer a button to click: Forge names what is actionable through
 *     `setWeaklySelectable` and a second land is not in it, so `Board` draws
 *     the card inert. This step checks the whole equivalence, card for card —
 *     a face exists exactly where Forge named the card and nowhere else — and
 *     it is the proof against the real jar that the frame crosses at all.
 *  3. The actor's next turn: a land, then Shock. Forge's `InputSelectTargets`
 *     sends `setSelectables` — its own list, with min and max — and the actor
 *     clicks the OPPONENT'S SEAT (`selectPlayer`), then pays BY CLICKING a
 *     land. Two Mountains are untapped by now, so which one to tap is a real
 *     choice and the shortcut stays out of it.
 *
 * ## Both seats run STRICT_PAYMENT_POLICY, and that is what makes step 3 real
 *
 * Wave 26 §E. `DEFAULT_STOP_POLICY.unambiguousPayment` became `'forgeAuto'` on
 * 2026-09-27 (item 6, the operator's own call): a payment Forge's own Auto is
 * live for is settled by Forge, ambiguous or not. Under that default step 3
 * cannot happen at all — the server pays for Shock before the driver can click
 * a land, and the capability this test exists to prove ("clicking a land pays")
 * would be untested with nothing red to say so.
 *
 * So each seat is given {@link STRICT_PAYMENT_POLICY} the moment the match
 * exists, through `Match.setStopPolicy` — the per-seat `StopPolicy` that
 * `auto.ts`'s own "what the next wave must add" asked for. That value is the
 * default's payment behaviour up to 2026-09-27 and nothing else: one offered
 * source is still settled by Forge's Auto (step 1 asserts exactly that), and a
 * choice the wire cannot prove away is still the player's (step 3). Full
 * control is NOT used here on purpose: it makes every phase a stop and would
 * change this driver's whole pacing rather than just the payment.
 *
 * Read the two steps together and they pin both halves of the policy against a
 * real Forge: step 1 that the server does press Auto when there is one way to
 * pay, step 3 that it does not when there are two.
 *
 * Done when each is visible on the actor's own folded board: the Mountain on
 * the battlefield, the Goblin on the stack or resolved, Shock on the stack or
 * in the graveyard with the opponent at 18.
 *
 * ## Nothing here is granted by the shuffle (wave 21 §B)
 *
 * The tracker ran this suite outside a wave and got *"a land and Raging Goblin
 * by clicking: not done in 120 s"*. FIVE separate ways this test could pass, or
 * hang, on something other than the product were found and closed — three of
 * them only visible with the whole suite running and 13 JVMs on the box, which
 * is how the tracker found it and how this lane reproduced it. They are written
 * down because each one is the shape the whole lane exists to remove.
 *
 *  - **A click the product declines is now retried, and counted.** `selectCard`
 *    sends nothing and returns false when the card is no longer in
 *    `boardInteraction` (`match.ts`) — a stale affordance, which is BY DESIGN:
 *    an auto-pass lands, Forge clears its actionable set, and the button this
 *    driver is holding a reference to stops meaning anything. `flow.jvm.test.ts`
 *    measured that happening in two runs out of three (wave 20, `341e51d`).
 *    This driver used to latch its target id on the DOM click alone, so one
 *    declined click meant the card never arrived and the drive could only run
 *    out its 120 s deadline. Every click now reports whether an act actually
 *    left the client (`stats.replies`), a declined one re-latches to null and
 *    is retried on the next tick, and the count is asserted as a BOUND.
 *  - **The `paid …` line is waited for, not sampled.** It is a `message`
 *    notify: the Goblin reaches the stack (which is what `phase1Done` watches)
 *    before the line describing its payment has been delivered. Sampling it the
 *    instant the drive returned failed one run in twenty.
 *  - **A click Forge never acted on is made again.** Sending is not acting:
 *    the server forwards an act to whatever input is current, so a window that
 *    closed in between means Forge takes it as an answer to something else. A
 *    whole-suite run latched Mountain 62 as played with an EMPTY `declined`, and
 *    the card was still in hand and still in Forge's actionable set at turn 5.
 *    Every latch now expires (`EFFECT_GRACE_MS`, or at once when Forge names
 *    the card again in a newer actionable set), and the re-clicks are counted
 *    and bounded.
 *  - **Phase 1 is no longer nailed to one turn number.** It used to run only on
 *    the turn the actor was first seen at its own main; a run that missed that
 *    window between two 150 ms ticks pressed OK to turn 108 and failed with the
 *    tracker's own message and an untouched `clicked`. It now runs at the
 *    actor's next own main, and phase 3 follows whatever turn that was. The
 *    generic OK press is vetoed off Forge's prompt while that window is the one
 *    the drive is waiting for.
 *  - **A selection Forge wants `min` cards for gets `min` clicks in one tick.**
 *    One per tick live-locked a run for the whole 120 s at *"Select 2 card(s) to
 *    discard"*: `spent` is cleared by Forge's next frame, so the driver kept
 *    re-offering itself the same first card and OK never enabled.
 *  - **The card-for-card equivalence is sampled over the whole run, not once.**
 *    Checked once at turn-1 priority it was vacuous: Forge names nothing there
 *    (`[]`), so "every clickable face is Forge's" compared two empty answers.
 *    It is now sampled on every tick, the samples where Forge named at least one
 *    card are counted, and that count must be positive.
 *
 * `seed: 11` fixes Forge's shuffle, so the actor's opening hand is a fact about
 * the seed rather than a hope. What the hand must contain is asserted, naming
 * the seed, the moment the actor is known — so a seed change fails in a second
 * with the hand printed instead of timing out in two minutes.
 *
 * Skips visibly without `CARDTABLE_FORGE_JAR` / `CARDTABLE_FORGE_RES`.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { createElement } from 'react';

import { STRICT_PAYMENT_POLICY } from '../../../../server/src/play/auto.ts';
import type { BoardCard, BoardPlayer } from '../adapter.ts';
import { forgeAvailability, liveJvmCount, startLiveMatch, waitUntil, type LiveHarness, type SeatClient } from './jvm-harness.ts';
import { LiveBoard } from './LiveBoard.tsx';
import { currentAsk, type LiveSelectables } from './match.ts';
import { answerOpenPrompt } from './prompt-driver.ts';

const available = forgeAvailability();
const title = available.ok
  ? 'playing by clicking the board, against a real Forge match'
  : `playing by clicking the board, against a real Forge match — SKIPPED: ${available.reason}`;
if (!available.ok) console.warn(`[board-play.jvm] SKIPPED — no Forge build: ${available.reason}`);

/**
 * How many clicks the product may decline before this is a defect rather than
 * the designed race. `flow.jvm.test.ts` bounds the same mechanism at two; this
 * driver clicks about six times, so the same bound applies here. Every declined
 * click is retried, and the drive completing is the proof the retry landed.
 */
const DECLINED_CLICK_BOUND = 2;

/**
 * Declined clicks after which the drive gives up rather than running out its
 * 120 s deadline. A declined click recovers because Forge's NEXT frame renames
 * what is actionable; a decline that keeps repeating is a state the retry
 * cannot leave, and two minutes of silence is the worst possible way to say so.
 */
const DECLINED_CLICK_LIMIT = 10;

/**
 * How long a click's effect may take before the latch on it is dropped and the
 * click is made again.
 *
 * Wave 21 §B. A click the client SENT is still not a click Forge acted on:
 * `Match.fromClient` forwards an act to whatever input is current, so a
 * priority window that closed between the render and the send means Forge takes
 * the act as an answer to something else and the card never moves. Measured, in
 * a whole-suite run with 13 JVMs up: Mountain 62 was latched as played,
 * `declined` was EMPTY — the act did leave the client — and the card was still
 * in the actor's hand, still in Forge's own actionable set, at turn 5. So "the
 * act left the client" is not enough on its own, and a latch that never expires
 * turns one lost act into two minutes of silence. Generous on purpose: under
 * that load Forge itself is slow, and where Forge names the card again, still
 * in hand, the driver has a positive signal and does not wait for the clock.
 */
const EFFECT_GRACE_MS = 8_000;

/** Re-clicks allowed before a lost act is a defect rather than the designed race. */
const REDONE_CLICK_BOUND = 3;

function deck(name: string): string {
  return `[metadata]\nName=${name}\n[main]\n24 Mountain\n18 Raging Goblin\n18 Shock\n`;
}

const named = (name: string) => (c: BoardCard) => c.card.name === name;
const isMountain = named('Mountain');

/**
 * The face of a card on this seat's board — a `<button>` whether or not Board
 * offers it (R10, wave 35: the face is always a `<button>`, so a creature
 * tapping to attack never unmounts the subtree). Null only when the card
 * itself is not on the board at all.
 */
function cardButton(root: HTMLElement, id: number): HTMLButtonElement | null {
  return root.querySelector<HTMLButtonElement>(`[data-board-card="${id}"] button`);
}

/** Does Board draw this card as an offered affordance — the thing a click can actually do something with? */
function isOffered(root: HTMLElement, id: number): boolean {
  return root.querySelector<HTMLElement>(`[data-board-card="${id}"]`)?.hasAttribute('data-selectable') ?? false;
}

/** A seat's clickable name, or null when Board drew it inert. */
function seatButton(root: HTMLElement, playerId: number): HTMLButtonElement | null {
  return root.querySelector<HTMLButtonElement>(`[data-testid="player"][data-player-id="${playerId}"] button`);
}

describe.skipIf(!available.ok)(title, () => {
  const running: LiveHarness[] = [];

  afterAll(async () => {
    cleanup();
    for (const h of running) h.stop();
    await waitUntil(() => liveJvmCount() === 0, 'every JVM to exit', 20_000);
    expect(liveJvmCount()).toBe(0);
  }, 60_000);

  it(
    'a player plays a land and casts spells — one targeted — by clicking their own board',
    async () => {
      const started = Date.now();
      const h = await startLiveMatch({
        seed: 11,
        seats: [
          { name: 'A', ai: false, deck: deck('Red A') },
          { name: 'B', ai: false, deck: deck('Red B') },
        ],
      });
      running.push(h);

      /*
       * A seat owns its stop policy (wave 26 §E), and these two want the strict
       * one: see "Both seats run STRICT_PAYMENT_POLICY" above. Set before a
       * single frame is clicked on, so no payment in the run is judged by the
       * `'forgeAuto'` default.
       */
      for (const s of h.seats) expect(h.match.setStopPolicy(s.seat, STRICT_PAYMENT_POLICY)).toEqual({ ok: true });
      expect(h.seats.map((s) => h.match.stopPolicy(s.seat).unambiguousPayment)).toEqual(['auto', 'auto']);

      const roots = h.seats.map((s) => {
        const root = document.createElement('div');
        document.body.appendChild(root);
        render(createElement(LiveBoard, { match: s.live }), { container: root });
        return root;
      });
      const log: string[] = [];
      const me = (s: SeatClient): BoardPlayer => s.live.view!.players.find((p) => p.isViewer)!;
      const opponent = (s: SeatClient): BoardPlayer => s.live.view!.players.find((p) => !p.isViewer)!;

      let actor: SeatClient | null = null;
      let firstTurn = 0;
      /**
       * The turn phase 1 last acted on. Phase 3 needs a LATER one.
       *
       * Wave 21 §B: this used to be `firstTurn`, the turn the actor was first
       * seen at its own main — and phase 1 could then only ever happen on that
       * one turn. A full-suite run where that window closed between two 150 ms
       * ticks left the driver with nothing to do for the rest of the game: it
       * pressed OK to turn 108 and failed with the tracker's own message and an
       * untouched `clicked`. Phase 1 now runs at the actor's next own main,
       * whichever turn that is, and phase 3 follows it.
       */
      let phase1Turn = 0;
      /** The actor's hand the moment it first held priority — what `seed: 11` dealt it. */
      let actorOpeningHand: string[] = [];
      const clicked = {
        land: null as number | null,
        goblin: null as number | null,
        land2: null as number | null,
        shock: null as number | null,
        targeted: false,
        shockPaid: false,
      };
      let targeting: LiveSelectables | null = null;
      /** Clicks the product declined because the affordance had gone stale. */
      const declined: string[] = [];
      /**
       * When each latched click was sent, and the actionable set Forge had named when it was, so
       * the latch can tell Forge answering it from Forge not having got to it yet.
       */
      const sentAt = new Map<string, { at: number; under: ReadonlySet<number> | null }>();
      /** Acts Forge did not act on, which this driver made again. */
      const redone: string[] = [];

      /**
       * Click, and say whether an act actually left the client.
       *
       * A `<button>` in the DOM is a render of a past state; `selectCard` and
       * `selectPlayer` re-check `boardInteraction` and send nothing when the
       * card or seat is no longer offered. `stats.replies` counts what was
       * sent, so comparing it across the click is the only honest answer to
       * "did that click do anything".
       */
      const click = (el: HTMLButtonElement, what: string, s: SeatClient): boolean => {
        const before = s.live.stats.replies;
        fireEvent.click(el);
        const sent = s.live.stats.replies > before;
        log.push(`seat ${s.seat} t${s.live.view!.turn} clicks ${what}${sent ? '' : ' — DECLINED, will retry'}`);
        if (!sent) declined.push(`seat ${s.seat} t${s.live.view!.turn}: ${what}`);
        return sent;
      };

      /**
       * Click a card of this name in hand that Forge offers now. Returns its id only when the click
       * was sent. Never one Forge does not name: once the land drop is spent no Mountain is offered,
       * and a click on one is a decline that no retry can turn into a play.
       */
      function fromHand(s: SeatClient, name: string): number | null {
        const card = me(s).hand?.find((c) => named(name)(c) && isOffered(roots[s.seat]!, c.id));
        const button = card === undefined ? null : cardButton(roots[s.seat]!, card.id);
        if (card === undefined || button === null) return null;
        return click(button, `${name} ${card.id} in hand`, s) ? card.id : null;
      }

      /** Pay by clicking an untapped Mountain on the battlefield. */
      function payWithLand(s: SeatClient): boolean {
        const land = me(s).battlefield.find((c) => isMountain(c) && !c.tapped);
        const button = land === undefined ? null : cardButton(roots[s.seat]!, land.id);
        if (land === undefined || button === null) return false;
        return click(button, `Mountain ${land.id} on the battlefield to pay: ${JSON.stringify(s.live.prompt)}`, s);
      }

      /** Latch `id` under `key`, remembering when its click was sent and what Forge offered then. */
      const latch = (s: SeatClient, key: string): void => {
        sentAt.set(key, { at: Date.now(), under: s.live.weaklySelectable });
      };
      const mark = (s: SeatClient, key: string, id: number | null): number | null => {
        if (id !== null) latch(s, key);
        return id;
      };
      /**
       * Has the effect of the click latched under `key` failed to arrive?
       *
       * The positive signal is Forge naming the card `id` again, in hand, in an actionable set NEWER
       * than the one it was clicked under: Forge came back to this seat's priority and the card did
       * not move. A card merely still in hand is not one — on a loaded claw the play takes longer
       * than a tick to fold, and a latch dropped then re-clicked a second Mountain after the first
       * had landed, which Forge (one land a turn) never offers (runs 39376063049, 39508268581).
       * Without the signal, the grace decides. Either way the latch drops so the click is made again.
       */
      const lost = (s: SeatClient, key: string, what: string, id: number | null): boolean => {
        const sent = sentAt.get(key);
        if (sent === undefined) return false;
        const waited = Date.now() - sent.at;
        const offered = s.live.weaklySelectable;
        const renamed = id !== null && inHand(s, id) && offered !== null && offered !== sent.under && offered.has(id);
        if (!renamed && waited < EFFECT_GRACE_MS) return false;
        sentAt.delete(key);
        redone.push(`${what} — ${renamed ? `named again, still in hand, after ${waited} ms` : `${waited} ms and nothing happened`}`);
        log.push(`re-clicking: ${what}`);
        return true;
      };
      /** Is this card still in the actor's hand? Then Forge did not act on the click. */
      const inHand = (s: SeatClient, id: number | null): boolean => id !== null && (me(s).hand ?? []).some((c) => c.id === id);

      const phase1Done = (): boolean => {
        if (actor === null || clicked.goblin === null) return false;
        const p = me(actor);
        const onStack = actor.live.view!.stack.some((i) => i.sourceCardId === clicked.goblin);
        return p.battlefield.some((c) => c.id === clicked.land) && (onStack || p.battlefield.some((c) => c.id === clicked.goblin));
      };
      let phase1Checked = false;
      const phase2Done = (): boolean => {
        if (actor === null || clicked.shock === null || !clicked.targeted) return false;
        const v = actor.live.view!;
        const onStack = v.stack.some((i) => i.sourceCardId === clicked.shock);
        const resolved = me(actor).graveyard.some((c) => c.id === clicked.shock) && opponent(actor).life === 18;
        return onStack || resolved;
      };

      /*
       * "A clickable face exists exactly where Forge named the card, and
       * nowhere else", sampled over the whole run instead of once.
       *
       * React's pending work is flushed first (`act`), so the DOM compared is
       * the render of the state compared and not of an earlier one — the
       * updates arrive outside `act`, from socket events. `spent` must be empty
       * for the same reason the one-shot check required it: a card this client
       * has already clicked is deliberately not offered again, so Forge's raw
       * set is only the authority while nothing is spent.
       */
      const parity = {
        samples: 0,
        /** Samples where Forge named at least one card the seat can see. */
        named: 0,
        mismatches: [] as string[],
        /** The widest set Forge named at any sampled moment. */
        widest: [] as number[],
        /** A sample where Forge named cards AND a land in the actor's hand was not among them. */
        inertLand: null as { forgeNamed: number[]; landId: number; offered: boolean } | null,
        /** Why a tick was not sampled — so "no samples" is diagnosable rather than a bare zero. */
        skipped: { noInput: 0, selecting: 0, cleared: 0, spent: 0, empty: 0 },
      };
      function sampleParity(s: SeatClient): void {
        // Flush React's pending work, so the DOM read below is the render of
        // the client state read below it and not of an earlier one. Every
        // update here arrives outside `act` (socket events), which is what
        // makes a stale DOM possible at all.
        act(() => {});
        const v = s.live.view;
        if (v === null || !s.live.inputLive || currentAsk(s.live) !== null) {
          parity.skipped.noInput += 1;
          return;
        }
        if (s.live.selectables !== null) {
          parity.skipped.selecting += 1;
          return;
        }
        if (s.live.weaklySelectable === null) {
          parity.skipped.cleared += 1;
          return;
        }
        if (s.live.spent.cards.size > 0) {
          parity.skipped.spent += 1;
          return;
        }
        const forgeNamed = s.live.weaklySelectable;
        const onBoard = [...(me(s).hand ?? []), ...me(s).battlefield, ...opponent(s).battlefield];
        if (onBoard.length === 0) {
          parity.skipped.empty += 1;
          return;
        }
        parity.samples += 1;
        const visible = onBoard.filter((c) => forgeNamed.has(c.id)).map((c) => c.id);
        if (visible.length > 0) parity.named += 1;
        if (visible.length > parity.widest.length) parity.widest = visible;
        for (const c of onBoard) {
          const offered = isOffered(roots[s.seat]!, c.id);
          if (offered !== forgeNamed.has(c.id)) {
            parity.mismatches.push(
              `seat ${s.seat} t${v.turn} ${v.phase ?? '-'}: card ${c.id} (${c.card.name}) drawn ${offered ? 'offered' : 'inert'} while Forge ` +
                `${forgeNamed.has(c.id) ? 'named' : 'did not name'} it; Forge's set was ${JSON.stringify([...forgeNamed])}`,
            );
          }
        }
        // The specific wave-20 claim, at a moment where it says something: a
        // land in hand that Forge left out of a set it did NOT leave empty.
        if (parity.inertLand === null && visible.length > 0 && s === actor) {
          const land = (me(s).hand ?? []).find((c) => isMountain(c) && !forgeNamed.has(c.id));
          if (land !== undefined) {
            parity.inertLand = { forgeNamed: [...forgeNamed], landId: land.id, offered: isOffered(roots[s.seat]!, land.id) };
          }
        }
      }

      /*
       * The window a click belongs to is read off the FOLDED VIEW, not Forge's
       * prompt — measured, not assumed (wave 21 §B). Forge's prompt names the
       * window more precisely, and reading it looks like the obvious fix for a
       * driver that misses one; it is not. The prompt is a transient that the
       * next frame overwrites, so a 150 ms tick can miss the actor's own main
       * phase entirely: driving off the prompt, three runs out of three failed,
       * one of them never finding an actor at all and running the game to turn
       * 108. The folded phase persists until it changes, which is what a
       * sampling driver needs.
       */

      /** One tick for one seat: answer, act by clicking, or press OK. At most one click. */
      function step(s: SeatClient): void {
        const root = roots[s.seat]!;
        sampleParity(s);
        if (currentAsk(s.live) !== null) {
          log.push(`seat ${s.seat} answers ${answerOpenPrompt(root) ?? 'nothing'}`);
          return;
        }
        /*
         * Two decisions that are Forge's own button bar (`match.buttons`)
         * under the hood, same as every other press here, but which wave 38
         * (T4, R2) moved OFF the generic control bar and into their own `ConfirmPrompt` branches with their own
         * testids — the coin toss (`live-play-or-draw-play`/`-draw`,
         * `isPlayOrDrawPrompt`) and every other yes/no (`prompt-confirm-yes`/
         * `-no`, T4's own shape, e.g. "keep your hand?"). Pre-existing, found
         * while running this suite for wave 46 §B (confirmed against a clean
         * baseline with none of this wave's changes: the hang reproduces
         * identically) — this driver predates both moves and never learned
         * either testid. Always the FIRST button ("Play", "Keep", "Yes",
         * whichever bar it is): which seat goes first and keeping the dealt
         * hand are not this suite's claim.
         */
        const playOrDraw = root.querySelector<HTMLButtonElement>('[data-testid="live-play-or-draw-play"]');
        if (playOrDraw !== null && !playOrDraw.disabled) {
          log.push(`seat ${s.seat} presses Play (coin toss)`);
          fireEvent.click(playOrDraw);
          return;
        }
        const confirmYes = root.querySelector<HTMLButtonElement>('[data-testid="prompt-confirm-yes"]');
        if (confirmYes !== null && !confirmYes.disabled) {
          log.push(`seat ${s.seat} presses ${confirmYes.textContent ?? ''} (confirm)`);
          fireEvent.click(confirmYes);
          return;
        }
        const v = s.live.view;
        if (v === null || !s.live.inputLive) return;
        const p = me(s);
        const myMain = v.turn >= 1 && v.activePlayerId === p.id && v.phase === 'MAIN1';
        if (myMain && actor === null) {
          actor = s;
          firstTurn = v.turn;
          // Read before anything is clicked: this is what the seed dealt.
          actorOpeningHand = (p.hand ?? []).map((c) => c.card.name);
        }
        if (s === actor && myMain && !phase1Done()) {
          phase1Turn = v.turn;
          if (clicked.land === null) clicked.land = mark(s, 'land', fromHand(s, 'Mountain'));
          else if (!p.battlefield.some((c) => c.id === clicked.land)) {
            if (lost(s, 'land', `Mountain ${clicked.land} never reached the battlefield`, clicked.land)) clicked.land = null;
          } else if (clicked.goblin === null) clicked.goblin = mark(s, 'goblin', fromHand(s, 'Raging Goblin'));
          else if (lost(s, 'goblin', `Raging Goblin ${clicked.goblin} never left the hand`, clicked.goblin)) clicked.goblin = null;
          /*
           * Nothing pays here. With one Mountain in play there is exactly one
           * way to pay {R} — one source, which even the STRICT policy these
           * seats run settles — so `autoPayReason` presses Forge's own Auto and the
           * cost is settled with no click and no button press at this table —
           * which is the wave-20 claim asserted below. A click racing that
           * press would decide the claim by whichever won, so the driver does
           * not make one. Clicking a land to pay is proved in step 3, where
           * there are TWO and the shortcut correctly stays out.
           */
          return;
        }
        if (s === actor && myMain && v.turn > phase1Turn && phase1Checked && !phase2Done()) {
          if (clicked.land2 === null) clicked.land2 = mark(s, 'land2', fromHand(s, 'Mountain'));
          else if (!p.battlefield.some((c) => c.id === clicked.land2)) {
            if (lost(s, 'land2', `Mountain ${clicked.land2} never reached the battlefield`, clicked.land2)) clicked.land2 = null;
          } else if (clicked.shock === null) clicked.shock = mark(s, 'shock', fromHand(s, 'Shock'));
          else if (!clicked.targeted) {
            // Forge's own list of what Shock may target, as it arrived.
            if (s.live.selectables === null) {
              if (lost(s, 'shock', `Shock ${clicked.shock} never asked for a target`, clicked.shock)) clicked.shock = null;
              return;
            }
            targeting = s.live.selectables;
            const target = seatButton(root, opponent(s).id);
            if (target === null) return;
            clicked.targeted = click(target, `the opponent's seat (player ${opponent(s).id}) as Shock's target`, s);
            if (clicked.targeted) latch(s, 'targeted');
          } else if (!clicked.shockPaid) {
            if (s.live.selectables === null) {
              clicked.shockPaid = payWithLand(s);
              if (clicked.shockPaid) latch(s, 'shockPaid');
            } else if (lost(s, 'targeted', 'the target click never closed Forge’s selection', null)) clicked.targeted = false;
          } else if (lost(s, 'shockPaid', `Shock ${clicked.shock} never reached the stack after it was paid for`, null)) {
            clicked.shockPaid = false;
          }
          return;
        }
        /*
         * Forge wants cards picked (the cleanup discard): pick `min` of them,
         * all in THIS tick.
         *
         * Wave 21 §B. One click per tick live-locked a run for the whole 120 s
         * at *"Select 2 card(s) to discard"*: `spent` is cleared by Forge's
         * next frame (`INPUT_FRAMES` → `unspend`), so the driver re-offered
         * itself the same first card every tick and the OK button never
         * enabled. Within one tick `spent` holds, so each click picks a
         * different card and a 2-of-2 selection completes.
         */
        const sel = s.live.selectables;
        // Forge's button one as the page draws it (wave 51): the box's Next
        // Phase at the empty-stack priority pass, the decision pop-up's own OK
        // for every other input, and neither while Forge has not enabled it.
        const nextPhase = root.querySelector<HTMLButtonElement>('[data-testid="live-button-next-phase"]');
        const ok = nextPhase !== null && !nextPhase.disabled ? nextPhase : root.querySelector<HTMLButtonElement>('[data-testid="live-decision-ok"]');
        if (sel !== null && (ok === null || ok.disabled)) {
          let picked = 0;
          for (const id of sel.cards) {
            if (picked >= Math.max(sel.min, 1)) break;
            if (s.live.spent.cards.has(id)) continue;
            const b = cardButton(root, id);
            if (b !== null && click(b, `a card Forge offered (${sel.min}..${sel.max})`, s)) picked += 1;
          }
          return;
        }
        if (ok !== null && !ok.disabled) {
          /*
           * Never press OK through the window this drive is waiting for.
           *
           * Wave 21 §B. `myMain` above is read off the FOLDED view, and
           * `activePlayerId` / `phase` can lag Forge by a frame or two when the
           * host is loaded; the branch then does not fire and this press passes
           * the actor's own main phase — the one window the server never
           * auto-passes for it (#7), so this driver is the only thing that can
           * lose it. Forge's prompt names the window outright, so it vetoes the
           * press. It is a veto and not the driver's compass: driven off the
           * prompt alone, three runs of three failed, because the prompt is a
           * transient a 150 ms tick can miss and the folded phase is not.
           */
          const text = s.live.prompt ?? '';
          const priority = /^Priority: (.+)$/m.exec(text)?.[1] ?? null;
          const turn = /^Turn: (\d+) \((.+)\)$/m.exec(text);
          const ownMainByPrompt =
            priority !== null && turn !== null && priority === turn[2] && /^Phase: Main phase, precombat$/m.test(text) && /^Stack: Empty$/m.test(text);
          if (
            s === actor &&
            ownMainByPrompt &&
            (!phase1Done() || (phase1Checked && !phase2Done() && Number(turn![1]) > phase1Turn))
          ) {
            return;
          }
          log.push(`seat ${s.seat} t${v.turn} ${v.phase ?? '-'} presses ${ok.textContent ?? ''}`);
          fireEvent.click(ok);
        }
      }

      /** What each seat is looking at — the only thing that makes a stalled drive diagnosable. */
      const where = (): string =>
        h.seats
          .map(
            (s) =>
              `seat ${s.seat}: turn ${s.live.view?.turn ?? '-'} ${s.live.view?.phase ?? '-'}, inputLive ${String(s.live.inputLive)}, ` +
              `ask ${currentAsk(s.live)?.method ?? 'none'}, prompt ${JSON.stringify(s.live.prompt)}, ` +
              `Forge named ${s.live.weaklySelectable === null ? 'nothing (cleared)' : JSON.stringify([...s.live.weaklySelectable])}, ` +
              `selecting ${s.live.selectables === null ? 'nothing' : JSON.stringify({ cards: [...s.live.selectables.cards], min: s.live.selectables.min, max: s.live.selectables.max })}, ` +
              `spent ${JSON.stringify([...s.live.spent.cards])}`,
          )
          .join('\n');

      async function drive(until: () => boolean, label: string): Promise<void> {
        const deadline = Date.now() + 120_000;
        while (!until()) {
          if (declined.length > DECLINED_CLICK_LIMIT) {
            throw new Error(
              `${label}: the product declined ${declined.length} clicks and the retry never landed — the affordance is stuck, not stale\n` +
                `${JSON.stringify(declined.slice(-4))}\n${where()}`,
            );
          }
          if (Date.now() > deadline) {
            throw new Error(
              `${label}: not done in 120 s\nclicked: ${JSON.stringify(clicked)}\ndeclined clicks: ${JSON.stringify(declined)}\n` +
                `re-clicked: ${JSON.stringify(redone)}\n` +
                `${where()}\n${log.slice(-40).join('\n')}\nrefused: ${JSON.stringify(h.refused)}`,
            );
          }
          for (const s of h.seats) step(s);
          await new Promise((r) => setTimeout(r, 150));
        }
      }

      // 0. Whoever wins the toss is the actor, and `seed: 11` dealt it the hand
      // the rest of this test needs. Stated here so a seed change says so.
      await drive(() => actor !== null, 'a seat to reach its own main phase');
      const a = actor! as SeatClient;
      const mountains = actorOpeningHand.filter((n) => n === 'Mountain').length;
      const seedDealt = `seed 11 dealt the actor (seat ${a.seat}) ${JSON.stringify(actorOpeningHand)}`;
      // Two Mountains: one played in step 1, and a second left in hand for the
      // inert-card check in step 2. One Raging Goblin to cast.
      expect(mountains, seedDealt).toBeGreaterThanOrEqual(2);
      expect(actorOpeningHand, seedDealt).toContain('Raging Goblin');

      // 1. A land and a spell, turn 1.
      await drive(phase1Done, 'a land and Raging Goblin by clicking');
      const mountain = me(a).battlefield.find((c) => c.id === clicked.land);
      expect(mountain?.card.name).toBe('Mountain');
      /*
       * Wave 20 §B, the operator's #6. One Mountain is one way to pay, so the
       * server pressed Forge's own Auto and the Goblin's cost was paid with no
       * click and no button press by either browser — see the module header.
       * The Mountain is tapped all the same: a cast is never free.
       *
       * The Goblin reaches the stack BEFORE the line describing its payment is
       * delivered, so the line — Forge's own `MANA` log entry for the Mountain —
       * is waited for. A payment that never happens fails here with the whole
       * log rather than with a bare `false`.
       */
      const paidSaid = (): boolean => a.live.says.some((say) => say.log?.type === 'MANA' && /Mountain/.test(say.text));
      const autoPaid = (): boolean => h.serverLog.some((l) => l.evt === 'auto-paid' && l.seat === a.seat);
      try {
        await waitUntil(() => paidSaid() && autoPaid(), 'the Goblin’s payment to be said, and to be the server’s Auto', 20_000);
      } catch {
        // Not a failure of its own: the two assertions below name what was
        // missing, with the lines this seat actually holds.
      }
      expect(paidSaid(), JSON.stringify(a.live.says)).toBe(true);
      expect(h.serverLog.filter((l) => l.evt === 'auto-paid' && l.seat === a.seat).length).toBeGreaterThan(0);
      expect(mountain?.tapped).toBe(true);
      const goblinResolved = me(a).battlefield.some((c) => c.id === clicked.goblin);
      console.log(
        `[board-play.jvm] seat ${a.seat} turn ${firstTurn}: Mountain ${clicked.land} played, Raging Goblin ${clicked.goblin} ` +
          `${goblinResolved ? 'resolved' : 'on the stack'}, paid by the server's Auto with no click — ${((Date.now() - started) / 1000).toFixed(1)} s`,
      );

      // 2. The card Forge's input ignores is drawn inert — nothing to click.
      //
      // `setWeaklySelectable` is the frame that makes this possible, so first
      // prove it crossed: against the real jar, for this seat, at least once.
      await waitUntil(
        () => a.live.inputLive && currentAsk(a.live) === null && a.live.weaklySelectable !== null && a.live.spent.cards.size === 0,
        'the actor to hold priority again with Forge’s actionable set',
        15_000,
      );
      const weaklyFrames = h.emitted.filter(
        (e) => e.seat === a.seat && (e.envelope.frame as { method?: unknown }).method === 'setWeaklySelectable',
      );
      expect(weaklyFrames.length, 'Forge must publish its actionable set to this seat').toBeGreaterThan(0);

      const offeredNow = a.live.weaklySelectable!;
      const second = me(a).hand?.find(isMountain);
      expect(second, `the actor must still hold a second Mountain — hand ${JSON.stringify((me(a).hand ?? []).map((c) => c.card.name))}`).toBeDefined();
      // A second land in one turn: Forge does not name it, so clicking it
      // cannot work. The face is NOT missing a button — R10 (wave 35) made
      // `.board-card__face` always a `<button>` (so a creature tapping to
      // attack never unmounts the subtree); what makes a non-offered card
      // unclickable is that Board draws it with no offered affordance
      // (no `data-selectable` on `[data-board-card]`) and no `onClick`
      // (Board.tsx), so a click on its face sends nothing.
      expect([...offeredNow].includes(second!.id), `Forge's actionable set was ${JSON.stringify([...offeredNow])}`).toBe(false);
      expect(isOffered(roots[a.seat]!, second!.id), `card ${second!.id} must not be drawn as an offered affordance`).toBe(false);
      const secondButton = cardButton(roots[a.seat]!, second!.id);
      expect(secondButton, `card ${second!.id}'s face must still exist in the DOM (R10, wave 35 — the face is always a button)`).not.toBeNull();
      const repliesBeforeInertClick = a.live.stats.replies;
      fireEvent.click(secondButton!);
      expect(a.live.stats.replies, 'clicking a card Forge does not offer must send nothing').toBe(repliesBeforeInertClick);
      console.log(
        `[board-play.jvm] at turn-${a.live.view!.turn} priority Forge named ${JSON.stringify([...offeredNow])}; the second Mountain ` +
          `${second!.id} is not among them, is drawn with no offered affordance, and a click on its face sent nothing` +
          `${offeredNow.size === 0 ? ' — but Forge named NOTHING here, so this instant does not tell a land apart from anything else' : ''}`,
      );
      phase1Checked = true;

      // 3. Next turn: a targeted spell, the target chosen by clicking a seat.
      await drive(phase2Done, 'Shock at the opponent by clicking');
      const t = targeting as LiveSelectables | null;
      expect(t).not.toBeNull();
      // Two untapped Mountains: which to tap is a real choice, so the shortcut
      // stays out and a CLICK on a land is what paid for Shock.
      expect(clicked.shockPaid, 'Shock was paid by clicking a land on the battlefield').toBe(true);
      const shockResolved = me(a).graveyard.some((c) => c.id === clicked.shock);
      console.log(
        `[board-play.jvm] seat ${a.seat} turn ${a.live.view!.turn}: Forge's setSelectables for Shock was ` +
          `${JSON.stringify([...t!.cards])} min ${t!.min} max ${t!.max}; the opponent's seat was clicked; Shock ` +
          `${shockResolved ? `resolved, opponent at ${opponent(a).life}` : 'on the stack'} — ${((Date.now() - started) / 1000).toFixed(1)} s`,
      );

      /*
       * The whole board agreed with Forge, card for card, at every quiet moment
       * of the run: a card was drawn with an offered affordance (`data-selectable`)
       * exactly where Forge named it and nowhere else. The face itself is always a
       * `<button>` now (R10, wave 35), so `data-selectable` — not button presence —
       * is the signal. This is the "nothing glows that cannot be clicked" claim,
       * and the `named` count is what stops it being two empty sets compared —
       * the one-shot version of this check was exactly that.
       */
      expect(parity.mismatches, parity.mismatches.slice(0, 4).join('\n')).toEqual([]);
      expect(parity.samples, `the board was never in a state that could be compared against Forge — ticks not sampled: ${JSON.stringify(parity.skipped)}`).toBeGreaterThan(0);
      expect(parity.named, `Forge named a card the seat could see in none of ${parity.samples} samples`).toBeGreaterThan(0);
      console.log(
        `[board-play.jvm] ${parity.samples} samples of the actor's board against Forge's actionable set, ` +
          `${parity.named} of them with at least one named card (widest ${JSON.stringify(parity.widest)}), 0 disagreements; ` +
          `ticks not sampled: ${JSON.stringify(parity.skipped)}; ` +
          `${weaklyFrames.length} setWeaklySelectable frames reached this seat`,
      );
      if (parity.inertLand !== null) {
        // The wave-20 claim where it is not vacuous: Forge named things, and a
        // land in hand was not one of them, and the board drew it inert.
        expect(parity.inertLand.offered, JSON.stringify(parity.inertLand)).toBe(false);
        console.log(
          `[board-play.jvm] a land Forge left out of a NON-empty actionable set: Mountain ${parity.inertLand.landId} absent from ` +
            `${JSON.stringify(parity.inertLand.forgeNamed)}, drawn inert`,
        );
      } else {
        console.warn(
          '[board-play.jvm] DID NOT HAPPEN: no sampled moment had Forge naming cards while a Mountain sat unnamed in the actor’s hand, ' +
            'so the land-specific half of the inert-card claim was not exercised this run. The card-for-card equivalence above still holds.',
        );
      }

      // Lane C's says crossed and this client holds them (display only). With
      // the shortcuts on, a match this short has still auto-passed stops for
      // the actor — the board must be able to say so.
      expect(a.live.says.length).toBeGreaterThan(0);
      console.log(`[board-play.jvm] says held by the actor: ${JSON.stringify(a.live.says.slice(-4))}`);

      /*
       * Clicks the product declined, bounded. Zero is not the assertion: a
       * stale affordance is by design (`flow.jvm.test.ts`, wave 20 `341e51d`),
       * and the drive above completing is the proof that every declined click
       * was retried and landed. A run over the bound is a product change.
       */
      expect(declined.length, `declined clicks: ${JSON.stringify(declined)}`).toBeLessThanOrEqual(DECLINED_CLICK_BOUND);
      console.log(`[board-play.jvm] clicks the product declined and this driver retried: ${declined.length} ${JSON.stringify(declined)}`);

      /*
       * Acts that left the client and that Forge did not act on, bounded. Zero
       * is not the assertion: the server forwards an act to whatever input is
       * current, so a window that closes between the render and the send loses
       * one by design. The drive completing is the proof each was made again.
       */
      expect(redone.length, `re-clicked: ${JSON.stringify(redone)}`).toBeLessThanOrEqual(REDONE_CLICK_BOUND);
      console.log(`[board-play.jvm] acts Forge did not act on, which this driver made again: ${redone.length} ${JSON.stringify(redone)}`);

      // Nothing this client sent was refused, by the server or by the bridge.
      expect(h.refused).toEqual([]);
      expect(h.raw.filter((l) => l.t === 'rejected' || l.t === 'stale' || l.t === 'fatal' || l.t === 'unsupported')).toEqual([]);
      console.log(log.filter((l) => / clicks /.test(l)).join('\n'));
      h.stop();
    },
    300_000,
  );
});
