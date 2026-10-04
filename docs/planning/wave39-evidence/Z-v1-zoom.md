# Z — V1: the zoom always grows to the right

Operator (playtest 6, `docs/planning/playtest-ledger.md`): *"hovering a hand card: the zoom
grows to the RIGHT, never the left, and its bottom-left corner sits on the hand card's
top-left corner."*

## What changed

`apps/ui/src/play/inspect/index.ts`, `placeInspector`:

- The left-first anchor (wave 22 item #6) and its flip-to-the-right-when-no-room fallback
  are **deleted**. The panel now always opens `left = hover.right + GAP` — never computed
  against the hovered card's left edge at all, for any card that is not in the hand.
- A HAND card (`hover.top >= hand.top`, same discriminator as wave 36's T1 fix, for the same
  reason — a hand card's own `top` sits a few px below the hand zone's registered `top`) is
  the one exception, on both axes: `left = hover.left`, `top = hover.top - height` — the
  panel's bottom-left corner sits exactly on the card's own top-left corner, no `GAP`.
- The only two clamps left are the board's right edge (shift left as little as needed,
  never flip sides) and the board's top. No left-edge or bottom-edge clamp remains — the
  hand-card anchor's own geometry already keeps it off the hand, and every other case grows
  away from the hand by construction (rightward, top-aligned or above).

`apps/ui/src/play/inspect/place.test.ts` was rewritten to the new rules (see below for the
mutation-test count); `index.test.ts` (behavioural: open/dismiss/swallow) needed no change.

## Unit tests

`pnpm --filter @hadoku/ui exec vitest run src/play/inspect/place.test.ts src/play/inspect/index.test.ts`
→ exit 0, **35/35 passed** (12 in `place.test.ts`, 23 in `index.test.ts`).

`tsc --noEmit -p .` → exit 0.

## Mutation test (the hand-card rule)

Reverted `const isHandCard = hand !== null && hover.top >= hand.top;` to
`const isHandCard = false && hand !== null && hover.top >= hand.top;` (forces every card
through the general, non-hand branch) and re-ran `place.test.ts`:

- **Reverted: 3 of 12 failed** (the two hand-card-specific geometry tests, plus the
  right-edge-clamp-while-hand-card test).
- **Restored: 12 of 12 passed.**

## Live frames (viewed, not committed — `/tmp/claude-1000/w39-Z/`)

Rendered the real `Board` component against the real fixture (a captured Forge game,
turn 14, MAIN1, viewer is Bob/player 0) via `apps/ui/src/play/harness.html` under
`pnpm --filter @hadoku/ui dev` (port 5799, outside the build/check lock — a dev server, not
a build), driven with the Playwright MCP tools at 1280×800.

| case | hovered card | card rect (client px) | panel rect | relation |
| --- | --- | --- | --- | --- |
| hand card | Leapfrog, `data-card-id="54"` | `{left:101, top:646.656, right:198.125, bottom:781.984}` | `{left:101, top:278.781, right:365, bottom:646.641, width:264}` | `panel.left === card.left` (101); `panel.bottom === card.top` (646.641 vs 646.656 — 0.015px float noise). Bottom-left corner touch, no gap. |
| battlefield card | Fire Urchin, Bob's own battlefield, `[data-card-id="21"]` | `{left:99, top:410.516, right:176.734, bottom:518.828}` | `{left:184.734, top:263.781, right:448.734, bottom:631.641}` | `panel.left === card.right + GAP` (176.734+8=184.734) exact. `top` is floor-clamped against the hand zone (pre-existing "shrink above the hand" behaviour, untouched by V1). |
| near the right edge | Direct Current, a stack item (no battlefield card in this fixture sits close enough to the right edge; a stack item was used instead, per the fallback the brief allows) | tile `{left:1068.781, top:148.984, right:1124.781, bottom:227.016}` | `{left:1008, top:148.984, right:1272, bottom:516.844}` | Unclamped preference would be `left=1132.781` → `panel.right=1396.78`, past the board (1280 wide). Clamped instead: `panel.right === board.right - GAP` (1280-8=1272) exactly, `panel.left` shifted left to 1008 — shifts as little as needed, never flips to the card's left side. |

Screenshots: `v1-hand-1280x800.png`, `v1-battlefield-1280x800.png`, `v1-right-edge-1280x800.png`,
`v1-layout-overview.png`, all under `/tmp/claude-1000/w39-Z/` — never committed.

Visually: the hand card's zoom stands directly above it, left edges aligned, touching with no
gap. The battlefield card's zoom sits immediately to its right. The near-edge case (a stack
item) is pulled left just enough to stay inside the board — it never jumps to the card's own
left side.

## For lane E (rewriting `e2e/w36.spec.ts` T1 after this lands)

The old `sitsAgainst` helper accepted either side (`leftOfIt || rightOfIt`) and either
vertical relation (overlap, or "above the card" via the old hand-zone-based clamp). Under V1:

- **Non-hand case:** the panel is *always* to the right of the card
  (`panel.x === hoverBox.x + hoverBox.width + INSPECTOR_GAP`), **unless** the board's right
  edge clamp fired, in which case `panel.x + panel.width === boardBox.x + boardBox.width - INSPECTOR_GAP`
  and the panel may no longer be flush against the card at all (it can sit anywhere to the
  card's left, clamped). The old `leftOfIt` branch (checking `panel.right ≈ card.left`) should
  be **deleted entirely** — it can no longer happen.
- **Hand case:** `panel.x === hoverBox.x` exactly (not `± GAP`) and
  `panel.y + panel.height === hoverBox.y` exactly (not `≤ hoverBox.y + 2`, and not the old
  `INSPECTOR_GAP + 40` slack — the touch is now exact, modulo sub-pixel float noise, so a
  tolerance of ~1px is enough), unless the right-edge clamp fired (then only `panel.x` moves;
  the vertical touch is untouched).
- A card counts as "in the hand" for this purpose when its own top is at or past the hand
  zone's own top (`hover.top >= hand.top`) — not simply "is this element under the hand zone",
  since the hand row's padding puts a hand card's measured top a few px below the zone's own.
