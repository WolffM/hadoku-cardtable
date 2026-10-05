# Wave 46, lane B — arrows + attacking (X1, the counterspell arc, the curve)

Evidence images referenced below are viewed and described, never committed (gitignored).

## X1/W14 — "arrow for attackers still not showing… the planeswalker didn't seem to be selectable"

Root cause and the WIP fix were already verified in code before this lane started
(`abf705c`, `docs/planning/playtest8-plan.md` §X1): during `COMBAT_DECLARE_ATTACKERS`
nothing offered the defenders, so `commitDrag` fell back to `selectCard(attacker)`,
which attacks Forge's current defender (the player). `match.ts`'s `attackDefenders`
(opponents' planeswalkers + every battle) and `attackAssignment` (defender-first send,
`'already'` on a re-drop) were the WIP; this lane:

- finished the unit tests (`apps/ui/src/play/adapter.test.ts`'s `view.combat` block;
  `apps/ui/src/play/live/match.test.ts`'s "X1/W14 — attackDefenders and
  attackAssignment" block; `apps/ui/src/play/live/gestures/gestures.test.ts`'s
  "X1/W14 — a drop on a planeswalker or a face attacks it" block, which retypes one of
  the fixture's real opponent battlefield cards a planeswalker via a synthetic
  `CardState` delta — the fixture's own capture has no planeswalker in it);
- added the LASTING attack arrow (`gestures/auto-targets.ts`'s `combatArrows`, fed into
  the SAME `drawAutoTargetArrows` reconciler the stack-target arrow already used —
  `install.ts`'s one paint-time call, now three producers into one draw);
- proved it against the real jar end to end: `e2e/w46-attack.spec.ts`, on
  `scenarios/w46-b-planeswalker.state` — drag Memnite onto Jace,
  Jace is offered as a defender (W14's own bug), Memnite is declared attacking by
  Forge's own `Attacking` property, and the lasting arrow's tip lands on one of Jace's
  eight edge points (the same geometric proof `arrow.spec.ts` already uses for the
  interactive arrow — there is no bridge-line capture in the e2e harness the way the
  jvm-test harness has, so the wire's `CombatView.def` is read back through the SAME
  adapter path the UI draws from, proven by GEOMETRY rather than a log line). The arrow
  survives through `COMBAT_DECLARE_BLOCKERS` and is gone by `MAIN2`.

### A real defect found in the reused `w41-planeswalker.state` fixture

The brief said to reuse `scenarios/w41-planeswalker.state` (Memnite vs Jace Beleren)
read-only for this proof. **It does not work against a real jar as written, and
apparently never has been run against one:** its `aibattlefield=Jace Beleren` carries
no `|Counters:LOYALTY=N`, and `GameState.applyToGame`'s puzzle-file placement
(`GameState.java`'s `processCardsForZone`) does not default a planeswalker's starting
loyalty on its own — it only sets counters from an explicit `|Counters:...` suffix
(`applyCountersToGameEntity`). Left at zero, Forge's own state-based action
(`GameAction.java`: a planeswalker at loyalty 0 or less goes to its owner's graveyard)
removes Jace before this spec ever gets a chance to see him on bob's battlefield —
confirmed directly: the first run of this spec timed out waiting for ANY card on bob's
battlefield at all. `scenarios/w43-planeswalker.state` already carries the identical
fix for the identical reason, and its own header says so explicitly ("explicit, not
left to whatever ETB setup the engine does on its own").

Per the brief, `w41-planeswalker.state` was **not edited** — a new file,
`scenarios/w46-b-planeswalker.state`, is a copy of it with
`Jace Beleren|Counters:LOYALTY=3` on the one changed line, and `e2e/w46-attack.spec.ts`
uses that instead. Flagging this for the tracker: any OTHER wave that reaches for
`w41-planeswalker.state` expecting a live planeswalker will hit the same wall.

## The counterspell arc (X3's curve item) — what the wire actually carries

The brief's open question: *"a stack item whose target is a spell on the stack draws
its arrow to that spell's THUMBNAIL… find out from the wire what the target id is for
a spell target (a card id matching the target's `sourceCardId`, or something else)."*

**Answer, proven against the real jar
(`apps/server/src/play/scenario-w46-b-counterspell.jvm.test.ts`, new scenario
`scenarios/w46-b-counterspell.state`): there is no id on the wire at all.** Forge's own
`TargetChoices` (`forge-game/.../spellability/TargetChoices.java:45-97`, read off the
main checkout's pinned `forge/` — this worktree's own `forge/` is the empty, un-checked-out
submodule) can hold a `Player`, a `Card`, **or a bare `SpellAbility`** — three disjoint
Java runtime types — and `getTargetCards()`/`getTargetPlayers()` filter strictly by
type. `TargetSelection.chooseCardFromStack`
(`forge-gui/.../player/TargetSelection.java:299-336`) is what resolves "counter target
spell": it asks a generic `getChoices` over `StackItemView`s (never a card offer — this
was already known, `adapter.ts`'s own header comment on shape 2) and, on a choice, adds
`stackItemViewCache.get(madeChoice).getSpellAbility()` — a `SpellAbility`, not a `Card`
— to the ability's own targets. That fails BOTH filters, so **Counterspell's own
resulting `StackItemView` carries `TargetCards: []` and `TargetPlayers: []`, even
though it plainly targeted something.** `TrackableProperty.java` has exactly two
`Target*` properties (`:225-226`); there is no third (`TargetSpells`/a stack-item
target) on the wire at all. The jvm test proves this directly: it drives Counterspell
over Memnite to `Stack: 2 to Resolve` and reads Counterspell's own `StackItemView`
off the real jar's wire — both collections are empty. It also confirms the target ask
itself carries a `{kind: 'stackItem', id}` ref per choice, and that Counterspell's own
stack item does **not** exist yet at the moment the ask fires (only Memnite's item is
on the stack then) — the countering item appears strictly AFTER the target is chosen.

### What this means for the arrow, and what it does NOT fix

Properly carrying this fact end to end would need a new `StackItemView` property (a
`TargetSpells`/stack-item-id field) threaded through `TrackableProperty.java`,
`StackItemView.java`, and `apps/server/src/play/bridge/PlayBridge.java` /
`packages/forge-wire/src/tier-c.ts` — all outside this wave's blast radius for lane B
(`PlayBridge.java` and `packages/**` are explicitly "owned by nobody this wave" in the
brief). So this lane did **not** touch the bridge or the wire schema.

Instead, `match.ts` holds the chosen target id CLIENT-SIDE, at the one place it still
exists — `answerAsk`, the ONE choke point every `getChoices` reply leaves through.
That is a deliberate, late correction: the first pass hooked this only from
`gestures/stack.ts`'s `commitStackTarget` (the manual click), which misses the
COMMON case entirely — `LiveBoard.tsx`'s own `autoAnswer` → `rules.ts`'s
`onlyStackTarget` auto-answers a `getChoices` ask that has exactly ONE legal stack
target (the ordinary shape: one counterspell, one thing to counter) by calling
`answerAsk` directly, never touching the gesture layer. Recording
`LiveMatch.stackTargetIntent` inside `answerAsk` itself — for ANY reply that named
exactly one stack item, read via `prompts/rules.ts`'s `stackItemChoices` (the same
function `onlyStackTarget` uses to decide whether to auto-answer at all) — catches
both the manual-click path and the auto-answer path uniformly.
`redraw`'s new `reconcileStackTargetArcs` claims the pairing into
`LiveMatch.stackTargetArcs` (source stack item id → target stack item id) the moment a
NEW top-of-stack item appears whose `controllerName` is this seat's own — the
countering spell having landed — and prunes an arc the moment either side leaves the
stack. `gestures/auto-targets.ts`'s `stackTargetArrows` draws it through the same
`drawAutoTargetArrows` reconciler as the lasting attack arrow and the existing
Forge-decided stack target arrow.

Proven at both levels:

- unit (`match.test.ts`'s "X3" block): the claim/prune state machine directly, PLUS a
  case that calls `answerAsk` straight — the same shape `onlyStackTarget`'s own
  auto-answer uses — with no gesture involved at all, and a case that a `getChoices`
  reply naming something other than a stack item records no intent;
- real browser (`e2e/w46-attack.spec.ts`'s second test, on `w46-b-counterspell.state`):
  casts Counterspell over bob's lone Memnite — exactly one legal target, so Forge
  auto-answers it and NOTHING in the test ever clicks a stack item — and asserts the
  arc's own tail sits inside Counterspell's thumbnail box and its tip sits inside (and
  on the nearest edge point of) Memnite's thumbnail box.

**Known limit, written down rather than hidden:** this covers THIS SEAT's own cast —
whether answered by a click or by Forge's auto-answer — and is unit-tested for the
common case, the auto-answer case, and two adjacent ones (does NOT mis-claim a trigger
that lands from the OPPONENT between the ask and this seat's own cast; prunes on either
side resolving). It does **not** make the OPPONENT's own counterspell (targeting one of
THIS seat's spells) draw an arc for THIS seat to see — that direction has no local
"I just answered this ask" moment to hang the intent on (this seat never sees that
ask at all), and fixing it properly needs a wire-level property. Recommended follow-up
for a lane that owns `PlayBridge.java`: add a `TargetSpells`/stack-item-ref property to
`StackItemView` and thread it through tier-c, which would let BOTH directions read
straight off `StackEntry.targetCardIds`-style fields the way the first-list-item-8
auto-target arrow already does, and this client-side pairing could then be deleted.

## Files changed

- `apps/ui/src/play/adapter.test.ts` — `view.combat` / `readCombat` unit tests.
- `apps/ui/src/play/live/match.ts` — `stackTargetIntent`, `stackTargetArcs`,
  `reconcileStackTargetArcs` (called from `redraw`), `noteStackTargetIntent` (exported),
  and `answerAsk` itself now records the intent for ANY `getChoices` reply naming one
  stack item — the centralisation that also covers Forge's own auto-answer.
- `apps/ui/src/play/live/match.test.ts` — "X1/W14" (`attackAssignment`/`attackDefenders`
  off the state channel) and "X3" (`stackTargetIntent`/`stackTargetArcs` claim/prune,
  PLUS a direct `answerAsk` auto-answer case and a not-a-stack-item case) blocks.
- `apps/ui/src/play/live/gestures/stack.ts` — `commitStackTarget` unchanged in
  behaviour; its doc now points at `answerAsk` as the actual recorder.
- `apps/ui/src/play/live/gestures/auto-targets.ts` — `combatArrows` (X1's lasting
  arrow) and `stackTargetArrows` (X3's counterspell arc) added, alongside the existing
  `autoTargetArrows`; header comment reorganised to cover all three.
- `apps/ui/src/play/live/gestures/auto-targets.test.ts` — unit tests for the two new
  drawing functions.
- `apps/ui/src/play/live/gestures/install.ts` — the one `drawAutoTargetArrows` call now
  merges all three producers' specs.
- `apps/ui/src/play/live/gestures/gestures.test.ts` — "X1/W14" drag-to-attack block
  (planeswalker, face, already-attacking-sends-nothing).
- `apps/server/src/play/scenarios/w46-b-counterspell.state` — new scenario (Counterspell
  vs Memnite), modelled on the existing Q7 `lone-spell.state`.
- `apps/server/src/play/scenarios/w46-b-planeswalker.state` — new scenario, a corrected
  copy of `w41-planeswalker.state` (see the loyalty finding above); `w41-planeswalker.state`
  itself was not touched.
- `apps/server/src/play/scenario-w46-b-counterspell.jvm.test.ts` — new jvm proof of the
  empty-`TargetCards`/`TargetPlayers` finding above.
- `e2e/w46-attack.spec.ts` — two real-Forge tests: X1 + the lasting arrow (on
  `scenarios/w46-b-planeswalker.state`), and the counterspell arc drawn in a real
  browser (on `scenarios/w46-b-counterspell.state`).

Made dead / deleted: none — every change in this lane is additive (new tests, new
fields, two new arrow-drawing functions feeding the existing reconciler). Nothing here
duplicates or parallels an existing path; `commitDrag`'s defender-first logic and
`autoTargetArrows`'s own stack-target arrow were already the WIP/shipped mechanism this
lane extended rather than replaced.

## Owned jvm suites: one real regression found and fixed, two pre-existing bugs found

Running all three owned jvm tests (`combat-drag`, `flow`, `board-play`) found:

- **`combat-drag.jvm.test.ts` — a REAL regression from this lane's own X1 fix,
  fixed.** Dragging an attacker onto the defender's face now sends TWO frames
  (`selectPlayer` then `selectCard`) instead of the old one, and the file's own
  second drag (onto the battlefield zone, after the face) became
  counterproductive — Forge's own toggle would have UNDECLARED the attacker a
  second click later. Rewrote the gesture-driving half to use the face-drag as
  the sole declaration and updated every assertion (the frame whitelist, the
  per-seat `selectCard`/`selectPlayer` counts, and the final section, which
  used to assert the face-drag sends NOTHING — W14's very bug — and now
  asserts it sends `[playerAct(defender), cardAct(attacker)]` byte for byte).
  Passes.
- **`flow.jvm.test.ts` — all 7 green, untouched.**
- **`board-play.jvm.test.ts` — two PRE-EXISTING bugs found and fixed, one
  PRE-EXISTING/likely-lane-A failure remains.** Confirmed pre-existing by
  reverting all four of this lane's runtime files (`match.ts`, `gestures/
  stack.ts`, `gestures/auto-targets.ts`, `gestures/install.ts`) to `HEAD` and
  re-running: both bugs reproduced identically with ZERO of this lane's code
  present.
  1. The coin toss ("play or draw?") and every other yes/no confirm ("keep
     your hand?", etc.) moved off the generic `live-button-ok`/`-cancel` bar
     into their own `ConfirmPrompt` branches two waves ago (38's
     `isPlayOrDrawPrompt`, T4's `prompt-confirm-yes`/`-no`) — this driver
     predates both moves and never learned either testid, so it hung for the
     full 120 s at the very first coin toss. Fixed: the driver now also
     presses `live-play-or-draw-play` and `prompt-confirm-yes` when enabled.
  2. With those fixed, the suite gets much further (120 s hang → ~14 s run)
     and hits a THIRD failure, NOT yet fixed: `cardButton(second Mountain)`
     is non-null when the assertion expects Forge's one-land-per-turn rule to
     leave it with no button. This is in MAIN1, where `declaringAttackers`
     is false and `attackDefenders`/`declaredAttackers` both return `null` —
     this lane's own code cannot be contributing to `boardInteraction`'s
     output at that point, by construction. `Board.tsx` was modified at
     14:02, ten minutes before this run, and is lane A's active, uncommitted
     rewrite (`git diff --stat` shows a live PlayerArea/StagingArea change
     touching hand-card button rendering broadly, not just the stack). Most
     likely collateral from that in-flight work; NOT re-verified against a
     clean `Board.tsx` baseline (that file is not this lane's to revert) and
     NOT confirmed as something this lane introduced. Flagging for a re-run
     once lane A lands.

## Jvm suites not owned by this lane, run anyway for context

`auto.test.ts` (2 failures) and the scenario/jvm suites lane C is actively
editing are lane C's own in-flight X2 work (`git diff --stat` on
`apps/server/src/play/auto.ts`/`auto.test.ts` confirms substantial
uncommitted changes there) — not this lane's files, not touched, and expected
to go green once C lands per the brief's own ordering (C lands last).
