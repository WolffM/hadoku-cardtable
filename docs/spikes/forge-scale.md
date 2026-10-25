# Forge at scale — what a claw can host

Lane stress, 2026-10-25 (04:49–07:40Z). This executes
`docs/planning/forge-hosting-plan.md` §3: many matches in one JVM, on the
claws, with cube decks and a human-paced seat. **VERIFIED** means a TSV row
under `docs/spikes/forge-scale/` (named inline) or a command says so.
**ASSUMED** means it does not.

## Answer

**At the operator's 50% rule, one claw-8 hosts 256 vs-AI matches or 256+
human-vs-human matches in one JVM.** The 100-match goal fits on claw-8
alone, or on claw-9 plus any one capped claw. Memory is ~6.5 MB of live heap
per vs-AI match and ~3.5 MB per human-vs-human match, on top of a ~180 MB
card DB. CPU is ~0.5–1 CPU-second per match-minute. Before CPU runs out,
**GC and the AI's unguarded code paths are what break first**.

### Knee and recommended cap, per claw × tier

"Struggling" uses the operator's criteria. **Lag** is act p95 > 250 ms or
act p99 > 500 ms. `act` is the engine time from a paced seat's action to the
next decision anyone is asked for (click → next state ready). **AI** means any
`AI eval thread at timeout:` cutoff, or AI priority-decision p95 above 2× its
baseline. The baseline is the lowest paced N measured on the same claw and
cap. **Knee** is the first N where a criterion trips. **Cap** is about half
of it (the operator's 50% rule), at or below an N that measured clean.
N doubles between points, so a knee is "somewhere in (previous N, this N]".

| claw | run as | vs-AI knee | trips first | **vs-AI cap** | human-vs-human knee | trips first | **h-v-h cap** |
| --- | --- | --: | --- | --: | --: | --- | --: |
| claw-8 (i7-9700F, 8c) | **leased, full box** | 512 | all at once: AI p95 184×, 8 cutoffs, act p99 833 ms; GC 35% | **256** | not reached at 512 (act p99 20 ms) | — | **≥ 256** |
| claw-9 (i7-5930K, 6c/12t) | **leased, full box** | 256 (marginal) / 512 | AI p95: 1.93× at 256, 29× + 4–19 cutoffs at 512; act never tripped | **128** | not reached at 512 (act p99 21 ms) | — | **≥ 256** |
| claw-4 (i7-6700, 4c/8t) | capped 2 CPUs / 1.5 GB, CI active | 96 | AI p95 8.2× (act and cutoffs clean) | **48** (24/CPU) | not reached at 100 (act p99 21 ms) | — | **≥ 50** (25/CPU) |
| claw-5 (FX-8350, 8c) | capped 2 CPUs / 1.5 GB, CI mostly idle | 64 | all at once: AI p95 5.9×, 1 cutoff, act p95 282 / p99 716 ms | **32** (16/CPU) | 100 | lag: act p99 2.3 s | **50** (25/CPU) |
| claw-6 | — | not measured: no JDK 21 on it | | | | | |

Rows: vs-AI `claw-8-t1full.tsv`, `claw-9-ramp.tsv` + `claw-9-t1full.c83.tsv`,
`claw-4-ramp.c83.tsv`, `claw-5-ramp.c83.tsv`. Human-vs-human: the `hvh-*`
rows in `claw-{8,9}-ramp.tsv` and `claw-{4,5}-ramp.c83.tsv`. Cutoffs counted
before the deadline: `predeadline.tsv`. All VERIFIED.

- **The capped claws are per-CPU figures**, and they are pessimistic.
  `AllowedCPUs` took the two highest-numbered logical CPUs. On 4c/8t claw-4
  those are hyperthread siblings of cores CI was using (load 2.4–18 during
  its rows). Full box, claw-4 (4 cores / 8 threads) would be ~2–4× its
  capped figures and claw-5 (8 cores) ~4×. **ASSUMED**: not run, no lease on those claws.
- **claw-9's 256 is "marginal"**: AI p95 17.2 ms against an 8.9 ms baseline
  is 1.93×, inside 10% of the line. Quality first: its cap is half of 256.
- **Human-vs-human never found a knee on the leased claws.** At N=512, claw-8
  used 1.4 cores and claw-9 1.7, with act p99 ≤ 21 ms. The ceiling there is
  memory and threads (each match is a game thread here), not CPU. Neither was
  pushed past 512 within the lease.

### Matches per GB and per core

| tier | live heap per match | idle JVM | CPU-s per match-minute | rows |
| --- | --: | --: | --: | --- |
| vs-AI (paced human vs AI) | **5.4–6.8 MB** (claw-4 5.4–5.9, claw-5 5.5–5.9, claw-8 6.5–6.7, claw-9 5.6–6.6) | ~180 MB live, ~600 MB RSS | **0.5–1.0** on claw-4/8/9; 1.75–3.2 on claw-5 | `claw-*-ramp*.tsv`, `claw-8-t1full.tsv` |
| human-vs-human | **3.2–3.5 MB** | same | 0.3–0.5 on claw-4/8/9; 0.85–1.3 on claw-5 (upper bound, below) | `hvh-*` rows |

- Heap is live heap after a full GC: `(live − idle) / N`, sampled every 60 s
  mid-run. **VERIFIED**. RSS follows `-Xmx`, not need: G1 grows into whatever
  it is given (claw-9, N=512 vs-AI: 3.0 GB live, 15.2 GB RSS under a 25 GB
  `-Xmx`). The capped runs show what fits: **96 vs-AI or 100 human-vs-human
  matches in a 1.5 GB cgroup with `-Xmx1000m`, RSS 1.24–1.27 GB.** Sizing
  rule, ASSUMED: `-Xmx ≈ 2 × (180 MB + 6.5 MB × N)`, which keeps G1 below the
  35% GC seen at 3.6 GB live in an 11.8 GB heap. So ~70–80 vs-AI matches per
  GB of RSS at N≈100, and better at larger N as the fixed ~600 MB amortises.
- CPU per match-minute is **an upper bound for real play**. The paced seat
  waits 2–15 s per decision a human makes, so matches ran 5.3–8.6 min median
  (17–25 turns), against 20–40 min real. Its choices are computed by Forge's
  AI, which a human's are not (`paced_compute_s` is 24–42% of total AI
  compute). Human-vs-human here is two AI-brained paced seats. **ASSUMED**:
  real matches cost less per minute.

### RAM speed (claw-5): VERIFIED it does not cost extra

Forge throughput at one CPU, full-speed AI-vs-AI: AI decisions per
CPU-second (`claw-*-t9s.tsv`, one 180 s run each, G1). That is compared with
the sha512 single-core ratio, both relative to claw-8:

| claw | dec/CPU-s | Forge vs claw-8 | sha512 vs claw-8 | Forge ÷ sha512 | STREAM GB/s | load during run |
| --- | --: | --: | --: | --: | --: | --- |
| claw-8 | 88.9 | 1.00 | 1.00 | 1.00 | 14.8 | leased, 0 runners |
| claw-4 | 62.6 | 0.70 | 0.83 | 0.85 | 16.2 | 1 runner, load 3–6.8 |
| claw-9 | 47.8 | 0.54 | 0.63 | 0.85 | 13.8 | leased, 0 runners |
| claw-3 | 25.2 | 0.28 | 0.69 | 0.41 | 16.9 | 1 runner, 2c/4t laptop part |
| **claw-5** | 21.1 | 0.24 | 0.21 | **1.11** | **4.9** | 0 runners |

**claw-5 does not underperform its sha512 ratio. It beats it by more than any
other claw does.** At density it also holds up relatively better: its capped
vs-AI knee (64) is 0.67× claw-4's (96), against a single-core ratio of
0.34×. So DDR3-800 is not a measurable extra cost to Forge; the FX-8350's
weak cores are. One run per claw, so ±15% noise is ASSUMED. claw-3's 0.41 is
its CI neighbour and laptop part, and claw-3 is out of the host pool anyway.

### GPU

None needed. Prod's bridge JVMs run with `-Djava.awt.headless=true`
(`/proc/<pid>/cmdline` of the live spares, VERIFIED), and so did every run
here, on claws with no display. Headless Forge renders nothing.

## What else was found

1. **The 5 s AI cutoff guards one loop; the rest of the AI has no limit.**
   `AiController.java:1686` puts `future.get(game.getAITimeout())` around the
   canPlay scan in `chooseSpellAbilityToPlayFromList` only. Declare-attackers,
   blocks and everything around that scan run unguarded. On a stalled
   24-creature board (Card-Forge/forge#3410's shape, `heavyBoard()` in the
   harness), declare-attackers took **9.9–15.9 s with zero cutoffs**
   (`claw-4-t4*.tsv`, heavy_combat columns). The harness watchdog sampled 78
   stalls past 3 s inside `AiAttackController.declareAttackers` at claw-8
   N=512 (`claw-8-t1full.tsv`, slow_frames). **A player waiting on the AI is
   not bounded by 5 s.**
2. **A cut-off eval thread keeps running.** `AiController.java:1711` calls
   `t.stop()`, which throws on Java 20+ and is caught, so the thread runs on
   ("sadly thread will keep running", in Forge's own comment). Under GC
   thrash these piled up: 0 → 12 live `Game AI Eval` threads in the 30 s
   before OOM (`claw-8-t6.tsv` run series).
3. **At high density GC limits first, not CPU.** claw-8 at N=512 vs-AI used
   4.4 of 8 cores, with GC at 35.5% of wall time, AI p95 1.1 s and 8 cutoffs.
   At N=256: 2.3 cores, GC 14.9%, everything clean. claw-9 at 512: 5.2 of 12
   cores, GC 25%. Forge allocates heavily per decision. The harness doubles
   the thread count (one sleeping cap timer per match), which adds GC root
   scanning, so production may fare slightly better. ASSUMED.
4. **The JVM silently picks SerialGC in a small cgroup.** Under 2 CPUs / 1.5 GB
   (below the server-class 1792 MB line) every capped run reported
   `gc=Copy+MarkSweepCompact`. At N=128 on claw-8, Serial cost 15.5% GC and
   tail decisions of 23 s, against G1's 3.5% (`claw-8-t7.tsv`). **A host agent
   that sizes JVM cgroups under ~1.8 GB must pass `-XX:+UseG1GC`.**
5. **Forge decides "game thread" by thread name.** `ThreadUtil.isGameThread()`
   is `getName().startsWith("Game")` (`ThreadUtil.java:51-52`), and
   `GameAction.invoke` (`GameAction.java:2508`) runs inline only on such a
   thread. Elsewhere it hands the work to Forge's own pool and races the game
   loop. In the first heavy-board run, 325 of 390 games died of
   `ConcurrentModificationException` from this. Our multi-match bridge must run each
   match's loop on a thread named `Game…`.
6. **An OOM gives ~30 s of visible degradation, then takes every match.**
   T6: 64 paced matches in a 400 MB heap. Live heap reached 376 MB at ~110 s.
   CPU went from ~1 core to 6.3, cutoffs appeared (8), and the decision rate
   fell ~4×. Then `Terminating due to java.lang.OutOfMemoryError` and exit 3
   at ~140 s: **64 of 64 matches lost**, exit instant once thrown
   (`claw-8-t6.tsv`, `predeadline.tsv`). A host agent can alert on the CPU
   spike and cutoffs before the process dies.
7. **A bad neighbour did not hurt the others** (T4, capped claw-4, Serial GC).
   16 paced matches had AI p95 11.7 ms and act p99 27 ms. The same 16 beside
   one heavy-board slot: 13.1 ms and 42 ms, no cutoffs. The heavy slot burned
   ~1 core on its own (`claw-4-t4c.tsv`). The full-box T4 was dropped to free
   claw-9 sooner.
8. **GC choice** (T7, claw-8, N=128 paced, 8 CPUs): G1 3.5% GC, AI max
   17.3 s. Serial 15.5%, max 23.4 s. Generational ZGC had the best tail (max
   0.98 s) but held 2.7–3.0 GB "live" and **12 GB RSS** against G1's 1.0 GB /
   5.1 GB. ZGC's collection time counts concurrent cycles, so its 15.8% is not
   comparable with G1's pauses. **G1 is the choice for density.** AppCDS and
   Java 25 were not tried.

## Full-speed AI-vs-AI (T2, T9)

Bots playing each other without pauses. Not a real match: a cube game
finishes in ~3 s (17 turns). Each one saturates whatever CPU it gets, so
the knee is about **one match per CPU**. On claw-9, AI p95 doubled at 2
matches/CPU with 1–2 CPUs (`claw-9-t2.tsv`) and cutoffs appeared from 1/CPU
at 6–12 CPUs (`claw-9-t2full*.tsv`, `predeadline.tsv`). GC ran 11–34%. An
AI-vs-AI exhibition match costs a whole core while it runs.

## Method

- **Harness**: `scripts/stress/src/ForgeScale.java`, one JVM, N slots, each
  playing matches back to back for `durationSec` through `Match.startGame`
  (no `FServerManager`, no test-classes: `forge.GuiDesktop` as
  `PoolService.java` uses it). Prod's pinned fat jar `c8370109…`, Temurin
  21.0.12.1, the res tree of the deploy tree minus adventure/music/skins.
- **Decks**: 16 legal 40-card decks built once with seed 20261024 from the
  default cube (`mtgo-vintage-cube-2025-04`, 540 cards, 0 missing in Forge)
  by Forge's `SealedDeckBuilder`, committed as `scripts/stress/decks/*.dck`.
  Every claw played the same decks. Play itself is not reproducible:
  `MyRandom` is one static for the JVM (`MyRandom.java:34`), and AI threads
  race.
- **Paced seat**: an AI controller that waits uniform 2–15 s before an action,
  its own main-phase pass, attacks and blocks, and passes instantly otherwise.
  The vs-AI tier is one paced seat against a full-speed AI. Human-vs-human is
  two paced seats.
- **Metrics** (one TSV row per run, with the claw's Runner.Worker count, load
  and MemAvailable before and after): AI priority-decision latency, cutoffs
  counted from Forge's own stdout line, act latency, decisions over 5 s with
  the stalled frames, CPU from the process, GC from the MXBeans, live heap
  after a forced full GC each 60 s, peak RSS/PSS, threads.
- **Not measured as load**: measurements spanning one of the harness's own
  forced GCs (`dropped_spanning_gc`), and anything after the deadline.
- **Caps**: until the lease (04:57:48Z, claw-8/9 only), claw-9 ran at ≤ 4 CPUs
  / 6 GB and the rest at 2 CPUs / 1.5 GB in a `systemd-run --user --scope`.
  After it, claw-8/9 ran full box. claw-3/4/5 stayed capped throughout.
- `scripts/stress/run.sh` stages and runs one capped JVM on a claw.
  `suite.sh` holds the T-suites, `t0-sample.sh` is T0, and `predeadline.py`,
  `t0-summary.py` and `tables.py` read the outputs.

### Reading the TSVs: harness generations

Column count tells which build wrote a row. Use **83-column** files for
latency, cutoffs and act. Older rows are sound for CPU, heap and RSS.

| cols | build | caveat |
| --: | --- | --- |
| 71 / 78 / 79 | first | cutoffs and >5 s decisions include the end-of-run teardown; `predeadline.tsv` has the real counts (all 0 for paced runs) |
| 82 | + watchdog | same teardown caveat; act p99 can include a forced GC (claw-5 forced GCs ran 1.6 s) |
| 83 | + teardown gate, GC epoch | clean |
| 18 | no RESULT | killed by `timeout(1)` in teardown (claw-5 N=96, claw-9 N=512); read the run's state at the deadline from `predeadline.tsv` |

Three harness bugs were found and fixed mid-lane, each from a TSV that did
not add up. (a) `GameAction.invoke` off a `Game…` thread (finding 5).
(b) The teardown: ending every game at once made paced seats stop pausing,
so all games raced at full speed, burning ~7 cores and printing cutoffs
after the deadline. (c) Forced full GCs inflated act p99. Re-runs replaced
every vs-AI point used in the table.

## T0: real prod matches — not measured

T0 sampled every non-spare PlayBridge JVM on hokon every 30 s from 04:50Z
(`/proc` and `jstat` only, no attach, no GC, no fifo reads). **No prod match
ran during the session.** Every sampled JVM was a lane or e2e JVM
(`t0-sample.tsv`, `kind=other`). The one long-lived one idled at 0.10
CPU-s/min with 179–197 MB old gen (`t0-summary.tsv`). The real per-match
profile is still open. Rerun `t0-sample.sh` during an evening's play.

## Not done

- **T3 held an hour**: ran 15 min per mix at N=128 on claw-8: 30/60/100%
  vs-AI, all clean (AI p95 7.0/7.2/6.6 ms, 0 cutoffs before the deadline).
  `claw-8-t3*.tsv`, but only the 100% row is 83-column.
- **T5 soak, T8 resurrection**: out of scope for a 4 h lease.
- **T6 hung AI and stack overflow**: not provoked. The heavy board's 10–16 s
  declare-attackers is the nearest measured case.
- **Full-box claw-4/5 and anything on claw-6**: no lease, and claw-6 has no JDK 21.
- **hokon**: no load runs, per the brief; the claw comparison uses sha512.
