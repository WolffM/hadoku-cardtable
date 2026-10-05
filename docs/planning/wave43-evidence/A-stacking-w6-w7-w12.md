# §A — W6, W7, W12: stacking never scrolls, dropping on is the easy case, one size per card

## W6 — *"when cards are stacked it creates an awkward looking scroll bar... it also weirdly reshape the whole page"*

**Root cause (found by direct measurement, not guessed):** `card.css`'s `.board-card` base rule
sets `--pile-fan: 0px` unconditionally. That selector matches EVERY `.board-card`, including a
pile's fanned MEMBERS, not just the base — and a rule that sets a custom property on an element
always wins over inheritance from an ancestor. So `card.css`'s `:has()` selectors (which raise
`--pile-fan` as a pile grows) only ever reached the base `<li>`; every fanned member kept reading
its own `--pile-fan: 0px` and drew at its full, un-narrowed width. The deepest member's right edge
then ran past the pile's own column by the fan amount (up to 24px), and separately its BOTTOM edge
ran past the row/tier's own height (the grid row sizes to the base card's own intrinsic height,
which `position: absolute` fanned members contribute nothing to) — both overflows landing on
`.seat > .zone--battlefield` / `.zone--hand`'s own `overflow: auto` ("the last resort", `board.css`),
which is the scroll bar the operator saw.

**Fix, in files this lane owns:**
- `apps/ui/src/play/Board.tsx` — `CardOnBoard` now computes the pile's fan ONCE (`pileSize`, same
  formula as `card.css`'s own `--stack-step`/depth cap) and sets `--pile-fan` as an INLINE style on
  EVERY card of the pile, base and every fanned member alike. Inline always wins over a class rule
  for the same element, so this needs no change to `card.css` (w44's file this wave) at all.
- `apps/ui/src/play/board.css` — `.board-card[data-pile-size] { min-height: calc(var(--pile-fan) +
  (var(--card-w) - var(--pile-fan)) * var(--card-tall)); }`. This is the SECOND half of the bug,
  found only after the width fix still left an 8-card pile 6px too tall: the grid row's own height
  is the base `<li>`'s intrinsic height, which (since `.board-card__pile` is out of flow) is just
  the face's height — never `fan + face-height`, the pile's real painted extent. `card.css`'s own
  comment already states that formula ("the pile's height is `fan + (w − fan) · 1.3934`... SHORTER
  than one card's height for any fan") as an invariant about the PAINTED box; nothing made the grid
  believe it. This is zone/grid sizing — this file's job per its own header ("how big a card is in
  each [zone]") — so it is fixed here, reading `--pile-fan` off the same inline value Board.tsx now
  sets, rather than in `card.css`.

**Measured before the fix** (`w43-stack-lands` scenario, 1280×800, real jar):
a pile of 8 breached with `section.zone zone--battlefield: 786x206 > 786x200` (6px of real vertical
overflow, on an element whose `overflow` really is `auto`, not merely `hidden`).

**Measured after both fixes:** `e2e/table-fit.spec.ts`'s new W6 test builds the SAME pile to 2, 3, 4
and 8 cards and checks, at each size, that no element under `.board` has BOTH (a) `scrollWidth`/
`scrollHeight` over its `clientWidth`/`clientHeight` AND (b) a computed `overflow-x`/`overflow-y` of
`auto`/`scroll` on that axis AND (c) a nonzero size on that axis — the third condition rules out
`styles.css`'s own pre-existing, deliberate `.card__rules { overflow-y: auto }` scroller ("long
planeswalkers scroll rather than push the stat line off the panel"), which a tiny board tile's
`flex: 1 1 auto` routinely squeezes to 0px tall and which therefore shows no scroll bar for anyone
to see, scrollable content or not — an early version of this check, without (c), false-positived on
exactly that element for every text-fallback tile on the board, stacked or not.

**Mutation check:** reverted `board.css`'s `min-height` rule to empty — the W6 test failed
(the same `786x206 > 786x200` breach at a pile of 8), W15 and W19 unaffected (2/2 pass). Restored,
3/3 green again. The width half (`Board.tsx`'s inline `--pile-fan`) is mutation-tested under W12,
below — the two halves guard different failure shapes (width vs height) and each test only catches
its own.

## W7 — *"it should be easier to drop cards on eachother to stack them, at the moment its too sensitive for left/right rather than on top"*

**Before:** `Board.tsx`'s `snapTo` read HEIGHT thirds on a pile's box — the top third stacked on,
the bottom third stacked under, and the whole MIDDLE third (any x at all) reordered instead. A drop
anywhere near a card's vertical centre — the single most natural place to aim — landed in that
middle band and reordered, never stacked.

**Fix:** width is read first. A thin strip at each edge (`EDGE = 0.12`, i.e. 12% of the card's own
width) is before/after; the rest — 76% of the width, at every height — stacks, on top if the pointer
is in the upper half, underneath if the lower half.

**Proof, real pointer drag (`e2e/stacking.spec.ts`):** on the `w43-stack-lands` scenario (eight
separate Plains), a drag released near a target card's dead centre (horizontally centred, 35% down
— not the exact geometric centre; see below) stacks; a drag released 5% in from either edge
reorders instead. `Board.test.ts`'s own pure-function tests cover the exact boundary geometry
(`snapTo`, jsdom, no layout needed).

**Found along the way:** `Board.tsx`'s `onTop = y - top < height / 2` ties exactly AT the
geometric centre (strict less-than, not less-or-equal) — a drop at the EXACT centre resolves to
"stack UNDERNEATH", which makes the DRAGGED card the new base and the original base the fanned
member. A naive e2e helper that drags onto a target's exact `centre()` therefore cannot assume the
target stays the base — it did, once, in this lane's own first draft of `stacking.spec.ts`, and
looked exactly like "the fix doesn't work" until traced to the geometry, not the product. Added
`onTopPoint` to `e2e/play/w32.ts` (dead centre horizontally, 35% down vertically) specifically to
land unambiguously in the "stack ON TOP" half, and used it everywhere a test needs the original
base to stay the base.

**Mutation check:** reverted `Board.tsx`'s edge-based `snapTo` block to the old height-thirds
logic — 2 of 2 new jsdom proof tests failed (`Board.test.ts`: "a drop at dead centre stacks, not
reorders"; the pure `snapTo` test asserting the same at the function level), 196 of 198 total still
passed. Restored, 198/198.

## W12 — *"stacking four lands on top of eachother makes one of the lands weirdly small"*

Same root cause as W6's width half (above): a fanned MEMBER drew at its full, un-narrowed width
(card.css's `--pile-fan` cascade never reached it), while the BASE (the one actually visible, on
top) drew correctly narrowed by the whole fan — so the one card the player is actually looking at
really was smaller than its own pile-mates.

**Fix:** `Board.tsx`'s `CardOnBoard` sets `--pile-fan` inline on every card of the pile (see W6).

**Proof:**
- jsdom (`Board.test.ts`, "every card in a pile shares the same --pile-fan..."): builds piles of 2,
  3, 4, and up to 8 (four synthetic lands added to the fixture's own three), and checks the inline
  `--pile-fan` style is byte-identical on the base and every fanned member at each size, growing
  8px/16px/24px for 2/3/4 and capped at 24px for 5 through 8 (Forge's own `UI_MAX_STACK_DEPTH`).
- real browser (`e2e/stacking.spec.ts`, "every card in a pile is the same size..."): the SAME
  progression, on the `w43-stack-lands` scenario, measuring each card's own `.board-card__face`
  rendered box (`getBoundingClientRect`, not the inline style) — width and height equal across
  every card in the pile within 0.5px, at 2, 3, 4 and 8.

**Mutation check:** forced `Board.tsx`'s `pileFan` to always be `0` — the jsdom W12 proof test
failed ("pile of this size: expected '' to be '8px'"), 197 of 198 total still passed. Restored,
198/198.

## Spec runs (3 consecutive, jar env, no SKIPPED)

`e2e/stacking.spec.ts` (W7, W12):

| run | W7 | W12 |
| --- | -- | --- |
| 1 | pass (10.9s) | pass (11.9s) |
| 2 | pass (9.5s) | pass (11.1s) |
| 3 | pass (9.6s) | pass (10.7s) |

`e2e/table-fit.spec.ts`'s new W6 test, run alongside the W15/W19 ones (below) — 3/3 green each time,
see `A-w15-loyalty.md` / `A-w19-ring-clip.md` for the shared run table.

## `pnpm run check`

Exit 0. 101 test files passed, 35 skipped (jar suites, no `CARDTABLE_FORGE_JAR` in that shell —
correct for this check), 3376 tests passed, 73 skipped.

## Made dead / deleted

Nothing deleted this wave — every change is additive (a new prop, a new inline style, a new CSS
rule, two new tests). `card.css`'s own `--pile-fan` `:has()` selectors on the base card are now
redundant (the inline style always wins and computes the identical capped value) but are left in
place: they are `card.css`, not this lane's file, and removing them changes nothing observable.
