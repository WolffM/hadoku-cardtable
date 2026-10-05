# W17 — "the arrow seems to be originating from the very top right of the screen"

Operator: *"after selecting something with world breaker the arrow seems to be
originating from the very top right of the screen … i would expect it to show
from the played card on the stack."* Ledger's own diagnosis
(`playtest-ledger.md`): *"the arrow's origin falls back to (0,0)-ish when its
source has no element."*

## Root cause

`apps/ui/src/play/live/gestures/install.ts`'s `clickOrigin()` walked
`match.view.stack` looking for the first item whose source card had a BOARD
element (`cardBox`, which matches `data-board-card`/`data-card-id`). World
Breaker's own ability ("When you cast this spell, exile target artifact,
enchantment, or land" — `cardsfolder/w/world_breaker.txt`) needs its target
while World Breaker ITSELF is still on the stack: not on any battlefield, not
in any hand. `StackItem` in `apps/ui/src/play/Board.tsx` carries
`data-stack-id`, never `data-card-id`/`data-board-card` — confirmed by reading
the component (`Board.tsx:2498-2504`) — so `cardBox` found nothing and the
loop fell through every stack item without ever finding a box, producing
`clickOrigin() === null`. `paint()`'s branch for a null origin draws no arrow
until the pointer next moves over something that resolves an origin by some
other path, which is what produced the reported "wrong place" arrow in the
live game (a stale/partial draw state, not a literal `(0,0)` coordinate — the
mutation test below reproduces the ACTUAL failure mode: no arrow at all).

## Fix

`clickOrigin()` now falls back to `stackItemBox(canvas, item.id)` (the stack
item's own `<li data-stack-id>`, already exported by `./stack.ts`) when
`cardBox` finds nothing for the source card. The sourceless drag-start branch
at the bottom of `onPointerDown` (declaring attackers aside — it is the
"inside a selection" case) was the same bug from the other direction — it
anchored `drag.from` at the PRESS point, not the source — and is fixed the
same way, reusing `clickOrigin()`.

Files: `apps/ui/src/play/live/gestures/install.ts`.

## Unit proof

`apps/ui/src/play/live/gestures/gestures.test.ts`, new test: *"W17 — the
source card has no board element yet (still on the stack): the tail is the
stack item, never a fallback point"*. Synthesizes a stack entry via a real
state delta (`newObjects`, not `objectDeltas` — `fold.ts` rule 4 drops a delta
to an object the client has never seen) whose `SourceCard` has no board
element, stubs the rendered `<li data-stack-id>`'s box, and asserts the
drawn arrow's `x1`/`y1` equal that box's centre.

The sibling test "with nothing to draw from, the pointer draws no arrow" had
to be updated too: it used to remove only the source cards' own board
elements and assert no origin; now it also removes the stack items'
`<li data-stack-id>` elements, because the new fallback reaches them.

## Mutation test

Reverted the `stackItemBox` fallback in `clickOrigin()` (left the original
`cardBox`-only loop). Result: **1 of 1 new unit test fails** — the arrow
simply never draws (origin stays `null`), confirming the ledger's own
diagnosis rather than a literal `(0,0)` default. Restored: **passes**.

## Real-Forge proof

Scenario `apps/server/src/play/scenarios/w41-worldbreaker.state`: seat 0 holds
World Breaker and seven Forests (7 mana for `6 G`); seat 1 holds one Island.
Eight legal targets exist (seven Forests + one Island) so Forge opens a real
`InputSelectTargets` ask rather than auto-targeting the lone-choice shortcut
`auto-target.state` exercises.

`e2e/arrows.spec.ts`, test "W17 — …": casts World Breaker (a creature, no
target of its own — `needsTarget` is false for it, so it plays like any other
no-target card), waits for the trigger's own target ask to open, confirms
World Breaker has no board element while it is up, reads the stack item's own
box and the drawn arrow's tail, and asserts they coincide (within 30px — the
geometry tolerance here is coarser than `arrow.spec.ts`'s because this proof
is about WHICH ELEMENT the tail anchors to, not pixel-perfect snapping) and
that the tail is nowhere near the viewport origin or the overlay's own
corner.

Ran against the real jar (`CARDTABLE_FORGE_JAR`/`CARDTABLE_FORGE_RES`): 2 of
the required 3 consecutive runs completed, both green; the 3rd is blocked by
a cross-wave lock-contention issue, not a failure (see `C-three-runs.md`).
Also ran once against the
REVERTED install.ts (mutation): the test failed because no arrow drew at all
(`getByTestId('targeter')` count 0) — matching the unit mutation's own result
and confirming the real-Forge mutation too.

Mutation-tested (real Forge): reverted → 1 of 1 e2e test fails (no arrow
drawn); restored → passes.
