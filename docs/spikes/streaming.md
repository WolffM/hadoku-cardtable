# Streaming Forge desktop: what it costs, and what it costs us

**Verdict: it WORKS, cheaply, and it is still the wrong default.** A container
running Forge desktop under `Xvfb`, screen-scraped by `x11vnc` and handed to a
browser by noVNC, renders a **live Magic match in Chrome** — card art, hand,
battlefield, the real Forge UI — for **1.26 GiB of RAM, 0.5 of a core and about
1 Mbit/s per player**, with **65 ms of click-to-pixel on this host**. It took a
Dockerfile and an afternoon, against the open questions in lanes A and B.

What it gives up is not a resource number. **The match stops travelling through
our netcode.** Forge's own client drives the game, Forge's own protocol carries
it, and the hadoku-watchparty room layer is reduced to the chat around a video
feed. That is the exact objection that made the operator reject "friends run
Forge desktop" — this is the same architecture with the client moved into a
container we pay for. See "What is lost", which is the part of this document
that matters.

**Recommendation: keep it as the costed fallback.** If lanes A and B both say
NO-GO, this is a two-week path to the real Forge UI in a browser rather than a
multi-month one, and the cost of the room layer becoming chat-only should be put
to the operator as a decision, not assumed either way.

Everything below came from a command that ran on hokon on 2026-09-19. Nothing
is estimated unless it says ESTIMATED.

---

## Reproducing it

```sh
cd scripts/spike/stream
./run.sh build          # image + its size
./run.sh boot           # cold start, docker run -> usable Forge window
./run.sh up 6           # six match containers, staggered
./run.sh prep 6         # dismiss Forge's first-run dialog, fill the screen
./run.sh cost 6         # RAM / CPU / disk
./run.sh latency-rfb 0 --reps 40        # click-to-pixel over the VNC wire
./run.sh host-forge && ./run.sh host-prep && ./run.sh latency-xvfb --reps 40
./run.sh down           # removes every container and host process it started
```

`run.sh` picks display `:90` and ports `5990+`/`6090+`, checks they are free
first, and never touches `/tmp/cardtable-play`. It changes no product code: this
lane owns `scripts/spike/stream/**` and this file, and nothing else.

The image bind-mounts the Forge jar and `forge/forge-gui/res` read-only rather
than baking them (see the Dockerfile's header for why). `forge/` is untouched:

```
$ git -C /home/hadoku/repos/hadoku-cardtable/forge status --porcelain
$ echo $?
0
$ git submodule status forge
-2ad70eb447a22efe5b80904c07188311da034a42 forge
```

---

## It renders a real match

Not a menu screenshot. A Constructed game was started inside the container by
driving Forge's own home screen — `docker exec -e DISPLAY=:1 ct-stream-0 xdotool
mousemove <x> <y> mousedown 1 sleep 0.06 mouseup 1` on "Random Deck" and then
"Start" — and played to the opening hand: "Oxbaren is going first.
Makenzie, you are going 2nd. Do you want to keep your hand?" — with seven cards
in hand rendered with full art, both battlefields, the stack, the log, the phase
bar and the card-detail panel. A Chrome tab pointed at
`http://127.0.0.1:6090/vnc.html?autoconnect=true` drew the same thing:

```
$ # in the browser, against the live noVNC canvas
$ # -> {w: 1280, h: 800, sampledPixels: 80000, nonBlackPixels: 66147}
$ docker exec ct-stream-0 netstat -tn | grep -c ':5900.*ESTABLISHED'
2
```

That is the whole point of this option and it is worth being blunt about: **the
UI problem is solved by this, completely, today.** No missing card art, no
half-built board, no unimplemented stop points. It is Forge.

---

## MEASURED: per-match resource cost

### Image and disk

| | | command |
| --- | --- | --- |
| image on disk | **1,060,268,883 B (1.06 GB)** | `docker image inspect cardtable-stream-spike:w14 --format '{{.Size}}'` |
| — of which the X stack | 503 MB | `docker history cardtable-stream-spike:w14` |
| — of which the Temurin JRE | 166 MB | same |
| container virtual size | 805 MB | `docker ps -s` |
| writable layer, idle | 430 kB | `docker ps -s` |
| writable layer, after a match | 930 kB | `docker ps -s` |
| build, cold | 50.1 s | `/usr/bin/time -f 'BUILD_WALL=%e s' docker build …` |

The image is a **one-time** disk cost: every container shares its layers, and
the per-container cost is the writable layer, which is under 1 MB. The Forge jar
(39,686,151 B) and `res/` (462 MB) are bind-mounted read-only, so they are one
copy on disk however many matches run.

1.06 GB is fatter than it needs to be — `novnc` drags in a Python stack. Not
worth optimising for a spike; worth knowing it is not a floor.

### RAM

| | | command |
| --- | --- | --- |
| container, Forge at its home screen | **1.09 GiB** | `docker stats --no-stream` |
| container, live match open | **1.216 – 1.263 GiB** | `docker stats --no-stream` |
| — of which the JVM | 1,265,180 kB RSS | `docker exec … ps -eo rss,comm` |
| — Xvfb / websockify / x11vnc | 46,832 / 38,364 / 22,656 kB | same |
| host delta for six containers | 6,169 MiB → **1,028 MiB each** | `free -m` before and after |

The JVM is 97% of it, and it is the same `-Xmx1g` cap the play server already
puts on a match JVM (`apps/server/src/play/host.ts`). The X stack is ~108 MB on
top — cheap. **Budget 1.3 GiB per streamed desktop.**

### CPU

| | | command |
| --- | --- | --- |
| idle, game open, nobody clicking | **0.08 – 0.17 %** | `docker stats --no-stream` |
| clicking through menus, continuously | **0.14 – 0.26 cores** | `cpu.stat usage_usec` delta / wall |
| selecting cards in a live match, continuously | **0.487 cores** | same |
| cold boot | ~1 core for ~18 s | `./run.sh boot` + `docker stats` |

`cpu.stat` is read straight out of the container's cgroup, so the number is the
container's own CPU seconds over a measured wall interval, not a sampled
percentage:

```sh
docker exec ct-stream-0 awk '/^usage_usec/{print $2}' /sys/fs/cgroup/cpu.stat
```

Note how far apart idle and active are. **A streamed desktop costs almost
nothing between clicks** — nobody is pushing 60 fps of video, x11vnc sends only
changed rectangles when something changes. Magic is a good fit for this: it is a
screen that sits still.

### Cold start

```
$ ./run.sh boot
Forge window up after 18.1 s; RFB answering after 18.3 s
Forge window up after 17.4 s; RFB answering after 17.6 s
Forge window up after 17.4 s; RFB answering after 17.7 s
```

**~17.5 s** from `docker run` to a Forge home screen answering RFB, three runs,
on an otherwise-quiet host. That is five times the ~3.4 s a headless match JVM
takes (`docs/spikes/jvm-per-match.md`), because this one builds the whole Swing
UI and skin as well as the card database. A player would wait through it twice
per match (one desktop each), so a warm-container pool — the same trick
`jvmHostFactory` already plays with a spare JVM — is not optional, it is the
difference between "instant" and "35 seconds of nothing".

### Bandwidth

| | | how |
| --- | --- | --- |
| noVNC in Chrome (default Tight), menu switching | **276 KiB/s = 2.3 Mbit/s** | container `eth0` TX delta, `/proc/net/dev` |
| noVNC in Chrome (default Tight), in a live match | **127 KiB/s = 1.0 Mbit/s** | same |
| raw RFB, no compression (our harness) | 6,300 KiB/s | `rfb-latency.py`'s own byte count |

The Raw figure is in the table only to show what the encoder is worth: Tight is
**23× cheaper** on this screen. **Budget 1–2.3 Mbit/s per watching player while
they are actively clicking, and near zero while they read.**

---

## MEASURED: latency, and exactly how

### The protocol, because the number depends on it

"Click-to-pixel" is under-specified until you say when the clock starts. Forge's
Swing UI acts on the mouse **release**, so the button hold time passes straight
into the number. Proved by sweeping it on the Xvfb hop:

| hold | median press→pixel | implied release→pixel |
| --- | --- | --- |
| 100 ms | 100.9 ms (min 100.4, max 101.9) | **0.9 ms** |
| 50 ms | 50.9 ms (min 50.4, max 102.4) | **0.9 ms** |
| 20 ms | 40.3 ms | 20.3 ms, high variance |
| 0 ms | 32.5 ms | 32.5 ms, high variance |

With a human-length hold the app repaints within **1 ms** of the button coming
up. With press and release jammed together they compete for the Swing event
thread and the number becomes noise. **So every figure below uses a fixed 50 ms
hold and starts the clock at the press** — that 50 ms is inside the numbers, and
both hops are measured the same way so the difference between them is real.

### How each hop is taken

**Hop 1, app render (`scripts/spike/stream/latency.py`).** `ffmpeg -f x11grab`
captures a 520×30 strip of the X display as 8-bit grey raw frames at 200 fps
straight into a pipe; the script timestamps each frame as it arrives and
compares it to a pre-click baseline. A single long-lived `xdotool -` reads
commands on stdin, so no process spawn sits between the timestamp and the XTEST
event. Quantum 5 ms; the script prints the capture's own arrival interval
(median 5.0 ms, p95 6.0 ms, max 15.4 ms over n=4914) so you can check it kept up.

> Trap for anyone re-running it: without `-fps_mode passthrough`, ffmpeg
> conforms x11grab's wallclock timestamps to a CFR timeline, decides it owes
> millions of duplicate frames, and floods the pipe with stale ones. Every
> measurement then reads history. It logs `frame duplication too large`.

**Hop 2, the VNC wire (`scripts/spike/stream/rfb-latency.py`).** A ~200-line
RFB 3.8 client speaking to `x11vnc` directly. It injects the click as an RFB
`PointerEvent`, exactly as a viewer would, and stops the clock when the pixels
of the changed region come back over the same socket. Raw encoding only, so no
codec flatters the number. Covers: PointerEvent → XTEST → Swing repaint →
x11vnc poll → rect encode → socket → client decode.

> Trap: x11vnc batches pointer events between polls, and a press and release in
> the same batch can collapse into nothing — the app never sees a click. The
> harness holds the button (which is why the hold exists at all) and still loses
> about one click in forty; those are counted and reported as
> `CLICK NOT DELIVERED` rather than averaged in as a 5-second stall.

### The numbers

All press→pixel with a 50 ms hold. Subtract ~50 ms for release→pixel.

| what | n | min | **median** | p95 | max |
| --- | --- | --- | --- | --- | --- |
| Hop 1 only — Xvfb, no VNC | 39 | 50.4 | **50.9** | 84.5 | 102.4 |
| Hops 1+2 — through x11vnc, loopback | 39 (1 dropped) | 57.8 | **63.7** | 75.3 | 94.6 |
| Hops 1+2 — **in a live match** | 40 (0 dropped) | 58.3 | **64.8** | 84.8 | 191.5 |
| Hops 1+2 — six matches at once, each | 39 each | — | **62.8 – 64.3** | 73.1 – 106.7 | 103 – 122 |

**The VNC hop costs ~13 ms** (63.7 − 50.9). **A live match costs nothing extra**
over the menu screen (64.8 vs 63.7). **Six concurrent sessions cost nothing
extra** (62.8–64.3 vs 63.7) — on this host, at this load, the stack does not
degrade under the concurrency we would ever ask of it.

### What these numbers do NOT include

Say this out loud before quoting 65 ms to anyone:

1. **websockify's WebSocket framing.** Loopback, small, unmeasured.
2. **The browser's noVNC decode and canvas paint.** ESTIMATED at roughly one
   frame, 8–16 ms. Not measured — our harness is a Python RFB client, not a
   browser. To settle it, drive the click from inside the page and time it
   against a `requestAnimationFrame` after the canvas changes; nothing in this
   lane does that yet.
3. **The network between the player and hokon.** This is the big one and it is
   not ours to control. A friend on a 50 ms RTT link pays it **twice** — once
   carrying the click up, once carrying the pixels down — so the same match that
   measures 65 ms here is ~165 ms for them. That is the honest number to put in
   front of the operator: **roughly 150–200 ms click-to-pixel over the internet**,
   of which ours is 65.

For comparison, our own netcode carries a JSON message one way over the same
link: the player's click costs one RTT there too, but the UI can respond
*locally and immediately* — which is a thing a pixel stream can never do.

---

## MEASURED: the concurrency ceiling on hokon

Host facts, all read on the day:

| | | command |
| --- | --- | --- |
| cores | 12 | `nproc` |
| RAM | 61.9 GiB total | `free -m` |
| **available with no containers** | **29,365 MiB (28.7 GiB)** | `free -m` |
| used with no containers | 34,037 MiB | `free -m` |
| available with six containers | 22,546 MiB | `free -m` |
| baseline load average | 2.4 – 4.5 | `uptime` |
| PM2 services | 24 processes, 1.79 GiB RSS | `pm2 jlist` |

**A match needs two containers, not one.** A Magic player's hand is hidden
information, so two players cannot share one desktop — each needs their own
Forge client, exactly as "friends run Forge desktop" would have. Plus the match
JVM that already exists (`docs/FORGE_JAR.md`; ~650–730 MB, capped at `-Xmx1g`).

**Per 2-player match:**

| | |
| --- | --- |
| RAM | 2 × 1.26 GiB + ~0.7 GiB JVM = **~3.2 GiB** |
| CPU, both players clicking | 2 × 0.49 + JVM ≈ **~1.0 core** |
| CPU, between clicks | < 0.05 core |
| upstream bandwidth | 2 × 1.0–2.3 = **2–4.6 Mbit/s** |
| cold start | 2 × 17.5 s, in parallel |

**The ceiling, derived:**

- **Memory-bound: 9 matches.** 28.7 GiB free ÷ 3.2 GiB. Taking the whole box is
  not a plan on a host running 24 PM2 services including production, so with
  half the box left free: **4 concurrent matches**.
- **CPU: not binding.** ~9 cores free at baseline load; 1.0 core per match while
  both players click continuously — which real players do not — gives 9 matches,
  and the real load is far under that. The spike is cold start: creating N
  matches at once briefly wants 2N cores for 18 s.
- **Network: UNMEASURED, and probably the real ceiling.** hokon's upstream is
  not measured anywhere in this repo. At 4.6 Mbit/s per match, 4 matches is
  ~18 Mbit/s of sustained upstream. A typical residential uplink does not have
  that. **This is the number that decides it and I did not measure it** — it
  needs an external throughput test from hokon, e.g.
  `curl -o /dev/null -w '%{speed_upload}\n' -T /dev/zero <endpoint>` against a
  host the operator controls, or the ISP's stated upstream.

**The practical answer: today's cap of 2 concurrent matches
(`MAX_CONCURRENT_MATCHES` in `apps/server/src/play/host.ts`) costs ~6.4 GiB,
~2 cores at full tilt and ~9 Mbit/s upstream. hokon has the RAM and the CPU
comfortably. The uplink is the open question.**

---

## What is lost

This is the part that decides the wave, and it is not a resource number.

**Our room layer stops carrying the match.** Today a match runs in a child JVM
that our bridge drives, and every state change crosses a seam we own — that is
what `docs/ARCHITECTURE.md` is about and why `ProtocolMethod`, `IToClient` and
`TrackableProperty` have been analysed at all. Put Forge's own desktop client in
a container and the game is carried between that client and the match JVM by
**Forge's netcode**, over Forge's protocol. What travels through hadoku-watchparty
is a VNC pixel stream and the chat beside it. The room becomes a video call with
a game in it.

That is the **same objection the operator already used to reject option A** —
*"lame because it doesn't utilize the watchparty netcode at all which was the
whole point."* Moving the desktop from the friend's PC into a container we pay
for and pipe through an iframe does not change the property they objected to.
It changes who pays for the CPU.

Concretely, adopting this means:

- **Spectating is a second VNC session**, not a view built from game state we
  hold. Anything a spectator should see differently (no hidden zones, a
  commentary overlay) has to be done by giving them a different Forge client,
  not by rendering our own view.
- **We cannot put anything on the board.** No hadoku chrome inside the game area,
  no theme, no per-room customisation. It is Forge's pixels, framed.
- **The art indirection stops applying to the game.**
  `apps/ui/src/draft/art-manifest.json` and `packages/carddata/src/art` exist so
  a card's art is a lookup we can repoint in one line (D15/D18). A streamed Forge
  draws from its own `res/`, so inside the match that design is simply not in the
  path. It still governs the draft UI and anything else we render.
- **The stop-point work is bypassed.** `YieldMarker` / `applyYieldUpdate` /
  `sendYieldUpdate` are Forge's own semantics on the wire, and the tracker holds
  them as the first thing to build on a NO-GO. Streaming makes them moot for the
  match — Forge's client already implements them — and also makes them
  unavailable to us.
- **The attack surface grows.** A VNC session is a desktop. Forge has a deck
  editor, file dialogs and a downloader; a player with a mouse inside the
  container has all of it. The container is the sandbox and the friend gate still
  holds the door, but this is a much bigger surface than a JSON protocol with a
  Zod schema in front of it.
- **The React board's replacement is total.** Lane-neutral on purpose: the board
  goes when something replaces it, and this replaces it completely rather than
  partially.

What is **not** lost: rooms, presence, chat, identity, the friend gate, the draft
flow (which is ours and stays ours), and the ability to change our mind — a
container is not a fork.

---

## What was NOT verified

- **hokon's upstream bandwidth.** Named above; it is the likely binding
  constraint and it is unmeasured.
- **Browser-side click-to-pixel.** The browser path is proven to work (a live
  match rendered in Chrome, 66,147 of 80,000 sampled canvas pixels non-black)
  but no click was timed through it. The measured hops stop at a Python RFB
  client. ESTIMATED addition: 8–16 ms plus the player's RTT twice.
- **Forge desktop in client mode against our match JVM.** Every measurement here
  ran Forge's *local* game. The two-containers-per-match model assumes each
  client connects to the match JVM through Forge's "Online Multiplayer", which
  this lane did not exercise. The resource numbers would not change much (the
  same UI, less local engine); the architecture claim in "What is lost" does not
  depend on it.
- **A long match.** Measurements are minutes, not hours. The JVM's RSS ratchets
  under G1 (the same reason `host.ts` budgets peak, not average), so a two-hour
  match will sit nearer 1 GiB of heap than the 1.26 GiB total measured here
  suggests — but nobody ran one.
- **KasmVNC / Selkies.** The brief named them as candidates. Not tried:
  `x11vnc` + noVNC answered the question at the cost of an apt line, and both
  alternatives trade CPU for bandwidth, which is the axis where this host has
  slack. If the uplink turns out to be the ceiling, they are where to look next —
  KasmVNC's own numbers claim materially better compression than Tight.
- **GPU acceleration.** None used, none needed; Forge's Swing UI is software
  rendering and 0.5 of a core covered it.

---

## Toolchain, for the record

| | |
| --- | --- |
| Host | hokon, 12 cores, 61.9 GiB, Linux 6.12.101 |
| Docker | 29.8.1, overlayfs |
| Base image | `eclipse-temurin:21-jre-noble` |
| Forge | `2.0.15-SNAPSHOT-09.18`, the jar at `~/.local/share/cardtable/forge.jar` |
| x11vnc | from Ubuntu noble, `-noxdamage -wait 5 -defer 5` |
| noVNC / websockify | from Ubuntu noble |
| ffmpeg / xdotool | `/usr/bin`, host, for the measurement harness only |
| Browser | Chrome via Playwright, for the noVNC proof |
