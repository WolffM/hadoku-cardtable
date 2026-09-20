# Click-to-pixel under CheerpJ, and what it is a number OF

**Status: PHASE 1.** The rig works, it is demonstrated to be able to FAIL, and it
has produced numbers for a bare Swing component under CheerpJ and for streamed
Forge in a browser. **It has NOT been pointed at Forge's real match UI** —
nothing past `SplashFrame` renders yet. That is Phase 2, gated on lanes A and B.

Headline, and it is not what this lane expected to find:

> **At the boundary that actually matters — pixels in the player's browser —
> CheerpJ's floor and streamed Forge's real UI are the same speed today:
> 49.5 ms vs 49.7 ms median, measured by one instrument on one host on one day.**
> Latency is therefore not what decides this wave. The cold cost, the server
> budget and the network RTT are.

And a correction to the number this comparison was supposed to be against:
**streaming.md's 65 ms is not what a player in a browser experiences**, in either
direction. See "The 65 ms needs a footnote".

Everything below came from a command that ran on hokon on 2026-09-20. Nothing is
estimated unless it says ESTIMATED. Host load is quoted where it matters: three
other lanes were running throughout, and `/proc/loadavg` ranged from 2.7 to 12.5.

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

## Recommendation (PROVISIONAL — the deciding number does not exist yet)

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

- **Forge's real match UI. Nothing here is Forge running under CheerpJ.** The
  CheerpJ figure is one `JComponent`. This is the wave's whole question, and it
  is Phase 2, gated on lanes A and B.
- **Forge's EDT under CheerpJ.** Lane A reports `FThreads.invokeInEdtNowOrLater`
  was never exercised and it invoked inline on its pump thread instead. Every
  pixel in Phase 2 goes through that dispatch. If it does not work, that is the
  measured reason the match UI cannot paint — a complete result.
- **`applyDelta` and the state channel.** Lane A's transport covers Tier A's 14
  methods and refuses the other 24 by name, including the whole `applyDelta`
  channel a match UI needs, and its frame encoder caps at 65,535 B. Whether a
  real `GameView` fits through that is unmeasured.
- **Why the browser path does not preserve a held button.** Measured that it does
  not (§ "The 65 ms needs a footnote"); noVNC's source was not read and the
  mechanism is not identified. It matters because it is the whole reason the
  published 65 ms needs its footnote. To settle it: instrument noVNC's
  `_handleMouseButton` in the container, or packet-capture the RFB stream.
- **CheerpJ's memory cost in the tab.** Not measured at all. Streaming's 1.26 GiB
  is measured; CheerpJ's browser-side equivalent is a blank. If a player's tab
  needs a gigabyte, that is as decisive as any latency number.
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
