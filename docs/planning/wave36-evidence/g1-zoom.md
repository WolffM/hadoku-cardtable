# G1 — T1, the hover zoom is misaligned

**Revised after the manager's review.** The first pass below (kept, under "static-fixture pass")
used `apps/ui/src/play/harness.html` — a committed FIXTURE, not a real game — and its "two hand
cards clamp to the identical pixel" framing overstated the finding: cards in the same row sharing a
row height is expected, not misalignment, and the manager was right that a 7px shift is not
plausibly what the operator meant. This revision reproduces against the REAL LiveBoard (a real
Forge match, real control bar, phase rail, stack band, decision area) and says plainly what was and
was not found there.

## Live-board pass (this revision)

**Build measured:** `8888cc3` (`B: the stack is each item's art and one line… (T8); hand cards fill
the row's height (T6); a card's ChosenType…(T7); the arrangement survives a reload…(T10)`) —
lane B's T6/T8/T7/T10 are LANDED in this build, not in-progress — plus this lane's own uncommitted
`inspect/index.ts` fix (below). Built with `pnpm --filter @hadoku/ui build && pnpm --filter
@hadoku/server build` under the build lock, then exercised with a real match under the e2e lock, via
`e2e/play/harness.ts`'s `startPlayStack` and `e2e/play/scenario.ts`'s `startScenarioMatch` — both
read-only imports (same precedent as `confirm.jvm.test.ts` importing `apps/server/src/play/
scenario.ts`); nothing under `e2e/` was edited. Script:
`/tmp/claude-1000/w36-G/live-repro.ts` (scratch, not part of the repo).

Scenario: `bolt-player` (already on disk, not created by this script) — alice holds Lightning Bolt
and one untapped Mountain, an uncontested turn-1 Main Phase 1. That gives a hand card and a
battlefield card directly; a stack item was produced by actually CASTING the bolt at bob (the same
click-driven Arena gesture `e2e/w35.spec.ts`'s R7 spec already uses against this exact scenario:
click the card, move onto the viewer's own battlefield unheld to settle it, click the target). A
fourth case — the same Mountain, now TAPPED (it paid for the bolt) — was hovered too, since a tapped
permanent renders in a visibly different (landscape, shorter) box and nothing had hovered one yet.

### Measured (both viewports; 1366×768 shown where it differs meaningfully, 1280×800 otherwise)

| target | viewport | hovered tile rect | panel rect | relation |
| --- | --- | --- | --- | --- |
| battlefield Mountain (untapped) | 1280×800 | `{left:131, top:554.16, right:199.28, bottom:649.30}` | `{left:207.28, top:278.92}` | top-aligned is NOT possible here either (554+height=922 > floor) — clamped to the floor, unchanged by this lane's fix (`hover.top <= floorTop`) |
| battlefield Mountain, same, TAPPED | 1280×800 | `{left:131, top:577.22, right:199.28, bottom:626.22}` (landscape: 68×49, not 68×95) | `{left:207.28, top:278.92}` — **identical panel** to the untapped reading | still `hover.top <= floorTop`, so still unchanged; the rotated/landscape AABB is handled correctly — no special-case needed, `placeInspector` only ever reads `left/top/right/bottom`, and a tapped card's real rendered box is still axis-aligned (no CSS `transform:rotate`, confirming `board.css`'s "states are words" comment — the tapped shape is a layout change, not a rotation) |
| stack item (Lightning Bolt, cast for real) | 1280×800 | `{left:629.28, top:223.97, right:685.28, bottom:302}` | `{left:357.28, top:223.97}` | `top` exact match, `left = hover.left − GAP − width` exact (room on the left) — **pixel-perfect** |
| hand card (Lightning Bolt, pre-cast) | 1280×800 | `{left:133, top:661.80, right:217.83, bottom:780}` (outer `<li>`) | `{left:225.83, top:282.92, bottom:650.78}` | see below — the outer `<li>`'s rect is NOT what `placeInspector` reads |
| hand card, same | 1366×768 | `{left:133, top:636.09, right:213.30, bottom:747.97}` (outer `<li>`) | `{left:221.30, top:257.22, bottom:625.08}` | same relation, other viewport |

The battlefield and stack rows are **pixel-exact** against `placeInspector`'s own formula, same as
the static-fixture pass found — confirmed again on a real match, with a real cast, with a real
tapped permanent. No bug in any of those three.

### The hand-card row: finishing the measurement the manager asked for

The outer `<li data-board-card>` I hovered is NOT the rect `show()` passes to `placeInspector` —
`inspectedCardFrom` resolves to `target.tile`, the inner `.card`, and `card.css:458`
(`.board-card[data-selectable] > .board-card__face:hover .card { translate: 0 -3px; }`) lifts that
inner tile 3px on hover whenever Forge has made the card selectable (true here — Lightning Bolt is
offered). Solving the fix's own formula backward from the measured panel position
(`clampFloor = panel.top + GAP + height`) gives the tile's REAL hover-time top as `658.797` at
1280×800 — exactly `661.797 − 3`, the outer `<li>`'s top minus the hover-lift. That is the manager's
hint #2, confirmed with a number: the lift is real, it is 3px, and it is already correctly reflected
in the panel's position because `placeInspector` is handed the tile's actual (post-lift) rect at
call time, not a stale one. Nothing about the lift needed a code change.

With that reconciled, the hand-card shift this lane's fix makes is **small on this board**: the
panel's bottom moves from "flush with the hand ZONE's padding edge" to "flush with the hand CARD's
own top" — about 7–10px depending on viewport, visually a few pixels, not the dramatic jump an
earlier draft of this doc implied from a misread screenshot.

### Plain answer to the manager's actual question

**No larger, more dramatic, operator-visible misalignment was found on the live board.** Four
targets, two viewports, a real cast, a real tapped permanent: three of the four were pixel-exact
before this lane touched anything, and the fourth (a hand card) is off by single-digit pixels
either way. If "the hover zoom is misaligned" describes something else — the stack band's NEW
one-line-per-item layout (T8, landed in this same build) interacting with the panel differently
once more items are on the stack at once, or a report from a DIFFERENT viewport/zoom level, or
browser chrome/OS scaling not reproducible headless — this lane could not find it from the files it
owns, and says so plainly rather than inventing a fix for a bug it could not observe.

### What this lane is doing with that answer

Keeping the `clampFloor` fix: it is still correct on its own terms (a hand card's own top, not the
zone's, is the right anchor — verified pixel-exact here too), it regresses nothing (`Math.max` is a
no-op whenever `hover.top <= floorTop`, which is every other measured case above), and it closes a
genuinely untested input domain (`place.test.ts` had no case where `hover.top > floorTop` before
this wave). It is a real, narrow, now-doubly-verified correctness fix — not the operator's dramatic
complaint, which this lane could not reproduce and is reporting as such rather than guessing
further.

---

## Static-fixture pass (first draft, kept for the record — see the manager's correction above)

Reproduced against the real DOM (not jsdom — `place.test.ts`'s own header explains why: no
layout in jsdom), using the committed board fixture's own dev harness
(`apps/ui/src/play/harness.html`, `pnpm --filter @hadoku/ui dev`, `Board` rendered straight from
`PLAY_FIXTURES[0]`, inspector included because `Board.tsx` wires it itself), driven with
Playwright at both viewports the brief named. All three targets — a hand card, a battlefield card,
a stack item — were hovered and measured with `getBoundingClientRect()` on the hovered element, the
panel, and the viewer's own hand zone.

## Method

```
pnpm --filter @hadoku/ui exec vite --port <port>   # outside the build lock — a dev server, not a build/check
# open .../src/play/harness.html, resize to 1280x800 / 1366x768, hover each target, read rects
```

## What was NOT the bug

For a **battlefield card** and a **stack item**, at both 1280×800 and 1366×768, the panel's
`left`/`top` matched `placeInspector`'s own formula **exactly** (sub-pixel, no CSS/wiring
discrepancy):

| target | viewport | hovered tile rect | panel rect | relation |
| --- | --- | --- | --- | --- |
| battlefield card (id 87) | 1280×800 | `{left:99, top:164.84, right:176.72}` | `{left:184.72, top:164.84}` | `left = tile.right + GAP` (flipped right, no room on the left); `top = tile.top` exactly |
| battlefield card (id 87) | 1366×768 | `{left:99, top:158.52, right:173.27}` | `{left:181.23, top:158.52}` | same — `top` still exact |
| stack item (Fire Urchin, id 21) | 1280×800 | `{left:825.38, top:148.98}` | `{left:553.38, top:148.98}` | `left = tile.left - GAP - width` (room on the left); `top` exact |

So `placeInspector`'s horizontal logic (left-preferred, flip right when the left runs off the
board) and its ordinary vertical top-alignment are both correct and already covered by
`place.test.ts`'s existing cases. **No CSS offset, no stale measurement, no aspect-ratio
mismatch** — `.inspect`'s inline `style.left/top` is `spot.left/top` minus the overlay's own
origin, applied with no rounding surprises beyond normal subpixel layout (~0.02px).

## What WAS the bug: a hand card's own vertical clamp ignored the card

`placeInspector`'s floor for the panel's bottom edge is the viewer's own hand zone
(`floorTop = hand.top`). That is correct when the hovered thing is ABOVE the hand (every case in
the table above). But hovering a card **inside your own hand** puts `hover.top` *below*
`floorTop` — measured on the real board, the hand zone's own box includes padding above the card
row, so a card's top sits a few px past the zone's registered top:

| viewport | hand zone `top` | hand card (id 54) `top` | hand card is `top − floorTop` past the floor |
| --- | --- | --- | --- |
| 1280×800 | 639.656 | 646.656 | **7.0px** |
| 1366×768 | 613.969 | 620.969 | **7.0px** |

The old clamp (`Math.min(hover.top, Math.max(ceilingTop+GAP, floorTop - GAP - height))`) used
`floorTop` here regardless of `hover` — so the panel's position depended **only on the hand zone**,
never on which card, or where in the row, was hovered:

| | card id 54, `left≈101` | card id 60, `left≈487` | both at the SAME row height |
| --- | --- | --- | --- |
| panel `top` (1366×768, before fix) | 238.094 | 238.094 | **identical** |

Two different cards — at opposite ends of the hand — produced the byte-identical vertical
position. **The manager's correction on this:** both cards are in the same row at the same height,
so an identical result is in itself expected, not proof of a bug — the actual defect is narrower
than this framing suggested: the position came from the hand ZONE's edge, not the hovered CARD's
own edge, which only matters once a card's top differs from the zone's padding-inflated one (by a
measured 7px here). See the live-board pass above for the honest size of that effect and for
whether anything larger exists.

### Before / after, measured

| viewport | hovered card `top` | hand zone `top` | panel `top` BEFORE | panel `top` AFTER | shift |
| --- | --- | --- | --- | --- | --- |
| 1280×800 | 646.656 | 639.656 | 263.781 | 270.781 | **+7.0px**, now `= hover.top − GAP − height` |
| 1366×768 | 620.969 | 613.969 | 238.094 | 245.094 | **+7.0px**, same relation |

Screenshots (`.playwright-mcp/`, not committed — this worktree's scratch, named per the brief):
`hand-1280x800.png` / `hand-1280x800-after.png`, `hand-1366x768.png` / `hand-1366x768-after.png`,
`stack-1280x800.png` (battlefield/stack, unaffected, for comparison).

## The fix

`apps/ui/src/play/inspect/index.ts`, `placeInspector`: one new local, `clampFloor`:

```ts
// Only differs from `floorTop` when the hovered card's own top already sits
// at or past the hand zone's edge — a hand card.
const clampFloor = Math.max(floorTop, hover.top);
const top = Math.min(Math.max(hover.top, ceilingTop + GAP), Math.max(ceilingTop + GAP, clampFloor - GAP - height));
```

`Math.max(floorTop, hover.top)` is `floorTop` unchanged for every existing case (hover is always
above the hand there), and becomes the hovered card's own `top` exactly when that card is already
past the hand zone's edge — bottom-anchoring the panel to the SPECIFIC card instead of the zone.
Every sibling in the same row starts no higher than that card's own top either, so the "never cover
the hand" guarantee still holds (nothing in the row is covered — the panel's bottom stops exactly
where the row begins, and it is beside the card horizontally regardless).

## Proof (counts)

- `place.test.ts`: 3 new cases (own top for a hand card; two different hand cards diverge; the
  ordinary case is provably unchanged). Reverted to `clampFloor = floorTop`: **2 of the 12 cases in
  that file fail** (the two that assert the position now depends on `hover`, not just `floorTop`).
  Restored: 12 of 12 pass. `index.test.ts`'s existing 23 cases (behavioural: open/dismiss/swallow)
  are untouched by this change and stay green throughout.
- `pnpm --filter @hadoku/ui exec tsc --noEmit` — exit 0, before and after.
- Re-verified live (Playwright, both viewports): the hand card's panel now sits `GAP` above its OWN
  top rather than the zone's; the battlefield card and stack item are byte-identical to before (no
  regression — `Math.max` is a no-op whenever `hover.top <= floorTop`).
