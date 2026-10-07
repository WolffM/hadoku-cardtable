# Wave 54 §B — blockers: undo and arrows (Z7, L15, W14's blocker half)

The operator, Playtest 10: *"blockers cannot be undone; they should work like
attackers: an arrow to what they block, and a second click undoes it."*

## What shipped

1. `apps/ui/src/play/adapter.ts` — `CombatBand` gets a second field,
   `plannedBlockers`, read off the wire's `CombatView` tagged value's `pblk`
   (parallel to the existing `blockers`/`blk`). Both arrive on the SAME wire
   property; the fork's own `DeltaSyncManager.combatViewToCombatData`
   (`forge-gui/src/main/java/forge/gamemodes/net/server/DeltaSyncManager.java:401-461`)
   already flattens Forge's `AttackersWithPlannedBlockers`/`AttackersWithBlockers`
   (`TrackableProperty.java:237-238`, `CombatView.java:162-189`'s
   `addAttackingBand`) band-wise into `DeltaPacket.CombatData`
   (`forge-gui/src/main/java/forge/gamemodes/net/DeltaPacket.java:84-101`); the
   client was simply not reading the `pblk` half.
2. `apps/ui/src/play/live/match.ts` — `declaredBlockers`, a new function beside
   `declaredAttackers`, offers (through `boardInteraction`) every one of the
   viewer's own creatures already in the planned map, so a second click on it
   reaches Forge. Same shape as the attacker undo wave 32 already fixed.
3. `apps/ui/src/play/live/gestures/install.ts` — `blockArrows`, a new producer
   feeding the existing `drawAutoTargetArrows` reconciler (same mechanism as
   `auto-targets.ts`'s `combatArrows`): a lasting blocker→attacker arrow, read
   from the planned map while `declaringBlockers` and from the confirmed map
   once Forge has moved past it.

## Forge source read, and what it says

- **`InputBlock.onCardSelected`**
  (`forge-gui/src/main/java/forge/gamemodes/match/input/InputBlock.java:115-160`):
  a click on an ATTACKING card sets the current attacker; a click on a
  creature already blocking the CURRENT attacker calls
  `combat.removeBlockAssignment` ("lblRemoveFromCombat") — Forge's own undo
  already exists and needs only an offer, not a new mechanism.
- **`PlayerControllerHuman.pushBlockerCandidates`**
  (`forge-gui/src/main/java/forge/player/PlayerControllerHuman.java:1621-1647`):
  only names LEGAL blocks for the current attacker in the actionable set, and
  drops a creature the moment it is already assigned — which is the whole gap:
  the undo click had nowhere to land until `declaredBlockers` offered it back.
- **`AttackingBand.java:14,71-72`**: `private Boolean blocked = null;` — starts
  null, "even if all blockers were killed before FS or CD, band remains
  blocked" once set.
- **`Combat.fireTriggersForUnblockedAttackers`**
  (`forge-game/src/main/java/forge/game/combat/Combat.java:677-679`): *"Call
  this method right after turn-based action of declare blockers has been
  performed"* — `ab.setBlocked(isBlocked)` is the FIRST time `blocked` stops
  being null, i.e. only once the whole Declare Blockers step has resolved.
- **`GameView.updateCombat`**
  (`forge-game/src/main/java/forge/game/GameView.java:215-229`): builds a
  fresh `CombatView` every update from `Combat.getAttackingBands()`, calling
  `combatView.addAttackingBand(attackers, defender, isBlocked ? blockers :
  null, blockers)` — the THIRD argument (→ `AttackersWithBlockers`/`blk`) is
  `null` unless `isBlocked()` is already true; the FOURTH
  (→ `AttackersWithPlannedBlockers`/`pblk`) is always the live
  `combat.getBlockers(b)` list, blocked-flag or not. So `blk` reads empty for
  the whole of `InputBlock` and only becomes populated once declare-blockers
  has fully resolved — `pblk` is the one that is live the entire time. This is
  the exact mechanism `CombatBand.plannedBlockers`'s own doc comment in
  `adapter.ts` cites, and it is what `blockArrows` switches on
  (`declaringBlockers(match)` — true while still in `InputBlock`, false once
  the step has resolved — picks `plannedBlockers` or `blockers` accordingly).
  A null `Game.getCombat()` (combat itself over) clears `CombatView` outright,
  survival of the creatures aside — which is why the e2e proof has to catch
  the confirmed map WHILE combat is still running, never after Main 2.

## Unit tests, and the mutation count (item 5)

Three suites touched: `adapter.test.ts` (the two combat maps, read
independently — a band mid-declaration with a planned blocker and no
confirmed one yet), `match.test.ts` (the offer appears off the planned map and
disappears the moment Forge's own next frame drops it, with no click of ours
in between), `gestures.test.ts` (new describe block `wave 54 §B.2/§B.3`: the
offer + undo click, the arrow while declaring, the arrow disappearing, the
arrow switching to the confirmed map).

Mutation: dropped the one line that reads `pblk` in `adapter.ts`
(`plannedBlockers: v.pblk[i] ?? []` → `plannedBlockers: []`):

```
Mutated:  Test Files  3 failed (3)
               Tests  6 failed | 280 passed (286)
Restored: Test Files  3 passed (3)
               Tests  286 passed (286)
```

The 6 failures: 1 in `adapter.test.ts` ("reads the planned map independently
of the confirmed one"), 1 in `match.test.ts` ("a creature already blocking is
offered too..."), and all 4 of `gestures.test.ts`'s new block — confirming the
single wire-read is what the offer, the undo, and both halves of the arrow all
rest on.

## The real-Forge proof, three runs (claws, `forge.yml`)

- **`37583989455`** — first dispatch, red at `w54-blockers.spec.ts:140`: the
  spec itself asserted `offered(alice.page)` equalled just the two blockers
  before any block was made. Wrong: `blockTargets` (wave 24 §B.3, untouched by
  this wave) offers both ATTACKERS too for the whole of `InputBlock` — a click
  on an attacker is what makes it Forge's current one. Fixed the assertion to
  compare against blockers ∪ attackers (`everyCreature`); not a product bug.
- **`37584358566`** — `--repeat-each=3`, all three green through "blocked
  again (planned map)" and red at the SAME line, spec:202, "the same arrow is
  still drawn, now off the CONFIRMED map": `block:164:170` expected 1,
  received 0. Diagnosed from the artifact's `play-server-stack-*.jsonl`:
  ```
  auto-passed seat1 "Declare Blockers Step"  06:58:27.015
  auto-passed seat0 "Declare Blockers Step"  06:58:27.032
  auto-passed seat1 "Combat Damage Step"     06:58:27.079
  auto-passed seat0 "Combat Damage Step"     06:58:27.092
  auto-passed seat1 "End of Combat Step"     06:58:27.104
  auto-passed seat0 "End of Combat Step"     06:58:27.114
  ```
  Declare Blockers → Combat Damage → End of Combat → Main 2 in **99ms**, every
  `stop-decided` entry in that window carrying `"sources":0,"nonManaSources":0`
  — nobody has anything left to respond with. The scenario's blockers AND
  attackers were both Memnite (`forge/forge-gui/res/cardsfolder/m/memnite.txt`:
  `PT:1/1`): a 1/1 blocking a 1/1 is a mutual kill, and combat damage is a
  turn-based action that runs BEFORE any priority is given in Combat Damage
  Step — so by the first (auto-passed) stop that step ever has, both creatures
  are already gone from the battlefield, `cardBox` finds neither one, and no
  arrow is possible. Not a product bug: the scenario killed the thing it
  needed to observe, and by Main 2 `CombatView` is null outright regardless
  (`GameView.updateCombat`), so there was never a stable moment downstream of
  the trade to catch it in either.
  - **Fix 1 (scenario):** alice's blockers changed from `Memnite;Memnite` to
    `Wall of Stone;Wall of Stone`
    (`forge/forge-gui/res/cardsfolder/w/wall_of_stone.txt`: `PT:0/8`,
    `K:Defender` — Defender only stops it attacking, irrelevant to a blocker).
    0 power never kills the 1/1 attacker; 8 toughness survives the 1 damage
    back. Both creatures now survive combat damage.
  - **Fix 2 (spec):** before the final confirm, turn on full control for
    alice (`live-full-control`) — the same escape hatch `w33.spec.ts`/
    `w46-stack.spec.ts` already use for an auto-paced burst a poll cannot
    reliably land inside. `match.ts`'s `maybeAutoPass` (server):
    `if (s.fullControl || s.ai || this.status !== 'running') return false;`
    — full control only suppresses the SERVER's OWN decision to send a pass
    automatically on the seat's behalf; it does not touch Forge's own
    computation of `Combat`, `CombatView`, `blk`/`pblk`, or anything
    `declaringBlockers`/`blockArrows` read. The feature code path under test
    is byte-for-byte the same whether the pass is sent by the auto-pass
    policy or by this test's own click — full control only buys the test a
    STABLE MOMENT to look, in place of racing a burst that finishes before
    any poll tick lands. Click "Done blocking", click the ordinary priority
    that follows (still inside Declare Blockers Step, now held open rather
    than auto-passed), poll the phase to `COMBAT_DAMAGE` — now held there for
    real — assert both cards are still on the board, THEN assert the arrow.
- **`37585304819`** — `--repeat-each=3` on the merged base (incl. the
  tracker's `aimAt` fix, `acaad12`): **skipped 0, 3 passed** (19.6s, 20.1s,
  18.7s).

### Evidence lines, one green repeat (run `37585304819`)

```
W54-B-EVIDENCE {"step":"declare-blockers opened","blockerId":164,"attackerId":170,"key":"block:164:170","offered":[164,165,170,171],"arrowPresent":false,"blockerDataBlocking":null}
W54-B-EVIDENCE {"step":"blocked once (planned map)","blockerId":164,"attackerId":170,"key":"block:164:170","offered":[164,165,170,171],"arrowPresent":true,"blockerDataBlocking":"true"}
W54-B-EVIDENCE {"step":"undone (second click)","blockerId":164,"attackerId":170,"key":"block:164:170","offered":[164,165,170,171],"arrowPresent":false,"blockerDataBlocking":null}
W54-B-EVIDENCE {"step":"blocked again (planned map)","blockerId":164,"attackerId":170,"key":"block:164:170","offered":[164,165,170,171],"arrowPresent":true,"blockerDataBlocking":"true"}
W54-B-EVIDENCE {"step":"confirmed (combat map)","blockerId":164,"attackerId":170,"key":"block:164:170","offered":[],"arrowPresent":true,"blockerDataBlocking":"true"}
```

Reads exactly as designed: no arrow before any block; arrow + `data-blocking`
the instant the planned map names it; both gone the instant the SECOND click
undoes it (Forge's own undo, no explicit "remove" affordance of ours); back
once blocked again; and — at `confirmed (combat map)`, where `offered` is
empty because neither `declaringBlockers` nor `declaringAttackers` holds any
more (nothing else is actionable either, `sources:0`) — the SAME key
`block:164:170` still drawn, now off the confirmed map, proving the switch
carried the arrow across rather than dropping and redrawing it.

## Made dead / deleted

None. This is new capability (the offer and the arrow did not exist before
this wave); no existing code path, test, or scenario was removed or
superseded. `−0` lines.
