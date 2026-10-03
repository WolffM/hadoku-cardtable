# T8 — the stack, depicted: screenshots and measurements

Operator (third ask, settled): *"the stack shows what is happening, not all the text"* — each
item is the card's art plus ONE line ("Alice · Lightning Bolt → Bob"), the full rules text only
in the inspector on hover, no scrolling text. The canvas stays static: the band's size does not
move with the item count.

## How these were taken

`apps/ui/src/play/harness.tsx` (read-only to this lane) renders `<Board view={boardFromFixture(...)} />`
with no interaction — the committed fixture, which carries 2 real stack items. To get exactly 1, 3
and 6 items on screen without touching Forge or React state, a DOM-only probe was used in the
harness page via Playwright, the same technique `e2e/table-fit.spec.ts`'s own `fillStack` uses (it
clones a real `CardTile` out of the dealt hand for art and builds `<li class="stack__item">` nodes
by hand): the 2 real items are hidden (`display: none`, never removed — the list is React-managed),
then N probe items are appended, built from the markup `StackItem` renders since this wave
(`.stack__controller` · `.stack__sep` · `.stack__source` · `.stack__target`, no `.stack__text`).

Served via `pnpm --filter @hadoku/ui exec vite` (lane G's already-running dev server, port 5174,
base `/cardtable/`) at `http://localhost:5174/cardtable/src/play/harness.html`, driven with the
Playwright MCP browser. Screenshots and the raw measurement log are in this lane's scratch
directory (`.gitignore` refuses `*.png`, so they are not committed):

```
/tmp/claude-1000/w36-B/evidence/b-t8-1280x800-n1.png
/tmp/claude-1000/w36-B/evidence/b-t8-1280x800-n3.png
/tmp/claude-1000/w36-B/evidence/b-t8-1280x800-n6.png
/tmp/claude-1000/w36-B/evidence/b-t8-1366x768-n1.png
/tmp/claude-1000/w36-B/evidence/b-t8-1366x768-n3.png
/tmp/claude-1000/w36-B/evidence/b-t8-1366x768-n6.png
/tmp/claude-1000/w36-B/evidence/b-t8-1366x768-n6-zoom.png       (cropped to `.stack`, legible)
/tmp/claude-1000/w36-B/evidence/b-t8-1366x768-n6-scrolled.png  (the band scrolled sideways to a later item)
```

## Band height/width/position: constant across 1, 3 and 6 items

`.board__mid.getBoundingClientRect()`, read in the page after each `fillStackExact(n)` call:

| viewport | n | left | top | width | height |
| --- | --- | --- | --- | --- | --- |
| 1280×800 | 1 | 760.31 | 92.00 | 308.47 | **192** |
| 1280×800 | 3 | 760.31 | 92.00 | 308.47 | **192** |
| 1280×800 | 6 | 760.31 | 92.00 | 308.47 | **192** |
| 1366×768 | 1 | 811.39 | 88.31 | 329.20 | **192** |
| 1366×768 | 3 | 811.39 | 88.31 | 329.20 | **192** |
| 1366×768 | 6 | 811.39 | 88.31 | 329.20 | **192** |

Identical box at every count, at both sizes — 192px is `--mid-h: 12rem` (the roomy default; no
question is open in this harness). This is the DOM/CSS half of "the canvas stays static"; the
no-`:has()`/no-sibling-count-selector half is pinned in `Board.test.ts` ("stack: T8 left no
question-specific stack rule behind", "is roomy by default and compact while a question is open").

At 6 items the LIST itself (`.stack__items`, inside the unchanging band) does grow past its own
box — `scrollWidth` 1454–1579px against a `clientWidth` of 237–258px — and scrolls **sideways**,
one item at a time (`.stack__item { flex: 0 0 100% }`, unchanged this wave). That is the band
holding more than it can show at once, not an item's own text scrolling; `b-t8-*-n6-scrolled.png`
shows the band scrolled to a later item, reading cleanly.

## What each screenshot shows

- **n1, n3, n6 at both sizes look identical** in a static screenshot, and that is expected, not a
  bug: every item is the band's FULL width (`flex: 0 0 100%`, same rule the P9 fix gave it in wave
  31 — one item at a time, the rest a sideways scroll away), so a screenshot of ONE moment in time
  always shows exactly one item regardless of how many are on the stack. The band's own box not
  moving (measured above, identical across n) is the proof item count asked for; the scrolled
  screenshot proves the OTHER items are there and render the same way.
- **`b-t8-1280x800-n1.png`** (full board): the item reads *"Alice · Lightning Bolt → ..."* — the
  band is narrower at 1280 (308px) and the line clips with an ellipsis before reaching the target
  name. This is "no scrolling text" doing its job: a sentence too long for the box clips as a unit
  instead of wrapping, scrolling, or growing the item.
- **`b-t8-1366x768-n6-zoom.png`** and **`-scrolled.png`** (cropped to `.stack`, legible): the wider
  329px band fits the whole line, *"Alice · Lightning Bolt → Bob"* — the operator's own example,
  verbatim, with the card's art beside it and nothing else. `STACK 2` still reads the real
  `view.stack.length` (2): the probe is DOM-only, exactly as `e2e/table-fit.spec.ts`'s own probe is,
  and does not touch React state.

## A finding for lane E / the tracker: `e2e/table-fit.spec.ts`'s own `fillStack` probe is now stale

Read (not edited — `e2e/**` is lane E's), at `table-fit.spec.ts`'s `fillStack`: it hand-builds a
probe item's markup, and that markup is the PRE-T8 shape —

```html
<span class="stack__source">Probe<span class="stack__kind"> · ability</span></span>
<span class="stack__controller">someone</span>
<span class="stack__text">deals 2 damage to any target, and a second line of text …</span>
```

`.stack__text` no longer exists (`Board.tsx` draws no full-description line any more), and the
real order is now controller → source → target, not source → controller. The probe will still
APPEND into `ol.stack__items` and the band-height claims it drives (`e2e/table-fit.spec.ts`'s
"the canvas is static" phase) should still hold, since those read `.board__mid` / `.stack`
geometry, not `.stack__text` — but the probe's own markup is not what a real stack item looks like
after this wave, and nothing in it exercises T8's one-line format or `targetLabel`. Blast radius
table named this exact reader; flagging it for lane E / the manager to re-aim rather than touching
`e2e/**` myself.
