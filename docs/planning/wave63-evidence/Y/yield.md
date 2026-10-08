# §Y — Auto Yield / Cancel Yield (AE8)

The operator: *"when it's the opponents turn the 'End turn' button should
turn to 'Auto Yield' meaning that we auto-pass on whatever the opponent plays
even if we did have a response even though the game would have given us a
chance. this is useful for hiding whether or not you have something, similar
to how plays utilize that in arena. Auto Yield should only last for that turn
and when clicking 'Auto Yield' it should turn to 'Cancel Yield' to regain the
ability to react normally."*

## The rule, as shipped

- `End Turn`'s own slot (`live-button-end-turn`, same testid in every state)
  reads **Auto Yield** on the OTHER seat's turn, off by default; a press turns
  it **Cancel Yield**, and the server auto-passes every one of this seat's
  priority windows for the rest of THAT turn — a response window with the
  other seat's spell on the stack included, whether or not this seat holds an
  answer. That hiding is the whole point: the operator's own Arena comparison.
- **Declare Blockers is exempt**, by construction, not by a special case: the
  block-ASSIGNMENT ask is never a `priority`-shaped window
  (`auto.ts`'s `readPromptFacts` — `window` is `'priority'` only for an
  `InputPassPriority` prompt), so `maybeAutoPass`'s override, gated on
  `facts.window === 'priority'` the same as `decideStop` itself, never reaches
  it. The POST-block ordinary priority stop (`COMBAT_DECLARE_BLOCKERS` phase,
  after blocks are already declared) IS a priority window and IS passed under
  the override, same as any other.
- **The override expires on the turn changing, with nothing run to time it.**
  `SeatState.autoYield` is `{ turn, on }`; `maybeAutoPass` compares `turn`
  against `s.projector.turnNumber()` (`visibility.ts`) — Forge's own
  Game-object `Turn`, off a delta every seat already receives, read fresh on
  every decision. A turn that has moved on makes the comparison fail on its
  own; no code anywhere clears the field when a turn ends. Cancel Yield (an
  explicit `on: false`) clears it at once instead, same turn or not.
- **Checked ahead of `autoPassReason`, after `s.fullControl`.** Full control's
  own short-circuit (ask everything) runs first and wins if both are on — the
  two are opposite directions of the same per-seat override slot, and full
  control's "ask me everything" is the stronger claim. `maybeAutoPass` guards
  the override with exactly `decideStop`'s own entry conditions
  (`facts.openAsks === 0`, `facts.mine`, `facts.confirmLive`,
  `facts.window === 'priority'`) plus the one new condition, `!facts.myTurn` —
  so it only ever presses a window this seat could genuinely press for
  itself, never a dead or foreign one.
- **The log row.** A normal auto-pass logs
  `{ evt: 'auto-passed', matchId, seat, phase }`; an override pass adds one
  field, `{ ..., why: 'auto-yield' }`, so the two are distinguishable without
  disturbing any existing exact-match test on the ordinary shape (none exists
  — checked by grep before adding the field).

## Why the turn number comes off the Game object, not a prompt

The first design read `Turn: N (…)` off this seat's own last `showPromptMessage`
(`auto.ts`'s `TURN_OWNER` reads the same line for a *different* fact, who
holds priority — kept there, since that is a shortcut decision this file does
not own). It mutation-tested fine against synthetic frames in `match.test.ts`
but FAILED against a real Forge jar (`yield.jvm.test.ts`, first run): a seat
that has not yet been prompted THIS turn still has last turn's number cached,
so `setAutoYield` called the instant a turn flips (exactly when a player would
reach for the button) recorded the wrong turn and the override never matched
the real window's turn number.

The fix: `SeatProjector.turnNumber()` (`visibility.ts`), reading the Game
object's own `Turn` property off the SAME per-seat delta stream every seat's
board already folds — the identical mechanism the CLIENT'S `view.turn` uses.
A browser can only show "it's the other seat's turn" (and so draw the Auto
Yield button at all) once its own state has that fact, and the server's own
per-seat projector for that same seat is, by construction, never behind what
it has already sent the browser — so this race is provably a test-sequencing
artifact, not a product one: the fix is a better TEST wait
(`yield.jvm.test.ts` waits for `s.match.seats[ALICE].projector.turnNumber() !==
null` before arming the override), but the production field moved to the
Game-object read regardless, because it is strictly more correct and no
narrower than the prompt-text read it replaced.

## Real-Forge proof (`yield.jvm.test.ts`, `w63-yield.state`)

Bob (seat 1, `ai` keys) holds two Lightning Bolts and two Mountains; alice
(seat 0, `human` keys) holds Counterspell and two untapped Islands —
`DEFAULT_STOP_POLICY`'s own "nothing to do" rule would otherwise ask her for
real the instant bob casts (she has Counterspell castable), so the auto-pass
without the override is never vacuous.

1. Alice arms auto-yield. Bob casts his first Bolt at her. The PRECONDITION
   (`forgeFrames`, what Forge itself sent her, before the server decides) shows
   Forge really did open `Priority: alice … Stack: 1 to Resolve.` with a live
   bar. The CLAIM (`s.sent`, what reached her wire) shows zero `updateButtons`
   frames for the whole span — not a disabled correction, nothing. The log
   carries `{ evt: 'auto-passed', seat: 0, phase: 'Main phase, precombat', why:
   'auto-yield' }`. The Bolt resolves; her life drops 20 → 17.
2. The match is driven on, through alice's own turn 2 and into bob's turn 3 —
   nothing re-arms or cancels the override. Bob casts his second Bolt at her.
   This time her wire DOES carry a live bar (`aliceBars(...).length > 0`); her
   life drops 17 → 14 only once that bar is pressed.

Mutation: forcing `yieldsNow` to `false` unconditionally in `maybeAutoPass`
fails step 1's wire-silence assertion (a real `updateButtons` with
`enable1: true, label2: 'End Turn'` reaches alice) — confirmed against the
real jar, not just the synthetic `match.test.ts` pins.

## Client

`LiveBoard.tsx`'s End Turn slot: on the OTHER seat's turn (`whoseTurnNow ===
'theirs'`, read off `view.activePlayerId`, the same fact the phase rail
already uses) the slot is `yieldMode`, labelled `Auto Yield`/`Cancel Yield`
off `isAutoYieldOn(match)` (`live/match.ts`), `data-yield="off"/"on"`,
pressable whenever `!spectator` — NOT gated on Forge's own bar or an open ask,
because the whole point is pressing it before Forge has shown anything this
turn. `setAutoYield` sends `forge:auto-yield` (no ack; the override's own
lifetime is one turn, so a reload simply draws it off, the same "off" a turn
that has already moved on would show anyway) and records the CURRENT
`view.turn` client-side; `isAutoYieldOn` compares that against `view.turn`
again on every read, the same lazy per-turn compare `attackIntents` already
uses — nothing runs when the turn changes, on either side of the wire.

## What this lane did NOT touch

- `packages/shared/src/*` — listed in the lane's own row as "(the envelope)",
  but the envelope `forge:auto-yield` needed is the SAME one-event,
  `{ matchId, on }` shape `forge:full-control` already established in
  `transport.ts` (both copies), not anything in the shared draft-wire
  package. Nothing there carries this preference; nothing there changed.
- `auto.ts` — read (`readPromptFacts`), never written; the override lives in
  `match.ts` as the brief's own row says.
- No server→client echo for `forge:auto-yield` (unlike `forge:full-control`).
  A reload mid-override simply draws the button off — the override's own
  lifetime is one turn, so this is the same "off" a turn that has already
  moved on would show regardless, and the operator never asked for it to
  survive a refresh. Recorded as a decision, not an oversight: the brief did
  not ask for an echo and `forge:stop-preference` already established the
  no-echo precedent for a preference with no server-side state the client
  needs told back.
