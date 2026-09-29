# §B → §A: what lane B's stop-policy change moved, measured

Wave 28, lane B. Written for lane A so they re-aim once instead of twice. Every
line below is a command that was run and an exit code that was read.

**Short version: two of lane A's four jar-gated suites were moved by lane B, one
was already red before this wave, and one is untouched.** The attribution is not
inferred — each failing suite was re-run with `DEFAULT_STOP_POLICY`'s three
changed fields reverted in place, and the difference is the evidence.

| suite | with lane B's change | with the change REVERTED | verdict |
| --- | --- | --- | --- |
| `apps/ui/src/play/live/board-play.jvm.test.ts` | exit 0, 1 passed | — | **untouched** |
| `apps/ui/src/play/live/combat-drag.jvm.test.ts` | exit 1, 1 failed | **exit 0, 1 passed** | **moved by lane B** |
| `apps/ui/src/play/live/prompts.jvm.test.ts` | exit 1, 1 failed / 2 passed | **exit 0, 3 passed** | **moved by lane B** |
| `apps/ui/src/play/live/flow.jvm.test.ts` | exit 1, 7 skipped (suite) | exit 1, 7 skipped (suite) | **already red** — lane B only moves where it dies |

All eight runs were one file at a time, under the wave's `jvm.lock`, with all
three env vars, against the real jar, on a tree where
`git status --porcelain -- apps/ui/src/play/` was EMPTY — so this is a clean read
of lane B's change and not a read of lane A's work in progress.

## What changed in lane B

`apps/server/src/play/auto.ts`, one value:

```diff
 export const DEFAULT_STOP_POLICY: StopPolicy = {
-	stopOnMyTurn: ['MAIN1', 'MAIN2'],
-	stopOnTheirTurn: [],
-	skipNonStopPhases: 'never',
+	stopOnMyTurn: ['MAIN1', 'MAIN2', 'COMBAT_DECLARE_ATTACKERS'],
+	stopOnTheirTurn: ['COMBAT_DECLARE_BLOCKERS', 'END_OF_TURN'],
+	skipNonStopPhases: 'always',
```

That is `ARENA_STOP_POLICY` adopted **wholesale**; `ARENA_STOP_POLICY` is now an
alias of the default. Two smaller things a suite can trip over:

- `skipsThisTurn()` now refuses a phase whose spelling the adapter could not map
  (`facts.phase === null`). With `'always'` as the default an unknown label would
  otherwise pass every window it appears in.
- `EVERY_PRIORITY_POLICY` is new — the stop behaviour that was the default until
  2026-09-28 — and `'everyPriority'` is a fifth name in `NAMED_STOP_POLICIES`.

**What a seat now experiences:** on its own turn a stop in MAIN1, MAIN2 and
declare-attackers and nowhere else; on the opponent's turn a stop in
declare-blockers and the end step and nowhere else. Every other phase is passed
**whether or not Forge named anything the seat could do there.**

Unchanged, so nothing needs re-aiming for it: `FULL_CONTROL_POLICY`, the per-seat
`SeatState.fullControl` flag, `passStackWindows`, `passWhenNothingToDo`, and
`unambiguousPayment`.

## Why the two suites moved, which is ONE mechanism

It is not that any assertion about the game became false. **Every one of these
failures is a driver running out its own deadline**, and the cause is a race the
repo has already diagnosed once, in `board-play.jvm.test.ts`'s own header (wave
21 §B, `341e51d`):

> *"an auto-pass lands, Forge clears its actionable set, and the button this
> driver is holding a reference to stops meaning anything. `flow.jvm.test.ts`
> measured that happening in two runs out of three."*

`jvm-harness.ts:158-165` bumps `notes.version` on **any** of `showPromptMessage`,
`updateButtons`, `setSelectables`, `clearSelectables`. So an `updateButtons`
arriving alone advances the version while `notes.prompt` still holds the PREVIOUS
window's message. A driver that keys on the version and then reads `msg` acts on
a stale window with a live button:

- `combat-drag.jvm.test.ts:366` — `if (msg.startsWith('Priority')) { … press OK }`
- `game-driver.ts:92,106` — `if (msg.startsWith('Priority: …')) { … return buttons?.enable1 === true ? ['pass', OK] : null }`
- `flow.jvm.test.ts:182-195` (`advance`) — presses OK on any live button unless `hold()` says otherwise, and `hold` is `atOwnMain`, which reads that same stale `notes.prompt`

Before wave 28 the server auto-passed only windows Forge itself called empty, so
these bursts were rare — "two runs in three", as above. With
`skipNonStopPhases: 'always'` the server passes upkeep, draw, beginning-of-combat,
combat-damage, end-of-combat, end-step and cleanup in a burst, so the stale-read
window is hit on nearly every turn. **The race was always there; lane B turned it
from occasional into routine.**

`board-play.jvm.test.ts` survives because it was hardened for exactly this in wave
21 §B and nothing else was: it never presses OK on a priority window at all, it
only clicks what `boardInteraction` offers, and every click is checked against
`s.live.stats.replies` so a declined one is re-latched and retried
(`board-play.jvm.test.ts:271-278`). Neither `combat-drag.jvm.test.ts`,
`flow.jvm.test.ts` nor `game-driver.ts` contains the string `stats.replies`.

### `combat-drag.jvm.test.ts` — the exact failure

```
FAIL  apps/ui/src/play/live/combat-drag.jvm.test.ts > an attack and a block, declared
      by dragging on a real Forge match > an attack and a block go on the wire as one
      selectCard each, and Forge puts both creatures in combat
Error: combat was never driven by drag: 38 attack drags, 1 block drags,
       attacking seen by [1,0], blocking seen by []
  ❯ apps/ui/src/play/live/combat-drag.jvm.test.ts:413
```

The attack half works — both seats saw an attacker. The block half never
happened: in the log the defender goes straight from the attack being declared to
a declare-blockers PRIORITY window with nothing offered, meaning Forge's block
INPUT was answered before the driver's `/to block/` branch ever read it.

```
seat 1 t54 DRAGS Memnite 81 to attack
seat 1 t54 COMBAT_DECLARE_ATTACKERS MINE ok=true offered=0 … msg="Priority: B…Declare Attackers Step"
seat 0 t54 COMBAT_DECLARE_BLOCKERS ok=true offered=0 … msg="Priority: A…Declare Blockers Step"
seat 1 t54 MAIN2 MINE …
```

### `prompts.jvm.test.ts` — the exact failure

```
FAIL  apps/ui/src/play/live/prompts.jvm.test.ts > the fifteen prompts against a real
      Forge match > combat and targets: showConfirmDialog, openZones,
      assignGenericAmount, assignCombatDamage, getAbilityToPlay
Error: the scenario did not finish in 150000 ms: [[0,"showConfirmDialog","s0-1",{"ok":true},3192],
       [0,"getAbilityToPlay","s0-2",{"ok":true},3175], … 70 entries, every one answered ok …]
  ❯ apps/ui/src/play/live/prompts.jvm.test.ts:371
```

Every ask in that list was answered successfully. The scenario simply never
reached `assignCombatDamage` inside its budget: it is driven by `game-driver.ts`,
which is the file with the `Priority` branch above. The other two cases in this
file pass under both policies.

### `flow.jvm.test.ts` — ALREADY RED, and for a reason that is not the policy

It fails in `beforeAll` under **both** policies, so all 7 tests skip either way.
Only the step it dies on moves:

```
with lane B's change     flow.jvm.test.ts:318  "timed out waiting for seat 0's own main phase with a land in hand"
with the change reverted flow.jvm.test.ts:406  "timed out waiting for seat 0's next own main phase, under full control"
```

The blocker is IDENTICAL in both runs, and it is seat 1:

```
{"seat":1,"at":"5/CLEANUP","prompt":"Cleanup Phase\nSelect 2 card(s) to discard…",
 "selectables":{"cards":[53,59,43,66,50,72,65,51,64],"min":2},
 "buttons":{…,"enable1":false},
 "acts":["selection #53","selection #53","selection #53","selection #53","selection #53","selection #53"]}
```

Six clicks, all on card #53, against a `min: 2` selection. `flow.jvm.test.ts:196-199`
is the reason:

```ts
const selection = p.seat.live.selectables;
if (selection === null || selection.min === 0) continue;
const next = [...boardInteraction(p.seat.live).selectable][0];   // ← always [0]
if (next !== undefined) click(p, next, 'selection');
```

It takes the first selectable every tick with no memory of what it already
picked, so a two-card discard can never be satisfied and `enable1` never comes
alive. `game-driver.ts:135-139` and `combat-drag.jvm.test.ts:391-394` both keep
that memory; `flow.jvm.test.ts` does not. **That is a pre-existing defect in
lane A's file, independent of wave 28**, and it has to be fixed for the suite to
be green under any policy.

## What lane A should do, and what it must not do

**Do not weaken an assertion.** Nothing that any of these suites asserts became
false. Two things are worth doing, in this order:

1. **`flow.jvm.test.ts:198` — give the selection loop a memory**, the way
   `game-driver.ts:135-139` already has one. This is the pre-existing red and it
   is not optional; the suite cannot be green without it.
2. **Decide, per suite, whether the driver should be hardened or the policy
   pinned.** Both are honest; they answer different questions.
   - *Hardened* is the better answer where the suite is about the PRODUCT under
     its real default: pair the prompt and the buttons before acting (never read
     `notes.prompt` as current because `notes.version` moved), and check
     `s.live.stats.replies` across every act so a declined one is retried —
     `board-play.jvm.test.ts:265-278` is the worked example, in this repo, for
     this exact hazard.
   - *Pinned* is the honest shortcut where the suite is about something else
     entirely. `combat-drag.jvm.test.ts` exists to prove a DRAG declares combat;
     `prompts.jvm.test.ts` exists to prove fifteen prompt shapes draw. Neither
     tests the stop policy — `auto.test.ts` and `auto.jvm.test.ts` do, and they
     now assert it directly. One line restores the timing they were written in:

     ```ts
     import { EVERY_PRIORITY_POLICY } from '../../../../server/src/play/auto.ts';
     // …after the match exists, before the drive loop:
     for (const s of h.seats) h.match.setStopPolicy(s.seat, EVERY_PRIORITY_POLICY);
     ```

     `board-play.jvm.test.ts:217` already does exactly this with
     `STRICT_PAYMENT_POLICY`, and says why in its header — the same precedent,
     for the same kind of reason.

   Pinning is NOT weakening **provided it is written down**: the suite then
   states that it measures the drag/the prompts and not the stop set, which is
   true. Pinning it silently, and thereby never running the product's real
   default anywhere, would be.

3. **`flow.jvm.test.ts:506`'s claim survives either way.** *"a turn never advances
   past a main phase unattended"* asserts `stalledFrom` matches `/^\d+\/MAIN[12]$/`.
   Both main phases are still stops under the new default, so that claim is as
   true as it was; it just cannot be reached while the cleanup-discard loop jams.

## What moved outside lane A, and what lane B did about it

### `apps/server/src/play/auto.test.ts` — lane B's, re-aimed

13 of 151 cases moved; all 13 re-aimed, none deleted, every claim still asserted
somewhere. Mutation-checked: reverting `DEFAULT_STOP_POLICY`'s three fields gives
**13 failed / 138 passed (151) in `auto.test.ts`**; restored, **151 passed / 0
failed**.

| case | why it moved | what it says now |
| --- | --- | --- |
| `never passes a stop where Forge named something actionable` | its window is the End of Combat step, not a stop phase any more | renamed `never passes a phase the player ASKED to stop in, …`; asserted over their end step AND the seat's own precombat main, with `[]`, `[67]` and `null` actionable |
| `never passes on silence: a cleared set is …` | same window | asserted where the rule still decides: every priority window under `EVERY_PRIORITY_POLICY`, and a stack window under the default |
| `does NOT pass a stop where Forge named something the seat can do` (harness) | same | re-aimed onto the seat's own precombat main |
| `does NOT pass on a cleared set` (harness) | same | run under `EVERY_PRIORITY_POLICY` |
| `#20 — the default asks, and ARENA passes it` | the two values swapped sides | `EVERY_PRIORITY_POLICY` asks, the default passes; still no code between them |
| `an unknown phase is never skipped` | it asserted `'always'` WOULD pass it | asserts every policy stops there, because `skipsThisTurn` now refuses a null phase |
| `the default policy is wave 20's behaviour, field by field` | the default changed | renamed `… is Arena's stop set, field by field`, plus a new case pinning `EVERY_PRIORITY_POLICY` as wave 20's |
| `leaves a strict seat's two-source payment alone …` | the `stop-policy` log carries `skipNonStopPhases` | `'never'` → `'always'` |
| `resolves each name to the value it names` | `'everyPriority'` is a fifth name | census is five names |
| `carries one skipPhase per (turn player, phase)` | "the default skips nothing" is false now | `'never'` skips nothing; the default skips the complement of its stop sets |
| `#20 — the phases the player DID ask for still stop`, `the scope of a skip is a value too`, `holds under ARENA too`, `ARENA's skip set …` | `ARENA_STOP_POLICY` is the default object now | pass unchanged |

New cases, each red when the change is reverted:

- `item 5 — an upkeep with a castable instant is PASSED by default and STOPPED
  under full control`, which also asserts the leak property directly: the answer
  is the same with `[]`, `[61]` and `[61,62,63]` actionable, so the pass says
  nothing about the hand.
- `item 5 — passes the upkeep the operator was stopped on, and passes it
  identically with nothing in hand` — the same, through `match.ts`.
- `the windows a held instant is actually cast in are still stops` — the other
  half of the wholesale decision.
- `item 11 — a payment line reaches the WHOLE table, attributed, and names only
  what the recipient can see`.

### `apps/server/src/play/auto.jvm.test.ts` — lane B's, and it was ALREADY RED

Two cases failed **before** lane B changed a stop set:

```
auto.jvm.test.ts:784   expected '{1}{W}' to be null
auto.jvm.test.ts:1105  expected '{R}' to be null
```

Both are `expect(decidePay(facts, DEFAULT_STOP_POLICY)).toBeNull()`.
`DEFAULT_STOP_POLICY.unambiguousPayment` moved to `'forgeAuto'` in `88ca6fb`
(2026-09-27), which makes `decidePay` return the cost; this file was last touched
in `1c9bdd3`, earlier the same day, and was never re-aimed. **CI runs no
jar-gated vitest suite**, so the red sat latent instead of failing anybody's
check. Fixed by naming `STRICT_PAYMENT_POLICY` for the claim that belongs to it
and asserting the default's `'forgeAuto'` answer beside it. Now **exit 0, 3
passed**.

### `apps/server/src/play/jvm.test.ts` — nobody's. FLAKY, not moved. NOT EDITED.

Run 1: 2 failed / 1 passed. Run 2, the same file alone: **3 passed, exit 0**.
1 red in 2 runs, and run 1 shared one `flock` and one shell with
`seed.jvm.test.ts`. The failures were

```
Error: timed out waiting for turn 1
  6 OKs sent and turn 1 never arrived.
  asks that reached a browser: [{"seat":0,"method":"showConfirmDialog"},{"seat":1,"method":"order"}]
AssertionError: expected 2 to be +0    (liveJvmCount(), jvm.test.ts:310)
```

The second is the known `liveJvmCount` cascade of the first. The first blocks on
two open ASKS, and an open ask short-circuits every stop decision (`decideStop`:
`if (facts.openAsks > 0) return null`), so a stop-set change cannot produce it.

### `apps/server/src/play/seed.jvm.test.ts` — nobody's. Did not move. 1 passed, exit 0.

### `e2e/play.spec.ts` — lane B's, and it moved for LANE C, not for lane B

The first run died at 4.6 s, before any Forge match started:

```
✘ play.spec.ts:673 › two friends play one Forge match: …
  Error: locator.selectOption: Error: Element is not a <select> element
```

That is `loadOwnDeck` at `play.spec.ts:648`, and it is §C's deck chooser
(*"we cannot use a standard dropdown for this"*), not §B's stop policy — it
reproduces identically with lane B's change reverted. §C anticipated it and left
the recipe in `docs/planning/wave28-evidence/C-deck-chooser-e2e-recipe.md`; lane B
took it up verbatim, one line:

```diff
-  await f.page.getByTestId('deck-mine').selectOption(deckId);
+  await f.page.getByTestId('deck-mine').locator(`[data-deck-id="${deckId}"]`).click();
```

With that line and the wave-28 default, against the real jar, after rebuilding
both `apps/server/dist` and `apps/ui/dist`:

```
✓ 1 play.spec.ts:660 › the play isolation check FAILS when one seat is sent the other seat's hand (62ms)
✓ 2 play.spec.ts:679 › two friends play one Forge match: seats, prompts from both sides,
    a refresh with a question open, the board agrees with the server, isolation per envelope (40.8s)
2 passed (42.5s)      EXIT=0
```

Neither title carries the `— SKIPPED: …` suffix and the match case took 40.8 s,
so this is a real Forge match and not the jar-less pass that reads like one.
**`e2e/play.spec.ts` needed no re-aim for the stop policy itself** — it drives the
game by what the board offers and by an idle counter, never by a phase name, and
a faster game is the direction it already wanted.

**`e2e/arrow.spec.ts:213` and `e2e/table-fit.spec.ts:666` carry the same
`selectOption` and belong to NOBODY.** They are not lane B's to edit and they will
fail the same way. §C's recipe has their one-line fix too; somebody has to apply
it.

Two doc-comments in `play.spec.ts` (`:1058`, `:1282`) described the stop model as
wave 20's. Both updated — the claim they rest on ("a seat's own main phase is a
stop the server never passes") is still true and is now MORE load-bearing.

### `e2e/table-fit.spec.ts` — nobody's. NOT RUN, and that is a gap.

It is jar-gated, it drives the same lobby, and it carries the same
`selectOption` on `deck-mine` at `:666`. It will fail on §C's chooser before it
ever exercises anything §B changed. Running it before that line is fixed proves
nothing, so lane B did not spend a jar slot on it. The command that settles it,
once `:666` is fixed:

```sh
flock -x /tmp/claude-1000/w28-locks/jvm.lock env CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… \
  CARDTABLE_PLAY_WORK_DIR=/tmp/claude-1000/w28-B-play \
  pnpm --filter @hadoku/e2e exec playwright test -c playwright.config.ts table-fit.spec.ts
```

### Everything else

- `apps/server/src/play/match.test.ts`, `socket.test.ts` (lane B's): never red.
  **238 passing across the three scoped suites, exit 0 read directly.**
- `apps/ui/src/play/**` non-jar suites (lane A's): **18 files passed, 5 skipped,
  561 passed / 13 skipped, exit 0** — run with `apps/ui/src/play/` still clean.
- `apps/server/src/play/visibility.test.ts`, `host.test.ts`: 2 files, 47 passed,
  exit 0.
- `apps/server/src/http/tables.test.ts:29` and `gate.test.ts:28` (lane D's)
  import `MatchRegistry`, `createMatchRegistry` and `Match` from `match.ts`.
  Lane B's `match.ts` change is **add-only** — two new private methods and one
  call site rewritten inside an existing private method — and no exported
  signature moved.

## The commands, so any of this can be re-run

```sh
export PATH="/home/hadoku/.local/share/fnm/node-versions/v24.18.0/installation/bin:$PATH"

# scoped, no lock
pnpm vitest run apps/server/src/play/auto.test.ts apps/server/src/play/match.test.ts apps/server/src/play/socket.test.ts

# jar-gated, ONE FILE AT A TIME, under the wave's lock
flock -x /tmp/claude-1000/w28-locks/jvm.lock env \
  CARDTABLE_FORGE_JAR=/home/hadoku/.cache/cardtable-w8/forge-build/forge-gui-desktop/target/forge-gui-desktop-2.0.15-SNAPSHOT-jar-with-dependencies.jar \
  CARDTABLE_FORGE_RES=/home/hadoku/.cache/cardtable-w8/forge-build/forge-gui/res \
  CARDTABLE_PLAY_WORK_DIR=/tmp/claude-1000/w28-B-play \
  pnpm vitest run <one file> --pool=forks --poolOptions.forks.singleFork=true

# the attribution itself: revert the three fields, run, restore
sed -i "300s/.*/\tstopOnMyTurn: ['MAIN1', 'MAIN2'],/; \
        305s/.*/\tstopOnTheirTurn: [],/; \
        309s/.*/\tskipNonStopPhases: 'never',/" apps/server/src/play/auto.ts
```
