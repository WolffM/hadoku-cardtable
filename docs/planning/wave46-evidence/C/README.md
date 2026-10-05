# X2 — "had to click twice for declaring blockers?"

**Verdict: it WAS a bug. Fixed in `auto.ts` via a new policy field,
`blockStopIsTheDeclaration`.**

(This file's first version concluded "not a bug" — wrong. The manager caught
it: this directory's own `idle-blocker.json`, from that first version,
already showed the real stop — `kept`, `sources: 0, nonLandSources: 0`,
`buttons: [true, true]` — at `COMBAT_DECLARE_BLOCKERS` AFTER the block was
declared. The investigation below is the corrected one.)

## The ask

Playtest 8, the operator, 2026-10-05: *"had to click twice for declaring
blockers? probably not a bug but just make sure."*

The tracker's reading of a real match's bridge log (`m-234c5f46dd94`, its run
dir gone by the time this lane started) found two `OK`s from the DEFENDER
around one attack: one during `COMBAT_DECLARE_ATTACKERS`, a second confirming
the block.

## What was actually wrong

The window the tracker named, `COMBAT_DECLARE_ATTACKERS`, was already
correct: it is outside `stopOnTheirTurn` and `skipNonStopPhases: 'always'`
skips it whatever the seat could do there — confirmed directly against a real
Forge match in both an idle and a reactive (castable instant + mana) variant,
and pinned in `auto.test.ts`.

The real bug was one phase later: the ordinary `COMBAT_DECLARE_BLOCKERS`
priority window Forge opens for the defender right AFTER the block is
assigned was a HARD STOP whatever the seat could do there. `isStopPhase`
names the phase (`stopOnTheirTurn` includes it, by design — blocking is a
decision, not a wait), and nothing but `skipEmptyBlockStop`'s DIFFERENT shape
(no creature at all) ever let it go. A defender holding nothing castable
still had to press OK a second time for no reason — confirmed against a real
Forge match (`w46-block-stop.jvm.test.ts`'s idle variant, before the fix:
exactly this second click, `kept`/`sources: 0`/`buttons: [true, true]`).

## The fix

`StopPolicy.blockStopIsTheDeclaration` (`auto.ts`), the non-active seat's
mirror of `attackStopIsTheDeclaration` (T3, wave 24/28): a new `blockStopIsDone`
function, parallel to `attackStopIsDone`, lets the post-declare priority
window at `COMBAT_DECLARE_BLOCKERS` fall through to `passWhenNothingToDo`
instead of being forced to a stop — but ONLY when `facts.creatures` is a
KNOWN, non-zero count (the declaration genuinely already happened). An
unknown creature count, or zero creatures, is untouched and keeps going
through the existing `blockStopIsEmpty` path exactly as before — Q10's own
invariant ("no creatures, no block", never a function of what the seat holds)
is unaffected.

The block-select input ITSELF is untouched and was NEVER passed, before or
after this fix: it is a `getChoices`-shaped `other` window, not a `Priority:`
one, so `decideStop`'s own `window !== 'priority'` guard refuses it
regardless.

Default policy: `true`. Full control: `false` (keeps every stop, as it keeps
every stop everywhere else).

## Real-Forge proof (`w46-block-stop.jvm.test.ts`)

Two scenarios, both landing at the attacker's own, UNDECLARED Main Phase 1 so
Forge's real `InputAttack` paces combat (see "a harness note" below for why):

- **idle** (`w46-c-blocker-idle.state`) — the defender holds one untapped,
  non-sick blocker and nothing else. **ONE click**: declare the block. The
  priority window right after is silently auto-passed now.
- **reactive** (`w46-c-blocker-reactive.state`) — the defender ALSO holds
  Lightning Bolt and an untapped Mountain. **TWO clicks**: declare the block,
  then the priority window right after — correct Magic, a held response is
  still castable once blocks are locked in.

Neither variant ever shows a stop during `COMBAT_DECLARE_ATTACKERS`, before
the block-select window opens — the `stop-decided` trace shows that window
`auto-passed` for the defender in both variants, even in the reactive one
where `sources: 2, nonLandSources: 1` prove Lightning Bolt and its Mountain
really were offered there too (a separate, correct finding from the same
investigation, pinned in `auto.test.ts` alongside the fix).

Run 3 times in a row after the fix: both tests green every time (`idle-
blocker.json`/`reactive-defender.json` are evidence from the last of those
runs).

## Readers adapted

- **`apps/server/src/play/blockers.jvm.test.ts`** (existing file, NOT owned by
  this lane otherwise — edited because the fix broke it): Q12's final wait,
  `await waitUntil(() => /Declare Blockers Step/.test(s.prompt(defender)), …)`,
  raced against the SAME window this fix now auto-passes: with nothing else
  castable for that defender, the window can resolve fast enough that a 25ms
  poll checking only the CURRENT prompt text sails past "Declare Blockers
  Step" to whatever phase comes next, never observing the text it was
  waiting for. Reproduced directly (timed out identically, 2 separate runs,
  at low-to-moderate host load, where contention cannot be blamed). Fixed by
  also accepting the server's own `auto-passed` log line for `Declare
  Blockers Step` as equally valid proof the window was reached and answered
  — a durable, non-racy signal, same one this lane's own suite already relies
  on. Verified green 3 times in a row after the fix, and as part of the full
  5-suite run.
- **`scenario-blockers.jvm.test.ts`, `scenario-combat.jvm.test.ts`,
  `endturn.jvm.test.ts`, `priority.jvm.test.ts`**: NOT edited. Read in full;
  none presses OK past a `COMBAT_DECLARE_BLOCKERS` window in a way this fix
  changes. `scenario-blockers.jvm.test.ts`'s own Q12 flaked under host
  contention (shared heavy.lock, a sibling wave's JVMs running concurrently)
  on several runs — reproduced the IDENTICAL failure against this file
  UNCHANGED, and it passes reliably once load drops (confirmed directly,
  load 2.5–3.7 vs. 7–10 when it failed). Pre-existing characteristic of the
  shared scenario harness (a sub-25ms window the block-select input itself
  can resolve in, independent of this fix), not a regression.
- **e2e specs** (`git grep -n "declare\|block" e2e/*.spec.ts`): analysed, NOT
  run (wave deadline). `e2e/w33.spec.ts`'s Q12 test (`one-creature.state`)
  only asserts the block gets made (`data-blocking`); it never presses
  anything or asserts on a window after that, so it is unaffected by
  construction. `e2e/w46-attack.spec.ts` (lane B's file) scripts the defender
  with NO creature (Jace is a planeswalker), so it runs through
  `skipEmptyBlockStop`'s unaffected path, not this one. `e2e/table-fit.
  spec.ts`'s generic combat-declare wait presses OK on whatever is enabled
  for EITHER seat while waiting past `COMBAT_DECLARE_BLOCKERS`; it is robust
  to one fewer required click, not broken by it. None of these were executed
  against a live build before the deadline — flagged here instead of silently
  assumed safe.

## Mutation testing

- Full revert of `auto.ts` to the committed (pre-fix) version:
  `auto.test.ts` → 3 failures (the field-by-field `DEFAULT_STOP_POLICY`
  equality check and the new wave-46-§C case, exactly as expected). Restored
  → 174/174 green again.
- Earlier, narrower mutation (adding `COMBAT_DECLARE_ATTACKERS` to
  `stopOnTheirTurn`, testing the OTHER finding in this investigation):
  `auto.test.ts` → 4 failures; `w46-block-stop.jvm.test.ts` → both tests
  fail/hang (the attacker-adjacent window becomes an unanswered real stop).
  Restored → both green.

## What could not be verified

- The original match `m-234c5f46dd94`'s own board state and exact timing —
  its run directory was already gone when this lane started, so whether its
  defender held anything castable (which variant it actually matched) could
  not be confirmed. The fix is verified against both shapes regardless.
- The e2e readers listed above were analysed by reading their source, not
  run against a live build, because of the wave's hard deadline.
- `pnpm run check` (no jar env) was run once, full repo: one unrelated
  failure, `apps/ui/src/play/live/parity.test.ts`'s fixture-markup hash
  (lane A's concurrent `Board.tsx` work, nothing this lane touched). Not
  re-verified after that lane's own changes land.
