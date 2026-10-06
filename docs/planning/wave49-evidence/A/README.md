# Wave 49, lane A — the counterspell arc, both directions

## Item 1 — the parked-cast diagnosis: verdict is a TEST bug, not a product bug

The WIP (`docs/planning/wave46-evidence/B/counterspell-e2e-wip.md`) reported, at the
w46 hard stop: *"the cast reaches `data-cast-lift="parked"` client-side, but no act
frame reaches the server for seat 0, so the stack never reaches 2."*

**Reproduced the WIP's own gesture against the real jar, with `WebSocket.prototype.send`
patched in the page** (the same technique the tracker used for X1): scenario
`w46-b-counterspell`, alice full-control on, bob casts Memnite, alice lifts and parks
Counterspell outside her hand by the WIP's own raw-mouse-click loop.

**Captured traffic — the act frame DOES reach the server, on the first press:**

```
CAST_LIFT_FINAL parked
WS_SENT_COUNT 2
WS_SENT [
  "42[\"forge:full-control\",{\"matchId\":\"m-e4d1171b0ad9\",\"on\":true}]",
  "42[\"forge:c2s\",{\"matchId\":\"m-e4d1171b0ad9\",\"frame\":{\"kind\":\"act\",\"method\":\"selectCard\",\"card\":{\"kind\":\"card\",\"id\":102},\"otherCardViewsToSelect\":[],\"triggerEvent\":null}}]"
]
```

The `selectCard` act for Counterspell's own card id reached the server exactly once,
immediately after the lift-and-park gesture — not zero times, not twice. The scenario
applied, hands populated, and the match proceeded normally.

**Verdict: the WIP's drive was the bug, not the product.** The retry-click loop the WIP
itself warns about ("retrying past [`parked`] would click the (now relocated) card a
second time... measured to derail the whole exchange") is the likely culprit for
whatever session produced the w46 symptom — a timing difference in when the loop
observed `data-cast-lift`, not a server-side failure to receive the act. Casting a
counterspell in response is NOT broken for a real player.

No product fix was made (there is nothing to fix): `e2e/w49-counterspell.spec.ts`
lands the WIP's own gesture unchanged (`liftAndParkOutsideHand`), now proven to work,
and does not touch `LiveBoard.tsx` or any gesture code.

**A second thing the WIP never discovered, because it never got this far.** Landing
the WIP's own post-park logic (poll for "Pay Mana Cost" or click Memnite's stack item)
hung the same way, for a DIFFERENT, real reason: full control suppresses EVERY
auto-answer, not only the stack-target one (`LiveBoard.tsx`: `const auto = pending ===
null || match.fullControl || spectator ? null : autoAnswer(pending)`). Counterspell's
own cast opens a `getAbilityToPlay` ask FIRST (one ability, "Counter target spell.") —
normally auto-answered (`rules.ts`'s `autoAnswer`, restoring Forge's own desktop-client
behaviour for a null-`triggerEvent` single-ability offer) — and a full-control seat has
to click through it by hand. The WIP's own code never answers this ask at all, so a
faithful port would have hung here regardless of the first finding. Separately, the
WIP's comment that the stack-target ask itself "opens no selection and draws no modal"
(`gestures/stack.ts`'s header) is also contradicted directly: full control draws the
ordinary checkbox-list `getChoices` modal for it, same as any other choice of this
shape — the gesture-layer board click is a second, independent way to answer the SAME
ask, not the only one. `e2e/w49-counterspell.spec.ts`'s `answerLoneAbility` and
`answerStackTargetChoice` answer both asks through that modal UI. Still not a product
bug: both asks are answered correctly by a real player clicking the modal Forge's own
client renders; the WIP's unfinished code simply never clicked them.

## Item 2 — the caster's arc, in a real browser

`e2e/w49-counterspell.spec.ts`'s first test: alice casts Counterspell on bob's Memnite
(scenario `w46-b-counterspell`, unchanged from w46). Full control on for alice, same
reasoning the WIP's own header gives (Forge's single-legal-choice ask would otherwise
auto-resolve the whole exchange before the test's own poll can observe the two-item
stack). The arc is read from `match.ts`'s existing `stackTargetArcs` — the CASTER's own
client-side pairing, built wave 46 §B, unchanged by this wave.

Result: see "3x results" below.

## Item 3 — the opponent's arc, off a new wire fact

**The bridge.** `PlayBridge.java`'s new `stackTargetSpellsJson(Game)` reads the live
`MagicStack` directly: for every `SpellAbilityStackInstance` on the stack, if its
`TargetChoices.getTargetSpells()` names another `SpellAbility` that is itself on the
stack, the pairing `[fromStackItemId, toStackItemId]` is recorded. Sent as
`stackTargetSpells`, a SIBLING of `packet`/`gameView` in `setGameView` and `applyDelta`
frames — not a `TrackableProperty` (that enum is Forge's own, in the stock-upstream
`forge/` this repo does not modify until the fork exists; see `PlayBridge.java`'s own
doc comment on `stackTargetSpellsJson`).

**Why not a `TrackableProperty`:** `StackItemView`'s own `TargetCards`/`TargetPlayers`
are the only two `Target*` properties `TrackableProperty.java` declares, and
`TargetChoices.getTargetSpells()` is a disjoint third arm neither one carries (proven
against the real jar, `scenario-w46-b-counterspell.jvm.test.ts`). Adding a 215th
constant to that enum would mean editing `forge/`, which is off limits this wave.

**The wire.** `packages/forge-wire/src/tier-c.ts`'s `StackTargetSpellsSchema` —
`z.array(z.tuple([JavaInt, JavaInt]))` — added as an OPTIONAL field on
`SetGameViewSchema.payload` and `ApplyDeltaSchema.payload`. Optional so every
historical capture/fixture predating this wave still parses unchanged; the live bridge
always sends it (even `[]`) on every real frame going forward.

**Hidden information.** `visibility.ts`'s projector passes `stackTargetSpells` through
UNREDACTED. This is safe: both ids name stack items, and the Stack zone is in
`PUBLIC_ZONES` (`visibility.ts`'s own table) — a pairing of two ids already on the
public stack reveals nothing a card redaction elsewhere in the same frame has not
already redacted (the pairing carries no name, only ids the client already has from
`GameView.Stack`). `visibility.test.ts`'s "stackTargetSpells (wave 49 §A)" block proves
the pass-through, present or absent, for both frame kinds.

**The fold → adapter → arrow chain.**
- `apps/ui/src/play/fold.ts`'s `FoldResult.stackTargetSpells`: a full snapshot,
  replaced (never merged) whenever a packet carries the field, held across packets
  that don't (fold.test.ts).
- `apps/ui/src/play/live/match.ts`'s `foldFrames` merges the frame-level sibling field
  into the packet objects it hands `foldPackets` (the field lives beside `packet`, not
  inside it), and `LiveMatch.stackTargetSpells` persists it between redraws
  (match.test.ts's "stackTargetSpells (wave 49 §A)" block, driven through real
  `ServerFrame`s via the replay-server harness).
- `apps/ui/src/play/adapter.ts`'s `toBoardView` reads it onto each
  `StackEntry.targetStackItemId` (adapter.test.ts).
- `apps/ui/src/play/live/gestures/auto-targets.ts`'s `stackTargetArrows` draws the
  UNION of `match.stackTargetArcs` (the caster's own client-side pairing, kept — it is
  still the only mechanism for the caster's own seat before the next wire frame lands)
  and every `StackEntry.targetStackItemId` (the wire fact, true for every seat)
  (auto-targets.test.ts).

**Why the old mechanism was kept, not deleted.** Wave 46 §B's own README recommended
deleting the client-side pairing once a wire fact existed. This wave kept it as a
UNION rather than replacing it — a deliberate, documented call made because the brief's
own mutation test (`item 4`) specifically wants the OPPONENT's proof to depend on the
new path while the CASTER's proof is unaffected by the mutation; collapsing to a single
source would have made that distinction unobservable, and replacing the proven wave-46
mechanism outright was more risk than this wave's clock allows to re-verify.

**The real-Forge, two-seat proof.** `e2e/w49-counterspell.spec.ts`'s second test:
new mirror scenario `apps/server/src/play/scenarios/w49-a-counterspell-opponent.state`
— bob holds Counterspell and the mana to pay it, alice holds the free creature. Alice
casts Memnite; bob counters it with NO click from the test for the target (Forge's own
single-legal-choice ask auto-answers it, same mechanism the first test relies on for
whichever seat has full control off); full control is on for ALICE so her own priority
stop holds the exchange open. The arc is asserted ON ALICE'S OWN PAGE — she answered no
ask, holds no `stackTargetArcs` entry, and the only source left is the wire fact.

**jvm-level corroboration.** `scenario-w46-b-counterspell.jvm.test.ts`'s existing test
now also reads `stackTargetSpells` off the actual frames seat 0 was sent (`s.sent`,
through the real projector) and asserts the pairing names Counterspell → Memnite by
their real stack ids — the server-side half of the same proof, independent of the
browser.

## 3x results — `w49-counterspell.spec.ts`

Both tests, 3 runs in a row, against the real jar, 0 SKIPPED:

```
run 1: 2 passed (25.5s)
run 2: 2 passed (25.1s)
run 3: 2 passed (25.9s)
```

`e2e/arrows.spec.ts` and `e2e/w46-stack.spec.ts` (required re-runs): 4 passed, 0
skipped, 0 failed (48.1s).

`scenario-w46-b-counterspell.jvm.test.ts` (the jvm-level corroboration, with the new
`stackTargetSpells` assertion added): 1 passed (11.8s).

## Mutation test

Dropped the adapter's read (`apps/ui/src/play/adapter.ts`, `targetStackItemId:
stackTargetSpells?.get(sid) ?? null` → `targetStackItemId: null`), rebuilt, ran
`w49-counterspell.spec.ts` 3 times:

```
run 1: test 1 (caster) PASS, test 2 (opponent) FAIL — "0 elements" for the arrow locator
run 2: test 1 (caster) PASS, test 2 (opponent) FAIL
run 3: test 1 (caster) PASS, test 2 (opponent) FAIL
```

Reverted-fails: **3/3** (the opponent's proof, and only the opponent's — the caster's
own `stackTargetArcs` path is untouched by this mutation, exactly as intended).

Restored the read, rebuilt, ran 3 more times:

```
run 1: 2 passed (25.5s)
run 2: 2 passed (25.1s)
run 3: 2 passed (25.9s)
```

Restored-passes: **3/3**.

## Full gate

`pnpm run check` (typecheck + lint + the whole `vitest run`, no jar env, every
`*.jvm.test.ts` present and self-skipping): exit 0, both before and after the e2e/jvm
work — **105 test files passed, 41 skipped, 4271 tests passed, 109 skipped, 0 failed**,
identical counts on the pre- and post-mutation runs (no regressions, nothing newly
skipped).

Targeted re-run of every file this lane changed or added a test to (fold.test.ts,
adapter.test.ts, tier-c.test.ts, visibility.test.ts, auto-targets.test.ts, match.test.ts):
**259 passed, 0 failed.**

**Session interruption, 05:17–06:15 UTC.** The session was interrupted mid-wave; the
operator WIP-committed the in-progress tree and the manager reset that commit back to
the working tree, so every file above survived unchanged (`git diff --stat` confirmed
identical to the pre-interruption numbers for every lane-A file). Re-verified from
scratch on resume, against CI's `forge-e2e` job holding the e2e ports until ~06:28:
`pnpm run check` exit 0 (same 105/41/4271/109 counts) immediately on resume with no
jar env; `scenario-w46-b-counterspell.jvm.test.ts` 1/1 against the real jar; the
targeted 259-test run; then, once the ports freed, `w49-counterspell.spec.ts` 3 more
runs in a row (0 skipped, 20.6s/20.7s/21.5s) and `arrows.spec.ts` + `w46-stack.spec.ts`
(4 passed, 0 skipped, 40.2s) — all green, no regressions from the interruption or from
lane B's own concurrent edits in the same shared worktree.

## Files changed

- `apps/server/src/play/bridge/PlayBridge.java` — `stackTargetSpellsJson`, `liveGame`,
  and the three call sites that now send `stackTargetSpells` as a sibling of
  `packet`/`gameView` (`setGameView`, the real `applyDelta`, the synthetic mulligan
  `applyDelta`).
- `packages/forge-wire/src/tier-c.ts` — `StackTargetSpellsSchema`, added (optional) to
  `SetGameViewSchema.payload` and `ApplyDeltaSchema.payload`.
- `packages/forge-wire/src/tier-c.test.ts` — schema shape tests + additive/optional
  frame tests.
- `packages/forge-wire/src/index.ts` — export `StackTargetSpellsSchema` / `StackTargetSpells`.
- `apps/server/src/play/visibility.ts` — `StateFrame`'s payload types carry the
  optional field; `project` passes it through unredacted, with the "why safe" note.
- `apps/server/src/play/visibility.test.ts` — pass-through tests, present/absent, both
  frame kinds.
- `apps/ui/src/play/fold.ts` — `FoldablePacket`, `FoldResult.stackTargetSpells`
  (replace-when-present fold rule).
- `apps/ui/src/play/fold.test.ts` — fold rule tests.
- `apps/ui/src/play/adapter.ts` — `AdaptOptions.stackTargetSpells`,
  `StackEntry.targetStackItemId`.
- `apps/ui/src/play/adapter.test.ts` — read-through tests.
- `apps/ui/src/play/live/match.ts` — `LiveMatch.stackTargetSpells`; `foldFrames` merges
  the sibling field into the packets it hands `foldPackets`; `statePacket` carries it
  forward; `redraw` passes it to `toBoardView`; reset on a new snapshot; updated the
  stale "there is no wire fact for this at all" comment on `stackTargetIntent`.
- `apps/ui/src/play/live/match.test.ts` — "stackTargetSpells (wave 49 §A)" block, driven
  through real `ServerFrame`s.
- `apps/ui/src/play/live/gestures/auto-targets.ts` — `stackTargetArrows` unions both
  sources.
- `apps/ui/src/play/live/gestures/auto-targets.test.ts` — union/precedence tests.
- `apps/server/src/play/scenario-w46-b-counterspell.jvm.test.ts` — header updated; added
  the `stackTargetSpells` wire assertion to the existing test.
- `apps/server/src/play/scenarios/w49-a-counterspell-opponent.state` — new, the mirror
  scenario for item 3.
- `e2e/w49-counterspell.spec.ts` — new, both tests.
- `docs/planning/wave49-evidence/A/README.md` — this file.

Not touched: `LiveBoard.tsx` (the parked cast was never its bug — item 1's verdict),
`apps/server/src/play/match.ts`, `apps/server/src/play/auto.ts` (neither owned this
wave; the projector's `project()` forwards whatever `createProjector` returns generically,
so no change was needed there for the new sibling field to reach the client).

## What this lane could NOT verify

- **A target with MORE than one legal choice.** Both scenarios give Counterspell
  exactly one legal target (the single creature spell on the stack), matching every
  existing scenario this wave builds on (`w46-b-counterspell.state`). The
  `stackTargetSpellsJson` loop takes the FIRST stack-item target of a `TargetChoices`
  that names one (documented in `PlayBridge.java`'s own doc comment on why that is
  always enough for a real game) — not independently proven against a scenario where a
  single spell counters two others at once, because no committed scenario offers one
  and building one was out of this wave's clock.
- **The full CI gate** (`ci.yml`'s pinned/known-failing judge, the forge-e2e job's own
  environment) — this lane ran the equivalent locally (`pnpm run check` with no jar env,
  every jvm suite serially with the real jar, the required e2e re-runs) but did not run
  inside the actions-runner itself; that is the tracker's own full-gate step per the
  wave file's Settled section.
- **Lane B's own items** (`board-play.jvm.test.ts`, the Thoughtseize flake) — out of
  this lane's owned files, not touched and not re-verified here.
