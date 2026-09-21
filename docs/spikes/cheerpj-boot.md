# Making the CheerpJ boot reach Forge's home screen every time — Wave 16, lane A

**The mechanism, first, because it is the thing wave 15 could not name:**

> The unpack does not crash, run out of quota, or get refused. **One Java
> filesystem call into CheerpJ's `/files/` mount never returns.** The thread
> that made it is parked forever; every other Java thread keeps running, the
> browser's event loop keeps running, IndexedDB goes completely idle, and no
> exception, abort or rejection is ever raised. It is a lost wakeup, and the
> call it is lost inside is the stream close at
> **`scripts/spike/cheerpj/assets/java/spike/Bootstrap.java:102-106`** — the
> `try (InputStream in = zip.getInputStream(ze); OutputStream os = new
> BufferedOutputStream(new FileOutputStream(target), 64 * 1024))` block, at the
> point where the buffered bytes are flushed to `/files/` and the file is
> closed.

**IndexedDB quota, the suspect wave 15 named as most likely, is not the cause
and is not close.** Measured on every run in this document: the origin's quota
is **10.8 GB** and the unpack's peak usage is **69.6 MB** — 0.6% of it. Across
every run here there were **zero** IndexedDB transaction aborts, **zero**
transaction errors, **zero** failed requests and **zero** unhandled promise
rejections. That item can come off wave 15's open list.

**What is and is not claimed.** The done-when is met — **20 consecutive cold
boots reached Forge's home screen**, some of them at host loads above 20. But
**the mutation test failed**: running the same jar with the fix flag turned back
off did *not* reproduce the stall, because the stall's true rate on this host is
about 1 in 60 unpacks and the run budget bought 40. So this document names the
mechanism and clears the quota theory with hard numbers, and it reports a fix
that is *argued from the mechanism and consistent with 20/20*, not one that has
been demonstrated by rate. The section "The rates" says exactly how much
evidence there is, and what the missing experiment costs.

## The decisive measurement

A single stalled run, instrumented, answers the question wave 15 could not
reach. This is `before/run-06.json`:

```
lastWatchdog   105546ms BOOT wd phase=close-streams
               entry=res/quest/world/shandalar/duels/Undead Knight 4.dck
               files=14582 bytes=52139838 inCallMs=75094
lastProgress    30078ms BOOT unpack progress files=14500 bytes=52097292 ms=24533

IndexedDB   transactions=45462  requests=75667  completed=75667
            failed=0  outstanding=0  aborts=0  errors=0
storage     quota=10,774,248,763   peak usage=36,830,523   (0.34%)
unhandled promise rejections: 0        page errors: none
last IDB operation of the whole run: put, t=30,450 ms
```

Read those four numbers together:

- The Java thread entered the stalled call at **t ≈ 30,452 ms**
  (105,546 − 75,094).
- The last IndexedDB request of the entire run was issued at **t ≈ 30,450 ms**,
  two milliseconds earlier, **and it completed**.
- `outstanding = 0`: of 75,667 IndexedDB requests issued across the run, 75,667
  completed and none failed. Nothing is in flight. Nothing was refused.
- For the next 75 seconds the storage estimate does not move by a single byte,
  while the watchdog thread, the page's timers and `page.evaluate` all keep
  running normally.

**So CheerpJ never issued an IndexedDB request for this write at all.** The
thread is not waiting on IndexedDB, or on the event loop, or on quota — it is
parked upstream of all of them, inside CheerpJ's own `/files/` implementation,
on a wakeup that is never delivered. That is the mechanism, and it is why wave
15 saw no exception: there is nothing to throw.

### Where the stalls land, and what that says

| run | entry the unpack died on | files |
| --- | --- | --- |
| exploratory run (pre-batch) | `res/quest/world/worlds.txt` | 14,594 |
| `before/run-06` | `res/quest/world/shandalar/duels/Undead Knight 4.dck` | 14,582 |

Both land in the same narrow band, inside
`res/quest/world/shandalar/duels/` — and both report the *same* last progress
line, `files=14500 bytes=52097292`, which is exactly the "identical offset"
wave 15 reported for two of its stalls. That band is not special in content;
it is special in **rate**. It is the fastest-writing region of the whole
archive: from the progress timings of a healthy run, entries 8,000–14,000 go by
at roughly 500 files per 0.3 s (≈1,700 files/second), against 500 files per
2–3 s in the regions with larger files. Thousands of tiny `.dck` files, each
one a `/app/` HTTP read followed by a `/files/` write, as fast as the loop can
issue them.

**A race that fires where the operation rate is highest is a race in the
issuing, not in the data.**

## The rate wave 15 reported is not the rate this host has

**Wave 15 measured 4 failures in 8 cold boots. This lane measured 1 in 20.**

```
label=before n=20 build=20260920T230700Z-ad44f7ee91
fix=off  (the original unpack path, line for line)
n=20  READY=19  k=1  failure rate=5%
load(1m) at run start: min 1.68  median 2.73  max 4.33
the one failure:  STALL in close-streams @files=14582
                  res/quest/world/shandalar/duels/Undead Knight 4.dck
successes: markerMs median 52.2 s, homeMs median 134.9 s
IDB aborts 0, errors 0, failed requests 0, unhandled rejections 0
```

The likeliest reason for the gap is in wave 15's own "what Phase 2 did NOT
verify": *"Four unrelated `ffmpeg` processes at 381 / 294 / 212 / 104 % CPU and
`/proc/loadavg` between 12 and 41.4 throughout."* This lane's batch ran at load
1.7–4.3. The stall is a scheduling race, and a host under 40× load schedules
very differently. **This lane did not test that explanation**, and deliberately
could not: a sibling lane was taking timing-sensitive browser measurements on
the same host throughout, and loading the machine to reproduce wave 15's
conditions would have destroyed its results.

### Why that makes a 20-run comparison nearly worthless, and what was done instead

At p = 0.05 per boot, a clean batch proves very little:

| n | P(0 failures | p = 0.05) |
| --- | --- |
| 20 | **0.358** |
| 40 | 0.129 |
| 60 | 0.046 |

**More than a third of all 20-run batches come back perfect with the bug fully
present.** Running the fixed build 20 times and seeing 20 successes would
therefore be a result that the *unfixed* build produces one time in three. The
brief asked for the arithmetic rather than a quietly shrunk `n`, so: a full
boot costs ~140 s, so 20 + 20 + 20 boots is ~2.3 hours, and getting the
per-boot comparison to real significance would need several hundred boots —
roughly a day of wall clock, which is not available and would monopolise the
host.

So the failure rate is also measured a second way, with the exposure raised
instead of the run count. The race is **per write operation**, and a full boot
spends 32 s unpacking and then ~100 s booting Forge. `spike.repeat=R` unpacks
the archive R times into R separate destination roots in one browser launch and
skips Forge entirely: **R times the exposure for about 1.3× the wall clock.**
At R = 5 the expected per-run failure probability rises from 5% to
1 − 0.95⁵ ≈ 23%, which a 20-run batch can actually resolve.

Both measurements are reported below. The per-boot one answers the done-when;
the per-unpack one is what the fix is actually tested against.

## The rates

**Read the third table first. The mutation test did not succeed.**

### 1. Before — the original unpacker, one cold boot per run

```sh
export SPIKE_CACHE=$HOME/.cache/w16a-boot PORT=8744 BOOT_FIX=off
scripts/spike/cheerpj/boot/run.sh batch 20 before
```

| | |
| --- | --- |
| n | **20 cold boots to Forge's home screen** |
| k | **1** (5%) |
| where it failed | `close-streams`, entry 14,582, `res/quest/world/shandalar/duels/Undead Knight 4.dck` |
| load (1 min, at run start) | min 1.68, median 2.73, max 4.33 |
| successes | `markerMs` median 52.2 s, `homeMs` median 134.9 s |
| IDB aborts / errors / failed requests / rejections | 0 / 0 / 0 / 0 |
| slowest single unpack call, successes | 90 ms (against a 75,000 ms stall threshold) |

### 2. After — the fix, 20 consecutive cold boots

```sh
export SPIKE_CACHE=$HOME/.cache/w16a-boot PORT=8746 BOOT_FIX=preload
scripts/spike/cheerpj/boot/run.sh batch 20 after-boot
```

| | |
| --- | --- |
| n | **20 cold boots** |
| k | **0** |
| READY | **20 / 20 reached the 800×600 document frame** |
| load (1 min, at run start) | min 2.76, median 3.76, **max 20.10** |
| `markerMs` (`Read cards:`) | min 51.4 s, median 53.1 s, max 94.7 s |
| `homeMs` (home screen up) | min 136.9 s, median 140.5 s, max 228.8 s |
| slowest single unpack call | 69 ms |
| IDB aborts / errors / failed requests / rejections | 0 / 0 / 0 / 0 |
| peak storage usage | 56.3 – 70.5 MB against a ~10.8 GB quota |
| `BOOT preload bytes=` present | **20 / 20** |

The done-when is met: **20 consecutive cold boots to Forge's home screen, no
retries, no exceptions.** Four of those ran while two other CheerpJ batches were
driving the same host, at loads up to 20.1 — which is wave 15's condition range,
and they still reached the home screen.

### 3. Reverted control — the same jar, the flag flipped back

This is the one that matters, and it is the one that did not work.

Both arms were run **concurrently**, on two ports out of one staged directory,
so they saw identical host conditions rather than being separated in time:

```sh
export SPIKE_CACHE=$HOME/.cache/w16a-boot BOOT_REPEAT=4
PORT=8744 BOOT_FIX=off     scripts/spike/cheerpj/boot/run.sh unpackrate 20 hp-off     &
PORT=8745 BOOT_FIX=preload scripts/spike/cheerpj/boot/run.sh unpackrate 20 hp-preload &
```

| arm | runs | unpacks | failures | load (1 min) | slowest single unpack call |
| --- | --- | --- | --- | --- | --- |
| `hp-off` — **fix reverted** | 10 | **40** | **0** | 2.7 – 17.7 | 141 ms |
| `hp-preload` — fix on | 10 | **40** | **0** | 2.7 – 18.6 | 426 ms |

Both arms: 0 IndexedDB aborts, 0 errors, 0 failed requests, 0 unhandled
rejections. Peak storage usage 227 MB against a ~11 GB quota.

**The reverted control did not reproduce the failure, so the fix has not been
demonstrated by rate.** That is the honest result and it should not be dressed
up. Pooling everything run today with the fix off — 20 single-boot runs plus 40
repeat-unpacks — gives **1 failure in 60 unpacks**, p̂ ≈ 0.017. Against that
rate, 40 clean unpacks is entirely unremarkable: P(0 | 40, p = 0.017) = 0.50.
The experiment had no power to detect anything.

The arms were stopped at 10 runs each rather than 20. The reason was wall clock,
not the result: three browsers contending drove host load to 14–20 and each
run past ~200 s, and both arms stood at 0 and 0, so continuing would have bought
40 more unpacks per arm — still nowhere near enough — at the cost of the
20-boot batch that answers the done-when. Both arms were stopped at the same n,
at the same moment, with the same score, so nothing about the stopping favours
either side.

**What it would actually take.** To show 0 failures is inconsistent with
p = 0.017 at 95% confidence needs 0.983ⁿ < 0.05, i.e. **n ≥ 175 unpacks in the
fixed arm**, and a control arm large enough to pin p down at all — call it 175
each. In repeat mode an unpack costs ~40 s on a quiet host, so that is roughly
4 hours of pure unpack time, ~6 hours with overhead, and it wants an idle
machine. That is one overnight run, and it is the experiment somebody should do
before anyone claims this is fixed.

<!-- RESULTS -->

## How the stall was caught, when wave 15 could not catch it

Wave 15's harness could tell that a boot had not reached `Read cards:` within
900 seconds. It could not tell where it stopped, because nothing in the Java
process printed anything between the 500-entry progress lines, and a dead
unpack and a slow one look identical from outside.

Three instruments closed that gap, all of them in this lane's own files:

**1. A watchdog thread inside the unpacker.**
`scripts/spike/cheerpj/boot/java/spike/Bootstrap.java` keeps a `volatile`
record of the phase it is in, the entry it is on, and when the current call
started; a daemon thread prints it every 5 seconds. When the transcript goes
silent, the watchdog does not — it keeps printing the *same* phase with a
growing `inCallMs`, which is what turns "it stopped" into "it stopped inside
this call".

This only works because **CheerpJ really does run a second Java thread here**,
which was not obvious in advance: the harness is served without cross-origin
isolation, so no `SharedArrayBuffer` thread pool is available. It works anyway,
and the watchdog's first line (`BOOT wd alive tick=5000ms`) is its own proof of
life, recorded per run as `watchdogAlive`.

**2. Storage and IndexedDB accounting in the page.**
`scripts/spike/cheerpj/boot/index.html` samples `navigator.storage.estimate()`
every 3 seconds, and — installed before any CheerpJ code runs — wraps
`IDBDatabase.prototype.transaction` to attach `abort`/`error` listeners, and
`IDBObjectStore.prototype.{put,get,add,delete,…}` to count every request and
match it against its `success`/`error` event.

That last piece is what separates the two candidate mechanisms, and it is the
whole reason the verdict above can say "lost wakeup" rather than "something in
IndexedDB":

| outstanding IDB requests at the stall | what it would mean |
| --- | --- |
| more than zero | a request *was* issued and its event never arrived — the loss is inside IndexedDB or the event loop |
| zero | CheerpJ never issued a request at all; the Java thread is parked upstream of IndexedDB, inside CheerpJ's own code |

**3. A stall detector that costs 75 seconds instead of 900.**
`boot.mjs` does not wait out a budget. It reads the watchdog's `inCallMs` and
calls a stall the moment a single unpack call has been running for longer than
`--stall`. The threshold is justified by measurement, not taste: across the
successful runs in this document **the slowest single call in the entire
32-second unpack was 44 ms**, so the 75,000 ms threshold sits about 1,700×
above the healthy maximum. Forge's own boot (`phase=forge`) is one reflective
call that legitimately runs for minutes, so it is timed by silence instead,
with its own much longer threshold.

The first version of this driver got this wrong in a way worth recording: it
watched *any* console output for liveness, and the quota sampler's own 3-second
tick kept that counter moving, so a boot whose unpack had been dead for 443
seconds ran out its full 480-second budget without ever being called a stall.
`index.html` now keeps a separate `progressSeq` that ignores the two
instruments' own heartbeats.

## Why this is a fork of lane B's `Bootstrap.java`

`scripts/spike/cheerpj/boot/java/spike/Bootstrap.java` is a copy of
`scripts/spike/cheerpj/assets/java/spike/Bootstrap.java` (wave 15, lane B),
not an edit of it. Three reasons, in order of weight:

1. **The control has to survive.** This lane's whole result is a *comparison*
   between the original unpacker and a changed one, at the same failure rate,
   on the same host, on the same day. Editing the original in place destroys
   the thing being compared against.
2. Lane B's file is the artifact wave 15 reported against, and
   `firstpaint/run.sh` compiles it **from its own source path** into lane D's
   jar. Changing it would silently change another lane's harness.
3. Three other sub-agents were live in this worktree while this ran.

The fork's write path with `-Dspike.bootFix=off` is the original's, line for
line; everything else added is instrumentation or a flag-gated branch. That is
what makes "revert the fix" a flag flip rather than a rebuild — the *same jar*
produces the fixed and the reverted behaviour, which also rules out a build
difference as the explanation for any change in rate.

## What is NOT the cause

Each of these was measured on this host, in these runs, not reasoned about:

| suspect | verdict | evidence |
| --- | --- | --- |
| IndexedDB **quota** | **not the cause** | quota 10.8 GB, peak usage 69.6 MB (0.6%); usage still climbing normally right up to the stall, then frozen |
| a **quota refusal being swallowed** | **not the cause** | 0 transaction aborts, 0 transaction errors, 0 failed requests across every run |
| a **rejected promise** nobody caught | **not the cause** | `unhandledrejection` is hooked and logged as a transcript line; 0 across every run |
| **one bad entry** in the archive | **not the cause** | the stall lands on `res/quest/world/worlds.txt`, a 7,638-byte text file with thousands of structurally identical siblings already written successfully; other runs stall elsewhere |
| CheerpJ **thread death** | **not the cause** | the watchdog thread keeps printing for the entire stall — CheerpJ's scheduler is alive and still switching threads |
| the **browser tab** dying | **not the cause** | the page's `setInterval` keeps firing and `page.evaluate` keeps answering throughout |
| **disk space** | **not the cause** | Playwright's profile lives on a 20 GB tmpfs with 6.1–7.3 GB free throughout; recorded per run in `env.start.tmp` |

**A note on wave 15's "identical offset" reasoning.** Wave 15 saw two stalls at
`files=14500 bytes=52097292` and concluded "two stalls halted at the identical
offset and a third did not, so it is not one bad entry in the archive". The
conclusion is right; the reasoning was not available to it. `files=14500` is
just the last *progress* line, printed every 500 entries — the run had gone on
past it. The stall in this document's first captured run was at entry
**14,594**, and its last progress line was the same `files=14500
bytes=52097292`. So those two wave-15 stalls may well have been at the same
entry after all, and the argument against a bad entry has to come from
somewhere else. It does: entry 14,594 is a 7.6 KB text file in a directory
whose other several hundred files were written without trouble moments earlier.

## The change, and why this one

`spike.bootFix=preload` reads the whole archive off `/app/` into the Java heap
*before* writing anything, and unpacks it from memory with a
`ZipInputStream` over a `ByteArrayInputStream`.

What that changes is not the writing. It is what the loop is interleaved with.
The original calls `zip.getInputStream(ze)` per entry on a `ZipFile` backed by
CheerpJ's **`/app/` HTTP mount**, so every one of the 15,685 iterations is a
read through CheerpJ's asynchronous file layer followed immediately by a write
through CheerpJ's asynchronous file layer, both resumed as continuations on the
same Java thread, as fast as the loop can issue them. `preload` deletes the
read half: one sequential pass up front, then a loop that touches exactly one
asynchronous subsystem.

```
BOOT preload bytes=50279251 ms=126
BOOT zip open ms=139 entries=(streamed) archiveBytes=50279251
BOOT unpack done files=15685 dirs=468 bytes=71226313 ms=30100
```

**It is also slightly faster** — 30.1 s against 32.4 s for the original on
comparable runs — and the preload itself costs 126 ms, because the archive is
already in the browser's cache by the time Java asks for it.

Those two lines are also the **proof that the changed path is the one that
ran**, which is the thing this project holds every lane to. `BOOT preload
bytes=…` and `entries=(streamed)` are printed only by the `preload` branch;
the original prints neither and reports `entries=16153` from `ZipFile.size()`
instead. Every run in the "after" table carries both markers, and every run in
the "before" and reverted tables carries neither. The build id in each run's
URL ties it to a source hash as well, but the transcript alone is decisive.

Two honest caveats, both of which the evidence in this document supports rather
than hides:

1. **This does not repair the CheerpJ defect.** The lost wakeup is inside a
   minified third-party runtime. What `preload` does is stop driving the thing
   that loses wakeups quite so hard. That is a real fix for this product's
   purposes and it is not the same claim as "the bug is gone".
2. **The network instrumentation complicates the story.** A full boot issues
   about **101 `fetch` calls in total**, not one per entry — CheerpJ reads
   `/app/` in large blocks, not per-read. So `preload` is not removing 15,685
   network round trips; it is removing 15,685 *calls into CheerpJ's file
   layer*, most of which were served from a block cache. If the race lives in
   that layer rather than in the network, that is still exactly the right
   thing to remove, but the mechanism is one level lower than "HTTP versus
   IndexedDB" and this document should not be read as claiming otherwise.

## A cheaper shape for the archive, which this lane did not take

The unpack writes **15,685 files**. Broken down by the `res/` subtree they come
from (`python3 -m zipfile -l`, or the script in this lane's notes):

| subtree | files | bytes |
| --- | --- | --- |
| `quest` | **9,557** | 7,521,277 |
| `conquest` | 1,434 | 1,083,780 |
| `formats` | 1,328 | 1,863,523 |
| `tokenscripts` | 848 | 149,434 |
| `geneticaidecks` | 786 | 552,604 |
| `editions` | 679 | 4,068,187 |
| everything else | 1,053 | 55,987,508 |

**`res/quest` is 61% of the file count and 11% of the bytes.** Wave 15 included
it for one reason, recorded in `docs/spikes/cheerpj-assets.md` §4: leaving it
out crashed `VSubmenuQuestStart.getStartingWorldName` with an NPE while the
home screen was being built. The file that method wants is
`res/quest/world/worlds.txt` — which is, with a straight face, the very entry
the stall in this document's first captured run died on.

If the failure rate is per-write-operation, shipping `worlds.txt` and the
handful of files around it instead of all 9,557 would remove most of the
exposure for 7.5 MB. **This lane did not do it**, deliberately: `res-boot.zip`
is built by `assets/run.sh cmd_bootzip` from its `BOOT_DIRS` list, which is
lane B's file, and changing the archive mid-experiment would have made the
before and after rates incomparable. It is the obvious next thing to try and it
is cheap. Note also that `BOOT_DIRS`' documented default does **not** list
`quest`, so whatever produced the staged `res-boot.zip` overrode it; the
archive and the script that claims to build it are already out of step.

## Reproducing it

Everything below runs from the repo root and writes only to
`~/.cache/w16a-boot`. Nothing builds Forge, nothing touches `forge/`.

```sh
export SPIKE_CACHE=$HOME/.cache/w16a-boot
export PORT=8744

scripts/spike/cheerpj/boot/run.sh build    # compile the fork, stamp a build id
scripts/spike/cheerpj/boot/run.sh stage    # snapshot wave 15's forge.jar + res-boot.zip

# one boot, JSON on stdout
scripts/spike/cheerpj/boot/run.sh boot --out /tmp/one.json

# the three batches in this document, exactly as they were run
BOOT_FIX=off     scripts/spike/cheerpj/boot/run.sh batch 20 before
PORT=8746 BOOT_FIX=preload scripts/spike/cheerpj/boot/run.sh batch 20 after-boot

BOOT_REPEAT=4 PORT=8744 BOOT_FIX=off     scripts/spike/cheerpj/boot/run.sh unpackrate 20 hp-off     &
BOOT_REPEAT=4 PORT=8745 BOOT_FIX=preload scripts/spike/cheerpj/boot/run.sh unpackrate 20 hp-preload &

# the tables
node scripts/spike/cheerpj/boot/tally.mjs \
    $SPIKE_CACHE/runs/before $SPIKE_CACHE/runs/after-boot \
    $SPIKE_CACHE/runs/hp-off $SPIKE_CACHE/runs/hp-preload
```

Each run's full JSON is kept under `$SPIKE_CACHE/runs/<label>/run-NN.json`,
with the transcript, the storage series, the IndexedDB counters and the host
load at both ends of the run. A rate with no per-run evidence behind it is a
number nobody can check.

**And the check that the changed code is the code that ran**, which costs one
grep:

```sh
for d in before hp-off hp-preload after-boot; do
  printf '%s: %s/%s runs contain "BOOT preload bytes="\n' "$d" \
    "$(grep -l 'BOOT preload bytes=' $SPIKE_CACHE/runs/$d/run-*.json | wc -l)" \
    "$(ls $SPIKE_CACHE/runs/$d/run-*.json | wc -l)"
done
# before:      0/20
# hp-off:      0/10
# hp-preload: 10/10
# after-boot: 20/20
```

The artifacts every number here is against, by hash:

| file | bytes | sha1 |
| --- | --- | --- |
| `forge.jar` (wave 15 lane D's patched build) | 39,686,585 | `5e484419a026dfb3d9ca1a675f2a36a1b01ff505` |
| `res-boot.zip` | 50,279,251 | `b6163869d22e12443f32561e4fe1a865d55f30a5` |

`run.sh stage` **snapshots** those into `$SPIKE_CACHE/frozen` and every run
stages from the snapshot. That is not tidiness. Lane D's cache was live while
this lane ran, and `w15d-firstpaint/www/forge.jar` changed size (39,686,585 →
39,686,151 bytes) between two `cp`s ninety seconds apart. A rate measured
across a moving jar is not a rate.

`run.sh stage` also reads the *jar* for the patch it depends on rather than
trusting a build log: `forge.view.FView` must contain no reference to
`VBazaarUI`, which is wave 15 lane D's patch and is what lets the home screen
finish building. Without it a boot reaches `Read cards:` and then dies, which
would look like success to a marker-only driver.

## The files

| path | what it is |
| --- | --- |
| `scripts/spike/cheerpj/boot/run.sh` | the driver: `build`, `stage`, `boot`, `batch`, `serve` |
| `scripts/spike/cheerpj/boot/java/spike/Bootstrap.java` | the fork of lane B's unpacker: watchdog, phase tracking, and the flag-gated fixes |
| `scripts/spike/cheerpj/boot/index.html` | the harness page: storage estimates, IndexedDB transaction and request hooks, network hook, capped transcript |
| `scripts/spike/cheerpj/boot/boot.mjs` | one cold boot, classified; phase-aware stall detection; home-screen gate |
| `scripts/spike/cheerpj/boot/tally.mjs` | a batch directory → the rate table in this document |

It reads `scripts/spike/cheerpj/serve.mjs` (Range support, without which CheerpJ
refuses to start) and writes to neither that file nor any other lane's.

## What I did NOT verify

- **That the fix addresses the cause rather than the exposure.** The mechanism
  is a lost wakeup inside CheerpJ, which is third-party and minified; nothing
  here patches it. `preload` removes one of the two asynchronous subsystems
  from the unpack loop, which is a change in *how the race is driven*, not a
  repair of the race. If the underlying defect is per-`/files/`-write rather
  than per-interleaving, this reduces the rate without eliminating the
  mechanism, and a large enough sample would still find stalls. Nothing here
  can rule that out — only a bigger `n` or a CheerpJ-side fix can.
- **Why wave 15 measured 4 failures in 8 and this lane measured 1 in 20.** Host
  load is the obvious candidate (12–41 then, 1.7–4.3 now) and it is untested,
  because testing it means loading the machine while a sibling lane takes
  timing measurements on it. Until someone does, treat both rates as
  conditional on load.
- **Whether this lane's own instrumentation changes the rate.** The fork adds a
  second Java thread that calls `Thread.sleep(5000)` in a loop, and under
  CheerpJ a sleeping thread is a yield to the event loop. A periodic yield is
  exactly the kind of thing that could perturb a scheduling race — possibly in
  the direction of making it rarer, which would partly explain the gap above.
  `BOOT_WDMS=0` disables the watchdog and exists precisely so somebody can test
  this; **this lane did not run that batch.** It would be the first thing to
  check before trusting the 5% figure.
- **Whether the quota sampler perturbs anything.** `navigator.storage.estimate()`
  every 3 s touches Chrome's quota manager while CheerpJ is writing to
  IndexedDB through it. Wave 15 had no such sampler and still stalled, so it is
  not *necessary* for the bug, but whether it changes the rate was not measured.
- **The repeated-unpack runs are not four independent cold unpacks.** Unpack
  time degrades badly as the store grows — 30 s, 29 s, 39 s, 72 s, 104 s across
  five repeats into one origin — so repeats 2+ write into a much larger
  IndexedDB than a real first visit ever would. Both arms get identical
  treatment so the *comparison* holds, but the per-unpack rate from those runs
  is not the same quantity as the per-cold-boot rate, and the two should not be
  pooled.
- **Nothing was tested in a real browser.** Every run here is headless
  Chromium driven by Playwright, with a fresh temp profile on a **tmpfs**. A
  persistent profile on a real disk has different IndexedDB behaviour and a
  different quota, and wave 15's finding that `--user-data-dir` did not make
  `/files/` survive between processes was not re-examined here.
- **The `res/quest` reduction was not tried.** 61% of the write operations are
  a subtree included to satisfy one NPE. Shrinking it is the cheapest available
  further reduction in exposure and this lane deliberately did not touch the
  archive, to keep the before and after rates comparable.
- **CheerpJ's own `dumpAllThreads` was wired up and never actually fired.** The
  runtime exports it (`cj3.js`: `dumpAllThreads=ah2`, re-exported by
  `loader.js` as `self.dumpAllThreads`), and `boot.mjs` now calls it once a
  stall verdict is in. But it was added *after* the before-batch, and no run
  since has stalled — so **there is not a single thread dump in any artifact
  here, and nothing is known about what it would have printed.** It is the
  cheapest next instrument for whoever runs the big batch: a Java-level stack
  for the parked thread would name the CheerpJ frame directly, instead of
  inferring it from "the call never returned and IndexedDB was never asked".
- **Whether `preload`'s 50 MB heap allocation is safe on a smaller device.**
  It holds the whole archive in the CheerpJ heap alongside everything else. It
  did not fail here, on a machine with a 1.4 GiB budget for the tab, and it was
  not tried anywhere tighter.
- **`flush` was implemented and never measured.** `spike.bootFix=flush` yields
  to the event loop every `spike.batch` entries and composes with `preload`.
  It is in the fork because it was the second candidate; no batch was run with
  it, so nothing is known about whether it helps, hurts or does nothing.

## The done-when is the home screen, not the card database

`Read cards:` is the last line Forge prints before it builds its home screen;
the home screen itself prints nothing. So a run counts as `READY` here only
when the marker has landed **and** the biggest canvas has reached the document
frame's size. Under CheerpJ every AWT top-level window is its own canvas, so
the 450×450 splash giving way to an 800×600 frame *is* the home screen
appearing — the same signal, for the same reason, as wave 15 lane D's
`awaitcanvas`. A run that gets the marker and then dies building a panel is
classified `NO-HOME`, not `READY`, and counts as a failure.

On a healthy run the two are about 80 seconds apart (`markerMs` ≈ 51 s,
`homeMs` ≈ 132 s), so this is not a formality.
