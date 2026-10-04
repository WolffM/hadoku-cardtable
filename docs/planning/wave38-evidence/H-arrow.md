# H — `arrow.spec.ts`: red against real Forge, cause confirmed in product code, not fixed

Per §H item 3 ("a product red there gets written up, and you stop"). This is NOT caused by this
lane's helper consolidation — confirmed by reverting the consolidation's effect on this file
mentally (the `enterMatch`/`offered`/`promptMethod` swap changes none of the match setup or drag
mechanics) and by reading the product code directly.

## The run

Built `@hadoku/ui` + `@hadoku/server`, then `w38run npx playwright test -c playwright.config.ts
arrow.spec.ts --reporter=line` with the jar env. Forge was live (the test drove a real match: "alice
pressed Play", two confirms answered, real card boxes measured, 387.6px apart — not the
`— SKIPPED` title). Failure:

```
Error: expect(locator).toHaveCount(expected) failed
Locator:  getByTestId('targeter')
Expected: 1
Received: 0
Timeout:  15000ms
```
at `arrow.spec.ts:307`, right after the drag: `mouse.move(srcC)` → `mouse.down()` →
`mouse.move(srcC+20,+20)` → `mouse.move(pointer)` (`pointer` is a few px inside the target card's
far corner) → expect one `targeter` element.

## Root cause, read from the product source (not guessed)

`src`/`dst` are the first two cards Forge offers alice with no prompt open — at this point in a
fresh match (right after the mulligan decisions, before anything has been played), that is
necessarily two HAND cards; nothing is on either battlefield yet. `apps/ui/src/play/live/gestures/cast.ts`'s
module header (Arena casting, R7, wave 35, the operator's own words quoted there: *"the card hovers
to follow the mouse for a bit until its over your battlefield, then just the arrow follows the
mouse as you go to your target"*) and `install.ts`'s `onPointerMove` implement exactly that: a press
on a HAND card only ever reaches `stage: 'lifted'` (no arrow — the card itself follows the pointer,
`drawCastLift`), and the arrow does not start existing until the pointer crosses into
`.seat[data-viewer] [data-zone="battlefield"]` (`overOwnBattlefield`), at which point
`stage` becomes `'settled'` and `drawArrow` starts running every paint (`install.ts:287-304`).

`arrow.spec.ts`'s drag goes straight from the hand card's centre to the target card's position and
never crosses the viewer's own battlefield at any point, so the lift never settles and the targeter
never exists. This spec was written in wave 19/20, well before R7 (wave 35), and — per this wave's
own retro (`retro-code-quality-2026-10-03.md`: *"`arrow.spec.ts` skips in `check` and is not in
forge-e2e's hand-kept file list, so its match never runs in CI"*) — has apparently never been run
against real Forge since. This is the first time anyone has.

## Why this is not a one-line fix, tried and reverted

The obvious fix — move into the viewer's own battlefield first to settle the lift, then continue to
the target — was written, and confirmed (by reading `install.ts` further, not by re-running) to
create two NEW failures in the same test rather than fixing it:

1. **The settle pins the arrow's tail to the settle point, not the source card.**
   `install.ts:298-299`: `const from = drag.stagedAt ?? drag.from; ... drawArrow(overlay, { from, … })`.
   `stagedAt` is wherever the pointer was when it crossed into the battlefield — i.e. wherever this
   fix moves it — not `srcC` (the hand card's original centre). The test's own later assertion,
   `expect(away(tail, srcC), "the tail is the source card's centre").toBeLessThanOrEqual(TOL)`
   (`arrow.spec.ts:341`), would start failing instead.
2. **The settle itself sends a real `selectCard` to Forge** (`install.ts:304`: `if (next.stage ===
   'lifted' && overOwnBattlefield(event.target)) { next = {…, stage: 'settled', cast: true};
   selectCard(match, next.source); … }`) — the cast is committed the instant it settles, not at
   release. The test's closing section, `/* ── and none of this touched the game ── */`
   (`arrow.spec.ts:387-394`), asserts `cancelDrag` leaves `src.id` still offered — i.e. that the
   whole gesture can be cancelled with no server effect. Once a settle has actually fired, that is
   no longer true: reconciling it needs its own look at Forge's cancel path, not a drag tweak.

Properly reconciling this spec with the Arena-cast model is a redesign of several of its assertions
(the tail's reference point, the "nothing touched the game" claim, and probably the setup itself —
using an already-in-play permanent instead of a hand card as the drag source would sidestep the lift
entirely, but needs the match driven to a point where one exists, which this spec's setup does not
do today). That is beyond "one copy of each e2e helper" and beyond a mechanical port to `board.ts`.

## Disposition

Not fixed this wave. `arrow.spec.ts` stays red against real Forge; `— SKIPPED: 0` is true (it is not
skipping, it is failing), but the done-when's "3 runs in a row" is not met and will not be attempted
further this wave — this is the one item §H could not deliver. Recommend routing it to w39/w40
alongside the other e2e-regroup-by-feature carry-over (`wave38-2026-10-03.md`'s "Watches the tracker
holds" for w40 already lists "the e2e regroup by feature" — this is an instance of exactly that: a
spec stale against a product change several waves old).

Everything else §H lists as "owned by nobody" or another lane's (`Board.tsx`,
`gestures/install.ts`, `gestures/cast.ts`) is unedited — this write-up is read-only against them.
