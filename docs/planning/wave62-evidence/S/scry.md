# §S — scry drags like the board, arrows on the card; boxed lands tap at once

Operator, 2026-10-08 (ledger AE4): *"dragging cards for scrying is a bit
inconsistent. can we us the same phantom card and placement logic we use for
putting cards on the board? also, when cards have been selected to be put on
bottom and we show the up/down arrow for reordering let's display those
up/down arrows on top of the card rather than in their own row. that makes it
look a bit more compact."*

Operator, same note (ledger AE5): *"when drawing a box to tap lands, can we
have them all tap simultaneously rather than one at a time?"*

## The AE4 finding, and the manager's decision

Measured against the pinned jar (`702b207eda874df8bae60435284f40836ed8799c`):
cast **Serum Visions** ("Draw a card. Scry 2.") and, separately, **Preordain**
("Scry 2. Draw a card.") — both Scry 2, different card order — from one-card
hands with one untapped Island. Both times the resulting ask is
`data-prompt="order"` (`OrderPrompt.tsx`'s dual list), title *"Select cards to
be put on the bottom of your library"*, never `manipulateCardList`. Lane D's
own `w62-condescend.state`/`w62-condescend.spec.ts` independently treats
Condescend's own Scry the same way (its own comments call it "alice's scry
`order` ask").

Reported first with `ManipulateCardListPrompt.tsx` fixed on its own and
`OrderPrompt.tsx` untouched (the original row). **The manager's decision,
recorded in the wave's closing note, widened this lane's row, sequentially,
to**: `apps/ui/src/play/card.css` (the tapped selector only),
`apps/ui/src/play/prompts/OrderPrompt.tsx` (+ `order.test.ts`), new
`apps/ui/src/play/prompts/scry-drag.ts` (+ its own coverage inside
`manipulate.test.ts`/`order.test.ts`), and `e2e/w62-scry.spec.ts` again — all
of it below is built against that widened row.

## One lift, shared — `prompts/scry-drag.ts`

Both `ManipulateCardListPrompt.tsx` and `OrderPrompt.tsx` used to have their
own copy of the press-drag lift (the first version of this lane's work had
exactly that duplication, flagged by the manager: *"do not leave two copies of
the press-drag lift"*). `scry-drag.ts` is the one copy: `usePressDragLift`, a
hook built directly on `../live/gestures/cast.ts`'s exported
`drawCastLift`/`clearCastLift`/`floatCastLiftHome` (none take a `LiveMatch`,
so a prompt can call them as-is), plus two small shared hit-test helpers
(`rowIdUnder`, `testIdUnder`) that do exactly what `install.ts`'s own release
does: `closest()` on `event.target`, never coordinate math.

**Every row needs a NUMBER, even one that is not a card.** `cardBox`
(`cast.ts`) finds an element by its numeric `data-board-card`/`data-card-id`.
`OrderPrompt.tsx` also orders rows that are not cards at all (Forge's "order
simultaneous triggers" — words, no art, no Forge id). Those still lift: each
row gets a "lift id" — a real card's own id where there is one, a small
per-mount NEGATIVE number where there is not. Forge's own ids are never
negative, so a synthetic one can never collide with a real board card's,
wherever `cardBox`'s document-wide query happens to land first. This is the
one piece of new design the generalisation needed; everything else is a
direct reuse of the board's existing gesture.

`usePressDragLift` owns the gesture (slop, the attribute, the click a resolved
drag leaves behind via `suppressClickRef`/`onListClickCapture` —
`install.ts`'s own `suppressClick` technique, scoped to one hook instance);
each caller owns its own `canLift`/`onDrop` semantics and does its own
hit-testing with the two shared helpers.

## `ManipulateCardListPrompt.tsx` — unchanged in shape, now calling the shared hook

HTML5 `draggable`/`onDrag*` deleted; a press on a movable row lifts it,
pinned to the viewer's own battlefield card width exactly as a lifted hand
card is; release over `manipulate-top`/`manipulate-bottom` commits `place`,
over another row commits `dropBefore`, anywhere else floats the row home.
↑/↓ moved onto the card's own tile (`.prompt__card-order`).

25 unit tests (`manipulate.test.ts`), all rewritten to real `pointerdown`/
`pointermove`/`pointerup` sequences (the same two-event shape
`../live/gestures/gestures.test.ts` uses for the board's own lifted-hand-card
cases).

## `OrderPrompt.tsx` — the real target, rebuilt the same way

HTML5 `draggable`/`onDrag*` deleted from BOTH lists (`order-source` and
`order-dest`). A press on either list's row lifts it (card or not — see
above); release, hit-tested via `rowIdUnder`/`testIdUnder`:

- over a PLACED row → lands just before it (the `from < destIndex ? destIndex
  - 1 : destIndex` adjustment `ManipulateCardListPrompt.tsx`'s own
  `dropBefore` already used — the ORIGINAL `OrderPrompt.tsx` did not have
  this adjustment for its own dest-to-dest drag, which landed one position
  too late when dragging an item LEFTWARD past itself; fixed here as part of
  unifying the two components' logic, not a separately-filed bug);
- over an UNPLACED row → unplaces the dragged item (a no-op if it already is);
- over the dest list's own empty space → appended at the end;
- over the source list's own empty space → unplaced;
- anywhere else, or dropped on itself → floats home, nothing changes.

↑/↓ moved onto each placed row's own tile (`.prompt__card-order`, the
identical class `ManipulateCardListPrompt.tsx` uses) — `prompt__row-actions`
is drawn by neither component any more, and its CSS is deleted (see below).

15 unit tests (`order.test.ts`): the three HTML5-drag cases rewritten to
press-drags (`dragTo`, the same shape `manipulate.test.ts`'s own helper
uses); two new cases (the lift attribute itself, `draggable` absent
everywhere); one new case in the cards-fixture `describe` block proving a
CARD row in `order` lifts the same way a non-card row does.

### A real-browser geometry fix the rewrite needed

The first real-Forge run of `w62-scry.spec.ts` failed: dragging the first
card into the EMPTY answer list left it un-placed. `.prompt__cards`/
`.prompt__list` had no minimum height, so an empty `<ul>`/`<ol>` collapsed to
~0px and painted nothing for a real pointer to land on — `OrderPrompt.tsx`'s
two lists are legal drop targets precisely when one of them is empty
(everything still unplaced, or everything already placed), and a collapsed
element cannot be hit-tested at all by a real browser (jsdom's `fireEvent`
never had this problem, since it dispatches directly on the named element
regardless of its rendered size — this is why the unit suite did not catch
it). Fixed with the same `min-height: 2.4rem` `.prompt__dropzone` already
had, added to both `.prompt__cards` and `.prompt__list` in `prompts.css`.
`Test Files 15 passed | 6 skipped` across every file under
`apps/ui/src/play/prompts/` after this change — nothing else depends on the
previous (collapsed) empty-list size.

## Shared CSS: `prompt__row-actions`, `[draggable]` — deleted

Grepped before deleting anything: `prompt__row-actions` and `[draggable]`
were drawn ONLY by these two components, and neither draws either any more.
`prompts.css`:

- `.prompt__stepper, .prompt__row-actions { … }` → `.prompt__row-actions`
  dropped from the selector (the block, otherwise identical, is
  `AssignPrompts.tsx`'s own `.prompt__stepper`, untouched).
- `.prompt__list > li[draggable] { cursor: grab; }` and
  `.prompt__cards > li[draggable] { cursor: grab; }` — both removed outright.
- `data-dragging`/`data-movable` selectors are **kept** — both components
  still draw those attributes, now driven by the lift's own state
  (`lift.liftedId === id`) instead of HTML5 drag state; the CSS they key off
  needed no change at all.
- `position: relative` added to `.prompt__list > li` (joining
  `.prompt__cards > li`, which already had it) and a
  `.prompt__cards > li[data-cast-lift='lifted'] { width: var(--card-w); }`
  rule, generalised in its own comment to cover both components' rows.
- `.prompt__card-order` (the on-tile ↑/↓) is unchanged from the original
  design, now explicitly shared by both files in its own header comment.

## `card.css` — the two-line diff, applied

```diff
- .board-card:is([data-tapped], [data-attacking]:not([data-vigilant])) > .board-card__face {
+ .board-card:is([data-tapped], [data-tapped-pending], [data-attacking]:not([data-vigilant])) > .board-card__face {
```
at line 685, and the identical change to the `> .board-card__face > .card`
selector at line 703 (now `:is([data-tapped], [data-tapped-pending],
[data-attacking]:not([data-vigilant]))` in both places). A box-draw's
optimistic `data-tapped-pending` now draws the real quarter-turn, not only
the attribute.

**Mutation, real Forge**: reverting both lines (`[data-tapped-pending]`
dropped from both `:is(...)` groups) makes `stacking.spec.ts`'s new
visual-turn assertion FAIL —
`land 108 is drawn visually turned (quarter rotation) at the same moment, not
only flagged: expected true, received false`. Restored, rebuilt, rerun:
green.

## AE5 — boxed lands tap at once, drawn state now proven visually too

`commit.ts`'s `TAPPED_PENDING_ATTR`/`markTappedPending`/`clearTappedPending`
and `install.ts`'s `pumpTaps`/marquee-release wiring are unchanged from the
first report. `e2e/stacking.spec.ts`'s box-tap test now reads BOTH the
attribute (`data-tapped-pending` or the real `data-tapped`, within a 1 s poll)
AND the computed CSS transform (`getComputedStyle(face).transform`, the same
technique the piled-card test above it already uses) for all four boxed
lands at the moment of release — the visual turn is proven, not only the
state that is supposed to cause it — together with the websocket capture
showing fewer than four `selectCard` acts on the wire at that same moment.

## Mutation proof, exact counts

- **Unit — `window.addEventListener('pointermove', onLiftMove)` commented
  out in `scry-drag.ts`** (the shared hook never starts a lift at all — the
  "kept HTML5 drag" class of regression, generalised across both
  components): `apps/ui/src/play/prompts/order.test.ts` + `manipulate.test.ts`
  together: **12 of 40 tests FAIL** (5 in `order.test.ts`: both drag-into
  cases, the reorder case, the lift-attribute case, the cards-fixture lift
  case; 7 in `manipulate.test.ts`, as reported before). Restored: **40/40
  green**.
- **Unit — `markTappedPending`/`endTapSweep`'s clear, `install.ts`**
  (unchanged from the first report): two targeted reverts, two FAILs, both
  restored to green; `gestures.test.ts` full file: 121/121.
- **Real Forge — `card.css`'s two lines reverted**: `stacking.spec.ts`'s new
  visual-turn assertion FAILS (above). Restored: green.

## Real Forge — final state

- `e2e/w62-scry.spec.ts` (new, against `w62-scry.state`'s Preordain): casts
  it, confirms the `order` ask opens, press-drags the first card into the
  empty answer list (the lift attribute observed mid-drag, the commit
  landing the right card), press-drags the second card onto the first
  (landing before it — the dest-to-dest fix above, proven live), measures the
  placed row's ↑ sits inside that row's own tile rect (all four edges), and
  confirms the answer reaches Forge (the prompt closes). **Run 3 consecutive
  times, all green** (12.4s, 12.5s, 11.3s).
- `e2e/stacking.spec.ts`: **6/6**, including the strengthened box-tap test
  (attribute + computed-transform + act-count).
- `e2e/drag.spec.ts` (lane P's file, shares `install.ts`): **7/7** —
  unaffected by this lane's `pumpTaps`-only edit.
- `apps/ui/src/play/prompts/**` unit suite in full: **316 passed, 12 jar-gated
  skipped**, 0 failed.
- `pnpm run typecheck` (whole workspace, rebuilt onto lanes D and I's
  landed commits): clean. `npx eslint` on every touched `.ts`/`.tsx`: clean.

## `e2e/w33.spec.ts` and the rest of `e2e/`

Grepped before and after this widening:
`grep -rln "prompt__row-actions|draggable|dragStart|dragOver" e2e/*.ts` finds
nothing relevant outside `w62-scry.spec.ts` itself (the two other hits,
`table-fit.spec.ts` and `play.spec.ts`, read the BOARD's own
`draggable`/arrange-gesture marker, unrelated to either prompt).
`grep -rln "order-source|order-dest|order-remember"` finds only
`e2e/w62-condescend.spec.ts` (lane D), which answers the `order` ask through
`answerPrompt`'s existing `'order'` case — **clicks only** (places items from
`order-source` one at a time until submittable, then submits), never a drag —
so it is unaffected by the HTML5-drag removal and was not touched.
`e2e/w33.spec.ts`: still nothing in it reads any testid or class either
prompt draws or stopped drawing (checked again after the widening).

## Done-when, final

- Every unit pin fails when reverted (above, both AE5's pair and AE4's
  `scry-drag.ts` mutation across both consumers) — proven.
- `stacking` (6/6), `drag` (7/7), `w62-scry` (3/3 consecutive) green on this
  host against the pinned jar.
- `card.css`'s own mutation proven against real Forge, not just a unit pin.
- `w33`: nothing in it to prove either way; re-checked, not re-run in full
  (still mid-edit risk from other lanes at the time of the first report; by
  the time of this widened report lanes D and I are landed on `w62` — a full
  re-run of `w33.spec.ts` was not repeated here since nothing in it names
  either prompt).
