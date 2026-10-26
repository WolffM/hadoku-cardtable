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
| P1 | Forge AI | Declaring attackers has no time limit: 9.9–15.9 s on a crowded board, with zero cutoffs. The 5 s cutoff (`AiController.java:1686`) guards only the canPlay scan. | `docs/spikes/forge-scale.md`, surprise 1; forge#3410 | high: a player waits 10–16 s on the AI's attack | fork change |
| P2 | Forge AI | A cut-off AI eval thread keeps running: `AiController.java:1711` calls `t.stop()`, a no-op on Java 20+. Under GC thrash they piled up 0 → 12. | forge-scale.md, surprise 2 | high under load: dead threads burn the CPU live matches need | fork change; test B5 in `hosting-test-plan.md` |
| P3 | Forge JVM | In a cgroup under ~1.8 GB the JVM silently picks SerialGC: 15.5 % GC against G1's 3.5 %. | forge-scale.md, surprise 4 | medium: every match in a small slice | launch flag `-XX:+UseG1GC` in the host agent |
| P4 | Forge JVM | At high density GC runs out before CPU: claw-8 at 512 matches, 35 % GC with only 4.4 of 8 cores busy. | forge-scale.md, surprise 3 | low at our target (≤100) | heap sizing; ZGC had the best tail but 12 GB RSS vs G1's 5.1 GB |
| P5 | Forge AI | The attack pool is a fixed pool of `availableProcessors()` per declare-attackers (`AiAttackController.java:876`); a JVM cannot read a nested cgroup's quota. | forge-hosting-plan.md §2; fleet-manager §3 reply | medium: oversubscribes a slice | launch flag `-XX:ActiveProcessorCount=<cores>` |
| P6 | Forge JVM | Card database init: 3.3 s and 170 MB per JVM. | `docs/spikes/jvm-per-match.md` | low once JVMs are long-lived; it is the cold-start cost of a new JVM (failover target, scale-up) | AppCDS untested (T7) |
| P7 | hosting | Today every match is its own JVM: ~750 MB each, idle spare 784 MB. | forge-hosting-plan.md §2 | high: the reason hosting is capped at 10 | superseded by many matches per JVM (lane-multimatch) |
| P8 | browser | The stack's resolve animation forces layout reads once per packet (`live/departures.ts:516`, `live/numbers.ts:967`, `motion.ts:257`): ~85 ms per 6 s crowded at 4× CPU after the `:has` fix. | `docs/spikes/browser-fps.md`; re-trace 2026-10-25 | low: already batched, one read per packet | a rewrite would compute positions without the DOM; high risk |
| P9 | browser | Flyers restyle every frame in headless software-rendered Chromium (737 ms per 6 s at 1×; the huge board idles at 30 fps at 6×). A plain `transform` animation does the same there, so this may be the test environment. | browser-fps.md | unknown until profiled on a GPU browser | needs a DevTools profile on the operator's machine |
| P10 | browser | Flyer pinning still forces a style read when an attack adds a part to a flyer: ~28 ms per 6 s crowded at 4×. | re-trace 2026-10-25 | low | genuinely needed for the part's clock |
| P11 | host | hokon carries 43 GB of swap; an Android emulator (`-avd spike`) held 17 GB RSS for 3+ days. | 2026-10-25 observation | medium: the CI backstop refused hokon on memory | not cardtable's; whoever owns the emulator |

## Not measured yet

- **T0: a real prod match's CPU and heap profile.** No prod match ran while the
  sampler did. Rerun `scripts/stress/t0-sample.sh` during an evening's play.
- Firefox under CPU throttling; real phones; Safari.

## Done

| id | finding | fixed in |
| --- | --- | --- |
| D1 | `:has(> li:nth-child(3))` on the command zone restyled the whole board on every card move (2,300–3,700 elements); input p95 at 4× crowded 220 → 57 ms | `6e977833`; `has-invalidation.test.ts` keeps it out |
| D2 | Flyer pinning re-read every animation of a card for any change inside it | `7b7b4141` |
