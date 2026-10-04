/*
 * Wave 36 T4 — `isConfirmPrompt` against a REAL Forge match, real engine
 * proof as the brief requires: the mulligan's Keep/Mulligan and a shockland's
 * "pay 2 life?" both satisfy it, and an ordinary priority pass does not.
 *
 * Uses the server's own scripted-scenario harness (`apps/server/src/play/
 * scenario.ts`, already a test-support import for this directory —
 * `choose-x.jvm.test.ts` imports it the same way) so the shockland is
 * GUARANTEED in hand rather than hoped for from a shuffled deck: the inline
 * `[state]` text below (the same format `apps/server/src/play/scenarios/
 * *.state` uses, see that directory's README) hands seat 0 one Steam Vents
 * and nothing else, landing straight on an uncontested turn-1 Main Phase 1 —
 * the same shape `land-into-middle.state`/`secluded-glen.state` use. This
 * file does not add a `.state` file under `apps/server/` (out of this lane's
 * files); `startScenario`'s `scenario` option takes the text directly.
 *
 * **Ordering, measured against the real jar, not assumed:** the coin toss's
 * own "would you like to play or draw?" is the FIRST bar either seat ever
 * sees (`GameAction.determineFirstTurnPlayer` picks a winner, then
 * `PlayerControllerHuman.chooseStartingPlayer` asks ONLY the winner —
 * `ConfirmPrompt.tsx`'s own header) — the mulligan's Keep/Mulligan comes
 * SECOND, once play/draw is answered (`MulliganService.runPlayerMulligans`'s
 * message even reads "you are going first!", which only makes sense once a
 * starting player is already settled). A first draft of this test waited for
 * "keep your hand" before pressing anything and timed out at 30 s sitting on
 * the un-pressed play/draw bar — this is that finding, corrected.
 *
 * So this presses through EVERYTHING except seat 0's own Keep/Mulligan bar
 * (by label, not by a generic "press everything" helper — `keepHands()` in
 * `scenario.ts` would press straight through the very bar this test needs to
 * capture unpressed), captures that bar, keeps both hands, then lets the
 * scripted state land.
 *
 * Skips visibly without CARDTABLE_FORGE_JAR / CARDTABLE_FORGE_RES, like every
 * other jar-gated suite in this directory.
 */

import { describe, expect, it } from 'vitest';

import { available, deck, finishMulligan, startScenario, waitUntil, type Scenario } from '../../../../server/src/play/scenario.ts';
import { isConfirmPrompt } from './ConfirmPrompt.tsx';

const title = available.ok
  ? 'isConfirmPrompt against a real Forge match: mulligan, a shockland’s pay-life, and a priority pass'
  : `isConfirmPrompt against a real Forge match — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Confirm A', ['40 Mountain']), deck('Confirm B', ['40 Mountain'])];

// Seat 0 holds exactly one Steam Vents and nothing else, an uncontested
// turn-1 Main Phase 1 — the same shape `land-into-middle.state` uses. No
// blank lines (`GameState.splitLine` reads `line.charAt(0)` unconditionally).
const SHOCKLAND_STATE = [
  'turn=1',
  'activeplayer=human',
  'activephase=MAIN1',
  'humanlife=20',
  'ailife=20',
  'humanhand=Steam Vents',
  'humanbattlefield=',
  'humanlibrary=Mountain;Mountain;Mountain;Mountain;Mountain;Mountain',
  'humangraveyard=',
  'aihand=',
  'aibattlefield=',
  'ailibrary=Mountain;Mountain;Mountain;Mountain;Mountain;Mountain',
  'aigraveyard=',
].join('\n');

const KEEP_YOUR_HAND = /keep your hand/i;

/**
 * Press OK on anything that is not a priority window and not seat 0's own
 * Keep/Mulligan bar — the coin toss's play/draw (whichever seat the toss
 * gave it to) and seat 1's own Keep/Mulligan both get pressed; seat 0's
 * Keep/Mulligan is left open for the caller to read. Same frame-index
 * bookkeeping as `scenario.ts`'s own `keepHands()`, so a bar already
 * answered this call is never pressed twice while the wire catches up.
 */
function pressExceptSeat0Mulligan(s: Scenario, handled: Set<number>): void {
  for (const seat of [0, 1] as const) {
    const at = s.sent
      .map((x, i) => (x.seat === seat && x.envelope.frame.method === 'showPromptMessage' ? i : -1))
      .filter((i) => i >= 0)
      .pop();
    if (at === undefined || handled.has(at)) continue;
    const msg = (s.sent[at]!.envelope.frame as unknown as { message: string }).message;
    if (msg.startsWith('Priority:')) {
      handled.add(at);
      continue;
    }
    if (seat === 0 && KEEP_YOUR_HAND.test(msg)) continue; // leave it — the caller captures this one
    if (s.buttons(seat)?.enable1 !== true) continue;
    handled.add(at);
    s.ok(seat);
  }
}

describe.skipIf(!available.ok)(title, () => {
  it(
    'Keep/Mulligan and a shockland’s pay-2-life are both isConfirmPrompt; an ordinary priority pass is not',
    async () => {
      if (!available.ok) return;
      const s = await startScenario(available.config, { seed: 3601, decks: DECKS, scenario: SHOCKLAND_STATE });
      try {
        // 1) Press through the coin toss (and seat 1's own mulligan, if it
        // comes up first) without touching seat 0's Keep/Mulligan bar, then
        // capture that bar — Forge's own `InputConfirmMulligan.java:74`.
        const handled = new Set<number>();
        await waitUntil(
          () => {
            pressExceptSeat0Mulligan(s, handled);
            return s.buttons(0) !== null && KEEP_YOUR_HAND.test(s.prompt(0)) && s.buttons(0)!.enable1 === true;
          },
          "seat 0's Keep/Mulligan bar",
          30_000,
        );
        const mulliganBar = s.buttons(0);
        expect(mulliganBar).not.toBeNull();
        expect(mulliganBar!.label1).toBe('Keep');
        expect(mulliganBar!.label2).toBe('Mulligan');
        expect(isConfirmPrompt(mulliganBar)).toBe(true);

        // 2) Keep seat 0's hand too, then let `finishMulligan` mop up
        // anything left (ordinarily nothing — both seats are already past
        // their own mulligan by this point). `GameState.applyToGame` runs
        // right after the mulligan step, before either seat gets priority.
        s.ok(0);
        await finishMulligan(s);
        await waitUntil(() => s.zone(0, 'Hand').some((c) => c.name === 'Steam Vents'), "seat 0's hand to reflect the scripted Steam Vents", 20_000);

        // 3) The ordinary priority bar at that Main Phase 1 — OK + End Turn
        // (`InputPassPriority.java:174`) — is NOT a confirm.
        const priorityBar = s.buttons(0);
        expect(priorityBar).not.toBeNull();
        expect(/^Priority: /.test(s.prompt(0))).toBe(true);
        expect(priorityBar!.label1).toBe('OK');
        expect(isConfirmPrompt(priorityBar)).toBe(false);

        // 4) Play Steam Vents — its ETB replacement asks "pay 2 life?" through
        // `InputConfirm`'s own default Yes/No (`InputConfirm.java:51,108`,
        // reached via `confirmReplacementEffect` → `confirmPayment` →
        // `HumanCostDecision.visit(CostPayLife)`, all non-libgdx on this
        // bridge — see `ConfirmPrompt.tsx`'s own header for the full chain).
        const land = s.zone(0, 'Hand').find((c) => c.name === 'Steam Vents');
        expect(land, 'no Steam Vents in the scripted hand').toBeDefined();
        s.select(0, land!.id);
        await waitUntil(
          () => {
            s.answerAsks(); // drains any incidental ask (e.g. a single-option getAbilityToPlay) so the game thread reaches the replacement effect
            return /life/i.test(s.prompt(0)) && s.buttons(0)?.enable1 === true && s.buttons(0)?.enable2 === true;
          },
          'the shockland’s pay-2-life question',
          20_000,
        );
        const payLifeBar = s.buttons(0);
        expect(payLifeBar).not.toBeNull();
        expect(payLifeBar!.label1).toBe('Yes');
        expect(payLifeBar!.label2).toBe('No');
        expect(isConfirmPrompt(payLifeBar)).toBe(true);

        // Still unresolved — the game thread is genuinely parked on the
        // question, not decided for the seat.
        expect(s.zone(0, 'Battlefield').some((c) => c.name === 'Steam Vents')).toBe(false);
      } finally {
        await s.stop();
      }
    },
    90_000,
  );
});
