# W5 — "if i bring something back to my hand and left click it, that should also put it back in the hand"

Operator's exact sentence, quoted above. Ledger's own note: *"found: (to
read: the click-armed path after a float-back)"* — flagging the CLICK-ARMED
path (a click lifts a card with no button held, as opposed to a continuous
held drag) as the one to verify.

## What was already correct

`install.ts`'s `resolveLift` already floats a lifted card back to the hand
and sends nothing when the release lands `overOwnHand(node)` — this is
exercised for the HELD-DRAG case by the pre-existing unit test "any card
released over the hand floats back, and nothing is sent, whatever the card
is". That path was never the bug.

## What had no proof at all

Nothing exercised the CLICK-ARMED path specifically: lift with a click (no
button held — `onPointerUp` arms it, `held: false`), move the floating card
back over the viewer's own hand, then the NEXT PRESS (the "left click" that
resolves the gesture, per `onPointerDown`'s own top-of-function check) lands
there too. Reading the code: `resolveLift`'s `overOwnHand(node)` check reads
`node.closest('[data-zone="hand"][data-owner="you"]')` on whatever the
resolving press landed on, with no dependency on the gesture having been a
held drag versus a click-arm — so the SAME check applies either way. No
code change was needed; this was a missing proof, not a bug.

## Unit proof (added, no code change)

`gestures.test.ts`, new test "W5 — a click-armed card brought back over the
hand and left-clicked there floats back, nothing sent": click-arms a hand
card, moves it out over the viewer's own battlefield and back over the hand
with no button held, then presses there — asserts `data-cast-lift` goes
`'returning'` then clears, and nothing reached the replay server the whole
time.

## Real-Forge proof

`e2e/arrows.spec.ts`, test "W5 — …", against the `own-spell` scenario
(Memnite in hand, nothing else): click-arms Memnite, carries it over the
viewer's own battlefield and back over the hand, left-clicks there. Asserts
`data-cast-lift` reads `returning` then clears, the stack count is unchanged
(0 before and after), Memnite is still in the hand by name, and still
`data-selectable`.

Ran 2 of the required 3 consecutive runs against the real jar, both green;
the 3rd is blocked by cross-wave lock contention, not a failure — see
`C-three-runs.md`.

No mutation test: there is no new code to mutate (the existing check this
test exercises already has its own coverage and mutation history from the
wave that built the lift gesture). This test's value is closing the one gap
the ledger named — the click-armed path had no proof before this wave.
