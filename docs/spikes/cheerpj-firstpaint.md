# Click-to-pixel under CheerpJ, and what it is a number OF

**Status: PHASE 2 — the premise is proved, the number is not taken.**

The rig works, is demonstrated to be able to FAIL, and has produced numbers for
a bare Swing component under CheerpJ, for streamed Forge in a browser, and for
the cost of a CheerpJ tab. Phase 2 then pointed it at Forge itself, and
**Forge's real match UI paints in a browser** — two battlefields, life totals,
the stack, a seven-card hand drawn with full card art, live Keep/Mulligan
buttons, reached by clicking Forge's own home screen. That is further than this
project has ever been, and it is shown, not asserted.

**The wave's gate — a click-to-pixel figure from that match UI — is NOT in this
document.** Every attempt was refused by the rig's own gates, correctly, and a
boot-reliability bug then stopped the run that would have settled it. See
"THE NUMBER WAS NOT TAKEN" below for what each refusal established and for the
exact command. Nothing here should be read as that figure.

Headline, and it is not what this lane expected to find:

> **At the boundary that actually matters — pixels in the player's browser —
> CheerpJ's floor and streamed Forge's real UI are the same speed today:
> 49.5 ms vs 49.7 ms median, measured by one instrument on one host on one day.**
> Latency is therefore not what decides this wave. The cold cost, the server
> budget and the network RTT are.

And a correction to the number this comparison was supposed to be against:
**streaming.md's 65 ms is not what a player in a browser experiences**, in either
direction. See "The 65 ms needs a footnote".

Phase 2 then added three findings that outlive any of the timings:

> **Forge's real desktop UI runs in a browser** — home screen, 505 decks,
> 33,785 cards, skinned and with player avatars and sleeves drawn, and a Start
> button that works. Three small patches.
>
> **A Forge tab costs 1.43 GiB**, against streaming's measured 1.26 GiB per
> container. Same cost, different machine — which is the entire CheerpJ
> argument, now measured on both sides.
>
> **Starting a purely local game builds a Netty server**, and epoll is not there.
> One more patch; the blocker was not previously known to be on that path.

Everything below came from a command that ran on hokon on 2026-09-20. Nothing is
estimated unless it says ESTIMATED. Host load is quoted where it matters: it
ranged from 2.7 (Phase 1) to 41.4 (late Phase 2), and Phase 2's durations are
badly distorted by it — see the note in that section.

---

## What the number is a number OF

Read this before quoting anything below.

| figure | what it measures | how far from Forge's match UI |
| --- | --- | --- |
| **34.7 ms** CheerpJ | one `JComponent`, 800×600, repainting on a click, under CheerpJ | **very far.** No Forge class is involved. Same shape of thing Wave 14 lane B measured and called *"an upper bound on Forge, never a prediction of it"* |
| **46.9 ms** streamed Forge | Forge's **real** home screen in a container, clicked and read **in a browser** | the real UI, the real VNC path, the real browser — but the home screen, not a match |

The CheerpJ figure is a **floor**: what CheerpJ costs to get a press into Java,
repaint one component, and put the result on the canvas, with no Forge in
between. Forge's match UI is dozens of components, a skin, a layout manager and
card art, and every one of those adds. **Treat 34.7 ms as "CheerpJ's Swing cannot
do better than this", never as a prediction.**

---

## Reproducing every number

From the repo root. `SPIKE_CACHE` and `PORT` are this lane's own, because three
lanes drive the shared CheerpJ harness at once:

```sh
export SPIKE_CACHE=$HOME/.cache/w15d-firstpaint
export PORT=8743
scripts/spike/cheerpj/firstpaint/run.sh build                          # exit 0

FP_MODE=release scripts/spike/cheerpj/firstpaint/run.sh measure --reps 40 --jitter 25            # exit 0
for H in 0 20 50 100; do
  FP_MODE=release scripts/spike/cheerpj/firstpaint/run.sh measure --reps 40 --jitter 25 --hold $H
done                                                                    # exit 0 each
scripts/spike/cheerpj/firstpaint/run.sh measure --reps 40 --jitter 25   # press-acting cross-check, exit 0
scripts/spike/cheerpj/firstpaint/run.sh coldload --runs 3               # exit 0

# THE NEGATIVE CONTROLS -- each must exit 1 and print no latency
scripts/spike/cheerpj/firstpaint/run.sh control-noclick                 # exit 1
scripts/spike/cheerpj/firstpaint/run.sh control-nolistener              # exit 1
scripts/spike/cheerpj/firstpaint/run.sh control-noise                   # exit 1
```

The streamed-Forge half needs Wave 14's container. **This lane owns no file under
`scripts/spike/stream/`; it only runs it.**

```sh
export CARDTABLE_FORGE_JAR=$HOME/.local/share/cardtable/forge.jar
export CARDTABLE_FORGE_RES=/home/hadoku/repos/hadoku-cardtable/forge/forge-gui/res
scripts/spike/stream/run.sh up 1 && scripts/spike/stream/run.sh prep 1

export PW_CORE=$(ls -d $HOME/repos/hadoku-cardtable/node_modules/.pnpm/playwright-core@*/node_modules/playwright-core | tail -1)
node scripts/spike/cheerpj/firstpaint/clicktopixel.mjs \
  'http://127.0.0.1:6090/vnc.html?autoconnect=true&resize=off' \
  --inject scripts/spike/cheerpj/firstpaint/rig.js \
  --ready none --settle 8000 --reps 40 --hold 0 --jitter 25 --budget 5000 \
  --clicks 68,253 --clicks 71,285 --watch 420,50,520,30                 # exit 0

# the two runs that corrected streaming.md's protocol claim
scripts/spike/stream/run.sh latency-rfb 0 --reps 20 --hold 0.05         # median 63.6 ms
scripts/spike/stream/run.sh latency-rfb 0 --reps 20 --hold 0.3          # median 312.8 ms
scripts/spike/stream/run.sh host-forge && scripts/spike/stream/run.sh host-prep
scripts/spike/stream/run.sh latency-xvfb --reps 20 --hold 0.3           # median 300.4 ms
scripts/spike/stream/run.sh down
```

`run.sh build` prints a **build id derived from a `sha1sum` of the sources**, and
every run carries it in the driver's URL and in the JVM's own `PAINT-READY` line.
That is what makes "prove the thing you changed was actually built" checkable
from the artifact rather than from memory — demonstrated below.

---

## The method, and why it is the same method

Wave 14 lane C's, verbatim from `docs/spikes/streaming.md`:

> `ffmpeg -f x11grab` captures a 520×30 strip of the X display as 8-bit grey raw
> frames at 200 fps straight into a pipe; the script timestamps each frame as it
> arrives and compares it to a pre-click baseline.

and

> every figure below uses a fixed 50 ms hold and starts the clock at the press

Term by term, into a browser:

| streaming.md | here |
| --- | --- |
| 520×30 strip of the X display | a 520×30 strip of the canvas (`--watch`, or auto-located from what a click actually changes) |
| ffmpeg at 200 fps → 5 ms quantum | a `setTimeout(…, 0)` sampler; **measured quantum 4.1–4.2 ms**, reported every run exactly as streaming reported its capture interval |
| compare to a pre-click baseline | same, on RGBA bytes: a pixel changed if any channel moves >12; a frame changed if ≥24 pixels did (`--min-pixels-pct` expresses `rfb-latency.py`'s `--threshold` instead) |
| fixed hold, clock at the press | same. The press timestamp is the browser's own trusted `PointerEvent.timeStamp`, read **in the page**, so press and pixel share one clock |
| n≈40, min / median / p95 / max | same |
| dropped clicks counted, not averaged | same, and split by cause |
| alternate two click targets | same, and for streamed Forge literally the same two: `--clicks 68,253 --clicks 71,285 --watch 420,50,520,30` — `rfb-latency.py`'s own `CLICK_A` / `CLICK_B` / `WATCH` |

Two detectors run off the **same** click, because streaming.md keeps two things
separate and only measured one:

- **poll** — the first sample in which the canvas **backing store** differs: the
  app has rasterised. The analogue of `x11grab` reading the X framebuffer.
- **raf** — the first `requestAnimationFrame` at which that difference is
  present: the change has survived to a compositing frame boundary.

The second exists because of this, from streaming.md's "What these numbers do
NOT include":

> **The browser's noVNC decode and canvas paint.** ESTIMATED at roughly one
> frame, 8–16 ms. Not measured — our harness is a Python RFB client, not a
> browser. To settle it, drive the click from inside the page and time it
> against a `requestAnimationFrame` after the canvas changes; nothing in this
> lane does that yet.

This lane does exactly that, and injects the **same instrument** (`rig.js`, via
`page.addInitScript`) into both CheerpJ's page and noVNC's — so the two sides are
not two instruments that agree only in prose.

### The one deliberate departure: jitter

The driver presses at a deterministic point after the baseline is taken, which
pins the press to a fixed phase of the 16.7 ms compositor clock and makes the
composited-frame figure artificially tight. Measured: without jitter the rAF
figure was min 48.4 / max 49.9 over n=40 — a 1.5 ms spread. With `--jitter 25`
the same figure spread to min 36.6 / max 58.3 **while the backing-store figure
did not move at all** (median 35.5 → 35.3). That is the proof that the gap
between the two detectors is frame-boundary wait and not something CheerpJ does.
**Every headline figure uses jitter.**

---

## MEASURED: CheerpJ, one `JComponent`

`spike.PaintProbe`, 800×600, `--jitter 25`, strip 520×30, sampler quantum
4.1–4.2 ms, n=40 per run, **0 dropped clicks in every run**.

### Which mouse edge, and the hold sweep

streaming.md: *"Forge's Swing UI acts on the mouse **release**, so the button
hold time passes straight into the number."* A probe acting on the **press**
would produce a press→pixel number with no hold inside it — a different quantity
wearing the same name. So `PaintProbe` has both modes, and the hold was swept in
release mode:

| hold | press→pixel (canvas) median | press→pixel − hold | press→Java listener median |
| --- | --- | --- | --- |
| 0 ms | 35.4 | 35.4 | 18.2 |
| 20 ms | 52.6 | 32.6 | 34.6 |
| 50 ms | 84.7 | 34.7 | 67.7 |
| 100 ms | 135.0 | 35.0 | 117.8 |

Flat at **~35 ms of release→pixel**, with the hold passing straight through — the
protocol's defining property, reproduced rather than assumed. The press-acting
mode gives the same answer from the other side: median 35.3 ms press→pixel at
hold 50 (n=40, min 21.4, p95 51.0, max 58.5).

### The numbers

| detector | n | min | **median** | p95 | max |
| --- | --- | --- | --- | --- | --- |
| press→pixel, 50 ms hold, canvas buffer | 40 | 79.9 | **84.7** | 87.1 | 97.8 |
| press→pixel, 50 ms hold, composited frame | 40 | 95.4 | **99.5** | 99.7 | 103.9 |
| **event→pixel** (hold removed), canvas | 40 | — | **34.7** | — | — |
| **event→pixel** (hold removed), composited | 40 | — | **49.5** | — | — |

### Where those 35 ms go

Every timestamp is in the browser's clock: Java's `System.out` arrives as a
`console.log` and the harness stamps it with `performance.now()` before CheerpJ's
loader is fetched. No JVM↔JS correlation to get wrong.

| segment | median | from |
| --- | --- | --- |
| press → Java `mouseReleased` fires | 17.7 ms | `PAINT-CLICK` minus press |
| → `paintComponent` returns | +5.4 ms (73.1 total) | `PAINT-DONE` |
| → pixels readable in the canvas | +11.6 ms (84.7) | poll detector |
| → present on a composited frame | +14.8 ms (99.5) | rAF detector |

The 17.7 ms input-to-listener sits inside Wave 14's independently measured
9.4–32.0 ms (median 22.4) for the same step, on a different probe.

**Internal consistency, checked every rep: 40/40 had Java's own `PAINT-DONE` at
or before the pixel detection, in all six runs.** If the rig were timing pixels
this click's repaint did not produce, that ordering would break.

Cross-check against lane A's transport floor (~6 ms median for a Java-inside-
CheerpJ server round trip): nothing here is near it — and **none of these figures
involve a server at all.** In a real match, a click that needs the server adds
lane A's ~6 ms on top of the repaint.

---

## MEASURED: the same instrument, pointed at streamed Forge in a browser

Wave 14's `cardtable-stream-spike:w14` container, Forge's **real home screen**,
noVNC in headless Chromium, the same two click targets and the same watch strip
`rfb-latency.py` uses. `--jitter 25`.

| hold | load | n | min | **median (canvas)** | p95 | max | median (composited) | dropped |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 ms | 2.7–4.9 | 39 | 29.2 | **46.9** | 79.6 | 83.8 | **49.7** | 1 |
| 50 ms | 12.5 | 39 | 30.5 | 67.0 | 93.2 | 96.9 | 78.9 | 1 |
| 100 ms | 12.5 | 39 | 30.8 | 52.7 | 96.2 | 121.0 | 65.5 | 1 |
| 300 ms | 12.5 | 19 | 30.0 | 56.2 | 110.0 | 110.0 | 65.4 | 1 |
| 300 ms, 2% threshold | 12.5 | 19 | 29.3 | 50.5 | 97.7 | 97.7 | 49.7 | 1 |

Two things fall straight out of that table.

**The number does not depend on the hold at all.** 50, 100 and 300 ms holds give
the same median. That is not what streaming.md's protocol says should happen, and
chasing it produced the correction below.

**Host load moves it more than anything else does.** The same measurement at
load 2.7 and load 12.5 differs by 20 ms. The clean figure is the low-load one:
**46.9 ms to the canvas, 49.7 ms to a composited frame.**

---

## The 65 ms needs a footnote

This started as "why does my number ignore the hold?" and ended somewhere that
matters to the wave's decision. Four measurements, in order:

1. **`rfb-latency.py`, hold 50 ms** — median **63.6 ms** (n=19, 1 dropped, min
   58.7, p95 90.9, max 196.5). streaming.md's 63.7 ms reproduces exactly.
2. **`rfb-latency.py`, hold 300 ms** — median **312.8 ms** (n=19, 1 dropped, min
   310.3, p95 317.2, max 319.8). The hold is inside their number, as documented.
3. **`latency.py` on Xvfb with XTEST injection, hold 300 ms** — median **300.4 ms**
   (n=20, min 300.3, max 300.5, capture quantum 5.0 ms). So **Forge really does
   act on the release**, and release→pixel on the host is **0.4 ms**.
4. **A browser driving noVNC, hold 300 ms** — the heading is already repainted
   **120 ms after `mousedown`, with the button still held.** Not an inference: the
   watched strip was captured as a PNG at +120 ms and reads
   `Sanctioned Format: Booster Draft` where the pre-click baseline read
   `Sanctioned Format: Constructed`. A per-rep trace shows exactly one change, of
   727 pixels, 30–63 ms after the press, persisting thereafter.

Forge cannot act on the release for one client and on the press for another, so
the difference is in delivery: **the browser path does not preserve a held
button.** Forge sees a completed click at press time. (I did not read noVNC's
source to confirm the mechanism; the observation is what is measured.)

The consequence for this wave:

- **`rfb-latency.py`'s 63.7 ms is ~50 ms of deliberate button hold plus ~13.6 ms
  of real work.** As a *protocol* that is sound and streaming.md says so plainly.
  As a *headline* — "65 ms of click-to-pixel on this host" — it is 50 ms of
  harness on top of 14 ms of stack, and **a real player in a browser never pays
  that 50 ms**, because their click is acted on at press.
- So the right figure to compare against is **event→pixel**, and for a browser
  that is the number measured above: **46.9 ms**.

This is a correction to `docs/spikes/streaming.md`, which is not this lane's file
to edit. Flagged for the tracker.

### And the browser hop is 2–4× the estimate

streaming.md ESTIMATED the browser's decode and canvas paint at 8–16 ms and said
it was unmeasured. Measured here, event→pixel at each boundary:

| boundary | median |
| --- | --- |
| X framebuffer, XTEST injection (`latency.py`) | **0.4 ms** |
| a Python RFB client on loopback (`rfb-latency.py`, 63.6 − 50) | **13.6 ms** |
| **the browser's canvas buffer** (this rig) | **46.9 ms** |
| **a composited browser frame** (this rig) | **49.7 ms** |

**The browser hop costs ~33 ms** (46.9 − 13.6), not 8–16. The compositing step on
top of it is only 2.8 ms here — it is the WebSocket framing, noVNC's decode and
the canvas write that cost, not the frame boundary.

---

## MEASURED: cold load

Every run is a brand-new browser context, so these are cold-cache figures by
construction. Bytes come from CDP `request.sizes()`, not the Resource Timing API,
which reports `transferSize: 0` for `cjrtnc.leaningtech.com` (no
`Timing-Allow-Origin`) and would have read as zero cost.

| | 5 runs |
| --- | --- |
| **CheerpJ runtime from `cjrtnc.leaningtech.com`** | **19,191,566 – 19,191,971 B (19.19 MB)**, 117–118 requests |
| — largest single files | `4.3/17/lib/modules` 1,181,262 B; `4.3/cj3n17.wasm` 1,147,911 B |
| `loader.js` fetched and ready | 204 – 211 ms |
| `cheerpjInit()` | 985 – 1,153 ms |
| **first Swing pixels on screen** | **11,730 – 13,151 ms** |

That refines Wave 14's 12.1–21.2 MB to a repeatable **19.19 MB** (five runs agree
within 405 B). It is paid on every cold cache, from a third party, and the
Community Licence does not permit self-hosting it (`docs/spikes/cheerpj.md`,
step 1). Streaming pays none of it.

### Where the 12 seconds go

| mark | ms |
| --- | --- |
| page start | 7 |
| CheerpJ loader ready | 207 |
| `cheerpjInit()` returned | 1,228 |
| display created | 1,233 |
| **Java `main()` entered** | **6,161** |
| `JFrame.setVisible(true)` returned | 9,368 |
| first `paintImmediately` done (+ a deliberate 700 ms settle) | 12,542 |

~1.2 s of CheerpJ, then **~4.9 s before Java `main()` runs at all**, then **~3.2 s
to make an 800×600 undecorated `JFrame` visible**, then **~2.5 s to rasterise one
component for the first time**. Swing's first paint under CheerpJ is seconds, and
Forge's UI is very much larger than one component. Wave 14 saw Forge's own
`main()` at ~10.2 s and its splash attempt at ~15.2 s, consistent with this.

**`forge.jar` on the classpath costs ~1 s and 1.2–2.2 MB, not 39 MB:** with
`withforge=0` the same boot took 11,730 / 12,310 ms and pulled 21,741 B from the
local origin, against 12,361–13,151 ms and 1.18–2.23 MB with it. CheerpJ
`Range`-reads a jar's central directory rather than downloading it, which is why
`serve.mjs` must honour `Range`.

---

## The rig can fail — demonstrated, not asserted

> *"A measurement harness that can pass while measuring nothing is the worst
> defect available here. This project has hit that shape six times."*

Each control makes the measured thing not happen **in a different place**. Each
exits **1** and prints **no latency**.

| control | what is broken | result | exit |
| --- | --- | --- | --- |
| `control-noclick` | sampler armed, **no click delivered** | `NO-CHANGE-WITHOUT-CLICK`, `changedPixels: 0` | **1** |
| `control-nolistener` | clicks delivered and reaching Java; the probe installs **no `MouseListener`** | `NO-CHANGE-ON-WARMUP`, `changedPixels: 0` | **1** |
| `control-noise` | the canvas **repaints itself** every 30 ms, so a pre-click baseline is meaningless | 3/3 reps dropped `NOISY-BASELINE`, `n: 0` | **1** |

The third matters most and is not hypothetical: Wave 14's `spike.SwingProbe`
busy-paints for 5 s, and a pixel-diff rig aimed at it would have found "change"
microseconds after any press and reported a spectacular number that was entirely
an artefact. `PaintProbe` is quiet on purpose and the gate refuses the sample
when it is not.

Four further gates exist, and **three of them fired during this lane's own work**
— which is how they are known to work rather than merely to be written:

- **`CLICK-NOT-DELIVERED-TO-DOM`** — *fired, and caught a real defect.* The first
  version timestamped `mousedown`. Under CheerpJ 4.3 a click on the display
  dispatches `pointerdown` / `pointerup` / `click` and **no `mousedown` at all**:
  CheerpJ `preventDefault`s the pointer event, suppressing the compatibility
  mouse events. The rig reported 3/3 `CLICK-NOT-DELIVERED-TO-DOM` and **no
  number**, while Java's `MouseListener` was firing perfectly
  (`paintClickLines: 4`). Without that gate it would have reported anything.
- **`NO-PIXEL-CHANGE`** — *fired, and caught a real mistake.* A noVNC run was
  aimed at coordinates read off a screenshot taken at a different viewport size,
  so the click landed 60 px from the widget. 40/40 `NO-PIXEL-CHANGE`, exit 1,
  rather than timing whatever else moved. `--target-cx/--target-cy`
  (canvas-relative) now exist so the mistake is not available.
- **`NOISY-BASELINE` on a page we do not own** — before quoting any noVNC number,
  `--no-click` was run against that exact watch strip: `NO-CHANGE-WITHOUT-CLICK`,
  exit 1. That rules out a slow background animation, which would have produced
  precisely the hold-independent signature observed, for the wrong reason.
- **`BASELINE-BLANK`** — the strip reads back as one flat colour, which is what
  `drawImage` from a WebGL canvas without `preserveDrawingBuffer` returns. Not
  fired; CheerpJ's and noVNC's canvases both read directly as 2d.
- **Java-before-pixels ordering** — 40/40 in every CheerpJ run.

### A sampler bug the interval reporting caught

`startSampling` was originally guarded by a boolean. `stopSampling()` set it
false and the next `arm()` set it true again before the previous loop's pending
callback ran, so every rep added another pair of sampling loops: the rAF sample
count went 23, 44, 66, 88, 110 across five reps and the reported sampler interval
collapsed from a true 4.1 ms to a meaningless 0.1 ms. The interval **is** the
evidence that the sampler kept up, so corrupting it corrupts the proof. Fixed
with a generation counter; the reported quantum has been a stable 4.1–4.2 ms
(poll) and 16.7 ms (rAF) in every run since.

### Stale builds are detectable from the artifact

`PaintProbe.java` was edited and **not** rebuilt, then measured:

```
staged BUILDID before edit: 20260920T070203Z-d3823332be
source sha1 after edit would give: 5af88e09fa
URL the driver used:  ...?build=20260920T070203Z-d3823332be&target=paint&mode=normal
what the JVM reported: 11886ms PAINT-READY build=20260920T070203Z-d3823332be ...
```

After `run.sh build` the id became `20260920T070813Z-5af88e09fa`, and after the
edit was reverted it returned to `…-d3823332be` — which also proves the revert was
byte-exact.

**Scope of that check, so nobody over-trusts it:** the id hashes what gets
*staged* — `java/spike/*.java`, `index.html` and `rig.js`. `clicktopixel.mjs` and
`coldload.mjs` run from the repo working tree on every invocation and so cannot
go stale; they are deliberately outside the hash. A change to `run.sh` itself is
also outside it.

---

## The comparison, stated at the same boundary

**The two costs are not the same kind of cost, and the recommendation has to say
which budget binds.**

| | streaming | CheerpJ |
| --- | --- | --- |
| **what it costs** | **hokon's RAM and CPU** — 1.26 GiB and ~0.5 core per *player*, two players per match, plus the match JVM | **the player's browser** — one JVM's worth of interpretation per tab, plus 19.19 MB of cold download |
| ceiling | ~4 concurrent matches with half the box free; **uplink unmeasured and probably binding** | whatever the player's machine does; we never see it, and we never pay it |
| cold start | ~17.5 s per container, on our hardware | ~12 s to one component's first paint, on theirs; Forge's own UI unmeasured |
| per-cold-cache download | 0 | 19.19 MB from a third party we cannot self-host |
| **event→pixel, canvas** | **46.9 ms** (real Forge) | **34.7 ms** (one component — a floor) |
| **event→pixel, composited frame** | **49.7 ms** (real Forge) | **49.5 ms** (one component — a floor) |
| **plus the player's network** | **2 × RTT on every click**: up with the click, back with the pixels. streaming.md's honest internet figure is ~150–200 ms | **0** for anything the UI answers locally; **1 × RTT + ~6 ms** (lane A's transport floor) only for actions needing the server |

**On this host, today, at the player's screen, the two are the same speed**
(49.5 vs 49.7 ms). That is a floor against a real UI, so Forge under CheerpJ will
be slower than this — but the margin to find out is 0 ms, not the ~20 ms deficit
a naive comparison against the published 65 ms would have suggested.

**Over the internet the asymmetry is enormous and runs CheerpJ's way.** Streaming
pays the RTT on every single click; CheerpJ pays it only when game state moves.
For a friend on a 50 ms link, every streaming click is ~150 ms and every local
CheerpJ interaction stays ~50 ms.

---

## Recommendation after PHASE 1 (superseded in part — see Phase 2)

*This section was written when Forge's match UI had never rendered. Phase 2
changed that; read it together with "What Phase 2 adds to the recommendation".*

**Do not decide on this document.** The operator's gate is *"if the CheerpJ path
is more performant than the streamed path then we should go that route"*, and the
honest state is:

- **"Unusably slow" is ruled out at the floor.** That was a live possibility. A
  Swing component under CheerpJ answers a click in ~35 ms to the canvas and
  ~49 ms to the screen — a comfortable interaction budget for a card game.
  Magic is a screen that sits still.
- **Latency does not decide this.** At the player's screen the two are equal
  today, and the internet RTT term — the largest in the comparison — favours
  CheerpJ decisively.
- **What decides it is cost and risk, not milliseconds:** streaming costs 1.26 GiB
  and half a core per player on our host with an unmeasured uplink as its likely
  ceiling, and it gives up the room layer entirely (streaming.md, "What is
  lost"). CheerpJ costs the player a 19.19 MB third-party download per cold cache
  and ~12 s of boot before one component paints, with no fallback if
  `cjrtnc.leaningtech.com` goes away.
- **The remaining technical risk is not performance, it is whether Forge's match
  UI paints under CheerpJ at all** — lane A reports `FThreads.invokeInEdtNowOrLater`
  untested, `java.lang.reflect.Proxy` broken, and `applyDelta` unimplemented.

**What would settle it: the same rig, same protocol, pointed at Forge's real
match UI once lanes A and B land.** Given the floor is level with streaming and
the RTT term favours CheerpJ, Forge's UI could cost **2–3× the floor** and CheerpJ
would still win the operator's gate. If it costs more than that, or if it does
not paint at all, streaming is costed and waiting.

---

## What was NOT verified

*(This list is Phase 1's. Where Phase 2 later settled an item, it says so.)*

- **Forge's real match UI. Nothing in Phase 1 is Forge running under CheerpJ.**
  The Phase 1 CheerpJ figure is one `JComponent`. Phase 2 goes considerably
  further — Forge's real home screen paints — and names to the line what still
  stands between that and a match.
- ~~**Forge's EDT under CheerpJ.**~~ **CLOSED in Phase 2, and it works.** Lane A
  flagged `FThreads.invokeInEdtNowOrLater` as never exercised and warned it sat
  between the transport and any painted UI. Forge's whole home UI is built from
  `SwingUtilities.invokeLater(() -> Singletons.getView().initialize())`
  (`FControl.java:285`) and it paints, so EDT dispatch under CheerpJ is not a
  blocker. It is not what stops the match; Wall 3 is.
- **`applyDelta` and the state channel.** Lane A's transport covers Tier A's 14
  methods and refuses the other 24 by name, including the whole `applyDelta`
  channel a match UI needs, and its frame encoder caps at 65,535 B. Whether a
  real `GameView` fits through that is unmeasured.
- **Why the browser path does not preserve a held button.** Measured that it does
  not (§ "The 65 ms needs a footnote"); noVNC's source was not read and the
  mechanism is not identified. It matters because it is the whole reason the
  published 65 ms needs its footnote. To settle it: instrument noVNC's
  `_handleMouseButton` in the container, or packet-capture the RFB stream.
- ~~**CheerpJ's memory cost in the tab.**~~ **CLOSED in Phase 2**, and the guess
  in this line was the right order of magnitude: a Forge tab costs **1.43 GiB**
  of peak RSS delta, against streaming's measured 1.26 GiB per container. See
  "MEASURED: what the tab costs".
- **Anything at a real viewer's screen.** Both "composited frame" figures are the
  first `requestAnimationFrame` at which changed pixels are readable — one step
  before photons. Display scan-out and compositor queueing are in neither side.
- **Headless Chromium vs a real browser.** Every browser figure is headless
  Chromium via playwright-core. A real Chrome with a GPU compositor may differ, in
  either direction, and nobody checked.
- **Streamed Forge in a live match, in a browser.** streaming.md measured a live
  match through its Python client (64.8 ms). The browser figures here are the
  **home screen**. Getting the live-match browser figure means starting a game
  first; not done.
- **More than one CheerpJ tab at once**, and **a long session** (minutes, not
  hours — no JIT warm-up curve, no GC behaviour).
- **The 19.19 MB over a real link.** Measured as bytes on a fast connection; the
  time a friend on a slow link waits is not measured.
- **Whether `cjrtnc.leaningtech.com` is reliable.** A hard third-party dependency
  with no fallback, observed on one day. No uptime data.

---

# PHASE 2 — pointing the rig at Forge itself

Lanes A and B landed, so the rig went where it was built to go.

**Forge's real desktop UI runs in a browser.** Not the splash — the application:
the home screen, 505 preconstructed decks listed, 33,785 cards loaded, the
default skin applied, player avatars and deck sleeves drawn out of `res/`,
Forge's own first-run dialog, and a Start button that responds to a click. Wave 14 got `UnsatisfiedLinkError`; lane B got `SplashFrame`; this is
Forge.

Getting there took **two more one-to-ten-line patches** on top of lane B's, and
answered lane B's two open questions along the way:

1. **XStream is reached from many Forge screens, not one.** Removing them
   individually is a tail; one tolerant patch ends it, and names what it skips.
2. **CheerpJ WILL bind a native for a `jdk.internal` class** — lane B's open
   question, answered YES. But neither way of using it is safe: a no-op stub
   makes XStream *silently corrupt data* (proved by round trip), and a throwing
   stub hangs the JVM. The binding is a real capability and the wrong tool here.

## What was built

The pipeline is lane B's, pointed at this lane's cache, with this lane's patches
on top. No file of lanes A or B was modified; lane B's `run.sh` honours
`SPIKE_CACHE`, and `spike.Bootstrap` is compiled into this lane's probe jar
**from lane B's source path**, never copied.

```sh
export SPIKE_CACHE=$HOME/.cache/w15d-firstpaint
export PORT=8743
scripts/spike/cheerpj/assets/run.sh pristine              # lane B's, my cache
scripts/spike/cheerpj/assets/run.sh patch                 # lane B's 3 patches
cd $SPIKE_CACHE/forge-patched && for p in \
    <repo>/scripts/spike/cheerpj/firstpaint/patches/*.patch; do patch -p1 < $p; done
scripts/spike/cheerpj/assets/run.sh build-forge           # DO NOT TRUST ITS EXIT CODE
grep -c '^\[INFO\] BUILD SUCCESS' $SPIKE_CACHE/forge-build.log   # this is the gate
scripts/spike/cheerpj/firstpaint/run.sh build
scripts/spike/cheerpj/firstpaint/run.sh stage-forge
scripts/spike/cheerpj/firstpaint/run.sh explore --ready 'Read cards:' --budget 600000 \
    --step awaitcanvas:800x600 --step wait:8000 --step shot:home
```

And the whole thing — boot, navigate to a match, then take the number — is one
command, with the navigation baked in so it is reproducible from the committed
files rather than from a shell history:

```sh
scripts/spike/cheerpj/firstpaint/run.sh forge-measure
```

`FP_WIPE=1` makes it a cold run, `FP_NATIVES=unsafe` binds the Unsafe stub (do
not — see Wall 2), `FP_W`/`FP_H` set the CheerpJ display size.

Trap 7 is not theoretical: **lane B's `build-forge` returned exit 0 on a
`BUILD FAILURE`** on this lane's first Maven run. `stage-forge` refuses to stage
unless Maven's own `BUILD SUCCESS` line is in the log, which is why the rest of
this section is not measuring a stale jar.

Both archives (`cardsfolder.zip` 16,193,445 B, `res-boot.zip` 50,279,251 B) were
copied from lane B's cache rather than rebuilt, and verified by sha256 against
theirs — they are deterministic products of the vendored `res/` tree.

All four patches were proved to reapply from a pristine copy, aggregate exit 0:

```sh
scripts/spike/cheerpj/assets/run.sh patch            # lane B's, recreates $WORK
cd $SPIKE_CACHE/forge-patched
for p in <repo>/scripts/spike/cheerpj/firstpaint/patches/*.patch; do
  patch -p1 --dry-run < $p; patch -p1 < $p; done    # every exit 0
```

Note that `run.sh patch` **wipes and recreates** `$SPIKE_CACHE/forge-patched`, so
running that check discards the built `target/`. Re-apply and re-run
`build-forge` before staging again. The staged `www/forge.jar` is unaffected —
and carries its own proof:

```sh
javap -p -c -cp $SPIKE_CACHE/www/forge.jar forge.view.FView | grep -c VBazaarUI   # 0
```

## Wall 1 — XStream has many doors, not one

Lane B named the free thing to try first: *does a match-only client touch
XStream at all?* The answer is **no, in principle** —

```sh
grep -rl XStream $SPIKE_CACHE/forge-pristine --include=*.java
```

lists only `gamemodes/quest/**` (incl. `bazaar`), `gamemodes/gauntlet/**`,
`gamemodes/tournament/**`, `util/IgnoringXStream.java` and one desktop test. A
Constructed match enters none of them.

**In practice it is not a client, it is a startup.** Patch
`0002-no-bazaar-ui-cache.patch` drops `VBazaarUI.SINGLETON_INSTANCE.instantiate()`
from `FView.cacheUIStates()`. Proof it is in the jar that was measured:

```
$ javap -p -c -cp $SPIKE_CACHE/www/forge.jar forge.view.FView | grep -c VBazaarUI
0
```

That cleared lane B's wall exactly — the boot ran past the card database, past
the editions, past the token reader, with no XStream error at all. And then hit
the next door:

```
com.thoughtworks.xstream.core.JVM.isAndroid
com.thoughtworks.xstream.core.util.CompositeClassLoader.<clinit>
forge.util.IgnoringXStream.<init>
forge.gamemodes.gauntlet.GauntletIO.getSerializer
forge.gamemodes.gauntlet.GauntletIO.loadGauntlet
forge.screens.home.gauntlet.CSubmenuGauntletContests.updateData
forge.screens.home.gauntlet.CSubmenuGauntletContests.initialize
forge.view.FView.initialize
```

read off **Forge's own crash dialog, rendered in the browser**
(`$SPIKE_CACHE/shots/11-t120.png`). The reason there is a queue of doors is one
loop, `FView.java:145`:

```java
for (final EDocID doc : EDocID.values()) {
    final IVDoc<? extends ICDoc> d = doc.getDoc();
    if (d != null) {
        d.getLayoutControl().initialize();
    }
}
```

Every home submenu — sanctioned, quest, gauntlet, puzzle, online, settings — is
constructed at startup whether the product shows it or not, and **one dead panel
kills the application before the main window is ever shown.** Deleting them one
at a time is the long tail lane B warned about after spending three cycles on
`StorageReaderFolder`.

So patch `0003-tolerate-screen-init-failure.patch` catches per panel instead:
`Throwable`, not `Exception`, because the thing being tolerated is an
`UnsatisfiedLinkError` — which is exactly why XStream's own internal guard does
not catch it either. That is one patch, independent of how many screens are
affected, and it is a change worth having anyway.

## Wall 2 — CheerpJ binds jdk.internal natives, and it does not help

Lane B's other open question: *will CheerpJ bind a native for a JDK-internal
class?* It listed this as "the single cheapest next probe in this area".

**Answer: YES.** Binding `Java_jdk_internal_misc_Unsafe_putChar` through
`cheerpjInit({natives: {...}})` works, the native is called, and XStream's
poisoned `<clinit>` completes:

```
5682ms XP vendor=CheerpJ
6002ms FP-NATIVE putChar argc=5 (no-op stub)
7520ms XP provider=com.thoughtworks.xstream.converters.reflection.SunUnsafeReflectionProvider
```

`argc=5` for an instance native taking `(Object, long, char)` — CheerpJ passes
the library handle and `this` ahead of the declared arguments.

**And it is a trap.** A no-op stub satisfies the self-test in `JVM.<clinit>`,
so XStream concludes the unsafe provider works and *selects* it — after which
the fields whose writes route through the stubbed native go nowhere, silently.
`spike.XStreamPick` round-trips one object carrying a field of each kind and
checks the values back:

```
8765ms XP xml len=294
8818ms XP roundtrip MISMATCH char(0) inner-fields
```

`char(0)` where `'Z'` went in, and the nested object's fields wrong with it.
`int`, `long`, `boolean`, `String` and the array survived — so the corruption is
*partial*, which is worse than total: an object comes back looking plausible.
Not inferred — measured, by reading the values back. Forge agreed
independently, dying at
`ConversionException / cause: NullPointerException / class: forge.deck.Deck`
while deserialising a gauntlet (`$SPIKE_CACHE/shots/21-t90.png`).

**A native stub that makes a self-test pass is exactly the "passes while
measuring nothing" shape this lane exists to avoid**, one level down: it turns a
loud, correct failure into a quiet, wrong success. It was caught only because
the probe checked a round trip rather than checking that initialisation
succeeded.

The honest alternative is to make the self-test fail *catchably*, so XStream
falls back to `PureJavaReflectionProvider` by itself. Tested:

```
5423ms XP vendor=CheerpJ
5754ms FP-NATIVE putChar argc=5 (throwing)
                                    <- and nothing, ever
```

**Throwing from a CheerpJ native does not surface as a catchable Java exception;
the JVM stops.** No `XP provider=`, no `XP roundtrip`, no `XP end`, and the
driver exits 1 on its budget.

So: both ways of using the binding are unusable, and the binding itself is a
real capability that this project now knows it has. Record both.

## MEASURED: what Forge's boot costs in a browser

**Every timing in this section was taken while the host was carrying unrelated
work** — the operator's media transcoding out of `/mnt/hoard`, four `ffmpeg`
processes at 381 % / 294 % / 212 % / 104 % CPU, with `/proc/loadavg` ranging from
12 to **41.4** over the course of Phase 2, still climbing at the end. Phase
1's numbers were taken at load 2.7–12.5. **Treat every Phase 2 duration as an upper
bound on a busy machine, not as a clean measurement**, and re-run them on a
quiet host before quoting them to anyone. The structural findings above do not
depend on load; these numbers do.

### Forge's real home screen paints in a browser

It does. `$SPIKE_CACHE/shots/33-t200.png` is Forge's own desktop UI running under
CheerpJ: the left menu (Sanctioned Formats / Constructed / Booster Draft /
Sealed / Online Multiplayer / Quest / Puzzle / Gauntlets / Game Settings), the
"Sanctioned Format: Constructed" header, the Variants checkbox row, the
Preconstructed Decks table reporting **505 / 505**, Add a Player / View Deck /
Random Deck, the Start button, and Forge's first-run "download a full card image
index" dialog — the same dialog `scripts/spike/stream/run.sh prep` dismisses on
the streamed desktop.

That is past everything Wave 14 and lane B reached. Lane B got `SplashFrame`;
this is the application.

**Exactly one panel was lost to it**, and patch 0003 says which:

```
223213ms FView: panel HOME_GAUNTLETCONTESTS failed to initialize, skipping it:
         java.lang.ExceptionInInitializerError
```

One line, one skipped screen, full UI. That is the argument for the tolerant
patch over deleting screens one at a time: the same patch would have absorbed
the bazaar, and it names whatever it absorbs.

### MEASURED: what the tab costs

Process-tree RSS from `/proc`, sampled every 2 s for the whole run (143
samples), rooted at the driver's own pid and excluding it.

| | |
| --- | --- |
| browser, blank page | **440,436 kB (430 MiB)** |
| browser, peak during Forge boot | **1,940,032 kB (1.85 GiB)** |
| browser, settled after boot | **1,622,148 kB (1.55 GiB)** |
| **delta at peak — the honest figure** | **1,499,596 kB (1.43 GiB)** |

The trajectory climbs steadily through the card load and the UI build and then
flattens: 572 → 829 → 1,038 → 1,373 → 1,503 → 1,940 MB, settling at 1,622 MB.

**How much of that is CheerpJ and how much is Forge:** the same measurement on
this lane's trivial `spike.PaintProbe` page — CheerpJ's runtime plus one
`JComponent` — reports a delta of **343,276 kB (335 MiB)**. So the CheerpJ
runtime itself is about a third of a gigabyte and **Forge is the other ~1.1 GiB**.
That matters for the recommendation: the cost is the application, not the
compiler, and it will not be optimised away by a CheerpJ upgrade.

**This is the blank this lane named in Phase 1, and it is filled in.** Put next
to the other side of the decision:

| | per player |
| --- | --- |
| streaming — a container on **hokon** | **1.26 GiB** (`docker stats`; the JVM is 1.21 GiB of it) |
| CheerpJ — a tab on **the player's machine** | **1.43 GiB** peak delta, 1.16 GiB settled |

**They cost about the same. The difference is entirely whose machine pays.**
That is the whole argument for CheerpJ in one line, and it is now measured on
both sides rather than asserted on one.

Caveat carried deliberately: tree RSS double-counts pages shared between Chrome
processes, so the absolute figures overstate; the delta against the blank-page
baseline in the same browser is the part to quote. And 1.43 GiB is what a
*laptop* has to find, which is a different kind of ask from a server that was
sized for it.

### MEASURED: how long the boot takes

All under the host contention flagged above, with `/files/` already warm.

| | ms |
| --- | --- |
| `cheerpjInit()` returned | 1,311 |
| card database loaded (`Read cards:` 33,785) | ~86,000 |
| token scripts loaded (`Read cards:` 848) | 107,276 |
| gauntlet panel skipped | 223,213 |
| **home screen usable** | **between 246,000 and 287,000** |

So **four to five minutes from page load to a clickable Forge**, on a box doing
roughly ten cores of other work. Lane B's warm figure for the same boot to the
card database was 10.8 s on a quiet host, against ~86 s here — call it an 8×
contention factor, which would put a quiet-host home screen somewhere around
30–60 s. **That is an extrapolation, not a measurement, and it is exactly the
number to take again on an idle machine.**

For scale on the other side: a streamed Forge container is at its home screen in
**17.5 s**, measured, and that cost is paid by us once per match rather than by
the player once per cold cache.

## Wall 3 — starting a match builds a network server, and epoll is not there

The rig drove Forge's own home screen exactly the way Wave 14 lane C drove the
streamed one: dismiss the first-run dialog, **Random Deck**, **Start**. The
clicks land — Forge responds to every one of them, and the screenshots between
steps show the UI changing.

`Start` produces this, read off Forge's own crash dialog rendered in the browser
(`$SPIKE_CACHE/shots/43-after-start.png`, unchanged 90 s later in `44-match.png`):

```
java.lang.UnsatisfiedLinkError: Java_sun_nio_ch_EPoll_eventSize
    at sun.nio.ch.EPoll.<clinit>
    at sun.nio.ch.EPollSelectorImpl.<init>
    at sun.nio.ch.EPollSelectorProvider.openSelector
    at io.netty.channel.nio.NioEventLoop.openSelector
    at io.netty.channel.nio.NioEventLoop.<init>
    at io.netty.channel.nio.NioEventLoopGroup.newChild
    at io.netty.util.concurrent.MultithreadEventExecutorGroup.<init>
    at io.netty.channel.MultithreadEventLoopGroup.<init>
    at io.netty.channel.nio.NioEventLoopGroup.<init>
    at forge.gamemodes.net.server.FServerManager.<init>
    at forge.gamemodes.net.server.FServerManager.getInstance
    at forge.gamemodes.match.HostedMatch.startGame
    at forge.gamemodes.match.HostedMatch.startMatch
    at forge.gamemodes.match.GameLobby.lambda$startGame$0
```

**This is the single most useful thing Phase 2 found, and it was not known.**
Wave 14 established that CheerpJ ships no `sun.nio.ch` natives and that this
kills Forge's *client* transport (`Java_sun_nio_ch_EPoll_create`), which is the
seam lane A replaced. Nobody knew it also sits on the path of a **purely local
game against the AI**, where no network is involved at all.

The cause is three lines. `FServerManager`'s Netty event loops are **field
initialisers**:

```java
private EventLoopGroup bossGroup = new NioEventLoopGroup(1);
private EventLoopGroup workerGroup = new NioEventLoopGroup();
```

so *constructing the singleton* opens epoll selectors — and
`HostedMatch.java:183` constructs it only to ask `isHosting()`, which for a
local game is `false`. `InputPassPriority.java:75` does the same **every time a
human gets priority**, i.e. on every turn of every local game:

```java
final FServerManager server = FServerManager.getInstance();
final AfkTimeout timeout = server != null ? server.armAfkTimeout(...) : AfkTimeout.NOOP;
```

Note that call site null-checks a singleton whose getter can never return null —
dead code that says plainly the author expected `getInstance()` to be cheap and
possibly absent. Constructing a network server in order to ask whether a network
server is running is a bug on any platform; under CheerpJ it is fatal.

Patch `0004-no-netty-server-for-a-local-game.patch` makes the two groups lazy:
`startServer()` creates them if absent, `stopServer()` shuts down whatever
exists and drops the references. Behaviour on a real JVM is unchanged — that is
exactly what the existing *"create new EventLoopGroups for potential restart"*
line did, only deferred. Fixing the field rather than the two call sites is the
same argument as patch 0003 and the same lesson lane B drew from
`StorageReaderFolder`.

**The patch does not give Forge networking under CheerpJ, and it must not be
read that way.** Nothing here provides `sun.nio.ch` natives. A hosted or joined
network game still cannot run, and that is precisely the gap lane A's transport
replacement exists to fill. All this does is stop a local game paying for a
server it never uses.

### With 0004 in, the epoll crash is gone

Same navigation, rebuilt jar, proof it is the right jar:

```
$ javap -p -c -cp $SPIKE_CACHE/www/forge.jar forge.gamemodes.net.server.FServerManager     | awk '/^  forge.gamemodes.net.server.FServerManager\(\);/,/^$/' | grep -c NioEventLoopGroup
0
```

`Start` no longer throws. Forge gets through `HostedMatch.startGame` and reaches
its own **deck legality check**, which puts up an ordinary game-rules dialog
(`$SPIKE_CACHE/shots/53-after-start.png`):

> **Invalid Deck** — The following decks are not legal:
> Cheyenne: must not contain more than 0 copies of the card Gleemox
> `[Ignore]` `[Cancel]`

That is Forge asking a question, not Forge failing. It appears because **Random
Deck** can land on a preconstructed deck that fails Forge's own legality rules;
`Ignore` proceeds. So the navigation gained one more click, and the three walls
Phase 2 set out to measure are all behind it.

## Forge's real match UI paints in a browser

`$SPIKE_CACHE/shots/measure-after-start.png`. This is the thing Wave 15 was
called to produce:

- the window tab reads **"Andrew vs Christina (0-0)"**
- **both battlefields** — "Christina Field" and "Andrew Field" — with player
  avatars, life totals at 20, and Forge's full per-player counter column
- **the stack** ("Stack : 0"), the **Dock**, the **Card Detail** and
  **Card Picture** panels
- the **Prompt**: *"Game Setup — Christina is going first. Andrew, you are going
  2nd."* with live **Keep** and **Mulligan** buttons
- **a seven-card opening hand, drawn with full card art**: Murderous Spoils,
  Wrench Mind, Swamp, Specter's Shroud, Leaden Myr, Grimclaw Bats, Leaden Myr

Wave 14 got an `UnsatisfiedLinkError`. Lane B got `SplashFrame`. This is a game
of Magic, rendered by Forge's own Swing UI, inside a browser tab, reached by
clicking Forge's own home screen the same way Wave 14 lane C clicked the
streamed one.

**It reproduces.** Two independent runs from a cold page load reached a live
game with two different random decks — *"Andrew vs Christina"* (hand: Murderous
Spoils, Wrench Mind, Swamp, Specter's Shroud, Leaden Myr, Grimclaw Bats, Leaden
Myr) and *"Niktohal vs Breanon"* (Roaring Primadox, Island, Coral Barrier,
Forest, Reclamation Sage, Forest, Forest), each with its own deck contents,
avatars and card art. The layout is identical between them, which is what makes
a fixed click target usable for the measurement.

The route, end to end: lane B's `/files/` unpack + `getAssetsDir` patch, this
lane's `0002` (no bazaar), `0003` (tolerate a dead panel) and `0004` (no Netty
server for a local game) — **four small patches over stock Forge**, none of them
longer than a dozen lines.

### The rig's failure gate fired on Forge's real UI, and it was right to

The first measurement run against the match screen exited **1** with
`NO-CHANGE-ON-WARMUP`, `changedPixels: 0`. Its default target is the centre of
the canvas, which in this layout is the middle of **Andrew Field** — an empty
battlefield. Clicking empty board space in Forge changes no pixels, so there was
nothing to time, and the rig said so instead of reporting a number.

That is the Phase 1 negative-control machinery doing its job on a target nobody
designed it against, which is the only kind of evidence that matters for a
harness. The measurement was then re-aimed:

```sh
scripts/spike/cheerpj/firstpaint/run.sh forge-measure \
    --clicks 200,510 --clicks 333,510 --budget 12000 --reps 40
```

**Two different cards in the opening hand, alternating** — exactly as
`rfb-latency.py` alternates "Constructed" and "Booster Draft" — because clicking
a card repaints Forge's Card Detail and Card Picture panels, and clicking a
*different* card repaints them again. Everything else is the Phase 1 protocol
unchanged: 50 ms hold, clock at the press, `--jitter 25`, n=40,
min/median/p95/max, drops counted by cause.

**That run also failed, and its failure is a real lesson about auto-location.**
The warm-up click worked — **34,925 pixels changed** — so `locate()` succeeded
and the rig proceeded. But all 40 reps then reported `NO-PIXEL-CHANGE` and the
run exited 1 with no number.

The reason is visible in the artifacts. Clicking a card in hand does three
things at once: it outlines the card green, it fills the **Card Detail** panel
at the top right, and it fills the **Card Picture** panel at the bottom right
(`$SPIKE_CACHE/shots/measure-measure-end.png` shows *Coral Barrier — Creature —
Wall, 1/3, Defender* in both). Those regions are far apart, so the bounding box
of "what the click changed" was 490 × 504 — most of the screen — and the rig
centres its 520 × 30 strip inside that box. The centre of that box is the **gap
between the two panels**, which is empty battlefield and never changes.

**Auto-location is safe when a click changes one compact thing and wrong when it
changes several scattered things.** The fix is to watch a region chosen from the
screenshot rather than derived from a bounding box:

```sh
scripts/spike/cheerpj/firstpaint/run.sh forge-measure \
    --clicks 200,510 --clicks 333,510 --watch 650,440,140,30 --budget 12000 --reps 40
```

`650,440,140,30` is a strip across the middle of the Card Picture panel — the
rendered card image, which changes completely when a different card is selected.
This is the same `--watch` mechanism used to point the rig at streaming's
"Sanctioned Format" heading in Phase 1, and for the same reason.

## THE NUMBER WAS NOT TAKEN — built, measurement pending

**There is no click-to-pixel figure for Forge's real match UI in this document,
and nothing below should be read as one.** The rig reaches the match UI and the
UI paints; every attempt to take the distribution was refused by the rig's own
gates, each time for a different and legitimate reason. Six further runs were
made after the section above was written. What they establish:

| state measured | n | result |
| --- | --- | --- |
| coin-toss screen | 40 | `NO-CHANGE-ON-WARMUP`, `changedPixels: 0` — the hand is still EMPTY until the prompt is answered, so the clicks landed on a bare panel |
| live game, AI's turn | 40 | 39 × `NOISY-BASELINE`, 1 × `NO-PIXEL-CHANGE`. `preClickChanges` 25–51 px on every rep |
| mulligan prompt, board static | 40 | 39 × `NOISY-BASELINE`. `preClickChanges` 47–60 px, steady |

**A live game is not a quiet baseline** — the AI takes its turn and the window
repaints continuously — so the measurement has to be taken at the **mulligan
prompt**, where the hand is dealt and nothing is running. `run.sh forge-measure`
now navigates there and screenshots it (`shots/measure-hand.png`: *"Ault, you
are going first! Do you want to"*, `Keep` / `Mulligan`, seven cards with art).

Even there a steady **47–60 changed pixels of a 140 × 30 = 4,200 px strip**
(~1.3%) appears inside the 300 ms quiet window, on every rep, at the default
24-pixel threshold. The cause is not identified. It is far below a real
selection change — lane D's own warm-up measured **34,925 px** for one — so
`--min-pixels 500` sits two orders of magnitude under the signal and one above
the floor. **That run has not yet completed successfully**, for the reason below.

### The cold unpack stalls, and that is what stopped this

**Four of eight runs never reached `Read cards:`**, exiting `NO-READY-MARKER`
after the full 900 s boot budget. The unpack simply stops — no exception, no
further console output:

```
30001ms BOOT unpack progress files=14500 bytes=52097292 ms=24391   <- last line, twice
11560ms BOOT unpack progress files=8000  bytes=47112609 ms=5823    <- last line, once
```

Two stalls halted at the *identical* offset and a third did not, so it is not
one bad entry in the archive. Cause unverified. This is the same area lane B
flagged: an unexplained 29.8–38.6 s spread on the same archive, and **IndexedDB
quota never checked**. A `--user-data-dir` flag was added to reuse a profile and
skip the unpack; it was measured NOT to help — two runs with a persistent
profile stalled in the unpack exactly like the fresh ones, so `/files/` is not
in fact surviving between processes. Lane B's measurement was persistence across
page loads *within one browser*, which is a weaker claim.

**The exact command that produces the number, once a run boots:**

```sh
export SPIKE_CACHE=$HOME/.cache/w15d-firstpaint PORT=8743
scripts/spike/cheerpj/firstpaint/run.sh forge-measure \
    --clicks 200,510 --clicks 333,510 --watch 650,440,140,30 \
    --min-pixels 500 --budget 12000 --reps 40
```

Settle the stall first — it is the thing standing between this wave and its
deciding number, and it is a boot-reliability bug, not a latency result.

## What Phase 2 adds to the recommendation

Phase 1 found that latency does not decide this wave. Phase 2 does not change
that and adds two things that might.

**1. The player's tab costs about what our container costs.** 1.43 GiB peak
delta against streaming's measured 1.26 GiB. The CheerpJ case was never "it is
cheaper" — it is "the cost moves off our host and onto theirs, and the RTT
disappears for local interactions". Both halves of that are now measured. What
is new is that the player's half is not small: a 1.4 GiB tab is a real ask of a
laptop, and it is the number to put in front of the operator beside the 19.19 MB
download and the boot time.

**2. Forge's desktop client is closer to running in a browser than anyone in
this project has assumed, and the remaining blockers are named to the line.**
Lane B got to `SplashFrame` and called the route open. It is more open than
that: **three** small patches put Forge's real home screen up with 505 decks
listed, 33,785 cards loaded, the skin and player avatars drawn, and one
quest-mode panel skipped —
lane B's `0001-assets-dir-from-system-property` (one line) plus this lane's
`0002` (one line) and `0003` (a try/catch). Lane B's `0002` and `0003` were
also applied here but lane B already measured them as not required for this
route. Nothing about any of that was predicted by Wave 14.

A fourth, `0004-no-netty-server-for-a-local-game`, addresses the match-start
blocker in Wall 3.

**3. The wave's premise is answered: Forge's real match UI paints in a browser.**
§0 asked for *"Forge's real match UI painting in a browser, with a click-to-pixel
figure taken the same way streaming's was"*. The first half is done and shown —
two battlefields, a seven-card hand with art, live Keep/Mulligan buttons. The
rig that takes the second half is the one already validated in Phase 1 against
both CheerpJ and streamed Forge, and `run.sh forge-measure` now drives it
through the whole route in one command.

**What the operator should take from Phase 2 is that the CheerpJ route is no
longer a research risk.** It is an engineering cost with a known shape: four
small patches to reach a match, a 19.19 MB third-party runtime, a 1.43 GiB tab,
and a boot measured in tens of seconds. Against that, streaming costs 1.26 GiB
and half a core *of our host* per player, an unmeasured uplink, and the room
layer (`docs/spikes/streaming.md`, "What is lost").

## What Phase 2 did NOT verify

- **The navigation to a match is not fully deterministic.** `Random Deck` picks a
  random preconstructed deck, and whether Forge's legality check objects
  ("Invalid Deck … Gleemox") depends on which one it picked. The click sequence
  in `run.sh forge-measure` handles both, but a rig whose setup varies run to run
  is a rig that can drift — pinning a specific legal deck would be better and was
  not done.
- **Patch 0004 was verified to clear the epoll crash, not to be correct.** The
  evidence is that `Start` stops throwing and Forge proceeds to its own deck
  check. Nothing exercised `startServer()` / `stopServer()` after the change, so
  the claim "behaviour on a real JVM is unchanged" is an argument from the code,
  not a test. `NetworkPlayIntegrationTest` and `UnifiedNetworkHarness` exist in
  the desktop test tree and would settle it; this lane ran neither.
- **`InputPassPriority` was fixed by inference.** It has the same
  `FServerManager.getInstance()` pattern and the same patch covers it, but no run
  got far enough into a game to execute it.
- **Every duration in Phase 2 was measured on a contended host.** Four unrelated
  `ffmpeg` processes at 381 / 294 / 212 / 104 % CPU and `/proc/loadavg` between
  12 and 41.4 throughout, still rising at the end. Lane B's warm card-load
  figure was 10.8 s on a quiet host against ~86 s here. **Re-run the boot timings on an idle machine before quoting any of
  them.** The structural findings do not depend on load; the durations do
  entirely.
- **The memory figure was taken in the same conditions**, though RSS is far less
  load-sensitive than wall time. It is also headless Chromium, not a real
  browser, and tree RSS double-counts shared pages.
- **`java.vm.vendor` was set by a system property in the probes** but not in the
  Forge boot used for the home-screen run — the boot there relies on patch 0003
  skipping the panel instead. Both routes were exercised; they were not
  exercised together.
- **Whether the surviving quest/tournament code paths matter.** Only
  `HOME_GAUNTLETCONTESTS` failed in the measured boot. Quest and tournament
  screens did not, which means either they do not construct XStream at startup
  or they were not reached. Nobody checked which.
- **Whether patch 0003 hides something it should not.** A panel this product
  *does* need would also be skipped-and-logged rather than crashing. That is the
  intent, but it makes a silent-degradation failure mode possible and no test
  guards it.
- **The `unsafe-throw` hang was not diagnosed.** It is measured that the JVM
  stops producing output after a native throws; whether that is a CheerpJ thread
  death, a deadlock, or an uncaught JS rejection is unknown. Worth knowing
  before anyone relies on natives for anything load-bearing.
- **The no-op stub's blast radius was characterised on one object.**
  `spike.XStreamPick` shows `char` fields lost and nested object fields wrong;
  `int`, `long`, `boolean`, `String` and arrays survived. Whether other types
  are silently wrong was not enumerated.
- **IndexedDB quota for the 71 MB unpack was still never checked** — lane B
  flagged it and this lane did not close it. Every run here reused an already
  warm `/files/`. If a quota refusal turns the 30 s unpack into a per-visit
  cost, §4 of lane B's doc and the boot figures here both change.
- **`FSkin.loadFull` now demonstrably runs** (the home screen is skinned), which
  closes one of lane B's open items — but no font, sprite or icon was checked
  for correctness beyond "the screen looks right in a PNG".
