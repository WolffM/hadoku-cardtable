# §S — the placed-cards layer

## The DOM contract (`apps/ui/src/play/live/placed.ts`)

Drawn into lane A's overlay root (`[data-board-overlay]`), one element per
`view.stack` entry, for both seats:

- `[data-placed-spell="<item.id>"]` — the wrapper. `data-stack-id="<item.id>"`
  too, on the SAME element: the one thing `gestures/stack.ts`'s `stackItemBox`
  and the fallback arrow origin in `gestures/install.ts`'s `clickOrigin` key
  off, so neither file needed a change to find the element in its new place.
- `data-mine` — present when `side === 'you'` (this screen's own viewer placed
  it). `gestures/install.ts`'s drag gesture (item 5) and the CSS cursor both
  key off exactly this.
- `data-selectable` — Q18: a SPELL entry (never an ability) whose own card id
  is one of Forge's `setSelectables` while it sits on the stack. A click
  answers it (`PlacedInteraction.onSelect`, wired from `Board.tsx`'s own
  `BoardInteraction`).
- `data-placed-next` — the top of `view.stack` (Forge's own order, top first)
  alone, never more than one at a time (item 3). Carries the SAME
  `live-ok-pulse` keyframes the End Turn flash uses (`live.css`), reused by
  name, not redefined.
- `data-placed-leaving` — an item that left `view.stack` for anywhere but a
  battlefield (decision c): fades 250ms (`LEAVE_FADE_MS`), then the element is
  gone. An item that left FOR a battlefield is removed AT ONCE — the AC8
  reservation (`Board.tsx`'s `notePlayedTo`/`expectPlacement`) is already
  drawing the arrival there.
- `.placed__arrow[data-for="<item.id>"]` — one per target (`aimAt`,
  `gestures/arrow.ts`, reused exactly; no second geometry), `data-key`
  `<item.id>:card:<id>` / `<item.id>:player:<id>` / `<item.id>:stack:<id>`.
  Redrawn on every `notify(view)` and on every `moveSpell` (the two mutation
  points, item 8).

### The point, for an item with no registered placement

1. A SPELL with a registered `placeSpell` point (the owner's release, via the
   park in `gestures/install.ts`'s `resolveLift`) — that point.
2. An ABILITY (never a spell) whose source (`sourceCardId`) is drawn on the
   board right now — beside it, to the right, clear of any other ephemeral
   tile already placed there this pass (`besideSource`).
3. Otherwise — a click cast with no recorded release, an ability whose source
   the board does not draw — the default spot: the centre of the old stack
   band's own column (`[data-testid="board-mid"]`, decision a).

### The seam with lane W

`placeSpell(id, at, side)`, `moveSpell(id, at)`, `commitSpell(id)`,
`onSpellMoved(listener)` — typed and fixed, per Settled. `id` at `placeSpell`
time is whatever the caller has: the owner's own release happens before
Forge has pushed a stack item at all, so `gestures/install.ts` calls it with
the CARD's id (the same id a card keeps hand → stack → battlefield);
`placed.ts`'s own `notify` promotes that registration onto the stack item's
real `id` the moment a matching entry appears in `view.stack`, so every call
after that (a drag's `moveSpell`, lane W's `commitSpell`) addresses the same
record by the stack id.

## Deleted (made dead)

- The thumbnail row (`Board.tsx`'s `StackThumb`, `stackItemLabel`) and the
  lone band's treatment — superseded by `live/placed.ts` drawing every item
  uniformly, both seats.
- `LoneAbilityContext` and `CardOnBoard`'s `data-stack-source`/`data-stack-id`
  — the pulse on a lone ability's source — superseded by the EPHEMERAL CARD
  (Settled).
- `board.css`: `.stack__items`, `.stack__item*`, `.stack[data-lone]`, and the
  whole `--stack-card-w`/`--stack-gap` sizing machinery. `.stack` is now a
  single `visibility: hidden` rule — a non-visual anchor, unconditionally, at
  any item count.
- `card.css`: the `data-stack-source`/`@keyframes stack-source` pulse, and
  `.stack__item[data-selectable]`/`.stack__select` (Q18's old button
  styling — `placed.css`'s own `[data-selectable]` replaces it).
- `e2e/w46-stack.spec.ts` — deleted outright (the carousel's own shape, which
  no longer exists).
- `docs/planning/wave59-evidence/S/` (this directory) is new.

## Decisions made because the brief was ambiguous

- **`data-carried` keeps its exact old meaning** (how many of Forge's stack
  items a played card is ALSO currently standing in for, via
  `carryCastOffStack`), even though nothing visual depends on it any more —
  every item is drawn once, by `placed.ts`, whether or not a played card also
  stands in for it. Kept because `e2e/played-card.spec.ts` and
  `gestures.test.ts` still check it, and the brief says keep
  `data-count`/`data-carried`. `carryCastOffStack`/`carriedCastId` in
  `Board.tsx` are otherwise unchanged — bookkeeping only now.
- **The ghost hands off to `placed.ts` the moment a matching SPELL (never an
  ability) appears on `view.stack`** (`gestures/install.ts`'s
  `syncParkedGhost`, `clickOrigin`), not at `stack.length > 1` as the old
  `showOnStack`/`carryCastOffStack` pairing did — the old threshold was about
  hiding a ROW, which no longer exists; drawing the ghost AND the placed card
  at the same point at once is the duplicate this wave exists to retire. The
  ability exclusion is load-bearing: World Breaker's own cast trigger names
  World Breaker as its `sourceCardId` too, before World Breaker's own SPELL
  is itself a stack entry (`e2e/arrows.spec.ts`'s W17 case) — without it the
  ghost would retire for the wrong reason and nothing would stand in for the
  spell at its park point.
- **The ephemeral ability card's "rules text" is the source's full oracle
  text** (`CardTile` on `item.sourceCard`), not a second, ability-specific
  renderer built from `item.description`. "Cards are `CardTile`" (one
  resolver) and the time budget both pointed the same way; for a triggered
  ability the source's own printed text already contains the trigger's
  wording in the overwhelming case.
- **Arrows pass `{ neighbours: true }` uniformly** to `aimAt` for every
  target kind (card, player, stack), rather than reproducing the old
  `aimOn`'s player-only special case (always centre, never edge-biased) —
  `aimOn` itself is private to `gestures/arrow.ts` and not exported; Settled
  only requires reusing `aimAt`, which this does exactly.
- **Q18's selectable click lives on the placed wrapper itself**, not a nested
  `<button>` — `placed.ts` is framework-free; a plain `click` listener,
  checked against `PlacedInteraction.isSelectable` at click time, replaces
  the old `<button className="stack__select">`.
- **A placed card's exact pixel position does not survive a page reload** —
  `placements` is an in-memory module store, never persisted (unlike
  `ARRANGED`'s `sessionStorage`, T10). A reload falls back to the default
  spot (or beside-source) for anything already on the stack. `e2e/play.spec.ts`'s
  `normalizedBoardText` now hides `.placed`/`.placed__arrow` from its
  byte-for-byte reload comparison for exactly this reason — the same
  treatment `.presence`/`.board-number` already had.
- **`e2e/w51-control-box.spec.ts`'s §A.6 ("the stack sits right above the
  decision pop-up") is retired, not merely re-pointed** — it was a claim
  about the deleted row's fixed column; AD4's own rule puts a parked card
  wherever it was actually released (here, the viewer's own battlefield
  centre, `clickHandCard`'s default), which is nowhere near that column by
  design. Replaced with a check that the card is still drawn, and still the
  one thing flashing `data-placed-next`, at both viewport sizes.
- **`e2e/table-fit.spec.ts`'s "12 items overflow the stack band sideways"
  claim is retired, not re-pointed** — there is no scrollable row left to
  overflow; every item is independently positioned in the overlay, which is
  already out of flow. `fillStack`'s DOM probe now injects `.placed`/
  `.placed__tile` elements into the overlay directly, and the remaining
  "canvas is static" proof is that doing so, at any count, never moves a
  board/mid/seat/zone box.

## Mutation tests (`placed.test.ts`)

- Drop the `requestRepaint()` call inside `moveSpell` (the arrow-redraw-on-move
  path, item 8): **1 test fails** — "a moved spell redraws its arrow at once —
  drop that call and this fails". Restored: 15/15 pass.
- Drop the `index === 0` guard on `data-placed-next` (the one-at-a-time flash,
  item 8): **1 test fails** — "exactly one item — the top of Forge's stack —
  carries data-placed-next". Restored: 15/15 pass.

`placed.test.ts` and `Board.test.ts` both fail if `placed.ts`'s changes or
`Board.tsx`'s stack-zone changes are reverted (the whole test suites assert
the NEW DOM; the deleted-row tests assert absence of `.stack__item`/
`data-stack-source` and presence of `[data-placed-spell]`).

## Verified locally (unit/typecheck/lint)

- `pnpm exec vitest run apps/ui/src/play/live/placed.test.ts` — 15/15.
- `pnpm exec vitest run apps/ui/src/play/Board.test.ts` — 223/223.
- `pnpm exec vitest run apps/ui/src/play/live/gestures/gestures.test.ts` —
  118/118 (112 of those pre-existing, unchanged; 8 rewritten for the new DOM;
  2 new — AD3 and item 5).
- `pnpm exec vitest run apps/ui/src/play/live/parity.test.ts` — 2/2, re-recorded
  (see `parity.test.ts`'s own comment: -3299 characters, the deleted row).
- `pnpm --filter @hadoku/ui run typecheck` — clean.
- `pnpm --filter e2e run typecheck` — clean.
- `pnpm exec eslint` on every file this lane touched — clean.
- `pnpm --filter @hadoku/ui build` — clean (needed before any local/claw e2e
  run, which serves the prebuilt dist).

## Verified on a claw (real Forge, real browser)

See the claw run id(s) and outcome below, filled in after dispatch.

## What I could NOT verify

- A local e2e run of the rewritten specs against real Forge on this host:
  port 19108 (the local e2e default) was held by a concurrent wave 60 run
  (lane H, a different worktree) for the whole of this lane's work — per the
  working agreement, local e2e is diagnosis-only and never races another
  session for the port, so this lane went straight to the claw dispatch
  instead of a local rehearsal first.
- Real-browser confirmation of the AD3/item-5 behaviour (covered by jsdom
  unit tests in `gestures.test.ts`, not yet by a dedicated e2e assertion —
  the claw proof specs list does not include a spec written specifically for
  dragging a placed spell; `drag.spec.ts` is in the list but tests the
  EXISTING arrange-drag, not this wave's new one).

## Cross-lane notes (read, not edited)

- `apps/ui/src/play/live/presence.ts:559` reads `.stack__item:has([data-card-id="w${id}"])`,
  which no longer matches anything — the brief already assigns this to lane W
  ("presence.ts reads .stack__item:has(...) today; that is W's file and W
  adapts it — do not edit it"). Confirmed still true after this lane's
  changes; not touched.
