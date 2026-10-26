# Performance catalogue

Every performance issue found, with its evidence, so it can be picked up as
work. The operator, 2026-10-25: *"if you find perf issues along the way and
places for us to optimize that'd be good to catalogue as well. i'll give perf
issues to another session."*

A row is a measured finding, not a guess: it names the evidence. Impact is
what a player feels, or what hosting costs. Whoever fixes a row moves it to
"Done" with the commit.

## Open

| id | area | finding | evidence | impact | notes |
| --- | --- | --- | --- | --- | --- |
| P2 | Forge AI | A cut-off AI eval thread keeps running: `AiController.java:1711` calls `t.stop()`, a no-op on Java 20+. Under GC thrash they piled up 0 → 12. | forge-scale.md, surprise 2 | high under load: dead threads burn the CPU live matches need | fork change; test B5 in `hosting-test-plan.md`. **Pin `9e5f5b75` fixes the normal-load case**: its cooperative cancel (`future.cancel(true)` + `join(2000)`, `AiController.java:1701-1703`) held live eval threads at 1–3 through 72,055 forced cutoffs (`hosting-tests/b5.tsv`). Still open under heap starvation: 19–26 live (P14). Fork `5eff8436` adds one more exit: a cut-off eval thread whose game has ended now unwinds at the scan's next card and at every block assignment it predicts (`Game.throwIfOver`); `t.stop()` is still a no-op, so a cut-off thread in a live game still runs to the end of its current evaluation. |
| P3 | Forge JVM | In a cgroup under ~1.8 GB the JVM silently picks SerialGC: 15.5 % GC against G1's 3.5 %. | forge-scale.md, surprise 4 | medium: every match in a small slice | launch flag `-XX:+UseG1GC` in the host agent |
| P4 | Forge JVM | At high density GC runs out before CPU: claw-8 at 512 matches, 35 % GC with only 4.4 of 8 cores busy. | forge-scale.md, surprise 3 | low at our target (≤100) | heap sizing; ZGC had the best tail but 12 GB RSS vs G1's 5.1 GB |
| P5 | Forge AI | The attack pool is a fixed pool of `availableProcessors()` per declare-attackers (`AiAttackController.java:876`); a JVM cannot read a nested cgroup's quota. | forge-hosting-plan.md §2; fleet-manager §3 reply | medium: oversubscribes a slice | launch flag `-XX:ActiveProcessorCount=<cores>` |
| P6 | Forge JVM | Card database init: 3.3 s and 170 MB per JVM. | `docs/spikes/jvm-per-match.md` | low once JVMs are long-lived; it is the cold-start cost of a new JVM (failover target, scale-up) | AppCDS untested (T7) |
| P7 | hosting | Today every match is its own JVM: ~750 MB each, idle spare 784 MB. | forge-hosting-plan.md §2 | high: the reason hosting is capped at 10 | superseded by many matches per JVM (lane-multimatch) |
| P8 | browser | The stack's resolve animation forces layout reads once per packet (`live/departures.ts:516`, `live/numbers.ts:967`, `motion.ts:257`): ~85 ms per 6 s crowded at 4× CPU after the `:has` fix. | `docs/spikes/browser-fps.md`; re-trace 2026-10-25 | low: already batched, one read per packet | a rewrite would compute positions without the DOM; high risk |
| P9 | browser | Flyers restyle every frame in headless software-rendered Chromium (737 ms per 6 s at 1×; the huge board idles at 30 fps at 6×). A plain `transform` animation does the same there, so this may be the test environment. | browser-fps.md | unknown until profiled on a GPU browser | needs a DevTools profile on the operator's machine |
| P10 | browser | Flyer pinning still forces a style read when an attack adds a part to a flyer: ~28 ms per 6 s crowded at 4×. | re-trace 2026-10-25 | low | genuinely needed for the part's clock |
| P12 | CI | A forge.yml job that overflows to `jit-hokon` runs `forge-bundle.sh`, which compiles the pin's Forge with mvn on hokon (119 s for 7878fe75) — the build the "no builds on hokon under CI" rule exists to prevent, here on the prod host. | lane-rng report 2026-10-26, run 40280573266 | medium: slows prod and every hokon job for ~2 min per new pin | prebuild a pin's bundle on a claw before dispatch, or keep forge.yml off hokon |
| P11 | host | hokon carries 43 GB of swap; an Android emulator (`-avd spike`) held 17 GB RSS for 3+ days. | 2026-10-25 observation | medium: the CI backstop refused hokon on memory | not cardtable's; whoever owns the emulator |
| P13 | Forge JVM | Running out of heap is a ~2 min death spiral before the JVM exits: 4 CPUs, 64 matches in 400 MB, live heap full at 111 s, then ~94 % GC (`gc_ms` 16 → 126 s) until `-XX:+ExitOnOutOfMemoryError` fired at ~227 s. On 8 CPUs T6 took 30 s. | `docs/spikes/hosting-tests/series/claw-8-b4-exit-n64-400m.tsv`; hosting-test-plan H7 | high when it happens: every match in the JVM frozen for minutes, then all lost; and a pause over 45 s wedges loopback clients (H3) | a live-heap-after-GC watchdog that stops admitting and drains at ~85 % of `-Xmx`; the exit flag on every bridge JVM |
| P14 | Forge AI | Heap starvation re-grows the AI eval-thread pile even with the pin's cooperative cancel: 19 and 26 live `Game AI Eval` threads in B4's runs, against 1–3 under 72k cutoffs at normal load. | `hosting-tests/b4.c97.tsv` (`eval_threads_peak`), `series/claw-8-b4-exit-n64-400m.tsv` | low on its own: it only happens past the point P12 is already fatal | follows P13's fix |
| P15 | Forge AI | A spinning AI thread (an infinite loop no interrupt reaches) costs one full core for the life of the JVM: 234.7 CPU-s in a 240 s run; nothing short of ending the JVM returns it. | `hosting-tests/b2.tsv` (`b2-spin-n16`, `fault_threads_cpu_s`), H6 | medium: one core per incident, cumulative in a long-lived shared JVM | recycle a JVM (drain its matches elsewhere) past a stuck-thread limit. Fork `5eff8436` narrows it: a spin that passes through Forge's attack search, a block assignment or the canPlay scan now ends with its game (`b2-h-fork.tsv`, fault `search`: 4 of 4 freed 0.6 s after the game ended, against 0 of 1 on the pin). A loop of its own (fault `spin`) still keeps the core |
| P16 | hosting | The server's deck-pool JVM (`PoolService`, run dir `pool`) is a third always-on Forge JVM beside the match and the spare: 746–761 MB RSS. Ten idle vs-AI matches + the pool held 8.6 GB RSS (~790 MB per match JVM). | C5 census (claw-9, `[breakit]` lines; hosting-test-plan C results) | medium: ~0.75 GB per server process, before any match | serve the pool from a match host JVM, or shrink its heap |
| P17 | hosting | Cold JVM starts slow down ~5× when they start together: 10 at once on claw-9 (CI load ~20) took 44.7–52.4 s each to `warm`, against 9.6 s for one; a lone spare on claw-8/9 under CI took 7.8–10.5 s (the README's 4.7 s was hokon, idle). | C7 and C1–C6 server logs (`bootMs`); H10 | high in a burst or a failover (D5): ~50 s to a board, within 8 s of the 60 s start timeout | **start queue built (H10, lane H-start, awaiting land)**: 2 match boots + the spare at once; 8 at once on a claw went from 36.7–41.2 s per boot (RED 40352572782) to 11.9–14.3 s, burst done in 37.3 s vs 42.9 s (GREEN 40355072517). Still open: AppCDS (P6); more warm spares on the claws |

## Not measured yet

- **T0: a real prod match's CPU and heap profile.** No prod match ran while the
  sampler did. Rerun `scripts/stress/t0-sample.sh` during an evening's play.
- Firefox under CPU throttling; real phones; Safari.
- **Per-match Netty event loops in a `--host` JVM.** Since lane-multimatch
  (`docs/spikes/multi-match-jvm.md`) each match gets its own `FServerManager`
  and so its own Netty loops and port. Two matches were proven; the thread and
  memory cost at 50+ per JVM is assumed small, not measured. Measure it with
  `scripts/stress/` before placement sizes a JVM by match count.

## Done

| id | finding | fixed in |
| --- | --- | --- |
| D1 | `:has(> li:nth-child(3))` on the command zone restyled the whole board on every card move (2,300–3,700 elements); input p95 at 4× crowded 220 → 57 ms | `6e977833`; `has-invalidation.test.ts` keeps it out |
| D2 | Flyer pinning re-read every animation of a card for any change inside it | `7b7b4141` |
| D3 | Forge's `AiCache` was one cache for the JVM and every AI cleared all of it at each decision: in a shared JVM one game's AI wiped another's cached board evaluation, which was recomputed (and drew extra randoms) | fork `7878fe75`, cardtable `0f9c92d6` (`docs/spikes/per-game-rng.md`) |
| P1 | Declaring attackers had no time limit: 9.9–17.1 s on a crowded forge#3410 board, zero cutoffs. It now has the AI timeout (5 s) as a budget: once spent, the search stops adding attackers and keeps the ones it has. Same board on claw-4 (drained), 1 CPU: 14.3 s → 7.0 s; 4 CPUs: 6.4 s → 5.3 s (`hosting-tests/b2-h-fork.tsv`, `b2-heavy-*`). The ~2 s past the budget at 1 CPU is the iteration in flight plus the work before the first loop head; declaring blockers has no budget yet. Seeded games unchanged: ForgeReplay's 32 concurrent games (seeds 301–332) hash identically to lane-rng's `v2-conc32` | fork `5eff8436` (lane H-fork) |
