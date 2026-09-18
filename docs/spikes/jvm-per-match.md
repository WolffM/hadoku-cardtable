# O3 — one JVM per match, or one JVM hosting many?

Wave 9, lane D. O3 has been open since Wave 1 and deferred twice. Wave 6's spike
ran one server and one client in a single JVM, so the cost per match had never
been measured. This measures it.

Everything here is an overlay under `scripts/spike/jvm/`. No Maven ran and no
Java was written into `forge/`. The harness is compiled against a prebuilt fat
jar of our fork at `2ad70eb4` (sha256 `e0254a63…9e881f`), staged as a **copy** in
`~/.cache/cardtable-w9-d/forge`. The vendored submodule is pristine afterwards;
proof is in the last section.

## Answer

**One JVM per match. Keep a single warm spare so a new match does not wait
~3.4 s for startup. Put a `matchId` on every Node↔JVM message anyway**, so that
moving to "one JVM hosting many" later only changes the supervisor.

| # | Question | Answer (all **VERIFIED** here unless marked) |
| --- | --- | --- |
| 1 | Is loading the card DB a per-JVM cost or amortised? | **Per JVM, and in a shared JVM it is paid once.** A JVM is ready in **3.4 s** with **170 MB** of live heap before any match exists. Hosting 1, 2, 4 or 8 matches leaves that unchanged (3.3–3.9 s). N separate JVMs each pay it again, and when they start together they compete for CPU: the slowest of 8 is ready at **11.4 s** |
| 2 | What does the N-th match cost? | **Shared JVM: ~10 MB of live heap and ~27 MB of RSS per match.** **Separate JVMs: ~730 MB of RSS per match**, most of it the fixed ~650 MB an idle JVM already holds |
| 3 | Can one JVM host two matches through Forge's own network server? | **No.** The second match fails with `IllegalArgumentException: Hook previously registered` at `FServerManager.java:276`. `FServerManager` is a per-JVM singleton that holds one lobby. Upstream's own test suite spawns one JVM per networked game "to avoid the FServerManager singleton limitation" (`MultiProcessGameExecutor.java` javadoc) |
| 4 | Crash blast radius | **Shared JVM: SIGKILL takes every match (4 of 4 lost, 3 of 3 reps).** An OOM lands on a **random** subset of matches (0, 2 and 5 of 8 lost in three reps) and slows survivors by up to **~30×**. **Separate JVMs: SIGKILL of one leaves the other three finishing normally (3 of 3 reps)** |
| 5 | Does a long-lived shared JVM give finished matches back? | **Yes on the heap: no leak over 32 matches in 8 rounds** (live heap after release 172–191 MB, back to 172). **No on RSS:** G1 keeps what it has committed (RSS stays at 817–1021 MB) |
| 6 | Did heap settle, or just grow to `-Xmx`? | **Live heap settles** (182 MB with one match, 249 MB with eight). **Committed heap starts at the smaller of `-Xmx` and 994 MB** (G1's default initial heap, 1/64 of this host's 63 GB), and for that reason a 512m JVM commits all 512 MB from its first GC. That is the JVM's startup choice and does not come from the game. See §4 |

## 1. Headline numbers

Median [min–max] over 3 reps. Each rep is a fresh process, or N fresh
processes. The workload is complete AI-vs-AI Constructed games between two quest
precons (`Abzan Siege` vs `Air Forces`), run concurrently, one thread per match.
The JDK is Temurin 21.0.12.1 with G1. Host: 12 cores, 63 GB RAM, 26–27 GB
available, ~31 GB of swap already used by other things. The 1-minute load
average for every row is in its TSV and ranged from 4.7 to 25; lanes A and C
were running JVMs on this host at the same time.

**Shared** = one JVM with `-Xmx1g` hosting N matches. **Per-match** = N JVMs with
`-Xmx512m` and one match each, launched at the same moment; their figures are
**summed** (`many-SUM` rows). RSS and PSS are read from `/proc/<pid>/status`
(`VmRSS`/`VmHWM`) and `/proc/<pid>/smaps_rollup`, which measure what the host
actually pays. Heap figures come from the platform MXBeans, taken after a full GC.

| N | shape | ready (slowest JVM) | live heap, all matches held | **peak RSS (VmHWM)** | PSS, matches held | slowest match |
| -: | --- | --: | --: | --: | --: | --: |
| 1 | shared | 3.40 s [3.34–3.42] | 182 MB [180–182] | **800 MB** [782–813] | 778 MB | 1.8 s |
| 1 | per-match | 3.39 s [3.37–3.44] | 187 MB [182–187] | **731 MB** [725–749] | 733 MB | 2.2 s |
| 2 | shared | 3.94 s [3.32–4.13] | 201 MB [189–206] | **808 MB** [789–822] | 806 MB | 3.9 s [2.3–6.4] † |
| 2 | per-match | 4.09 s [3.89–4.15] | 366 MB | **1,443 MB** [1,442–1,458] | 1,429 MB | 2.7 s [2.5–4.2] |
| 4 | shared | 3.33 s [3.25–3.91] | 215 MB [208–217] | **916 MB** [842–949] | 915 MB | 4.5 s [3.3–5.0] |
| 4 | per-match | 6.04 s [5.94–6.07] | 726 MB | **2,850 MB** [2,847–2,896] | 2,789 MB | 5.2 s [4.8–7.9] |
| 8 | shared | 3.33 s [3.26–3.34] | 249 MB [245–253] | **992 MB** [898–1,030] | 976 MB | 5.0 s [4.1–5.3] |
| 8 | per-match | 11.40 s [11.20–11.43] | 1,461 MB | **5,839 MB** [5,821–5,892] | 5,707 MB | 11.4 s [11.3–12.0] |

† **Outlier, re-run.** Rep 1 of shared N=2 drew one long game (6.4 s, against
1.8–2.3 s elsewhere). Three more reps (`out/rerun/shared.tsv`) gave a slowest
match of 1.8–2.2 s, median 1.98 s, and a peak RSS of 777–792 MB. The memory
columns barely moved. Match duration varies with game length, which ranged from
12 to 61 turns across every run, so the duration column only indicates contention
and does not measure throughput.

### Marginal cost, from the rows above

- **One more match in a shared JVM:** (249 − 182) / 7 ≈ **9.6 MB of live heap**,
  and (992 − 800) / 7 ≈ **27 MB of peak RSS**.
- **One more JVM:** ~650 MB of RSS **before it plays anything** (idle
  651–661 MB) and **~730 MB at peak**. Idle PSS equals idle RSS to within 3 MB
  when a JVM runs alone and is ~21 MB lower each when 8 run together
  (5,041 against 5,210 MB summed; `pss_idle_mb` and `rss_idle_mb` in
  `out/many.tsv`). The page
  sharing between JVMs (libjvm, the CDS archive) is therefore small. The
  obvious lever for sharing more is AppCDS, and that was **not measured**.
- **The card DB:** 170 MB of live heap and **3.3 s of `FModel.initialize`**,
  identical in every JVM. The "33,752 scripts in ~1.6 s" figure from earlier
  waves times card reading alone. The whole `FModel.initialize` measured here
  (editions, formats, preferences, AI profiles) takes about twice that.
  `LOAD_CARD_SCRIPTS_LAZILY` was left at its default (**false**, printed on the
  RESULT line), which is the setting `DedicatedServer` uses too.

### The real entry point costs the same

`run.sh server-idle` starts **our fork's `forge server`** (`DedicatedServer`, the
process lane A would actually spawn), waits for `Dedicated server listening`,
runs `jcmd GC.run` and samples the process from outside:

| rep | listening after | RSS | PSS | live heap after GC | committed |
| -: | --: | --: | --: | --: | --: |
| 1 | 3.47 s | 670 MB | 667 MB | 172 MB | 512 MB |
| 2 | 3.36 s | 643 MB | 640 MB | 172 MB | 512 MB |
| 3 | 3.37 s | 642 MB | 639 MB | 173 MB | 512 MB |

These match `MatchLoad`'s idle figures (653 MB RSS, 170 MB heap). Netty plus an
empty lobby therefore add nothing measurable, and the headline table is a fair
proxy for the process lane A would run. Exit code 143 is the SIGTERM the script
sends. The raw `jcmd GC.heap_info` is in `out/server-idle-heap_info.txt`.

### Leaner per-match JVMs are possible, and cost match speed

Running the per-match shape with `-Xmx256m -XX:+UseSerialGC` (`out/lean/`,
re-run at low load in `out/rerun/many.tsv`):

| N | peak RSS (sum) | per JVM | slowest match |
| -: | --: | --: | --: |
| 4 | 1,834 MB [1,810–1,854]; re-run 1,812 MB [1,794–1,817] | ~455 MB | 25.8 s at load 16–23; **14.3 s [11.3–19.6] at load 5–6** |
| 8 | 3,681 MB [3,639–3,733] | ~460 MB | 30.5 s [20.3–48.5] |

RSS falls by a third, and the AI's turns become 3–6× slower because a 256 MB heap
holding a 170 MB card DB spends its time collecting garbage. Against human players
the extra delay would appear as "the opponent is thinking". Not worth it at our
scale. It is noted because it shows where the floor is.

## 2. How small can the heap be? (`out/floor.tsv`, 1 rep per cell)

This is a threshold search and was run once. The one cell that mattered, N=8 at
256m, is repeated three times as the OOM experiment in §3.

| `-Xmx` | N=1 | N=4 in one JVM | N=8 in one JVM |
| --: | --- | --- | --- |
| 1024m | ok | ok | ok |
| 768m | ok | ok | ok |
| 512m | ok | ok | ok |
| 384m | ok | ok | ok |
| 320m | ok | ok | ok (one match 32 s) |
| 256m | ok | ok, **but matches took 32 s and 71 s** | **one match `OutOfMemoryError`**, the other 7 finished in 4–39 s |

**One JVM can hold eight live matches in 384 MB of heap.** That is not the
problem with the shared shape. Its problems are §3 and the singleton.

## 3. Blast radius (`out/blast.tsv`, 3 reps each)

| experiment | what happened, per rep |
| --- | --- |
| `kill-shared 4`: SIGKILL the JVM hosting 4 matches, 0.3 s after they start | exit 137, **0 of 4 matches report**, all 3 reps. This is true by construction; it is measured so the table has both sides |
| `kill-many 4`: SIGKILL 1 of 4 one-match JVMs, 0.3 s after all have started | victim exit 137; **the other 3 finish normally with exit 0**, all 3 reps (`win@t12`…`t26`, 2.0–4.0 s) |
| `oom-shared 8 256m`: 8 matches in one JVM with too little heap, no `ExitOnOutOfMemoryError` | rep 1: **0 lost**, but survivors took 2.6–56 s. Rep 2: **2 lost** (`THREW:OutOfMemoryError`), survivors 2.6–**88 s**. Rep 3: **5 lost**, survivors 2.3–12 s |

The OOM result is the one reasoning would not have predicted. **An OOM in a
shared JVM does not stay in the match that caused it.** It lands in whichever
threads happen to be allocating, which is effectively random. Before it lands,
survivors slow by up to 30× while the collector thrashes. A
production shared JVM would run with `-XX:+ExitOnOutOfMemoryError`, which turns
this into the `kill-shared` row: every match is lost at once. With that flag set,
the experiment would have ended in the first rep, so it was measured without it
to show where the damage falls.

**What that costs at our scale.** For a handful of friends the realistic
concurrency is 1 or 2 matches and at most 4 (8 players). With the shared shape
and 2 matches, a crash loses 2 matches instead of 1, and the difference is one
extra group of people who have to restart a game. That by itself would not justify
eight times the memory. The argument for isolation at our scale is weaker than it
would be at 400 players, and this doc does not rest on it. The recommendation
rests on the singleton (§5) and on lifecycle: an exited process returns all of its
memory, which a shared JVM only does if nothing leaks. Isolation comes with that
choice at no extra cost.

**Not measured:** native JVM crashes, `StackOverflowError` from deep AI recursion,
and an AI that never returns. The last one matters. A shared JVM would lose one
core to a hung match until someone noticed, while a per-match JVM can be killed
by the supervisor on a wall-clock limit without touching any other match. That
is **ASSUMED**.

## 4. Does the heap settle? (`out/gc/*.txt`)

One GC log per configuration (rep 1), `-Xlog:gc`:

- **Live data settles.** Every `Pause Full (System.gc())` after the card DB
  loads reads `170M->170M`. After one match it reads `182M->182M`, and after
  eight concurrent matches `250M->172M` once they are released
  (`shared-n8-r1.txt`).
- **Committed heap does not track the game.** G1's initial heap on this host is
  **994M** (1/64 of RAM). A 512m JVM's log therefore reads `(512M)` on every line
  from GC(0) onwards: it committed its maximum at startup and never grew into it.
  A 1g JVM starts at `(994M)`, drops to `(584M)`/`(614M)` after the first full GC,
  and peaked at `(738M)` with eight matches. **Set `-Xms` explicitly in
  production** so that committed heap is a decision rather than 1/64 of whatever
  RAM the host happens to have. This is **ASSUMED** to lower idle RSS and was
  not measured.
- **Why `-Xmx512m` / `-Xmx1g`.** 512m is upstream's own setting for exactly this
  shape: `MultiProcessGameExecutor.java` passes `-Xmx512m` to each per-game JVM.
  It is also 2× the measured one-match floor (256m, §2). 1g for the shared JVM
  is 2.6× the measured N=8 floor (384m), so it never limited N≤8.
- **Rounds** (`out/rounds.tsv`): one JVM played 4 matches, released them,
  collected garbage, and repeated this 8 times, for 32 matches with 0 failures.
  Live heap after each release was `172,191,187,188,184,186,172,172` MB, so
  **there is no leak**. RSS after each release was
  `817,1021,995,946,958,971,996,893` MB. G1 does not hand memory back to the OS
  quickly, so a long-lived shared JVM sits near its high-water mark.

## 5. The singleton: "one JVM hosting many" is not available off the shelf

`run.sh singleton` runs two stock `UnifiedNetworkHarness` matches, 2 s apart, in
one JVM. It is the same harness Wave 7's `MatchPhase` used to prove a real
2-player match over a real socket. Result (`out/singleton.txt`, exit **3**):

```
FServerManager.getInstance() is one object for the whole JVM: true
-- match A --  port 50000  gameStarted=true   gameCompleted=true   turns=15  deltas=58
-- match B --  port 50010  gameStarted=false  gameCompleted=false  deltas=0
               errorMessage = Hook previously registered
  at java.lang.Runtime.addShutdownHook(Runtime.java:250)
  at forge.gamemodes.net.server.FServerManager.startServer(FServerManager.java:276)
```

The failure comes early. Even past the shutdown hook, `FServerManager` has one
`localLobby` field (`:154`, set by `setLobby` at `:496`), so a second lobby would
replace the first. **Forge's network server is one lobby, and therefore one
match, per JVM.** To host many matches in one JVM we would have to either change
the singleton in the fork, or bypass `FServerManager` and drive `Match`/`Game`
objects directly through a bridge of our own. The second option is what
`MatchLoad` does, minus the bridge. It shows the **engine** is happy to run 8
concurrent games in one JVM: 8 × 3 reps in the matrix, 32 more in `rounds`, and
the `floor` runs, with **no exception other than the deliberate OOMs**.

**ASSUMED, not verified:** that the engine stays that happy with human-driven
`PlayerController`s and per-client delta sync. Some static state is global per
JVM: `GuiBase.getInterface()`, `FModel`'s preferences, and `MyRandom`, which is
shared by all games and so makes seeded matches non-reproducible in a shared JVM.
None of it broke AI-vs-AI play. None of it was tested with a bridge.

## 6. Recommendation, and what it means for lane A

**One JVM per match**, spawned and owned by the Node server, **plus one warm
spare** that has already paid the 3.4 s startup and is waiting to be assigned.
Reasons, in order of weight:

1. **It is the shape Forge supports.** Forge's own network server cannot host a
   second match in the same JVM (§5, measured), and upstream's tests go one JVM
   per game for the same reason. The shared shape needs either a fork change to
   `FServerManager` or a bridge that bypasses it, and that is real work spent on
   saving memory we do not need to save.
2. **It is affordable at our scale.** 2 concurrent matches cost 1.4 GB, 4 cost
   2.85 GB and 8 cost 5.8 GB of peak RSS. The host has 26 GB available. Startup
   is 3.4 s against a 20–40-minute match, and the warm spare hides it.
3. **Lifecycle is free.** When a match ends the process exits, every byte comes
   back, and no correctness depends on "nothing leaks" (true today per §4, which
   is not the same as true forever). A hung or runaway match is `kill -9` with no
   collateral damage (§3, measured).

**Revisit** if concurrency regularly goes above ~8 matches, or if the host
becomes memory-constrained. Then the data points to **one JVM per *group* of
matches, driven by our own bridge**: ~27 MB of RSS per extra match, bounded blast
radius, one card DB per group. The measured costs of that shape are in §1. It
would not be "one JVM for everything".

**The interface consequence for lane A.** *Per-match (recommended):* the Node
server is a **process supervisor**. `startMatch` takes a JVM (the warm spare, or a
new spawn with a ready timeout of **~5 s for one and ~12 s when 8 start at
once**), gives it a transport of its own (stdio is simplest: no port to allocate
or guard; otherwise a per-process port), and records `matchId → pid`. The process
exiting means the match is over. A non-zero exit becomes an "aborted" event for
that room only. Closing a room is `SIGTERM`, then `SIGKILL`. No multiplexing is
needed on the wire, **but put `matchId` on every message anyway**. *Shared, if we
ever switch:* one long-lived child with a `createMatch`/`destroyMatch` RPC, and
every message **must** carry `matchId` because one channel carries every match.
The JVM's exit fans out to an abort for **every** room it hosted, it needs health
checks and restart, and it cannot use `forge server`/`FServerManager` at all. It
has to be our own bridge driving `Game` objects. If lane A builds the per-match
supervisor with `matchId` already on the wire, switching later only changes the
supervisor and leaves the protocol alone.

## Verified vs assumed

- **VERIFIED (W9 D):** every number in §1–§5, from the committed TSVs and
  transcripts under `scripts/spike/jvm/out/`. The `FServerManager` singleton
  failure and its line (`FServerManager.java:276`, fork `2ad70eb4`). Card-DB
  cost is per JVM and flat across N in a shared JVM. No heap leak over 32
  matches. SIGKILL isolation between JVMs. Random-victim OOM in a shared JVM.
  `forge server` idle footprint equals `MatchLoad`'s idle footprint.
- **ASSUMED / NOT MEASURED:**
  - **AI-vs-AI stands in for a human match.** A real match lasts 20–40 minutes
    and is mostly idle. The memory of a finished game held live is used as a
    proxy for a mid-game one.
  - Per-client `DeltaSyncManager` state was not in `MatchLoad`. The networked
    shape was measured idle (`server-idle`) and was not measured mid-match.
  - Only two precon decks were used. A cube deck's card pool is different but
    uses the same card DB.
  - Native crashes, `StackOverflowError` and hung-AI blast radius.
  - AppCDS, CRaC and `-Xms` tuning to cut per-JVM RSS or startup.
  - Human `PlayerController`s in a shared JVM (§5).
  - Timings ran under load from other lanes (1-min load 4.7–25). Memory figures
    varied by ≤ 5% between reps. Durations did not, which is why no conclusion
    here rests on them.

## Reproducing every number

```sh
export FORGE_DIR=~/.cache/cardtable-w9-d/forge          # a COPY; the guard refuses forge/
scripts/spike/jvm/run.sh stage          # cp -a jar + test-classes + res from ~/.cache/cardtable-w8/forge-build
scripts/spike/jvm/run.sh matrix         # §1: shared and per-match, N=1 2 4 8, 3 reps -> out/shared.tsv, out/many.tsv, out/gc/
OUT_DIR=scripts/spike/jvm/out/rerun scripts/spike/jvm/run.sh shared 2 3             # § 1 outlier re-run
OUT_DIR=scripts/spike/jvm/out/lean  XMX_ONE=256m JVM_FLAGS=-XX:+UseSerialGC \
  scripts/spike/jvm/run.sh many 4 3     # §1 lean (and `many 8 3`; re-run of 4 into out/rerun)
scripts/spike/jvm/run.sh server-idle 3  # §1 `forge server` idle footprint
scripts/spike/jvm/run.sh floor          # §2
scripts/spike/jvm/run.sh kill-shared 4 <rep>; scripts/spike/jvm/run.sh kill-many 4 <rep>
scripts/spike/jvm/run.sh oom-shared 8 256m <rep>                                     # §3, reps 1..3
scripts/spike/jvm/run.sh rounds         # §4
scripts/spike/jvm/run.sh singleton      # §5
scripts/spike/jvm/run.sh guard-test     # below
scripts/spike/jvm/run.sh verify-pristine
```

`floor.tsv` was produced by `run.sh floor` with `OUT_DIR` pointing at scratch,
then copied into `out/`. The code path is the committed one.

Two operational notes. **Do not run two `run.sh` invocations at once**: each
recompiles into the shared `WORK_DIR/classes`. **Do not edit `run.sh` while it
runs**: bash reads scripts incrementally. The `matrix` run above ended
`exit=2` on a syntax error at its last line because `run.sh` was edited (in
`do_guard_test` only) while it was running. Every row it wrote came from code
that edit did not touch, and every per-run exit code in those rows is 0. The
exit 2 is recorded here so the transcript's reading and this doc agree.

## `forge/` stayed pristine, and the guard refuses it

`run.sh guard-test` points `FORGE_DIR` at the vendored tree under four spellings:
the worktree path, its `pwd -P` resolution, `forge/../forge`, and **a symlink to
it**, which is the spelling that got through on 2026-09-16. It runs two modes
under each spelling (`stage`, and `shared`, which would compile and run). Each
must exit **2** *and* print the guard's own `Refusing: it must stay pristine`,
so an exit 2 for any other reason does not count
(`out/guard-test.txt`, abridged: the file has one line per invocation):

```
8 of 8 invocations -> exit=2 refused-by-guard=yes
target/ dirs in vendored forge/: before=0 after=0
forge/ pristine: 0 tracked changes, 0 target/ dirs (both checked).
forge/ HEAD 2ad70eb447a22efe5b80904c07188311da034a42
guard-test exit=0
```

The guard stops before anything runs: no `cp`, no `javac`, no `java`. So the test
cannot damage the tree it protects.
