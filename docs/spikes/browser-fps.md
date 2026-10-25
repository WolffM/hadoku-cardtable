# Browser frame rate and input on the board (lane fps, 2026-10-25)

Client side only. Server-side lag is `lane-stress` (`docs/spikes/forge-scale*`).
Every number below is in a TSV under `docs/spikes/browser-fps/`; each claim is
marked **VERIFIED** (with the TSV or command) or **ASSUMED**.

## The answer

- **A strong laptop (Chromium 1×) and Firefox unthrottled stay smooth at every
  board size we built**, up to 51 + 54 permanents and a 10-card hand: frame p95
  16.8 ms everywhere, input → paint p95 at most 41 ms (Chromium) / 43 ms
  (Firefox). Nothing trips the jank line. VERIFIED: `frames-chromium-desktop.tsv`
  (1x rows), `frames-firefox-desktop.tsv`.
- **Jank starts on a weak laptop (4×) at the crowded board (~28 + 31
  permanents), and it is input first**: clicking a card is p95 145–339 ms to the
  next paint, the stack loop's worst frames are 166–550 ms, and frame p95 goes
  over 33 ms in some runs. Early and mid boards (≤ 8 a side) stay clean at 4×.
  VERIFIED: `frames-chromium-desktop.tsv` + `frames-chromium-desktop-rerun.tsv`
  (4x crowded/huge, two re-runs because the first pass ran at load 20–43).
- **A low-end phone (6×, 390×844 touch) trips at the crowded board too**
  (click p95 219 ms, frame p95 83 ms) and holds on the mid board (click p95
  64 ms). At 6× on a laptop-sized window even the mid board's click trips
  (p95 199 ms). VERIFIED: `frames-chromium-phone.tsv`, `frames-chromium-desktop.tsv` (6x).
- **No leak**: ten minutes of state updates (1,500 packets: taps, combats,
  casts, life changes) keep the DOM at 3.2–3.4 k nodes, listeners cycling
  446↔591 with the loop, one document, and frames at 60 fps. The heap after a
  forced GC grows 17.0 → 18.0 MB over minutes 1–10 (~0.1 MB/min). VERIFIED:
  `leak-chromium-crowded.tsv`. That creep is most likely the folded state
  keeping every stack item the loop minted (a new id per cast, as Forge does);
  not traced to an object. ASSUMED.

| condition | early (3+3) | mid (5+8) | crowded (28+31) | huge (51+54) |
| --- | --- | --- | --- | --- |
| Chromium 1×, 1920×1080 | smooth | smooth | smooth | smooth |
| Firefox, 1920×1080 | smooth | smooth | smooth | smooth (worst frame 51 ms) |
| Chromium 4×, 1920×1080 | smooth | smooth (click p95 73) | **input janky** (click p95 145–339, hover 93–143) | **janky** (click 228–414, stack frame p95 up to 383) |
| Chromium 6×, 1920×1080 | hover p95 102 (borderline) | **click p95 199** | **janky** | **janky** |
| Chromium 1×, phone | smooth | smooth | smooth | smooth (click p95 95) |
| Chromium 4×, phone | smooth | smooth | smooth (click p95 87) | **click p95 148** |
| Chromium 6×, phone | smooth | smooth (click 64) | **click p95 219, frame p95 83** | **janky (idle p95 50)** |

"Janky" is the brief's line: frame p95 > 33 ms, or input → paint p95 > 100 ms.

## The top three costs

### 1. `board.css:906-916` — a `:has(> li:nth-child(3))` that restyles the whole board on every DOM change

```css
.board .seat .zone--command .zone__cards:has(> li:nth-child(3)) { … }               /* :906 */
.board .seat .zone--command .zone__cards:has(> li:nth-child(3)) > li:not(:last-child) { … } /* :911 */
.board .seat .zone--command .zone__cards:has(> li:nth-child(3)) > li > * { … }      /* :916 */
```

Landed in f2c0074e (2026-10-22, the command zone's overlap). Chromium cannot
scope the invalidation of a `:has()` whose argument holds a structural
pseudo-class, so any node inserted or removed anywhere under `.board` — the
inspector opening, a menu, a mana symbol, a card moving to the stack —
invalidates the whole board's style (`StyleInvalidatorInvalidationTracking:
"Invalidation set invalidates subtree"`, `allDescendantsMightBeInvalid`, on
`SECTION.board`, reason `has`). Each of those is a restyle of every element on
the board: 2,300 on the crowded board, 3,700 on the huge one.

- Cost per restyle: 5.0 ms (crowded) / 7.6 ms (huge) at 1×, 34–46 ms at 4×;
  20–25 of them per 6 s of clicking, 18–19 per 6 s of the stack loop, 8–10 per
  6 s of hovering. VERIFIED: `trace-chromium-desktop.tsv` (`full_restyles`,
  `full_restyle_ms`).
- With those three rules deleted in the page (nothing else changed): 4× crowded
  click p95 145–168 → 52–55 ms, 4× huge click p95 228–291 → 92–122 ms, long
  tasks 8–13 → 0–2 per run, full-board restyles → 0. VERIFIED:
  `ab-frames-baseline.tsv` vs `ab-frames-nth-child-dropped.tsv` (load 5–12 for
  both), `ab-trace-nth-child-dropped.tsv` (`dropped_rules` column). Deleting the
  neighbouring `.zone--command:has(.zone__cards > li)` (`:921`) alone changes
  nothing; deleting the three `nth-child` rules alone removes every full restyle
  (diagnostic runs, not kept as TSV).
- It is also the multiplier under cost 2: the forced reads below are expensive
  largely because each one pays for this restyle. With the rules gone, the stack
  loop's forced-layout time at 4× falls 643 → 124 ms per 6 s and
  `drawnWidth`'s self time 267 → 31 ms. VERIFIED (same two trace files; the
  baseline ran at load 33, the A/B at 13, so read the size, not the decimals).
- Why the "mechanism" sentence holds: ASSUMED from Chromium's documented `:has`
  invalidation limits; the effect is VERIFIED.

### 2. Forced style/layout reads on the stack's resolve path (`card-size.ts:31`, `placed.ts:907`, `departures.ts:361`, `departures.ts:516`, `placed.ts:1068`, `motion.ts:257`)

A spell going hand → stack → battlefield → hand runs 34–35 forced layouts per
six seconds on the crowded and huge boards (18 on mid). By self time at 4×, crowded board
(`trace-chromium-desktop.tsv`, `top_forced_from` / `top_script_fns`):

| where | what it reads | forced ms / 6 s |
| --- | --- | --- |
| `card-size.ts:29-31` `drawnWidth` | `getComputedStyle(card).width`, from `remeasureCardWidths` (a `ResizeObserver` callback) re-reading every kept row | 168 forced, 267 self |
| `live/placed.ts:1068` `measure` | `root.getBoundingClientRect()` once per paint with a stack | 204 |
| `live/departures.ts:516` `leave` | `root.getBoundingClientRect()` | 164 |
| `live/placed.ts:902-907` `settle` | `void el.offsetWidth` to restart the settle animation | 122 self |
| `live/departures.ts:361` `turnedStep` | `getComputedStyle(copy).marginTop` | 112 self |
| `motion.ts:257` `animationsSettled` | `root.getAnimations({ subtree: true })` over the whole board | 20–46 |

Each read is individually batched as its comment says ("every box first, then
every write"), but they run in different modules on the same commit, so the
board is laid out several times per move. On the 4× crowded board the stack
loop's worst frames are 166–550 ms; on huge, 300–1,233 ms. VERIFIED:
`frames-chromium-desktop-rerun.tsv` (stack rows). Mid board, same loop: 75 ms
forced per 6 s and no frame over 33 ms at 4× (VERIFIED, same files), so the
cost scales with board size — which is what cost 1 does to each read.

### 3. `flight.ts:22` `pin` — `getAnimations({ subtree: true })` on every flyer, on every DOM mutation under it

`pinFlight`'s `MutationObserver` (`flight.ts:28-45`) re-pins every flyer whose
subtree changed, and `pin` asks each for its animations, which forces a style
update. In the attack loop (attackers move, gain arrows and damage) it is the
largest forced read: 91 ms per 6 s at 4× desktop, 131 ms at 6× phone, with
`lift.ts:151` `centreOf` (`getBoundingClientRect`) next at 23–26 ms. VERIFIED:
`trace-chromium-desktop.tsv`, `trace-chromium-phone-6x.tsv` (attack rows).
Attack frames at 4× crowded: worst 150–267 ms, p99 67–117 ms.

### Not in the top three, and why

- **Flyers at idle.** With four flyers on the crowded board, every frame
  restyles each flyer's `.card`, `.board-card__pt` and `::after` (style
  737 ms / 6 s at 1×, 2.3 s at 4×; the same board with no flyers: 0). At 6× the
  huge board idles at 30 fps. VERIFIED: `trace-chromium-desktop.tsv` (idle rows),
  `frames-chromium-*.tsv` (huge/idle at 6x). **But** a plain
  `transform: translateX` control animation injected beside them restyles every
  frame here too, with or without SwiftShader GPU flags, so this headless
  software-rendered Chromium does not composite *any* CSS animation. On a GPU
  Chrome the `fly-*` keyframes (`card.css:703-795`: `translate`, `rotate`,
  `scale`, `opacity`) are compositor-eligible, and Firefox (also software here)
  shows no idle cost. ASSUMED: it is an artefact of this environment, not a
  product cost. A real-device profile would settle it.
- **React work per state packet** is modest: the crowded tap loop (five
  packets each tapping or untapping 25 lands) is 252 ms of script per 6 s at 1×,
  no tap frame went over 33 ms at 1×, and frame p95 stayed 16.8 ms at 4× in both
  low-load re-runs. VERIFIED: tap rows of `trace-chromium-desktop.tsv` and
  `frames-chromium-desktop-rerun.tsv`.
- **`frame-watch.ts`** (the in-product frame-rate telemetry) shows up at idle
  at ≤ 7 ms per 6 s (`animationTop`, `pageFacts` on a stretch). VERIFIED: idle rows.
- **Hover** costs mostly the cost-1 restyles (8–10 per 6 s from the inspector's
  insertions) plus `presence.ts:252` `anchorOf` (10 ms / 6 s at 4×). With cost 1
  removed hover's style time falls 2,448 → 801 ms / 6 s. VERIFIED: trace vs
  ab-trace hover rows (different load, see above).

## How it was measured

**Harness** (`scripts/fps/`, committed separately): the REAL `LiveBoard` inside
`MatchScreen`'s shell (`harness.tsx`), fed by an in-page `MatchTransport` that
answers the join with a snapshot and then streams `applyDelta` envelopes on a
timer — the client's own parse, fold, pacing and animation code runs unchanged.
Built by `build.mjs` with `apps/ui/vite.config.ts`'s plugins and defines, React
in production mode, unminified and source-mapped so profiles map back to
`file:line`. Why this path and not a live match: it is the cheapest faithful
one (no Forge, no server, no jar on hokon), every board state is repeatable,
and a loop can run for ten minutes. The live stack was not needed.

**Boards** (`scenarios.ts`): the committed real capture
(`apps/ui/src/play/fixtures/tierc-game1-seq1-27.json`) is the base. *early* is
its packet 6 (turn 5, 3 + 3 permanents, 6 cards in hand); *mid* is packet 27
(turn 14, 5 + 8, hand filled to 10). *crowded* and *huge* add clones of the
capture's own card and card-state objects (same tags and properties, new ids):
lands, creatures with `+1/+1` counters, tokens, an artifact attached to a
creature, Flying creatures; creature clones are renamed to cards
`art-ids.json` knows so they draw with CDN art, as cube cards do (the capture's
own precon creatures have no art row and draw as text). Loops: **tap** (every
land, both sides, every 1.2 s), **attack** (declare 6 attackers, 4 blockers,
damage, end, one step a second), **stack** (a hand card cast, resolved, bounced,
one step a second), **hover** (pointer to a card every 300 ms), **click**
(click or tap a card, Escape, every 500 ms), **mix** (all of them plus life
changes, every 400 ms; the leak loop).

**Metrics** (`measure.mjs`): rAF intervals (fps p50, p95, p99, worst; the
"over 16.7" column counts intervals over 20.9 ms — one missed vsync, tolerant
of timer jitter — and "over 33" over 33.4 ms); `longtask` and
`long-animation-frame` observers (Chromium); input → paint as the event's
timestamp to the second rAF after it (a floor of 1–2 frames), and Event Timing
`duration` p95 (`evt_p95_ms`) where the browser reports it. Traces: the
renderer main thread's self time by script / style / layout, paint and
composite (including raster and compositor threads), forced layouts (a
`Layout` inside script) with the JS frame that forced them, restyles over 1,000
elements, and the CPU profile's top functions. `--drop-rules <regex>` deletes
CSS rules in the page before recording, for an A/B that edits nothing in the
app. The host's 1-minute load average sits beside every row.

**Conditions**: Chromium (Playwright 1.62.1's, new headless) with CDP
`Emulation.setCPUThrottlingRate` 1×, 4×, 6×; 1920×1080 and 390×844 with touch
and DPR 3; Firefox (Playwright's) unthrottled at 1920×1080. 8 s recordings
after a 1.5 s warm-up of the loop; traces 6 s.

```sh
export PATH="$HOME/.local/share/fnm/node-versions/v24.18.0/installation/bin:$PATH"
node scripts/fps/build.mjs                       # → ~/.cache/cardtable-fps/dist
node scripts/fps/measure.mjs frames --browser chromium --viewport desktop --throttle 1,4,6 --out frames.tsv
node scripts/fps/measure.mjs frames --browser firefox --out frames-ff.tsv
node scripts/fps/measure.mjs trace --throttle 4 --cases crowded/click,crowded/stack --out trace.tsv
node scripts/fps/measure.mjs frames --throttle 4 --cases crowded/click --drop-rules 'nth-child\(3\)' --out ab.tsv
node scripts/fps/measure.mjs leak --minutes 10 --board crowded --out leak.tsv
```

## Files

| file | what |
| --- | --- |
| `frames-chromium-desktop.tsv` | 22 cases × 1×/4×/6×, 1920×1080 |
| `frames-chromium-desktop-rerun.tsv` | 4× crowded/huge again, ×2, at lower load |
| `frames-chromium-phone.tsv` | 17 cases × 1×/4×/6×, 390×844 touch |
| `frames-firefox-desktop.tsv` | 22 cases, unthrottled |
| `trace-chromium-desktop.tsv` | 11 cases × 1×/4×: time by kind, forced layouts, full restyles, top functions |
| `trace-chromium-phone-6x.tsv` | 4 cases at 6×, phone |
| `ab-frames-baseline.tsv`, `ab-frames-nth-child-dropped.tsv` | cost 1's A/B, frames |
| `ab-trace-nth-child-dropped.tsv` | cost 1's A/B, trace |
| `leak-chromium-crowded.tsv` | heap / DOM / listeners each minute over 10 min of `mix` |

## What this could not measure

- **A GPU.** Both browsers render in software here; CPU throttling slows the
  renderer's main thread, not raster or the GPU process. Paint and composite
  numbers are a software rasteriser's, and the idle-flyer result above is very
  likely this environment's (ASSUMED). A real-device profile (Chrome DevTools
  on the operator's machine, or a phone over remote debugging) is the check.
- **A real phone.** "Phone" is a viewport, touch and DPR 3 on this CPU,
  throttled. No Safari / iOS at all.
- **Firefox under throttle, and Firefox long tasks.** Firefox has no CPU
  throttling over Playwright and no `longtask` / `long-animation-frame`
  entries; its rows are frame and input timing only.
- **Host noise.** The box runs CI and production. The first 4× desktop pass of
  the crowded/huge rows ran at load 20–43 and was re-run at 9–18
  (`frames-chromium-desktop-rerun.tsv`); run-to-run spread on those rows is
  still up to 2× in worst-frame terms. Counts (restyles, forced layouts) are
  stable across runs; milliseconds are not.
- **The live path's extras**: a real socket, the pacer holding opponent frames
  against a live Forge, sounds (the harness has no `/api/sounds`), avatars, and
  art for every card (the capture's own creatures draw as text).
