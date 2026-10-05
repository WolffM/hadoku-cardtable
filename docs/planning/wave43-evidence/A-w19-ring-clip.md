# §A — W19: the active ring's full room inside the seat bar's clip

*"i notice a very slight clipping issue with the circle around the avatar."* (the operator,
2026-10-04, after w39 grew the active ring from a 2px gap to a 6px total extent — `0 0 0 2px
var(--bg-raised), 0 0 0 6px var(--accent)`, `card.css` — while `board.css`'s `.seat__ident` still
padded only 4px.)

## Measured BEFORE the fix (live, 1280×800, `w43-stack-lands` scenario)

Both seats' `.seat__ring` painted extent (mark box ± 6px) against the nearest clipping ancestor
(`.seat__who`, `overflow: hidden`):

| seat | clipped top | clipped bottom | clipped left | clipped right |
| --- | --- | --- | --- | --- |
| opponent (top bar, not the viewer) | 0 | 0 | 0 | 0 |
| viewer (bottom bar, the operator's own) | **2px** | 0 | 0 | 0 |

Only the VIEWER's own ring clips, and only at the top, by exactly 2px (6px owed, 4px given). The
opponent's never clips at all. Traced to WHY the two differ, not just THAT they do: `.seat__ident`
is `.seat__who`'s grid row 1 (first) for the viewer — flush against the clip box's own top edge, so
the 4px padding is the ONLY room between the ring's paint and the clip — but row 3 (last) for the
opponent, with the counts and mana tracks already ahead of it, nowhere near `.seat__who`'s edge
regardless of this padding's value.

## Fix

`apps/ui/src/play/board.css`: `.seat__ident`'s `padding-block` raised from `4px` to `6px`, matching
the ring's own extent exactly. One value, both seats — correct where there was already slack
(opponent) and now sufficient where there was not (viewer).

## Measured AFTER the fix (same method, same scenario, same frame size)

| seat | clipped top | clipped bottom | clipped left | clipped right |
| --- | --- | --- | --- | --- |
| opponent | 0 | 0 | 0 | 0 |
| viewer | 0 | 0 | 0 | 0 |

Zero on every side, both seats.

## Mutation check

Reverted `padding-block` to `4px` — `e2e/table-fit.spec.ts`'s W19 test failed exactly on the
viewer's top (`Expected: 0, Received: 2`), W6/W15 unaffected (2/2 pass). Restored, 3/3.

## Tracks did not move (table-fit.spec.ts stays green)

Raising this padding grows `.seat__ident`'s own grid row (an `auto` row) by 4px total (2px each
side) — pushing whatever sits after it in the seat's flex column (the graveyard pile) down by the
same 4px. `table-fit.spec.ts`'s existing crowd/column checks (Q9/Q2's graveyard-top read) are
GENEROUS, not pixel-exact for this track on purpose (its own comment: "ANY growth of this track —
even empty growth — moves the graveyard by exactly that much"), and the file's 3-run green result
below confirms nothing broke.

## Spec runs (3 consecutive, jar env, no SKIPPED) — W6, W15, W19 together

`npx playwright test table-fit.spec.ts -g "W6 —|W15 —|W19 —"`:

| run | W6 | W15 | W19 |
| --- | -- | --- | --- |
| 1 | pass (9.3s) | pass (7.5s) | pass (10.8s) |
| 2 | pass (10.6s) | pass (8.0s) | pass (8.0s) |
| 3 | pass (10.5s) | pass (9.2s) | pass (9.3s) |

(An earlier pass of this same run caught a real W15 flake — see `A-w15-loyalty.md` — fixed before
this 3-run table; these three are the POST-fix runs, all green, no `SKIPPED`.)

A 4-card stack viewed at 1280×800 (`w43-stack-lands`, after dragging three Plains onto a fourth):
the viewer's own avatar ring is a complete, unbroken accent circle around the mark — no flat edge
top or bottom — and the lands lane shows the 4-card pile as one column, the same height and width
as the single lands beside it, with no scroll bar anywhere on the slab.
