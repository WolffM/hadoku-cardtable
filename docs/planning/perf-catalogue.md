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
| P18 | Forge projection | Every Forge packet recomputes every card's visibility per seat (`visibility.ts` `visibilities`/`cardVisibility`): 0.9 ms per seat and 1.2 ms for the watcher per packet, p99 ~4.8 ms; about 5 of the 7 s a 26-minute game spends handling bridge lines once the folds were fixed. | perf pass 2026-11-02, prod recording `m-07e77e92db5c` (1,109 deltas) | low at tens of matches; grows with match count per server | incremental projection (only the cards a packet names) is the next server win; harder than the folds were |
| P19 | Forge frames | `safeParseServerFrame` Zod-validates every JVM frame: 0.53 ms average, 5 ms for the 170 KB opening delta, ~0.8 s per seat per long game; the browser parses the same frames again. | perf pass 2026-11-02, same recording | low | Forge is our own process; a shallow check of the envelope would do |
| P20 | sockets | `safeEmit` (`@wolffm/rooms-server`) measures every socket's write buffer before each emit, but both our policies (`play/socket.ts`, `room/emit.ts`) have `lowPriorityOrder: []`, so the measurement never changes the outcome; in a burst each emit rescans what engine.io has queued. | perf pass 2026-11-02 (read) | low | pass no policy for these events, or have rooms-server check priority first (not this repo's package) |
| P22 | lobby | `FeaturedMatch` starts its replay fallback (replay list, full replay, every card face decoded, both decks' art preloaded) before `/api/rooms` has answered, so a lobby with a live match does that work and throws it away. | perf pass 2026-11-02 (read) | low today (live matches are rare); grows with play | wait for the first `/api/rooms` answer |
| P25 | rosters | A seat roster carries each seat's live wait (`seatIdentities`), so a join inside a new wait's 150 ms grace gets it at once and then again, byte for byte, when the grace timer tells the room. | `2cc98ff98` (the flaky test it explained) | negligible | report the told wait, not the live one, if the grace should hold for joiners too |
| P27 | room reads | In a match, `MatchScreen`'s `useFollowReplacedGame` reads `/api/rooms/:id` on every feed ping, and `LiveBoard` reads the room again whenever the table changes: two reads of one record on overlapping triggers. | dup-reads lane 2026-11-03 (read) | low | share one read, as the draft room now does (`relayedPodSource`); `LiveBoard.tsx` was held by wperf4 |

Looked at and kept as they are, by the operator's decision (2026-11-02): a draft pick writes the
room's whole snapshot synchronously (`draftRooms.ts` `persistRoom`), 3.6 ms at p50 for the 312 KB
prod snapshot (2.3 ms to serialize, 1.3 ms to write and rename), so that no pick is ever lost to a
crash; bots already write once per 1.2 s turn, not once per pick.

## Not measured yet

- **Edge caching of pinned takes in prod.** A pinned take and the cue pack answer
  `private, max-age=31536000, immutable`; Cloudflare's browser TTL rewrote the old `no-cache` to
  4 h, so check after the release that ships `a31badf42`/`1cfedf3e2` that it keeps the long one
  (`curl -D -` a `?v=` take through hadoku.me).

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
| D4 | Every session fetched and decoded all 220 assigned sound takes at load, 17 of them music loops: 46.6 MB of OGG over the edge and ~1.06 GB of decoded PCM per tab. Cues only are preloaded, and a loop keeps one decoded take | `6ee26aa05` |
| D5 | `/api/discord/recent` and `/api/events/forms` waited on ArchiveBot and Rally on expiry (Discord server p50 552 ms; a Rally outage stalled every poll 5 s, with no in-flight dedupe). Both answer from the kept read and refresh behind it; failures keep the last good answer | `88f0d6ebc` |
| D6 | Take URLs were revalidated on every use and the route read and SHA-1'd the whole file even for a 304. Game takes are pinned to `?v=<size-mtime>` and kept for good; `sendFile` answers revalidations from the stat and serves ranges | `a31badf42` |
| D7 | A seat's board was refolded from its whole history on most priority stops: 18.9 s of fold work over a 26-minute game, 9.2 ms per late read. Folded incrementally, byte-identical at all 2,220 reads: 3.5 s, 0.009 ms | `5c46d5df0` |
| D8 | The recorder rebuilt the whole board per frame to compute an end-of-match digest (796 ms per seat per game); folds in place (10 ms). Bridge stream lines opened and closed the file and re-serialized JSON per line (55 ms); one open handle (9 ms) | `8a7d905e8`, `0637aa4b3` |
| D9 | One 3.57 MB / 1.13 MB-gzip entry chunk, 583 KB of it static data re-downloaded on every deploy. Lazy screens and long-lived data/vendor chunks: the lobby's first paint needs 264 KB gzip, the embed entry 33 KB | `f8f1afe50`, `1eda4a69b` |
| D10 | The front page's calendar and polls re-read every 60 s in hidden tabs (one idle tab: 2,593 reads in a week); all timed re-reads share `visible.ts` | `8f418289e` |
| D11 | A first visit asked the edge for ~203 cue takes one by one (each an edge-worker run with two KV reads). One versioned pack | `1cfedf3e2` |
| D12 | `/api/tables/decks` rebuilt and stringified 1,459 decks per request (12–15 ms of event loop); `/api/sounds/assignments` re-read and Zod-validated the ~280 KB catalogue per page load. Built once / read once per change | `38113ac53` |
| D13 | The lobby's cube spotlight downloaded the cube's whole card list (244 KB raw, 55 KB gzip) to show three arts; the server samples them | `eee5a6b99` |
| D14 | Sockets started on HTTP long-polling and upgraded: 3–4 extra edge round trips per connection. WebSocket-first with polling fallback (`tryAllTransports`); measured through the edge, connect time is unchanged and the handshake requests are gone | `ef2375bfb` |
| D15 | A reconnect or watcher join was sent the whole match history: 2.08 MB in a 26-minute game, 1,100 frames for the browser to refold. Compacted at each turn: 178 KB, identical client state at all 27 turn bases | `d9f5f9830` |
| D16 | Ended matches were never released (each seat's history, projectors, a frame ring: 10–15 MB for a long match until restart). Released at their end, with a small tombstone; a game both players left is parked to disk and resumable forever | `9c306ac0b` |
| D17 | A draft room read its own room record twice (the room screen's follow and the pod's): opening 2 → 1 reads, three pings 8 → 4; the 30 s fallback is kept | `0ae99eaa7` (branch dup-reads) |
| D18 | A reloaded match link asked which room it was in twice (`App.tsx`, then `MatchScreen.tsx`): one lookup per page, shared, failures not kept | `0ae99eaa7` |
| D19 | A cube's card list was fetched by two screens and formats/decks on every room visit; the server re-serialized ~244 KB per cube request. Read once per page (`readOnce`, forgotten on refresh/re-import/delete); serialized once per cube version with its own ETag (`http/prepared.ts`, shared with `/tables/decks`) | `0ae99eaa7` |
| D20 | The lobby's featured board pulled in the room screen and with it pod, draft, gauntlet and deck-art code: lobby JS after the featured board 1,154 → 1,028 KB gzip (`screens/libraryPeek.ts`) | `0ae99eaa7` |
| D21 | The Decks table had no "Last played": prefs-api's breakdown dropped the `MAX(ended_at)` it computed. Rows carry `lastPlayedAt` (hadoku_site `7a6d24404`, prefs-client 1.1.19) and the table shows it | `0af5cfa02` |
| P1 | Declaring attackers had no time limit: 9.9–17.1 s on a crowded forge#3410 board, zero cutoffs. It now has the AI timeout (5 s) as a budget: once spent, the search stops adding attackers and keeps the ones it has. Same board on claw-4 (drained), 1 CPU: 14.3 s → 7.0 s; 4 CPUs: 6.4 s → 5.3 s (`hosting-tests/b2-h-fork.tsv`, `b2-heavy-*`). The ~2 s past the budget at 1 CPU is the iteration in flight plus the work before the first loop head; declaring blockers has no budget yet. Seeded games unchanged: ForgeReplay's 32 concurrent games (seeds 301–332) hash identically to lane-rng's `v2-conc32` | fork `5eff8436` (lane H-fork) |
