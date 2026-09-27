# Wave 24 §E — the shortcut engine stops guessing from English

Evidence for lane E. Everything here is either read out of a Forge source file
(path and line given) or measured from a real Forge match on this host. Nothing
in this document is inferred from a prompt's wording.

Lane E owns `apps/server/src/play/auto.ts`, `auto.test.ts`, `auto.jvm.test.ts`,
`packages/forge-wire/src/tier-b.ts`, `tier-b.test.ts` and this file. Everything
it found that lives elsewhere is in §6.

---

## 1. The model

A **stop preference** is a named field of `StopPolicy` (`auto.ts`). There is one
such record per seat, and it is the only input to whether the player is
interrupted. Every field names a Forge concept, so the whole record can be
handed to Forge verbatim:

| `StopPolicy` field | Forge |
| --- | --- |
| `stopOnMyTurn` / `stopOnTheirTurn` | the COMPLEMENT of `YieldController.skipPhases` (`YieldController.java:105-113`), carried by `YieldUpdate.SkipPhase` |
| `skipNonStopPhases` | whether a skip set is sent at all (`'never' \| 'theirTurn' \| 'always'`) |
| `passWhenNothingToDo` | `FPref.YIELD_AUTO_PASS_NO_ACTIONS` — APINA, read by `YieldController.isAutoPassingNoActions` (`:569-573`) |
| `interruptsRestoreStops` | `FPref.YIELD_AUTO_PASS_RESPECTS_INTERRUPTS` (`:507-518`) |
| `passStackWindows` | the standing form of `YieldController.setAutoPassUntilStackEmpty` (`:127-134`), carried by `YieldUpdate.StackYield` |
| `unambiguousPayment` | `FPref.UI_SHOW_AUTOTAP_PREVIEW` — the pref that puts Forge's own auto-tap PLAN on our wire |
| `costConfirm` | `AutoYieldStore` per-ability auto-yield, `YieldUpdate.SetDisableYields` / `CardAutoYield` |
| `answerOneAnswerAsks` | ours: the bounds arithmetic in `onlyAnswer` (wave 19) |

Three policy values ship: `DEFAULT_STOP_POLICY` (behaviour-identical to wave
20/22), `ARENA_STOP_POLICY` (item #20 as a value) and `FULL_CONTROL_POLICY`.

**Where each part lives, and who decides.**

1. `readPromptFacts(notes)` — **the one named adapter**. The only code above the
   wire that reads Forge's human-readable prompt. It produces `PromptFacts`: a
   `PhaseType` (never a spelling), whose turn it is, whether the stack is empty,
   the cost being paid, and Forge's actionable multiset.
2. `decideStop(facts, policy)` and `decidePay(facts, policy)` — **pure over
   structured facts**, with no pattern literal, no phase spelling and no button
   word in them. `auto.test.ts` asserts that mechanically by reading the source.
3. `toYieldUpdates(policy, seat)` — the policy as `YieldUpdate` arms, which is
   how the preferences become **Forge's** state so that **Forge** decides. Every
   frame it emits parses against `YieldUpdateSchema` and is an arm
   `YieldController.apply` already handles (`YieldController.java:365-393`).
4. `autoPassReason` / `autoPayReason` keep their names and signatures because
   `match.ts` calls them and lane E does not own `match.ts`. Each is now one
   line: read the facts, ask the policy.

**How the next shortcut request is satisfied.** By naming the preference. For
example:

- *"stop asking me in the opponent's upkeep"* → remove `UPKEEP` from
  `stopOnTheirTurn` (it is not in it) and set `skipNonStopPhases: 'theirTurn'`.
  No new branch: `auto.test.ts`'s *"#20 — the default asks, and ARENA passes it,
  with no code between them"* is that exact diff, asserted.
- *"stop at my declare-attackers step"* → add `COMBAT_DECLARE_ATTACKERS` to
  `stopOnMyTurn`.
- *"never auto-tap for me"* → `unambiguousPayment: 'ask'`.
- *"don't resolve the stack without me"* → `passStackWindows: false`.
- *"give me every stop back"* → `FULL_CONTROL_POLICY`.

---

## 2. The three requests, diagnosed

All three were diagnosed from a real Forge match before anything changed. The
producing command is in §5; the run is `auto.jvm.test.ts`'s second test, which
writes its rows to `$CARDTABLE_PLAY_DUMP/w24-e-windows-<ms>.json`. The rows
below are copied out of that dump (run of 2026-09-26, seed `20260926`, decks
`14 Evolving Wilds / 14 Plains / 12 Stoneforge Mystic` a side).

### #16 — Evolving Wilds asking whether to sacrifice

**Does Forge offer a real decline? Yes — and the decline is an ABORT, not a
game choice.**

`cardsfolder/e/evolving_wilds.txt` gives the ability
`Cost$ T Sac<1/CARDNAME>`, so `CostSacrifice.payCostFromSource()` is true and
`HumanCostDecision.visit(CostSacrifice)` takes its first branch
(`HumanCostDecision.java:1295-1301`):

```java
if (cost.payCostFromSource()) {
    if (source.getController() == ability.getActivatingPlayer() && source.canBeSacrificedBy(ability, isEffect()) &&
            (mandatory || confirmAction(cost, Localizer.getInstance().getMessage("lblSacrificeCardConfirm", source.getTranslatedName())))) {
        return PaymentDecision.card(source);
    }
    return null;
}
```

`mandatory` is `sa.getPayCosts().isMandatory()` (`:36`), false for an ability the
player activated, so Forge asks. Answering "No" falls to `return null`, which
means the cost is not paid and the activation does not happen. So the decline is
real to Forge — **and its only outcome is "nothing happened"**, which is the same
outcome as never having clicked the land. There is no version of the activation
without the sacrifice: the sacrifice IS the cost.

**What the frame carries — measured.** `confirmPayment`
(`PlayerControllerHuman.java:2061-2080`) builds `InputConfirm.confirm(this, sa,
question)`, which is an **input, not a dialog**: `InputConfirm.showMessage`
(`InputConfirm.java:107-121`) calls `updateButtons(owner, "Yes", "No", true,
true, defaultYes)` and then `showMessage(message)` with `card == null` (the
`card != null` branches need a `CardView`, and `confirmPayment`'s path passes
`null` for it). The one row that reaches a seat is therefore:

```json
{ "message": "Sacrifice Evolving Wilds?", "card": null,
  "label1": "Yes", "label2": "No", "enable1": true, "enable2": true,
  "actionable": null }
```

`lblSacrificeCardConfirm=Sacrifice {0}?` is `en-US.properties:2821`.

**So #16 cannot be shortcut from what the wire carries, and that is a finding,
not a preference.** The `CostPart` and the `SpellAbility` are both dropped at
`InputConfirm`; nothing in the row tells this window apart from an
**optional-trigger** confirm, which goes through the same `InputConfirm` with the
same Yes/No bar (`PlayerControllerHuman.confirmTrigger`) and **is** a real game
choice. Under the wave's own asymmetry — a stop they did not get is a lost game —
the window stays a stop. `auto.test.ts` and `auto.jvm.test.ts` both assert that
it stays a stop under every policy, including `costConfirm: 'accept'`.

**What would close it**, and the asymmetry in Forge that makes it cheap:
`confirmTrigger` already consults the yield store —
`getTriggerDecision(wrapper.yieldKey())` is its first line — and
`confirmPayment` consults nothing. The two changes, both outside this lane:

1. **Forge fork:** `PlayerControllerHuman.confirmPayment` gains a
   `yieldController.shouldAutoYield(sa.getKey())` short-circuit, the way
   `confirmTrigger` has one. `shouldAutoYield(String)` has exactly two call sites
   today (`PlayerControllerHuman.java:3808` and `IGameController.java:59-61`),
   neither of them a cost.
2. **`PlayBridge.java`:** carry the ability key with the confirm, so the UI can
   offer "don't ask me again for this ability" and send
   `YieldUpdate.CardAutoYield(key, true)` through `sendYieldUpdate`.

A cheaper interim that does NOT need a Forge change, also outside this lane:
`match.ts` notes which ask a seat last answered, so a Yes/No input arriving
immediately after this seat answered a `getAbilityToPlay` is known to be a cost
confirm for an activation the player chose. That is a `SeatNotes` field and a
`match.ts` edit — named, not taken.

### #20 — stopping at every priority point when there is something to do

Wave 20's rule passes a priority window **only** when Forge's actionable set is
present and empty (`setWeaklySelectable { cards: [] }`), and never passes the
seat's own main phase. So any window where Forge names anything at all is a stop
— which on the opponent's turn is every step, as soon as the seat holds one
instant or one activatable permanent.

Forge's own answer is `skipPhases`: `YieldController.isSkippingPhase(turnPlayer,
phase)` / `setSkipPhase(...)` (`:105-113`), consulted by
`PlayerControllerHuman.skipsPromptForStackOrPhase()` → `isUiSetToSkipPhase`, and
**independent of what the seat could do there** — which is exactly the property
wave 20's rule lacks. Note that Forge only consults it with the stack empty
(`skipsPromptForStackOrPhase` checks `peekStack()` first), and `decideStop` does
the same.

`ARENA_STOP_POLICY` is #20 as a value: stop in `MAIN1`, `MAIN2`,
`COMBAT_DECLARE_ATTACKERS` on your own turn and in `COMBAT_DECLARE_BLOCKERS`,
`END_OF_TURN` on theirs; skip everything else whatever the actionable set says.
`toYieldUpdates(ARENA_STOP_POLICY, seat)` emits exactly the complement of those
two sets as `SkipPhase` frames, asserted per side in `auto.test.ts`.

**It is not the default, deliberately.** Flipping `skipNonStopPhases` changes
what `e2e/play.spec.ts` and `apps/ui/src/play/live/*.jvm.test.ts` observe, and
lane E owns none of those. The flip is one word; the suites that must be green
for it are named in §5 under "could not verify".

### #22 — Stoneforge Mystic waiting for a click on Plains

**Two sources, one assignment — and Forge's own plan is not on our wire.**

`cardsfolder/s/stoneforge_mystic.txt` gives `Cost$ 1 W T`, so the payment is
`{1}{W}`: two mana, which off two lands is two clickable sources even though the
assignment is forced (the Plains must pay `{W}`). The measured row:

```json
{ "message": "Stoneforge Mystic - Creature 1 / 2\n\nPay Mana Cost: {1}{W}",
  "card": { "kind": "card", "id": 23 },
  "label1": "Auto", "label2": "Cancel", "enable1": true,
  "actionable": [1, 11] }
```

Wave 20's `autoPayReason` required `new Set(actionable).size === 1`, so two
sources is a stop. The row shows why that was the only thing provable at the
time: `actionable` is `[1, 11]` — **no repeats**.

Forge does compute the exact plan `Auto` would use
(`InputPayMana.getAutoTapPreviewViews`, `:455-465`) and `pushActionableCards`
raises each planned card to strength 2 **by sending it twice**
(`PlayerControllerHuman.java:1580-1589`). That layer is gated on
`FPref.UI_SHOW_AUTOTAP_PREVIEW`, whose default is `"false"`
(`ForgePreferences.java:101`) and which the bridge does not set — `PlayBridge`
sets only `LOAD_CARD_SCRIPTS_LAZILY`, `UI_LANGUAGE`, `ENFORCE_DECK_LEGALITY` and
`UI_SHOW_ACTIONABLE_HIGHLIGHTS` (`PlayBridge.java:1431-1452`). Our wire already
keeps the multiset rather than a set (`SetWeaklySelectableSchema`, and
`match.ts:747` maps without deduplicating), so the weighting needs no wire
change at all.

So #22's rule is: **a payment is unambiguous when every source Forge offered is
one Forge's own plan would tap.** A source left out of the plan means the plan
had a choice to make, and that choice is the player's. `decidePay` implements
exactly that, and `auto.jvm.test.ts` asserts both halves on the real row — the
measured `[1, 11]` stays a stop, and the same row re-read with Forge's weighting
(`[1, 11, 1, 11]`) settles as `{1}{W}`.

**`UI_SHOW_AUTOTAP_PREVIEW` is in `YieldController.SYNCED_PREFS`**
(`YieldController.java:65`) and `pushActionableCards` reads it through
`yieldController.getBoolPref` (`PlayerControllerHuman.java:1551-1553`), not through `FModel` — so
`sendYieldUpdate(SetYieldPref(UI_SHOW_AUTOTAP_PREVIEW, "true"))` turns it on
per seat, with no preferences-file change. `toYieldUpdates` emits that frame
whenever `unambiguousPayment === 'auto'`. What is missing is the bridge act that
carries it (§6).

### A finding neither request asked for: the buttons lag the prompt

The first run of the diagnosis test recorded a `Priority: … Main phase,
postcombat` message under a `Yes` / `No` bar. That is not a bug in Forge and not
a bug in the capture: `InputConfirm.showMessage` sends `updateButtons` **before**
`showMessage` (`InputConfirm.java:107-121`), exactly as
`InputPayMana.updateMessage` does, so a window opened on the buttons carries the
previous window's message. Wave 19 learned this on the payment input and wave 20
had to relearn it.

The consequence for the model: **`label1` cannot classify a priority window.**
`readPromptFacts` reads it only for the payment input, whose own label is
Forge's `Auto`. The diagnosis test asserts that a priority prompt under a stale
Yes/No bar still classifies as `priority`; the run of 2026-09-26 produced one.

---

## 3. The wire: `sendYieldUpdate`

`ProtocolMethod.java:101` declares
`sendYieldUpdate (Mode.CLIENT, Void.TYPE, YieldUpdate.class)` and
`IGameController.java:84-86` routes it to `applyYieldUpdate` on the receiving
controller. Before wave 24 it existed nowhere in this repo but a comment
(`tier-b.ts:85`).

`SendYieldUpdateSchema` is now in `tier-b.ts` beside `ApplyYieldUpdateSchema`,
over the same twelve-arm `YieldUpdateSchema`: `kind: 'act'`,
`method: 'sendYieldUpdate'`, `update`. `tier-b.test.ts` pins that all twelve arms
carry in this direction, that a thirteenth fails in **both** directions, that it
is an act and not a notify or an ask, that the method name is the one Forge looks
up, and that it refuses an extra field.

It is deliberately **not** in `TIER_B_METHODS` or `TIER_B_CLIENT_FRAMES`, and
that is a file boundary rather than a design choice: `envelope.test.ts` pins the
census (`TIER_B_METHODS` 23, `REQUIRED_METHODS` 41, 38 examples) and lane E owns
neither it nor `examples.ts`, `index.ts` or `envelope.ts`. `tier-b.test.ts`
asserts the exclusion so it cannot drift silently. The five edits that move it
in are listed in §6.

---

## 4. Retiring the regexes

`grep -c 'RegExp\|/\^' apps/server/src/play/auto.ts`: **7 before → 6 after**, and
all six are inside the one named adapter.

| pattern | survives? | owner |
| --- | --- | --- |
| `/^Priority: ([^\n]*)/` | yes | `readPromptFacts` |
| `/^Turn: \d+ \(([^)]*)\)/m` | yes | `readPromptFacts` |
| `/^Stack: Empty$/m` | yes | `readPromptFacts` |
| `/^Phase: Main phase/m` | **gone** | replaced by `PHASE_BY_UI_NAME`, a 13-entry table that yields a `PhaseType` |
| `/^Phase: (.+)$/m` (as `PHASE_LINE`) | yes | `readPromptFacts` |
| `/^Pay Mana Cost: (.+)$/m` | yes | `readPromptFacts` |
| `/^Click on your life total to pay life for /m` | yes | `readPromptFacts` |
| `AUTO_BUTTON = 'Auto'` (a string, not a pattern) | yes | `readPromptFacts` |

`plainCost`'s three patterns (`/\{T\}/g`, `/\{Q\}/g`, `/\{([^}]{1,5})\}/g`) are
not decisions and are not anchored: they rewrite WotC's braces for the line the
seat is shown.

Two assertions keep it that way, and both are mutation-tested:

- *"every anchored pattern in the file is inside the adapter"* — reads `auto.ts`
  off disk, finds every `^const NAME = /^`, and asserts the offset of each lies
  between the adapter's two section markers. It also pins the six names, so a
  rename is a deliberate edit to the list.
- *"the decision layer contains no pattern literal at all"* — asserts the slice
  between the decision marker and the payment-line marker contains no `/^`, no
  `RegExp`, no `Main phase` and no `'Auto'`.

---

## 5. Verification

Node 24 for every command
(`PATH="/home/hadoku/.local/share/fnm/node-versions/v24.18.0/installation/bin:$PATH"`).

| claim | command | result |
| --- | --- | --- |
| the unit suites are green | `npx vitest run apps/server/src/play/auto.test.ts packages/forge-wire/src/tier-b.test.ts` | exit 0 — 434 tests (112 + 322) |
| nothing else in the server or the wire broke | `npx vitest run apps/server/src packages/forge-wire/src` | exit 0 — 1117 passed, 6 skipped (the three jar-gated files) |
| the types hold | `pnpm --filter @hadoku/server run typecheck`, `pnpm --filter @hadoku/forge-wire run typecheck` | exit 0, exit 0 |
| lint is clean on the five owned files | `npx eslint <the five files>` | exit 0 |
| against a real Forge match | the flock line below | exit 0 — 2 tests, both **RAN** (not skipped) |

The jar-gated line, verbatim, and it RAN — the header the run printed is
`wave 19 lane C against a real Forge match`, not the `SKIPPED:` variant:

```sh
flock -x /tmp/claude-1000/w24.lock bash -c '
  export PATH="/home/hadoku/.local/share/fnm/node-versions/v24.18.0/installation/bin:$PATH"
  export CARDTABLE_FORGE_JAR=$HOME/.local/share/cardtable/forge.jar
  export CARDTABLE_FORGE_RES=/home/hadoku/repos/hadoku-cardtable/forge/forge-gui/res
  export CARDTABLE_PLAY_WORK_DIR=/tmp/claude-1000/w24-e-play
  export CARDTABLE_PLAY_DUMP=/tmp/claude-1000/w24-e-dump
  cd /home/hadoku/repos/hadoku-cardtable/.claude/worktrees/w24-manager
  npx vitest run apps/server/src/play/auto.jvm.test.ts'
```

What it printed, 2026-09-26:

```
[lane-c] 2 casts, 26 priority stops (22 with nothing to do), 20 auto-passed, 2 payments, 9 asks reached a browser
[lane-c] the populations each sweep below is over: {"idleNotOwnMain":18,"busy":4,"ownMain":6,"stackLoadedIdle":4,"asksCarryingCards":3}
[lane-e] 42 (prompt, buttons) rows; 1 Yes/No confirms, 1 live payments, 1 of them with two or more sources
[lane-e] #16 confirm: {"message":"Sacrifice Evolving Wilds?","card":null,"label1":"Yes","label2":"No","enable2":true}
[lane-e] 1 priority prompts arrived under a stale Yes/No bar
[lane-e] #22 payment: cost={1}{W} sources=[1,11] planned=[]
```

Three matches were spent in all: one failing pairing (the buttons-lag finding),
one failing classification (the two kinds of Yes/No row), one green.

### Mutation tests

Every one reverts a guard in `auto.ts`, runs
`npx vitest run apps/server/src/play/auto.test.ts`, restores from a byte-exact
copy and runs again. `auto.ts`'s sha256 before the first mutation and after the
last is the same: `5973f4e9511af1bbedd78a00da0fb313d8f53631c24316ecdc13d2925a3a0a91`.
Every mutation is against fixtures and synthetic frames inside `auto.test.ts`;
none touches a live target.

| # | guard reverted | reverted | restored |
| - | --- | --- | --- |
| 1 | `decideStop` stops honouring Forge's actionable set (item 6: a stop with a legal action) | exit 1 — **6 failed** / 106 passed | exit 0 — 112 passed |
| 2 | `decidePay` treats any multi-source payment as unambiguous (item 6: a cost that is a genuine choice) | exit 1 — **4 failed** / 108 passed | exit 0 — 112 passed |
| 3 | `FULL_CONTROL_POLICY` starts passing again (item 6: anything at all under full control) | exit 1 — **3 failed** / 109 passed | exit 0 — 112 passed |
| 4 | `toYieldUpdates` stops clearing the transient yields (item 5) | exit 1 — **2 failed** / 110 passed | exit 0 — 112 passed |
| 5 | the "when in doubt, ask" line — an unclassified window is passed (#16's guarantee) | exit 1 — **3 failed** / 109 passed | exit 0 — 112 passed |
| 6 | a new anchored pattern added OUTSIDE the adapter (the §0b guard) | exit 1 — **2 failed** / 110 passed, naming the pattern | exit 0 — 112 passed |

### Could not verify

| claim | why | the command that would settle it |
| --- | --- | --- |
| `ARENA_STOP_POLICY` as the DEFAULT keeps the browser suites green | lane E may not edit `e2e/play.spec.ts` or `apps/ui/src/play/live/*.jvm.test.ts`, and may not run `pnpm e2e` or build the UI | flip `skipNonStopPhases` in `DEFAULT_STOP_POLICY`, then `pnpm --filter @hadoku/ui build && pnpm e2e` and the three jar-gated UI suites under the same flock and env |
| a `YieldUpdate` this lane emits actually reaches Forge | `PlayBridge.act()` has no `sendYieldUpdate` case, so nothing can be sent | after §6.1 lands: drive `sendYieldUpdate(SetYieldPref(UI_SHOW_AUTOTAP_PREVIEW,"true"))` in `auto.jvm.test.ts` and assert the next payment's `actionable` carries repeats |
| `UI_SHOW_AUTOTAP_PREVIEW: true` really yields a weighted multiset on OUR bridge | the pref cannot be set from inside lane E: it comes from `host.ts`'s `FORGE_PREFERENCES` or a `sendYieldUpdate` act, and neither file is this lane's | set it in `FORGE_PREFERENCES` and re-run the jar-gated line above; the `#22 payment` log line must print a non-empty `planned` |
| `SkipPhase` frames change what Forge does | `PlayBridge.java:1172` answers `isUiSetToSkipPhase` with a hardcoded `false`, and our GUI is not a `RemoteClientGuiGame`, so `PlayerControllerHuman.isUiSetToSkipPhase` never reaches the `YieldController` | after §6.2 lands: run the jar-gated line with `ARENA_STOP_POLICY` pushed, and count `auto-passed` lines per phase |

---

## 6. What the next wave must add, outside this lane

1. **`apps/server/src/play/bridge/PlayBridge.java` — the `sendYieldUpdate`
   act.** `act()`'s switch (`:1196-1224`) has no case for it. Add
   `case "sendYieldUpdate" -> c.sendYieldUpdate(yieldUpdate(frame.getAsJsonObject("update")))`
   plus a `YieldUpdate` deserialiser: twelve tagged arms, `PlayerView` by id out
   of `getGameView().getTracker()`, `PhaseType.valueOf`, `FPref.valueOf`,
   `AutoYieldStore.TriggerDecision.valueOf`. `IGameController.sendYieldUpdate`
   already exists and defaults to `applyYieldUpdate`
   (`IGameController.java:84-86`).
2. **`PlayBridge.java:1172` — `isUiSetToSkipPhase`.** It returns a hardcoded
   `false`. `PlayerControllerHuman.isUiSetToSkipPhase` only asks the
   `YieldController` when `isRemoteClient()`, which is
   `gui instanceof RemoteClientGuiGame` — false for our bridge — so it asks the
   GUI. Delegate it to
   `getGameController().getYieldController().isSkippingPhase(playerTurn, phase)`
   or a `SkipPhase` envelope is inert.
3. **`apps/server/src/play/match.ts`** — a per-seat `StopPolicy`, an act that
   ships `toYieldUpdates(policy, seat)` once `openView` has named the players,
   and `setFullControl` pushing `toYieldUpdates(FULL_CONTROL_POLICY, seat)`.
   Also a `lastAnsweredAsk` field on `SeatNotes`, which is the cheap interim for
   #16 (§2).
4. **`packages/forge-wire/src/{envelope,examples,index}.ts` and
   `envelope.test.ts`** — five edits to put `sendYieldUpdate` in the census:
   `TIER_B_METHODS` 23→24, `TIER_B_CLIENT_FRAMES` 3→4 (both in `tier-b.ts`),
   `CLIENT_FRAME_EXAMPLES.sendYieldUpdate`, the `index.ts` re-export, and
   `envelope.test.ts`'s counts (23→24, 41→42, 38→39, and the 9 client actions).
5. **Forge fork — `PlayerControllerHuman.confirmPayment`** gains a
   `yieldController.shouldAutoYield(sa.getKey())` short-circuit, the way
   `confirmTrigger` already has `getTriggerDecision(wrapper.yieldKey())`. That is
   what makes #16 expressible as a preference rather than a finding. Do not do it
   before `WolffM/forge` exists (`AGENTS.md`).
6. **A UI for the policy** (`apps/ui/`, not this lane): Forge's own clients draw
   one — `forge-gui-desktop/.../VYieldSettings.java` and
   `forge-gui-mobile/.../VYieldOptions.java` are the two, and they are the shape
   of the idea.

---

## 7. Decisions taken because the brief was ambiguous

1. **`DEFAULT_STOP_POLICY` keeps wave 20/22's behaviour exactly; #20 ships as
   `ARENA_STOP_POLICY` rather than as the new default.** §E's done-when says the
   three items behave as the operator asked, and §0b says the deliverable is the
   model. Flipping the default changes what three suites this lane may neither
   edit nor run observe (`e2e/play.spec.ts`,
   `apps/ui/src/play/live/flow.jvm.test.ts`, `board-play.jvm.test.ts`), and "do
   not call work done with anything red" outranks shipping the value. The flip is
   one word and its verification command is in §5.
2. **`sendYieldUpdate` is modelled but left out of the tier census.** Adding it
   to `TIER_B_METHODS` makes `envelope.test.ts` red, and that file is not this
   lane's. The exclusion is asserted rather than commented.
3. **#16 is reported as a finding, not answered.** The brief asked whether Forge
   offers a real decline; it does, and the discriminator that would make the
   shortcut safe is dropped at `InputConfirm`. Auto-answering every Yes/No input
   would also shortcut optional-trigger confirms, which are real choices. Under
   the wave's asymmetry that is the wrong trade, so the window stays a stop and
   §6.5 names the change that closes it.
4. **`isOwnMainPhaseEntry` is kept** (`auto.jvm.test.ts` counts windows with it),
   but is now a question about the policy — a main phase is a stop because
   `stopOnMyTurn` says so — rather than a rule of its own.
5. **`toYieldUpdates` emits a `skipPhase` frame for every (player, phase) pair,
   including the ones with `skip: false`.** Forge's envelope carries one pair at
   a time and `applyClientSeed` is the only atomic form; sending all 13 per player
   makes a policy push idempotent rather than incremental, which is what makes
   "full control clears the yields" true of a single push.
