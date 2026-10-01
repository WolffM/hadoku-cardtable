# Q5 — skipped phases crawl, scoped to End Turn

Lane S, wave 32. `apps/server/src/play/endturn.jvm.test.ts` against a real Forge (w31 jar).

Forge's own sleep: `PlayerControllerHuman.chooseSpellAbilityToPlay` waits `phasesDelay` (about
205 ms) at every phase an auto-passing player is not set up to skip, unless `YIELD_SKIP_PHASE_DELAY`
is true (`:1685-1691`). The only auto-pass the bridge ever starts is End Turn (`InputPassPriority.
onCancel` -> `autoPassUntilEndOfTurn`); every other pass is our server clicking a live prompt, which
sleeps nowhere. So the sleep shows only after an End Turn, and the operator's scope is "off while the
End Turn yield runs, on after".

## The change

`PlayBridge.java` `SeatGui`: the `selectButtonCancel` act, when button 2 is Forge's own `End Turn`
(label and enabled), first sends `SetYieldPref(YIELD_SKIP_PHASE_DELAY, true)` (same channel, so Forge
applies it before the click). The next `Priority:` prompt the seat is shown means no yield is
running (a real input), and flips it back to `false`. Each match is its own JVM and each seat has its
own `YieldController`, so it is per seat. Nothing is set globally, and no Forge file changed.
Both flips are reported as `{t:'pace', seat, skipPhaseDelay}` bridge lines (`host.ts`, logged by
`Match`).

## Measured (real Forge, seed 32, 40 Mountains each)

Gaps between consecutive `Phase` changes after the End Turn click, up to the end step:

| | gaps (ms) |
| --- | --- |
| with the change | 11, 7, 10, 5 (phases: Beginning of Combat, Declare Attackers, End of Combat, Main 2, End step) |
| reverted (no `SetYieldPref` on the click) | 211, 208, 210, 206 |

`pace` lines: `[true, false]`, both for the End Turn seat only: on at the click, off 64 ms later at
the next real window (the other seat's turn).

## Mutation counts (`endturn.jvm.test.ts`)

- click no longer sends the preference: **reverted fails 1 / restored passes 1** (gaps 206-211 ms).
- the lift removed: **reverted fails 1 / restored passes 1** (`pace` lines `[true]` only).

## What was NOT verified

"A pass that is not an End Turn still paces" is covered as: the preference reads `false` again
(the `pace: false` line) and the other seat never gets one. No pass other than End Turn sleeps in
this server's configuration to measure a gap against, so there is no gap to assert for it.
