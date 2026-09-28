# The board's blocking — the operator's own layout, 2026-09-27

The operator laid this out by dragging the real regions on a 1280×800 canvas
(`Cardtable Blocking`, https://claude.ai/artifact/YVxEMT7bfxyK6zcgdcivDN — the
arrangement is saved in that artifact's own store, `layout/current`). This file
is the record, because the last visual instruction was given three times in
conversation and never reached the board. **It is a spec to implement, not a
suggestion.**

Coordinates below are the operator's, in that 1280×800 space, with percentages
because the real layout is fluid. Percentages of the canvas, not of a parent.

## The settled shape

**Two things in the flow, everything else floating.** This is the operator's
answer to the one question the drag could not express (2026-09-27): *"float over
the board makes sense"*. The board's own grid KEEPS ITS WIDTHS — the battlefield
and hand rows still run the width of the table — and the stack, the question
panel, the phase rail and the controls are overlays on top of the right end.
`.live__phases` and `.live__buttons` are already `position: absolute` inside
`.live`, so this is the mechanism that exists, not a new one.

**Permanent overlays reserve their space; transient ones do not.** The rail, the
controls and the log button are always there, so the rows underneath them
reserve right-hand padding and a card never comes to rest beneath them — the
trick `.board__bar { padding-right: 11rem }` already uses for the status line
(`board.css:207`). The stack and the question panel come and go, so they simply
cover what is under them.

## The flow: a left column and four rows

| region | selector | x | y | w | h | as % (x, y, w, h) |
| --- | --- | --- | --- | --- | --- | --- |
| piles, opponent | `.seat__piles` (opp) | 8 | 52 | 72 | 132 | 0.6, 6.5, 5.6, 16.5 |
| hand, opponent | `.card-backs` | 84 | 52 | 1112 | 124 | 6.6, 6.5, 86.9, 15.5 |
| portrait, opponent | `.seat__who` (opp) | 8 | 192 | 72 | 212 | 0.6, 24, 5.6, 26.5 |
| battlefield, opponent | `.zone--battlefield` (opp) | 84 | 192 | 1112 | 208 | 6.6, 24, 86.9, 26 |
| portrait, you | `.seat__who` (you) | 8 | 412 | 72 | 208 | 0.6, 51.5, 5.6, 26 |
| battlefield, you | `.zone--battlefield` (you) | 84 | 408 | 1112 | 208 | 6.6, 51, 86.9, 26 |
| piles, you | `.seat__piles` (you) | 4 | 628 | 76 | 128 | 0.3, 78.5, 5.9, 16 |
| hand, you | `.zone--hand` (you) | 84 | 628 | 1112 | 132 | 6.6, 78.5, 86.9, 16.5 |

Read off that table:

- **One left column, ~72px (5.6%), per seat**, holding the portrait and the
  piles — and the piles are on the hand's side of the divide, the portrait on
  the battlefield's side. For the viewer that means **portrait above, graveyard
  below**, which is wave 25 §E's item 5 arriving as exact geometry. The opponent
  mirrors it: piles above, portrait below.
- **Four rows, hands outermost.** Opponent hand, opponent battlefield, centre
  line at y≈404, your battlefield, your hand. The two battlefields face each
  other across the middle; each hand is furthest from it.
- The piles column is no longer a full-height third column beside the
  battlefield (`grid-template-areas: 'who field piles'`, `board.css:309-311`).
  It becomes a second row of the left column.

## The overlays

| region | selector | x | y | w | h | as % | behaviour |
| --- | --- | --- | --- | --- | --- | --- | --- |
| stack | `.stack` | 760 | 92 | 308 | 92 | 59.4, 11.5, 24.1, 11.5 | transient, covers |
| question / payment | `.live__prompt` | 760 | 192 | 308 | 384 | 59.4, 24, 24.1, 48 | transient, covers |
| phase rail | `.live__phases` | 1084 | 248 | 108 | 280 | 84.7, 31, 8.4, 35 | permanent, reserves |
| controls | `.live__buttons` | 1080 | 536 | 112 | 84 | 84.4, 67, 8.8, 10.5 | permanent, reserves |
| log button | (new) | 1224 | 212 | 36 | 32 | 95.6, 26.5, 2.8, 4 | permanent, reserves |

- **The stack and the question share one column** (both x760, w308): stack on
  top, question beneath it, together spanning the play area's height. A question
  now appears in ONE always-the-same place instead of a centred sheet, which is
  what the operator's *"popout into its own popover modal on top of the game"*
  becomes once it has a fixed home.
- **The phase rail goes from 32px to 108px** — 8.4% of the width. At 32 it can
  only draw marks and the current step's name (`.live__step-name` is clipped for
  every other step, `live.css:684-692`). At 108 all thirteen names fit. Taken as
  deliberate: the phases are to be read, not decoded.
- **The controls shrink from 288×153 to 112×84** and sit directly under the
  rail. Five buttons — OK, Cancel, Leave, Full control, Concede — in a narrow
  stack. This is the same decision as deleting the prose, seen from the other
  side: what is left is small because only the controls are left.
- **The log is a 36×32 button** that opens to **the full height of the screen**
  (operator, 2026-09-27). Collapsed by default. Wave 25 §C is already moving the
  log behind a toggle; the height and the button size are this file's addition.

## Deleted

- **`.board__bar`, the turn bar.** Operator: *"i dont understand what 'turn bar'
  and 'seat 1 live' are relevant for so i think these should just be deleted."*
  Turn and phase are the rail's job, and the rail is now wide enough to say so.
- **`.live__status`, the `Seat 1, live.` line.** Same instruction. Note before
  removing it: **three playwright specs wait on that exact string** —
  `e2e/arrow.spec.ts:210`, `e2e/table-fit.spec.ts:512`, `e2e/play.spec.ts:752`
  and `:1345`. Each needs a different signal that the match is live, and picking
  it is part of the work, not a detail.
- `live-says`, already going in wave 25 §C.

## How cards sit in a zone

Operator, verbatim: *"regarding how cards fit in zones, i want a system that by
default snaps to the next available space, but also allows stacking cards with
slight off-set similar to how enchantments/equipped artifacts are already
represented."*

Two behaviours, one model:

1. **Auto-flow.** A card entering a zone takes the next free slot. The player
   never has to tidy, and nothing overlaps unless they ask for it.
2. **Deliberate stacking.** A card dropped onto another stacks with a slight
   offset, rendered the way an attachment already renders.

This SUPERSEDES wave 24 §A's free placement as the default — free placement put
a card wherever it was dropped, which is why a board needs tidying. It does not
remove the arrangement store; a stack is an arrangement, and so is a manual
move. Wave 25 §E gives the hand the same plumbing, so both zones inherit this.

## The tab system, finally identified

Asked in the artifact as a multiple choice; the operator picked **labelled
panels**: each zone renders as a bordered, filled box with a head, so the table
reads as a stack of form fields rather than a surface. `ZoneShell`
(`Board.tsx:828-869`) is what draws it.

The label question came back `on`, but that was the pre-checked default and not
necessarily a choice, so the reading recorded here is: **the panel chrome goes,
the zone stays identifiable.** Borders, fills and heads that make a zone look
like a form field are the complaint; knowing which zone is which is not. If that
reading is wrong the operator will say so, and this paragraph is where it gets
corrected.

## Ordering against wave 25

Wave 25 is running and its lanes C and E own every file this touches
(`Board.tsx`, `board.css`, `LiveBoard.tsx`, `live.css`). **It lands first; this
is the wave after.** Nothing in wave 25 is wasted by this file:

| wave 25 does | this file's relation |
| --- | --- |
| §C: phase rail anchors right | a step toward it; only the width and the labels change again |
| §C: the corner's prose goes, a payment becomes a question | unchanged — this only gives the question a fixed home |
| §C: the log moves behind a toggle | unchanged; this adds full height and the button's size |
| §E: graveyard below the portrait | exactly this file's left column |
| §E: the hand gets the arrangement plumbing | what the snap-and-stack model then runs on |

Superseded, and the lanes should not be re-briefed mid-flight for it: §C's rail
stays 32px wide this wave, and §C's question sheet stays centred this wave.
