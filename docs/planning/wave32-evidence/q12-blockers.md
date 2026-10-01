# Q12 — "i was not able to assign blockers at all"

Lane S, wave 32. Reproduced against a **real Forge** (w31 jar), one file at a time:
`apps/server/src/play/blockers.jvm.test.ts`, which drives a real attack with
`apps/server/src/play/scenario.ts`.

## Verdict

**Not summoning sickness, and not the client. The server pressed OK for the defender.**

A summoning-sick creature can block, and Forge says so: in the reproduction the defender's
only creature carries `Sickness: true` (it arrived on its own last turn) and Forge offers it
as a blocker. What ended the block input was our own `match.ts` auto-pass.

## The mechanism

Forge's inputs do not agree on the ORDER they say things in:

- a priority window sends its **prompt, then its buttons**;
- `InputBlock` (and the payment input, which `maybeAutoPay` already handled) sends its
  **buttons, then its prompt**.

`Match.onFrame` decided a pass on every `updateButtons`, from whatever prompt the seat last
held. At the block input's `updateButtons` that prompt was still the PREVIOUS window's:
`Priority: B / Turn: 3 (A) / Phase: Declare Attackers Step / Stack: Empty`. With
`skipNonStopPhases: 'always'` and Declare Attackers not a stop on the opponent's turn, the
decision was "pass", and `selectButtonOk` was commanded onto the block input that had just
opened. Forge ended `InputBlock` and moved to the priority window of the Declare Blockers
step. The seat was never asked.

## Measured, before the fix (real Forge, `seed: 32`, two Memnite decks)

Defender seat 1, one untapped summoning-sick Memnite (`id 105`); seat 0 attacks with Memnite
`40`. Frames the defender was sent, with arrival time from the first:

```
+77ms  setWeaklySelectable []            prompt: Priority … Declare Attackers Step
+81ms  setHighlighted [card 40]          <- InputBlock opens: attacker highlighted
+81ms  setWeaklySelectable [card 105]    <- the sick Memnite IS offered as a blocker
       updateButtons [OK] [Cancel-]      <- buttons FIRST
       showPromptMessage "Select creatures to block Memnite (40) or select another attacker…"
+82ms  setHighlighted [card 40]
+82ms  clearWeaklySelectable             <- the input has ENDED
+87ms  setWeaklySelectable []
       showPromptMessage "Priority: B … Declare Blockers Step"   <- 6 ms after the block prompt
```

The block prompt lived **6 ms**. 600 ms later the defender's prompt was the Declare Blockers
priority window and nothing was offered.

## Measured, after the fix

Same scenario. 600 ms after the block prompt the defender's prompt is still
`Select creatures to block Memnite (40)…`, buttons `[OK] [Cancel-]` with `enable1: true`, and
Forge's actionable set is `[card 105]` (the summoning-sick creature) with the attacker
highlighted. The block can be declared by clicking the attacker, then the blocker, then OK.

## The production log says the same thing

`m-96b0a5e2f90d` (the operator's match), `~/.pm2/logs/cardtable-out.log`. Four times, seat 0
logs `auto-passed … Declare Blockers Step` a few milliseconds after the attacking seat 1 logs
its own pass, and the block prompt never reaches the browser:

| time (UTC) | seat 1 (attacker) | seat 0 (defender) | gap |
| ---------- | ----------------- | ----------------- | --- |
| 04:58:10 | `.599` Declare Attackers Step | `.609` Declare Blockers Step | 10 ms |
| 05:01:16 | `.582` Declare Attackers Step | `.587` Declare Blockers Step | 5 ms |
| 05:04:15 | `.192` Declare Attackers Step | `.199` Declare Blockers Step | 7 ms |
| 05:07:49 | `.436` Declare Attackers Step | `.441` Declare Blockers Step | 5 ms |

A human cannot press OK on a prompt in 5 ms, so each of the four is the server's own pass,
arriving right behind the attack. The log does not record which prompt each pass was decided
on, so the production rows are consistent with the mechanism rather than a proof of it; the
reproduction above is the proof, and it fails the same way before the fix.

## The fix (server, `match.ts`)

`SeatState.passedOn`: the prompt frame a stop was last passed on. A prompt earns ONE press, so
`maybeAutoPass` returns when `s.prompt === s.passedOn`: the buttons that arrive next belong to the
input after it, and a second press would answer that input. A priority window (prompt, then
buttons) is unchanged and is decided afresh when Forge re-sends it (a new frame). The block input
(buttons, then prompt) is no longer passed. (A first version of this fix made every `updateButtons`
wait for a fresh prompt; it was replaced by this narrower rule because it could withhold a pass for
a window whose buttons arrive twice.)

## What is the client's (for lane G, via the manager)

Nothing is missing on the wire: with the server fix the block input is open, Forge's
`setWeaklySelectable` carries the defender's creature, and `setHighlighted` carries the
attacker. `boardInteraction` (`apps/ui/src/play/live/match.ts`) already unions
`weaklySelectable` and `blockTargets`, so a click on the creature and on the attacker are both
offered. G's arrows and the blue highlight (first-list item 15) can be built on that set.
Q12 itself needs no client change to start working.
