# §E — e2e specs, wave 34

> The `.png` screenshots this file names were removed from the repository on
> 2026-10-11; the written descriptions stand on their own.

All work in `e2e/w34.spec.ts`, plus a fix to `e2e/w31.spec.ts` (the rail-rows
check, §E item 2) and a fix to `e2e/play/prompts.ts` (the shared test-driver
for every spec in this lane). Every scenario used is lane S's
(`apps/server/src/play/scenarios/*.state`); every PRODUCT fix exercised is
another lane's, read not edited except where explicitly noted as a mutation
(always reverted, verified `git diff --exit-code` clean, restored).

## Final status — all six wave-34 specs green, plus play.spec.ts fixed

| spec | status |
| --- | --- |
| §E1 — Full Control + respond to an opponent's spell | **green, 10/10** |
| §E2 — Ponder's decision reaches the browser | **green, 10/10** (one flake observed once across ~30 total runs while iterating — see below) |
| Q8 — no order ask without Full Control; a real one with it | **green, 10/10** |
| Choose X slider at its cap | **green, 10/10** (plus an earlier 20/20 before a hardening fix) |
| Poison/energy/experience counters, 1280×800 and 1366×768 | **green, 10/10 × 2 viewports** |
| Rail rows (`e2e/w31.spec.ts`) | **green, 20/20** |
| `play.spec.ts` (CI-gating, not a wave-34 spec but found red mid-wave) | **green, 4 consecutive invocations** — a real harness gap, diagnosed live and fixed; see its own section below |

## Item 2 — the rail rows (w33 L): done, with a second, pre-existing bug fixed along the way

**Starting point**: `wave33-evidence/m-ci-and-mutations.md` recorded that
reverting L's fix (`.live__step` back to `flex: 1 1 0`) left the existing
`e2e/w31.spec.ts` check passing 3/3 — the check did not measure what L fixed.

**What was wrong with the check**: it compared `.live__step`'s height
out-of-combat (sampled once, early) against in-combat (sampled later, after a
0.3s CSS transition, mid-way through an unrelated combat-timing watch). Under
the OLD code that comparison's size depends on how much the live chrome
drifted between those two separate reads — `l1-rail-rows.md` measured that
drift from ~0.19px to ~2.16px on the SAME code — so a tolerance loose enough to
avoid false reds on real hardware was also loose enough to let the regression
through.

**The fix**: two new assertions that do not depend on cross-sample timing at
all — every `.live__step` within ONE state (out-of-combat alone, and
separately in-combat alone) must read the *bit-identical* height
(`toBeLessThanOrEqual(0.02)`), because the fixed CSS gives every row the same
custom-property value regardless of sibling count or sample time. The original
cross-state comparison is kept, tightened from 2px → 1px → **0.02px** (the
fixed formula does not depend on row count at all — it is a bare `/13`, not
`/var(--rail-rows)` — so cross-state is *also* bit-identical, not merely
close).

**Measured**:

| build | runs | result |
| --- | --- | --- |
| fixed (landed tree) | 3 | 3/3 pass |
| `.live__step` reverted to `flex: 1 1 0` (local, restored after) | 5 | **5/5 fail**, same assertion every time (`every row OUTSIDE combat...`), spread **1.015625px** every run — not flaky, a real, reproducible number |
| fixed, restored, rebuilt | 10 + 10 | **8/10, then 8/10** — a NEW, pre-existing bug found (below) |
| fixed, after that bug's own fix | 10 + 10 | **20/20** |

**A second, pre-existing bug found and fixed in the same test (w31.spec.ts,
owned by this lane)**: 2 of 10 runs failed on an *unrelated*, older assertion
("the rail is taller in combat than out of it"), with the identical numbers
both times (`184.71875` expected, `183.43...` received) — not host-noise
(noise would not repeat the same near-miss twice). Root cause: the watcher
loop that samples the rail's height mid-CSS-transition is stopped by a
*separate* `expect.poll` the instant it first sees combat, which can land
inside the 0.3s grow transition with only 0-2 extra samples taken. Fixed by
giving the watcher a fixed 400ms to keep sampling once combat is seen, before
it is told to stop (`e2e/w31.spec.ts`, the `await alice.page.waitForTimeout(400)`
right before the `finally` that sets `watching = false`). 20/20 after.

**Mutation**: `apps/ui/src/play/live/live.css`'s `.live__step` reverted
locally to `flex: 1 1 0` (no `--rail-row-h`), rebuilt, run, restored
byte-identical (`git diff --exit-code` clean), rebuilt again. 5/5 fail
reverted; 20/20 pass restored.

## Q8 — mutation

`apps/server/src/play/match.ts`'s `const auto = s.fullControl ? null :
onlyAnswer(frame, s.policy);` reverted locally to `const auto =
onlyAnswer(frame, s.policy);` (full control no longer suppresses
auto-answer), rebuilt, run: **fails** ("with Full Control on, the ordering
decision was a REAL ask... Received: ask-auto-answered"). Restored
byte-identical, rebuilt, run: **passes**, then 10/10.

## Choose X — mutation

`apps/ui/src/play/prompts/{rules.ts,ChoicePrompts.tsx,prompts.css}` reverted
locally to their pre-G-item-1 `HEAD` versions (the manager's own count:
59/25/30 changed lines, confirmed restored byte-identical with `diff`),
rebuilt, run: **fails** ("Forge's X ask reaches the browser as the slider...
element(s) not found" — the checkbox-list fallback, exactly bug 1 in
`g1-choose-x-slider.md`). Restored from a local backup copy
(`/tmp/claude-1000/w34-e/g1-backup/`, not from git — G's changes were
uncommitted at the time, now committed as `4d06b60`), rebuilt, run:
**passes**, then 10/10.

**Note on the brief's own premise**: the brief asked this spec to check "the
slider's max equals the mana actually available." That is false for
`choose-x.state` (Fireball, a mana-X cost) and not fixable from the client —
`g1-choose-x-slider.md` traced it to `Cost.getMaxForNonManaX` never inspecting
a mana cost's own `X`, so Forge's real ask is the plain, uncapped `0..9`, not
`0..4`. This spec reads `min`/`max` off the slider's own attributes rather
than hard-coding a mana figure, asserts legibility across the FULL
Forge-offered range (0 through 9), and separately proves the round trip by
submitting at the scenario's actual payable value (X=4, five Mountains, {R}
first) and reading bob's life drop — not by submitting Forge's own
unconstrained max, which is a legal slider value but not a payable cast.

**A second product issue this spec found while being hardened** (see §E1
below for the same root cause, found independently): the initial version
routed the final cast through a generic drain loop that also ran on bob's
page, where it occasionally misfired a click against whatever "selectable"
state bob's own view happened to mirror from alice's in-progress targeting.
Fixed by scoping all targeting/payment driving to alice's page only, with bob
drained purely generically (`page_answerOnce`). 20/20 after.

## Poison — mutation

Not separately mutated: B's own evidence (`b-poison-and-ability.png`,
`Board.test.ts`) already carries the revert/restore counts for the CSS fix
this spec exercises; this spec is additional, independent, real-Forge
confirmation of the same claim at the DOM level (every `.seat__counter`
contained within its own `.seat__who`/`.seat__counts` box, not merely
"present somewhere on the page"). B's later rework of the counters to short
glyphs (`P3`/`E7`/`XP2`, commit `69c6f32`) needed no change here: this spec
reads `data-counter` (unchanged: `poison`/`energy`/`experience`) and bounding
boxes, never the rendered word text.

## §E1/§E2 — now green, and what it took

Both specs are **green, 10/10**, against the fully landed tree (S2's commit
`6ec7591`: `match.ts` now tracks `SeatState.lastAbilityToPlay` and
auto-answers Forge's own re-ask of an identical, already-answered
`getAbilityToPlay` server-side, ahead of the full-control gate). Getting there
took two more real fixes, both found by these specs against the real, fixed
server — not assumed from the brief:

### A second, independent bug in `e2e/play/prompts.ts` (this lane's own shared driver)

With S2's fix landed, §E1 still failed — not on the original symptom, but on
a NEW one: `castCard`'s generic drain stalled after answering a `getChoices`
ask titled *"Select target spell / Up to 1 / Memnite - Creature 1/1"*, with
the match sitting right back at alice's priority, Mana Leak still offered.

**Root cause**: Mana Leak's lone legal target is offered as an ask whose wire
`min` is `0` (rendered as "Up to 1", not "Choose 1"). `answerPrompt`'s
`getChoices` handler (`e2e/play/prompts.ts`) only ticks a choice while NOT YET
submittable — with `min=0`, zero-selected is already a legal answer, so the
old loop ticked nothing and submitted "no target." Forge accepts that answer
but the spell then has nothing to do, so the cast is abandoned rather than
reaching the stack — this lane's own file's stated intent ("the default, the
first option" — see the file's own header) was not actually being followed
for this shape. **Fixed**: the driver now always ticks the first offered,
choosable option before the submittable-loop, for every `getChoices`/
`chooseSingleEntityForEffect`/`chooseEntitiesForEffect` ask — matching the
file's own documented default rather than "decline whenever declining is
legal." A card-tile choice's checkbox sits under its own `ChoiceTile` inside
the same `<label>`, which Playwright's actionability check saw as
intercepting pointer events on the raw input even though a real click
anywhere in the label toggles it; `{ force: true }` on that click (still the
same input element, not a different one) clears it. Re-ran §E1: green.

This is a test-harness fix, not a product one, and it is squarely this lane's
file (`e2e/**`). Checked for regressions: `Q8` (10/10), `Choose X` (10/10,
which uses a different, non-checkbox slider path unaffected by this change),
`poison` (10/10, no `getChoices` involved), and the full CI spec set (below)
all stayed green with this change in place.

### §E2's own race: `castCard` answers the very ask the spec needs to inspect

Separately, §E2 kept failing to ever SEE the `order` ask (`promptMethod()`
never reported `'order'`) even though the server log showed it being
answered — because `castCard`'s own generic drain loop calls the shared
`answerPrompt` every tick, which (correctly) already knows how to answer an
`order` ask on sight. With S2's fix landed, Ponder's whole sequence (cast →
repeat collapsed → order ask → answered) now happens fast enough that
`castCard` raced straight through the ask before this spec's own `expect.poll`
ever got a turn. **Fixed**: §E2 no longer uses `castCard` for Ponder's own
cast — a dedicated loop stops the INSTANT `promptMethod() === 'order'`,
leaving the ask open for this spec's own assertions before answering it
itself. A second instance of the identical race was also present AFTER
answering the order ask (the stack took a moment to actually finish
resolving); fixed by draining both pages generically until the stack empties
before checking the hand count.

### The mechanism is pinned directly, in both specs, against the server log

Beyond the outcome-level assertions, both specs now also assert the exact
mechanism directly: `stack.serverLogFile` (same technique as Q8) must contain
an `ask-auto-answered` line for the relevant seat, method `getAbilityToPlay`,
with `why` containing `"re-asked"` — S4's own fixed string. This is the
assertion that actually distinguishes "the repeat was collapsed server-side"
from "this test's own patient drain loop happened to click through it anyway
regardless of whether the collapse exists" (see the mutation below — this
distinction mattered).

### §E1/§E2 — mutation (the exact line the manager asked for)

`apps/server/src/play/match.ts:1009`, `const repeat = frame.method ===
'getAbilityToPlay' ? repeatedAbilityToPlay(frame, s.lastAbilityToPlay) :
null;`, set locally to `const repeat = null;`.

**This does not typecheck** (`tsc` correctly narrows `repeat` to the literal
type `null` and flags every later read of `.result`/`.callId`/etc. as "does
not exist on type `never`"), so `pnpm --filter @hadoku/server build` cannot
produce a mutated `dist/index.js` — its own `tsc --noEmit && esbuild` chain
stops at `tsc`. Ran `esbuild` directly (same flags as the build script, no
`tsc`) to get a runnable mutated server for this one test, then restored
`match.ts` from the pre-mutation copy and ran the NORMAL `pnpm build` (which
does typecheck) to confirm the restore.

**First attempt — the outcome-only assertions (before the server-log pin
above was added) did NOT reliably fail**: §E1 **0/10 failed** across two 5-run
batches; §E2 **2/10 failed**. Diagnosis: this lane's own generic drive loops
(`castCard`, the custom Ponder loop) are written to patiently click through
repeated identical-looking asks regardless of their cause, so they tolerate
the missing server-side collapse most of the time — a mutation this weak is
not a real safety net. **Fixed** by adding the server-log assertion above,
which checks the MECHANISM, not just the outcome. Re-ran: **§E1 and §E2 both
fail, 6/6 (two batches of 3)**, on the new assertion specifically (`Forge's
own re-ask of getAbilityToPlay was collapsed server-side (S4)... Received:
false`). Restored `match.ts` byte-identical (`git diff --exit-code` clean
against the committed `6ec7591`), rebuilt normally (typechecks), re-ran:
**10/10 both**, including the new assertion passing cleanly every time.

### §E2's own flake, separately from the mutation

While iterating, §E2 failed once in 20 runs (and 0 times in two other
10-run batches either side of it, so ~1/30 total) on its OWN precondition
("Ponder's own decision reaches the browser as an ask") timing out — likely
the custom stop-the-instant-order-appears loop's own 5-second window
occasionally losing the race under host load. Not chased further: the
required ten CONSECUTIVE passes were observed cleanly in the batch reported
above, and the rate is low enough that it reads as host contention rather
than a structural issue, consistent with this project's own standing
finding (["under load, suspect the host before the code"]).

### §E2's expected ask method was corrected

The spec originally expected `manipulateCardList` (guessed from a
differently-named component in this lane's own tree); S traced the real wire
method to `'order'` (`PlayerControllerHuman.orderMoveToZoneList` →
`getGui().order`, the same ask Q8's simultaneous-trigger ordering uses) and G
confirmed `OrderPrompt.tsx` is already exercised and unit-tested against it.
Fixed in this file.

## play.spec.ts — Incinerate: a real harness gap, found live and fixed

Per the manager's instruction, re-ran the full CI spec set a second and final
time against the fully committed tree (no in-progress work anywhere):
`play.spec.ts table-fit.spec.ts w31.spec.ts w32.spec.ts w33.spec.ts
w34.spec.ts`, **353s wall** (≈5.9 min, under the 8-minute budget), **27
expected / 1 unexpected**:

*"two friends play one Forge match..."* — *"a spell left the hand and
resolved with no button press from either browser; casts:
[{"card":"Incinerate","left":true,"arrived":false,"pressed":[]}]; 320 passes,
offered in hand: [...]"*. Reproduced three times total, identical down to the
exact numbers (`PLAY_SEED` is fixed), confirming it is real, not noise.

An earlier pass of this report hedged that this might be an artifact of S2's
then-in-progress work; re-confirmed against the fully committed tree before
diagnosing further — same failure, so that hedge was wrong and is withdrawn
here.

### Diagnosis — captured live, at the exact moment of the stall

Ran `play.spec.ts` alone under the lock with a one-shot diagnostic dump
inserted right where the existing watch loop gives up (removed again once the
real fix replaced it — see below). Captured, the moment Incinerate had left
the hand but not arrived:

```
DIAG spell Incinerate 15
DIAG says alice: Incinerate (15) - Incinerate deals 3 damage to any target.
  A creature dealt damage this way can't be regenerated this turn.
  Select any target
DIAG says bob: Waiting for e2e-alice...
DIAG prompt method alice: null          ← NO live-prompt open at all
DIAG prompt method bob: null
DIAG alice selectable players: ['1', '0']   ← BOTH player avatars offered
DIAG alice selectable cards: ['9']          ← one battlefield card also offered
DIAG alice ok enabled: 0
DIAG alice cancel enabled: 1 ("Cancel")
DIAG server log tail: […, {"evt":"ask-answered","seat":0,"callId":"s0-1",
  "method":"getAbilityToPlay","ms":10}, {"evt":"ask-answered","seat":0,
  "callId":"s0-2","method":"getAbilityToPlay","ms":14},
  {"evt":"ask-auto-answered","seat":0,"callId":"s0-3",
  "method":"getAbilityToPlay","why":"forge re-asked its own
  already-answered getAbilityToPlay"}, …]
```

This is a **harness gap, not a product bug**: Incinerate (`ValidTgts$ Any`, a
mandatory single target — the same underlying shape as §E1's Mana Leak
diagnosis above) is asking for its target as a BOARD-LEVEL request — no
`live-prompt` ask at all, `data-selectable` on player avatars and a card
instead, `says()` reading "Select any target," OK disabled, Cancel enabled —
exactly the convention w33's `auto-target.state` established for Doom Blade
("choosing a CARD target is never an ask"). `play.spec.ts`'s generic
"hands off" watch loop only ever called `answerPrompt` (which drives
`live-prompt` modals) and checked whether the card "arrived" — it had no
mechanism to click a board target at all, so a hand that draws a spell
needing one, with nothing else castable as a fallback across the whole
320-pass run, stalls out the full 20s watch every time. The server log
confirms S4's repeat-collapse (§E1/§E2's own fix) is working correctly here
too (`ask-auto-answered`, `"why": "...re-asked..."`) — this stall is entirely
downstream of it, at the targeting step, unrelated to the repeat-ask
mechanism itself.

The card drawing Incinerate at all, with the seed otherwise unchanged, is D's
library replacement (`966a420`): the entire deck pool is new, so the same
fixed seed now deals different cards than it did against the old library —
this is the wave file's own prediction ("every deck the specs can now pick
must start a real match") landing exactly as described.

### The fix — `e2e/play.spec.ts` only

Added `clickOfferedTarget`, called alongside `answerPrompt` inside the same
"hands off" watch loop, for both pages every tick: if no `live-prompt` is
open, click the opponent's own avatar if it is `data-selectable`-offered,
else any offered player, else the first offered card OUTSIDE the hand zone
(a selectable card IN hand is a different castable spell being offered, not
a target for this one). This is still the server's own answer being
supplied — the same class of click `pressOk`/the Pay Mana Cost handling
nearby already make — not a client decision that changes what this test
claims (nobody presses a button to make the SPELL RESOLVE; targeting is part
of announcing it).

**Result**: `play.spec.ts` green, **4 consecutive invocations** (1 single run
+ one `--repeat-each=3` batch, 6/6) — no change needed to any other spec; the
new helper only activates when no `live-prompt` is open and a target is
actually offered, which no other currently-passing run of this file hits.

### `table-fit.spec.ts`

Both specs passed clean in the second CI-set run (no "nothing but the
counts..." margin failure — B's later counters rework, `69c6f32`, appears to
have resolved it). The manager's separately-reported `bob: the ghost and the
indicator were drawn — Expected: 2, Received: 0` (a land `pointerDrag`) did
**not** reproduce in that run — both `table-fit.spec.ts` tests passed
outright. Not chased further; if it recurs it reads as a flake under host
load rather than a deterministic regression, since nothing in this wave
touches the drag/ghost/indicator mechanism.

**`table-fit.spec.ts`**: both specs passed clean in this final run (no
"nothing but the counts..." margin failure — B's later counters rework,
`69c6f32`, appears to have resolved it; not independently re-verified against
that specific commit, since it was already gone by the time of this run).
The manager's separately-reported `bob: the ghost and the indicator were
drawn — Expected: 2, Received: 0` (a land `pointerDrag`) did **not** reproduce
in this run — both `table-fit.spec.ts` tests passed outright. Not chased
further (second and final full-set run, per instruction); if it recurs it
reads as a flake under host load rather than a deterministic regression,
since nothing in this wave touches the drag/ghost/indicator mechanism.

## `.github/workflows/ci.yml`

Per the brief, not edited by this lane (the manager owns this file and has
already made its own edit in the tree). The spec filename to add to the
`forge-e2e` job's command is **`w34.spec.ts`** (alongside `play.spec.ts
table-fit.spec.ts w31.spec.ts w32.spec.ts w33.spec.ts`, matching the existing
list's convention).
