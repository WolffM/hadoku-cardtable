# §S item 3 — the Declare Blockers scenario bug: landing straight on
# `COMBAT_DECLARE_BLOCKERS` loses a scripted blocker

**Reported by**: the manager, relaying lane E's finding against the HTTP/socket
path (`e2e/play/scenario.ts`); independently reproduced here against the
internal `startScenario` harness, same root cause, same fix.

## The symptom

`one-creature.state` scripts an untapped, non-sick Memnite onto the
DEFENDER's (seat 1) battlefield, attacked by seat 0's Memnite, with
`activephase=COMBAT_DECLARE_BLOCKERS`. The claim under test: the defender is
offered that Memnite as a blocker.

Measured instead: the defender's `setWeaklySelectable` arrived with an EMPTY
card list, no `setHighlighted` at all, and the window closed itself —
indistinguishable on the wire from `no-creatures.state`, where there is
genuinely nothing to block with. Lane E saw exactly this through the HTTP
route; this lane reproduced it through the internal harness (bypassing HTTP
entirely), so it is not a routing or socket-layer artifact — it is the
scenario's own `activephase` choice.

## The cause

`GameState.applyGameOnThread` (forge-game; read from
`/home/hadoku/.cache/cardtable-w8/forge-build`, since `forge/` is not
initialised in this worktree and this wave touches no Forge code) does, in
this order:

1. `setupPlayerState` for both players — clears every zone, repopulates from
   the scenario's `cardTexts` (`GameState.java:619-621`).
2. The combat block, gated on `newPhase`:
   ```java
   if (newPhase == PhaseType.COMBAT_DECLARE_ATTACKERS || newPhase == PhaseType.COMBAT_DECLARE_BLOCKERS) {
       handleCombat(game, newPlayerTurn, newPlayerTurn.getSingleOpponent(), toDeclareBlockers);
   }
   ```
   (`GameState.java:636-642`). `handleCombat` sets up the attacker, fires
   `GameEventAttackersDeclared`, and — **only when `newPhase` is
   `COMBAT_DECLARE_BLOCKERS`** — calls
   `game.getPhaseHandler().devAdvanceToPhase(PhaseType.COMBAT_DECLARE_BLOCKERS)`
   itself (`GameState.java:731-734`). That walk runs the REAL
   `onPhaseBegin()` for Declare Blockers, which is where Forge constructs
   `InputBlock` and computes who may block
   (`PlayerControllerHuman.pushBlockerCandidates`, which calls
   `defendingPlayer.getCreaturesInPlay()` and
   `CombatUtil.canBlock(blocker)` for each).
3. Only AFTER the combat block does `applyGameOnThread` call
   `game.getAction().checkStateEffects(true)` (`GameState.java:658`) —
   **unconditionally**, every time, regardless of `newPhase`.

So choosing `activephase=COMBAT_DECLARE_BLOCKERS` makes Forge compute "who
may block" BEFORE the scenario's own state-effects pass has run even once
since the cards were placed — one pass later than every other scenario in
this wave gets it. `CombatUtil.canBlock(Card)` (`CombatUtil.java:452-490`)
does not itself look sickness-sensitive for blocking (sickness only restricts
attacking, correctly), but `getCreaturesInPlay()` and a card's own
`isCreature()`/characteristics are exactly the kind of cached, layer-dependent
state a state-effects pass settles — and the measured symptom (a real,
plain, vanilla creature simply not counted) matches a stale read of exactly
that kind of state, not a rules decision.

`COMBAT_DECLARE_ATTACKERS` alone does not have this problem: `handleCombat`
only calls `devAdvanceToPhase` when `toDeclareBlockers` is true, so landing on
Declare Attackers Step does the attacker setup and firing but makes **no**
early read of the defender's blocking eligibility; `checkStateEffects(true)`
then runs once, unconditionally, before the hook returns — and the real
Declare Blockers transition, when it happens later through the ordinary main
loop (not `GameState`'s shortcut), runs state effects again on every priority
pass before it gets there.

## The fix

`no-creatures.state` and `one-creature.state` now set
`activephase=COMBAT_DECLARE_ATTACKERS` instead of `COMBAT_DECLARE_BLOCKERS`.
`scenario-blockers.jvm.test.ts` drives the one remaining step itself —
`passDeclareAttackers`, which presses OK once for the ATTACKER's own priority
stop at Declare Attackers Step (recognised by `/^Priority:/` and `Declare
Attackers Step` in the prompt, never touching the defender's side) — so the
transition into the real Declare Blockers window happens through the normal
main loop, with state effects already settled.

**Mutation evidence** (the repo's own history during this lane's work, not a
separate deliberate revert — the broken version is simply what shipped first
and was caught by this exact suite):

- **Before the fix** (`activephase=COMBAT_DECLARE_BLOCKERS` directly):
  `scenario-blockers.jvm.test.ts`'s Q12 case failed every real run — the
  block-assignment input either never carried a non-empty card list, or (once
  the defender's board was confirmed correct and `s.prompt(1)` was read
  precisely) the window had already closed to a plain priority prompt in
  Declare Blockers Step with an `auto-passed` log entry, exactly like
  `no-creatures.state`. Reverted fails: 1/1 (every run against the one-
  creature case; Q10/no-creatures was never affected, since it never had a
  blocker to lose).
- **After the fix** (`activephase=COMBAT_DECLARE_ATTACKERS` +
  `passDeclareAttackers`): two consecutive full runs, both tests, both green
  — 19.0 s and 19.3 s wall time, ~9.4–9.8 s per test. Restored passes: 2/2.

## What lane E should change

Nothing in the spec's assertions — the scenario's CLAIM (the creature is
offered as a blocker) is unchanged. What changes is **the state the
scenario lands on**: `one-creature.state`/`no-creatures.state` now put the
match in **Declare Attackers Step**, one step short of Declare Blockers, not
in Declare Blockers itself. `e2e/play/scenario.ts`'s driver needs one extra
click before the Declare Blockers assertions: the ATTACKING seat's own
priority window at Declare Attackers Step (`updateButtons` with `label1`
"OK") needs an OK/pass click — exactly the click a human would make to say
"attacks are declared, move on" — before the defender's Declare Blockers
window opens. The defending seat's own prompt/selectable state is otherwise
unaffected and asserted exactly as before.

## Addendum: lone-spell / MAIN1 selectability

Lane E also reported seat 1's own hand card never becoming `data-selectable`
in MAIN1 under `lone-spell.state`, suspecting the same class of bug.
**Reproduced here against the internal harness with the SAME file, and it is
not reproducible**: `scenario-priority.jvm.test.ts`'s Q17 (`own-spell.state`)
and Q7 (`lone-spell.state`) cases both pass cleanly and quickly (two
consecutive full runs, 19.0–19.3 s each; both scripted hands show up, both
spells cast and resolve, Q7's one-option `getChoices` ask arrives with the
expected `min: 0, max: 1`). `GameState.applyGameOnThread` never reads a
card's battlefield-combat characteristics for a plain `MAIN1` landing — the
only early, pre-state-effects read of characteristics is the combat block
above, which `MAIN1` never enters — so there is no analogous ordering bug to
find on this side.

This suggests the lone-spell symptom lane E saw is not in the scenario
mechanism or the server; it is worth checking on lane E's own side: whether
`e2e/play/scenario.ts`'s helper is reading the right seat's board for
`data-selectable`, and whether the UI adapter's selectable computation
(`setWeaklySelectable` → `data-selectable`, a client-side/lane-B-and-G
concern, not this lane's files) has a timing assumption a scenario-landed
match violates that an ordinarily-played-into match does not (e.g. an
`openView`/snapshot ordering the client assumes always follows a specific
number of turns). Flagged for the manager to route to whichever lane owns
that adapter code; this lane's own wire-level evidence says the SERVER
offered the card correctly.

## Correction (same day, after the manager relayed a second, wider report from E)

**The above "no analogous bug on the MAIN1 side" conclusion was wrong — it
tested the wrong thing.** `scenario-priority.jvm.test.ts`'s Q17/Q7 cases
`select()` the scripted hand card directly; they never checked whether
`setWeaklySelectable` carried it first. Checked directly: it does not.
`own-spell.state`, seat 0's own uncontested MAIN1, holding a free Memnite —
every `setWeaklySelectable` frame sent to seat 0 before the cast is `[]`.
`s.select(0, memnite.id)` still casts it successfully regardless (the stack
shows it, it resolves, it lands on the battlefield) — so the GAME ENGINE
accepts the action as legal; only the "what's actionable" highlight
computation is empty. This is the SAME symptom class as the Declare Blockers
bug (a scripted card never offered through the UI-facing selectable channel,
while direct engine actions on it still work), but **not the same cause**:
`MAIN1` never enters `GameState`'s combat block at all, so there is no
`checkStateEffects`-ordering explanation here.

Traced as far as this lane's remaining time allowed, in
`forge-ai/src/main/java/forge/ai/AvailableActions.java` (what ultimately
feeds `PlayerControllerHuman.pushActionableCards` → `setWeaklySelectable`):
no caching (`collectActionable`/`compute` do a fresh zone walk every call),
and for a 0-cost, no-target Memnite both `canAfford` and
`ComputerUtilAbility.isFullyTargetable` should trivially pass. Also ruled
out: `UI_SHOW_ACTIONABLE_HIGHLIGHTS` (set `true` at boot in `PlayBridge.java`;
`YieldController.getStringPref` falls back to `FModel`'s value correctly,
confirmed from source — no per-player override ever narrows it), and a
player-index mismatch between the scenario's `activeplayer=` and Forge's own
coin-toss winner (`PhaseHandler.setPlayerTurn` calls `resetPriority()`,
confirmed from source, so priority tracking realigns whenever the active
player differs from whoever won the natural toss). `Zone.setCards` — what
`GameState` uses for a scripted HAND (unlike the battlefield, which goes
through `moveToPlay`) — does correctly call `c.setZone(this)` and fire a
`GameEventZone`, so it is not skipping zone linkage outright either.

**Found and fixed**, after the manager named the exact candidates to measure
rather than reason about further. Added a TEMPORARY diagnostic to
`PlayBridge.java`'s `setWeaklySelectable` override (reverted once measured):
log the priority player, phase, every hand card's
`getAllPossibleAbilities(player, true).size()`, and a FRESH, direct call to
`AvailableActions.collectActionable(player, 2000)` at the exact moment Forge
sends an empty `setWeaklySelectable`. Result: the fresh, direct call finds
the scripted Memnite correctly (`collectActionable=[81]`) at the SAME instant
Forge's own push carries `[]`. So the scan itself is not wrong when run
fresh — Forge is sending a STALE result.

**Cause, first pass (wrong in a detail the manager caught by re-running the
test twice)**: the explanation above — reasoning that
`chooseSpellAbilityToPlay()` must have cached an empty, UNTAP-time set that
then went stale — was plausible but not what the code does, and the fix
built on it (calling `pushActionableCards(false)` once, right after the
scenario applies, with nothing else) was a RACE, not a fix: it passed when
timing happened to go one way, and the manager's own re-run (twice) got one
pass and one timeout. Recorded honestly rather than silently replaced:
**reverted/original fix, 1 fail / 1 pass over 2 runs** (the manager's own
measurement; transcript at `/tmp/claude-1000/w33-M/prio1.txt` on their side).

**Cause, confirmed from source**: `pushActionableCards` itself
(`PlayerControllerHuman.java:1550-1590`) does **not** recompute anything when
not paying a cost — line `:1572-1574`: `else if (cachedActionableCards != null)
{ actionable.addAll(cachedActionableCards); }`. That field
(`:1539`, `private Set<CardView> cachedActionableCards`) is written ONLY by
`chooseSpellAbilityToPlay()` (`:1664`/`:1668`/`:1672`) — and `refreshActionable`
runs from the START-GAME HOOK, strictly before the main loop has ever called
`chooseSpellAbilityToPlay()`. So calling `pushActionableCards(false)` at that
point reads WHATEVER the field happened to hold already — sometimes still
`null` from construction (→ `pushActionableCards`'s `else` branch, line
`:1575-1578`, correctly does a fresh scan), sometimes non-null (left over
from the mulligan step's own input, apparently timing-dependent) — and in the
non-null case it resends that leftover value, not a fresh one. This is
exactly a race, and explains the manager's 1/2 result precisely.

**Fix, corrected**: null `cachedActionableCards` directly via reflection
(on a `private` Forge field — no Forge file is changed; this bridge already
reads a different Forge-internal field this way, for
`SeatGui#liveMulliganFlag`) immediately before calling
`pushActionableCards(false)`. With the field null, `pushActionableCards`'s own
`else` branch always runs a fresh `AvailableActions.collectActionable` scan —
no more dependence on what some earlier, unrelated input happened to leave
behind. Because `pushActionableCards` never WRITES this field (only reads
it), it is still null afterward, so `chooseSpellAbilityToPlay`'s own first
real call (once the main loop starts) is guaranteed to take its own
fresh-scan branch too, rather than finding a non-null value someone else
already wrote. `PlayBridge.java`'s `refreshActionable(game)` (called from
`hostMatch()`'s start-game hook, right after `state.applyToGame(...)`
returns) implements this for every human seat.

**Verification, at the budget the manager said this claim was worth**:
`scenario-priority.jvm.test.ts`'s Q17 case (asserting the scripted Memnite
is offered as actionable BEFORE it is selected) run as ten SEPARATE,
consecutive JVM processes (`-t "Q17"`, ten full `pnpm exec vitest run`
invocations, not one process repeating the test): **10/10 passed**
(9.3–10.0 s each). Reverted (skip the reflection null, call
`pushActionableCards(false)` directly — the exact pre-fix shape): **5/5
passed in this environment** — the mutation did not reproduce a failure
here, most likely because the manager's own JVM cleanup (17 stale wave-31
JVMs plus one orphaned worktree's, freeing swap from 46 GB to 34 GB) lowered
host contention enough to narrow the race further than this lane's own 5
samples could catch; the manager's own 1-fail-in-2 stands as the direct
evidence the race is real, and the fix is a deterministic correction (forces
a fresh scan by construction, not by making a window narrower) rather than
one this lane is claiming to have reproduced failing after the fact. Restored
and re-run once more after the mutation runs: clean, 2/2. No regression in
the Declare Blockers suite (`scenario-blockers.jvm.test.ts`, re-run clean
after every change above, 19.2–19.7 s, 2/2 each time) or the combat/harness
suites (re-run clean, 1/1 and 2/2).

This affects any scenario that needs a browser to show a scripted hand card
as clickable — which, per the manager's relay, was most of this wave's e2e
specs (`Q7, Q12, Q14, Q17, Q18, Ponder, auto-target` per E's count; only
`Q10`, with nothing to offer, and `Q1b`, pure turn-passing, did not depend on
it) — and should now be resolved for all of them, since the fix runs
unconditionally for every scenario, not just the ones this lane's own tests
exercise. `scenario-priority.jvm.test.ts`'s own header carries the same
summary next to the tests it applies to.

## Q8 (two-triggers.state): confirmed to never fire at all

Raised independently by the manager relaying E's own confusion about the
missing `order` ask. Checked directly by asserting seat 0's life actually
dropped (each Dark Confidant reveals a card and loses life equal to its
cost) before trusting anything about ordering: **it never does — life stays
at 20.** The triggers do not fire at all; the earlier "no order ask without
full control" pass was vacuously true for the wrong reason (nothing to
order), and the "order ask under full control" case times out for the same
reason.

Cause: `GameState.applyGameOnThread`'s combat path (`handleCombat`)
explicitly calls `game.getStack().addAllTriggeredAbilitiesToStack()` after
declaring attackers — that call is what actually PUTS a fired trigger on the
stack for resolution. The general `activephaseadvance` path
(`devAdvanceToPhase(advPhase)`, what `two-triggers.state` uses to walk
UNTAP→UPKEEP) has no equivalent: `PhaseHandler.onPhaseBegin()` calls
`runTrigger(TriggerType.Phase, …)` for the non-combat case too, which appears
to only REGISTER that the trigger condition was met; nothing later
materialises it onto the stack, because by the time the normal main loop
resumes (after the scenario's hook returns), the engine considers Upkeep's
phase-begin already handled and does not revisit it. `handleCombat`'s extra
call is a combat-specific workaround with no general-purpose equivalent a
`.state` file can reach.

**Second attempt, after the manager's explicit redesign instruction**: land
`two-triggers.state` one step earlier (the OPPONENT's Cleanup Step, so seat
0's Untap→Upkeep transition happens through ordinary priority passes, not a
synthetic jump) and drive it with a loop that presses OK on every
`Priority:` window for either seat until seat 0's life drops and the stack
empties. Measured against a real match: **still 20.** The drive ran all the
way to seat 0's Declare Attackers Step (several phases past Upkeep) without
seat 0's life ever changing, and without the stack ever (observed) holding
more than one item at a time attributable to a Dark Confidant.

This lane could not fully separate two possible explanations within the
budget left: (a) this scenario genuinely does not produce the triggers
(something about a devMode-placed permanent's upkeep eligibility, parallel
to — but not explained by — the Declare-Blockers characteristics bug), or
(b) the test's OWN drive loop is at fault: pressing every enabled
`Priority:` window indiscriminately, with no narrower stop at Upkeep
specifically, could race past the one window that mattered before anything
inspected the stack or asked a question. Per the manager's instruction for
exactly this outcome: **the red test was deleted rather than landed or left
red.** `two-triggers.state` stays (documented as unverified in its own
header and in the README) in case a later pass wants to try a narrower drive
loop that stops AT Upkeep specifically and inspects the stack before
pressing anything further. Reported here as: **Q8 — not verified, scenario
cannot be confirmed to produce two simultaneous triggers within this lane's
budget.**

## The auto-target scenario: RESOLVED — TargetCards reaches the wire; Fiend Hunter was a test bug, not a product one

First attempt (Fiend Hunter's ETB, "you may exile another target creature")
left this inconclusive: the stack item arrived with `TargetCards: []` and
`s.asks` recorded nothing for it. Per the manager's instruction, switched to
a mandatory, card-only-target spell (Doom Blade, "destroy target nonblack
creature") against the same one-legal-target setup, and the SAME test design
also came up empty on the first two tries — until a diagnostic dump of
`s.sent` showed why: **targeting a CARD is not an `ask` at all.**
`answerAsks()` only answers frames with `kind: 'ask'` (`getChoices`,
`chooseSingleEntityForEffect`, …) — Q7's Mana Leak targets a STACK ITEM that
way. Targeting a CARD instead arrives as an ordinary `setSelectables` +
`setHighlighted` pair (the same "click a card" affordance as everything
else), with `showPromptMessage` "Select target nonblack creature" and `OK`
disabled until something is clicked. The fix was in the TEST, not the
product: select the legal target directly (`s.select(seat, targetId)`, the
same act any card click sends) once that prompt appears.

With that one line added: **`TargetCards` reaches the wire correctly** —
confirmed against a real match, two consecutive clean runs (9.4–9.5s each,
alongside the unrelated Q18 case). The wire-level claim lane G's brief asked
for is answered: **targets DO reach the browser** for a card-targeted
effect with exactly one legal option. Fiend Hunter itself was never
re-tried after this fix (its own "you may" confirm step is a separate
question this lane did not re-open, out of budget) — `auto-target.state`
now uses Doom Blade, documented in its own header and the README, and
Fiend Hunter is not a card this wave's scenarios reference any more. The
Q18 case (an activated ability's stack item, source = the permanent, still
on the battlefield) passed cleanly throughout and was never in question.

## Q14 (attackers-declared.state): the SAME bug class as Declare Blockers, found by E, fixed the same way

E found this file's first design (the creature pre-marked `|Attacking` via
`GameState`, landing directly on `activephase=COMBAT_DECLARE_ATTACKERS`)
skips Forge's own live `InputAttack` entirely. Not a stale-characteristics
bug this time — `handleCombat` runs for `COMBAT_DECLARE_ATTACKERS`
UNCONDITIONALLY, regardless of whether any card is marked `|Attacking`: an
EMPTY attack is still a manual `GameEventAttackersDeclared` GameState fires
itself, exactly as it fires a real one. So the live input — the one thing
Q14's claim ("clicking a declared attacker, and a box, pull attackers back")
needs — never opens either way, and no `updateButtons` for it ever reaches
the wire. A browser's `declaredAttackers()` precondition (`button2 ===
"Call Back"`) can therefore never hold, because there is no live window to
hold it in.

**Fix, same shape as Declare Blockers**: do not land on EITHER combat phase
key for this claim at all. `attackers-declared.state` now lands at seat 0's
own, ordinary Main Phase 1 — no combat key, no `|Attacking` marker — with one
untapped, non-sick creature on the battlefield (`GameState.java:1286` sets
`c.setSickness(false)` unconditionally on every card it creates; nothing
here needs an explicit override). `scenario-combat.jvm.test.ts` presses
seat 0's own Main 1 priority stop once, through the ordinary main loop, so
Forge's own phase transition into Declare Attackers Step opens the REAL
`InputAttack`, live, with the creature offered.

**What the test actually drives** (the exact clicks, for lane E to mirror):

1. Wait for seat 0's own Main Phase 1 priority window (`Priority: …
   Main phase, precombat`, `enable1 === true`) and press OK ONCE — the
   ordinary "move on" click, same as any other unremarkable priority window.
2. Wait for the prompt `/^Select creatures to attack/` — Forge's live
   declare-attackers input is now open. Precondition check: `button2` is NOT
   yet `"Call Back"` (nothing declared).
3. **Click the creature** (`selectCard`, the same act any card click sends)
   — this is the "declare an attacker" click. Wait for `button2 ===
   "Call Back"`; the prompt is still `/^Select creatures to attack/` (same
   input, not a new one), and the wire's `Attacking` property for that card
   is now `true`.
4. **Click the SAME creature again** — this is the "pull it back" click.
   Wait for `button2` to stop being `"Call Back"`; the wire's `Attacking`
   property reverts to not-true.
5. (Not driven by this test, but available: pressing OK/button1 now would
   confirm whatever is currently declared — zero attackers, after step 4 —
   finishing the input exactly as an ordinary declare-attackers step would.)

No ask, no `getChoices`, no stack item anywhere in this flow — it is three
ordinary acts (`selectButtonOk`, `selectCard`, `selectCard` again) against
one long-lived input, exactly like Declare Blockers' own
`setSelectables`/`setHighlighted`/click pattern.

**Mutation evidence**: reverted to the original `|Attacking` +
`activephase=COMBAT_DECLARE_ATTACKERS` design, the SAME test fails 1/1 —
"timed out waiting for Forge's live declare-attackers window to open"
(29.9 s, the full `waitUntil` budget). Restored: three clean runs, all
green, 9.4–9.7 s each.
