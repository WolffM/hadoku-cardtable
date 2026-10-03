# T3 re-test — the extra OK after declaring attackers still reproduces

**Brief:** `docs/planning/wave36-2026-10-03.md` §E item 3 — "declare attackers in a
scenario on the current build; if an extra OK still appears, write it up with the
frames and stop (the tracker plans it)." Re-test only, no fix attempted here.

**Ledger row** (`docs/planning/playtest-ledger.md`, T3): seen once on a half-landed
build (w35's jar offering lands, the old server not yet ignoring them); candidate
cause named was w35's own `ad2d4b7` ("auto-pass ignores your own lands"), with
"declare attackers: no extra OK" as the done-when check.

## Result: reproduces, on the current build, with a scenario that has nothing to do

Driven against `apps/server/src/play/scenarios/attackers-declared.state` (seat 0:
one untapped, non-sick Memnite, **empty hand**, Main Phase 1, uncontested) — chosen
specifically because an empty hand and nothing else on the battlefield rules out
`ad2d4b7`'s own cause (a land being offered and not ignored): there is no land, no
card, nothing `offered()` could ever return here.

Driven through the ordinary main loop (never a direct `activephase` jump — see
`scenarios/README.md`'s own warning that a jump skips Forge's live `InputAttack`
entirely) to Declare Attackers Step, declared the one creature as an attacker by
clicking it (`data-attacking` becomes `"true"`), then pressed OK for every window
that offered one until the step actually ended. Two were needed, not one:

```
declare-attackers presses:
1. "Select creatures to attack Bob or select player/card you wish to attack." | offered=[106] | cancelText=null
2. "Priority: Alice\nTurn: 1 (Alice)\nPhase: Declare Attackers Step\nStack: Empty" | offered=[] | cancelText=null
```

Press 1 is legitimate: it is the declaration itself (the board's own "select
creatures…" instruction, with the creature — id 106 — still offered). Press 2 is
the finding: a SECOND priority stop, still inside `COMBAT_DECLARE_ATTACKERS`,
after the attack is already declared, with:

- `offered=[]` — nothing on the board is actionable, at all;
- `cancelText=null` — no second button either (no "End Turn", no "Call Back");
- the message is the ordinary `Priority: Alice … Stack: Empty` line, not a new
  question — nothing changed that would justify asking again.

This is a priority window with nothing in it, requiring a manual press before
Declare Attackers Step can end — the shape the operator called "an extra OK after
declaring attackers that makes no sense." `ad2d4b7`'s fix (ignoring the active
seat's own lands in the actionable set) does not reach this case: there are no
lands here to ignore, so whatever is still stopping this window is a different
cause than the ledger's candidate.

**Pre-combat, for completeness:** one ordinary OK got alice from Main Phase 1 into
Declare Attackers Step (`"pre-combat OK (Priority: Alice\nTurn: 1 (Alice)\nPhase:
Main phase, precombat\nStack: Empty)"`) — expected, not part of the finding.

## Not diagnosed further (re-test only, per the brief)

Why Forge/the server still stops this window — `auto.ts`'s `decideStop`/
`autoPassReason`, or Forge's own `InputPassPriority` reconsidering priority after
a declare — was not traced; the brief asked to re-test and stop, not fix. Carried
back to the tracker as **T3 still open**.

## Reproduction

A test for this was written in `e2e/w36.spec.ts`, run (the frames above are its
console output), and then taken back out before this lane's changes were handed
to the manager — per the brief's "write it up… and stop", not pinned red as a
permanent spec, since that would assert a claim this wave never made (fixing T3
is the tracker's to plan). To reproduce: scenario `attackers-declared`, declare
the one creature, count enabled-OK presses inside `COMBAT_DECLARE_ATTACKERS`
after the declaration — exactly the sequence this file's own log shows.
