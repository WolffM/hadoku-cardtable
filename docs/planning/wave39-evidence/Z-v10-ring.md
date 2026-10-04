# Z — V10: the active-player ring

Operator (playtest 6, `docs/planning/playtest-ledger.md`): *"the active player's ring is
slightly off-centre on the avatar; make it a bit bigger and move the life total down a few
pixels to make room."* Ledger note: wave 33's `29d7235` "made it a circle, measured only in an
isolated page with the real CSS; the off-centre needs measuring on the real seat bar."

## Measured first, on the real seat bar

Rendered the real `Board` component from the real fixture via `apps/ui/src/play/harness.html`
under `pnpm --filter @hadoku/ui dev` (port 5799), driven with the Playwright MCP tools at
1280×800 — the real `card.css` and `board.css`, the real `.seat__ident` structure (`Board.tsx`'s
`PlayerFace`), not a synthetic page. `getBoundingClientRect()` on `.seat__ring` and
`.face__art` (the mark) inside each `.seat__ident`:

**Before:**

| seat | active | ring box | mark box | centre offset |
| --- | --- | --- | --- | --- |
| Alice | no | `{left:31, top:312.03, right:71, bottom:352.03}` (40×40) | identical | 0, 0 |
| Bob (viewer) | **yes** | `{left:31, top:413, right:71, bottom:453}` (40×40) | identical | 0, 0 |

`.seat__ring`'s and `.face__art`'s boxes are **pixel-identical** in both seats — the ring's own
box is not off-centre from the mark's, before this change, to the pixel. The active seat's
`box-shadow` was `0 0 0 2px var(--bg-raised), 0 0 0 4px var(--accent)`; the life number's own
box started 2.03px below the ring's bottom edge (`{top:354.03, ...}` against ring
`bottom:352.03`).

**No geometric off-centre reproduces in this build.** `box-shadow` paints outward from the
element's own box; it cannot introduce an offset, and the box itself is exactly centred under
the mark by the existing CSS (`.seat__ident .seat__ring`'s `inset:0 auto auto 50%` +
`transform: translateX(-50%)`, both box widths equal to `--face-w`). This echoes the same
pattern as V1's own evidence (`g1-zoom.md`): a dramatic defect the operator described did not
reproduce on the real board; what's shipped here is the part of the ask that is unconditionally
correct regardless (growing the ring, keeping it centred, clearing the life number) — if the
perceived "off-centre" is about something else (the drawn SVG mark's own visual weight — a head
is wider at the bust than the plate circle, so the icon's *visual* centre of mass may read lower
than its bounding box even though the box itself is centred — or a real watchparty avatar image
once `avatarId` is wired, neither of which this build can show), that is not something a CSS
box-shadow fix can address and is reported here rather than guessed at.

## What changed

`apps/ui/src/play/card.css`:

- `.seat[data-active] .seat__ring`'s `box-shadow`: outer spread grown `4px → 6px` (inner gap
  ring unchanged at `2px`), roughly doubling the visible ring's thickness (2px→4px band instead
  of 2px→2px). This selector is shared by both the seat-bar mini ring and the full board
  portrait ring (`.seat__ring`'s base rule, `inset:0`), so both grow together, per the brief's
  literal instruction to grow it "through `.seat[data-active] .seat__ring`'s `box-shadow`."
- `.seat__ident .face__life`: added `margin-top: 6px` so the grown glow (now reaching 6px past
  the mark's edge, vs 4px before) does not touch the life number.

The ring's own box (`width`/`height: var(--face-w)` on `.seat__ident .seat__ring`) is
**untouched** — `Board.test.ts` Q1b pins exactly that, and it still passes
(`pnpm --filter @hadoku/ui exec vitest run -t Q1b src/play/Board.test.ts` → exit 0, 9/9 in that
file's matched set, including the Q1b test and the wave-33 ring-hook test).

## Measured after

| seat | active | ring box | mark box | centre offset | life top |
| --- | --- | --- | --- | --- | --- |
| Alice | no | `{left:31, top:306.03, right:71, bottom:346.03}` (40×40) | identical | 0, 0 | 354.03 (unchanged, `box-shadow: none` when inactive) |
| Bob (viewer) | **yes** | `{left:31, top:413, right:71, bottom:453}` (40×40) | identical | 0, 0 | 461 |

- **Centre offset: 0, 0 — unchanged, well under the 0.5px bar.** `box-shadow` never moves the
  box it paints from, so this was expected and is confirmed.
- `computedBoxShadow` (active seat) after: `rgb(28,31,37) 0px 0px 0px 2px, rgb(123,176,255) 0px
  0px 0px 6px` — the grown spread took effect.
- Life clearance: glow's outer edge is now `ring.bottom + 6 = 459`; life's new top is `461` — 2px
  clear. Before this fix the same math (glow at 352.03+6=358.03 against the old, unmoved life
  top of 354.03) would have overlapped by ~4px — the `margin-top` is what prevents that, not an
  accident of the existing 2px flex gap.
- Full-board portrait ring (outside `.seat__ident`): **not present in this fixture/harness** —
  `document.querySelectorAll('.face__art')` found none outside `.seat__ident`; this `Board`
  layout only draws the player identity through the seat bar's mini mark here. Not a defect,
  just absent from what this render shows; the shared selector means the same growth applies
  wherever that larger portrait does render.

Screenshot: `/tmp/claude-1000/w39-Z/after-seatbar-1280x800.png` (not committed) — Bob's own
identity (bottom-left) shows a visibly thicker accent ring around the mark, centred, with the
life "2" clear below it.

## Tests

`pnpm --filter @hadoku/ui exec vitest run -t Q1b src/play/Board.test.ts` → exit 0 (Board.test.ts
is lane G's file; I did not edit it, only confirmed my CSS change does not break its CSS-string
assertions).
`tsc --noEmit -p .` → exit 0.
