# Wave 46 §A — X3, the stack carousel: evidence

Screenshots are gitignored PNGs (not committed); described here per the wave's
own rule. Taken by `e2e/w46-stack.spec.ts` against real Forge, scenarios
`w46-a-two-bolts.state` and `w46-a-permanent.state`.

## `pinned.png`

Scenario `w46-a-two-bolts`: Alice (viewer) has cast two Lightning Bolts at Bob
under Full Control, both sitting on the stack at once, board otherwise empty
(two Mountains on Alice's own battlefield, far below the stack's column).
Shows: two thumbnails, art-only, top of the stack (the second Bolt cast)
leftmost with a visible blue ring (`aria-current`) and a thin blue "mine"
strip under each (both are Alice's own); the big view — the full `CardTile`
for the selected thumbnail (name, mana cost, type line, oracle text, set
symbol) — pinned directly below the row, no side panel, no coloured outline
beyond the thumbnail's own ring. Matches the approved demo's "whatever is the
top card should show in the expanded big view below it."

## `hidden-no-peek.png`

Scenario `w46-a-permanent`: Bob controls fourteen Memnites, filling the
creature lane well past the stack's own horizontal column (x588–756 of the
1280-wide canvas — confirmed by direct measurement: four Memnites were NOT
enough, the lane only reached x381; fourteen reaches past x1000). Alice casts
one Lightning Bolt at Bob. The big view's own candidate position lands
squarely on top of several Memnites, so it does not pin: the stack shows only
the two thumbnails (Lightning Bolt, Memnite-colony owner strip amber on
Bob's own row is not visible here since only Alice's cast is on the stack),
nothing enlarged below them, and no permanent is covered.

## `peek.png`

Same match, same moment, with the lone stack thumbnail hovered: the carousel's
own peek opens — the identical full `CardTile` the pinned view uses — anchored
one `--stack-gap` below that specific thumbnail. Confirmed in the spec's own
geometry assertions that the peek's vertical offset matches `--stack-gap`
(within tolerance) and is horizontally centred on the hovered thumbnail, not
the row. The peek is allowed to cover the Memnite row here — unlike the
PINNED state, a user-initiated hover is the point of the gesture, not an
unwanted cover.

## Precondition measured directly (not assumed)

Lane A's first attempt at `w46-a-permanent.state` used four Memnites, reasoned
(wrongly) to "span most of the battlefield's own width" since they were the
only thing in the creature lane. Measured against real Forge: the lane packs
from its own left edge rather than stretching, so four Memnites sat at
x131–381 — nowhere near the stack's own column (x588–756) — and the big view
pinned regardless, failing the "hidden" test. Raised to fourteen Memnites
(confirmed by the same measurement to reach x1000+) before the test passed.
