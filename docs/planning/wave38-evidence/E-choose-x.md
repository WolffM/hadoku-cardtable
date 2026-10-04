# E-choose-x — the X spell resolved with zero targets, not X=4 on bob (w38 §E item 3)

**Now true:** the Choose X spec's own drive loop no longer locks in "zero targets" before it has had
a chance to click bob — life drops by exactly the announced X.

## What was targeted and what X Forge recorded

`gh run download 37171407975 -R WolffM/hadoku-cardtable -n forge-e2e-evidence-1`, stack `Iom2Us`,
match `m-3a4c44ab1756`. The **entire** 545-line server log for this match carries exactly four
`ask-answered`/`ask-auto-answered` lines, all within 120ms of match start:

```
ask-answered     s0-1 getAbilityToPlay ms:8      (casting Fireball — clickHandCard)
ask-auto-answered s0-2 getAbilityToPlay (forge re-asked its own already-answered one — S4)
ask-answered     s0-3 getChoices       ms:86     (the X announce — Fireball's X is wire-shaped as
                                                   a `getChoices` over consecutive integer labels,
                                                   `rules.ts`'s `numericChoiceRange`; this IS the
                                                   slider's own submit)
ask-answered     s0-4 openZones        (self-answering, unrelated)
```

**No further ask of any kind appears for the rest of the match** — in particular, no
`chooseEntitiesForEffect`/`chooseSingleEntityForEffect` for targeting. Per the established
convention this codebase already documents twice (`w33.spec.ts`'s Doom Blade comment, `w35.spec.ts`'s
Thoughtseize comment): **choosing a card or player target is never a modal ask** — it is a plain
board `data-selectable` state with the control bar's OK gating on whether the minimum is met. So X
genuinely was announced and paid as **4** (the `s0-3 getChoices ms:86` round trip, and the final
page snapshot confirms Fireball resolved — it is in alice's graveyard), and the **target** step was a
board-level selection the generic drive loop was racing against, not a modal ask it stole.

The final DOM snapshot shows **both** players still at life 20, and bob's library at **0** (he had
decked and the result badge read "lost") — several turns had elapsed past the cast, which only
happens if targeting completed with the match still running, not if it ever actually hung.

## Root cause

`w34.spec.ts`'s Choose X test loop called `page_answerOnce(alice.page)` (which clicks the control
bar's OK when it is enabled) in its `else` branch whenever `targetPlayer.count()` was not yet `> 0` —
but Fireball's target step is `TargetMin$ 0` ("any number of targets"), so the control bar's OK is
**already enabled** the instant the target-selection board state opens, before the board necessarily
renders bob's `[data-selectable]` on the very same tick the test checks for it. The loop's own
`else` branch raced ahead and answered "zero targets" (a legal, complete answer for a `min=0` ask)
before the `!targeted` branch ever got to click bob — the exact bug class `w35.spec.ts`'s own
Thoughtseize-targeting comment already names and guards against (*"Calling [the generic answer]
unconditionally here answered [the ask] before this spec's own … read ever ran"*), just not yet
applied here.

## Fix (`e2e/w34.spec.ts`, the Choose X test's drive loop)

The `else` branch only drains generically once `targeted` is already `true`. While `!targeted` and
`targetPlayer` is not yet selectable, the loop does nothing that tick (no OK-click) rather than
risk locking in zero targets — it just waits for the next 40ms tick and checks again.

## Mutation proof

This is a genuine timing race, not a deterministic logic error: whether `targetPlayer` renders
selectable before or after the control bar's OK becomes enabled depends on exactly when, within one
server push, the DOM commits each. It does not reproduce on every attempt even with the bug present
— measured directly below, rather than assumed from one result (an earlier single-run attempt
passed even with the bug in place, which is why this was widened to 5 reverted runs rather than 1).

- **Reverted (unguarded `else`, clicks OK regardless of `targeted`): 5 runs, 1/5 FAIL** (life stays
  at `lifeBefore` instead of dropping by X — the exact shape observed in CI, `Iom2Us`/run
  37171407975; the other 4 passed — the race, present but not won every attempt, consistent with it
  having slipped past every CI run before this one too).
- **Restored (guarded `else`): 3 runs, 0/3 FAIL — 3/3 PASS** (life drops by exactly the announced X
  every time; 9.4s–12.3s each, real Forge, not a skip).

(An earlier attempt at this same proof hit `EADDRINUSE` on 2 of its runs from a CI push stealing
the fixed ports mid-script — infrastructure noise, not a code result; re-run above with a port-wait,
settle delay, and re-check before every invocation.)
