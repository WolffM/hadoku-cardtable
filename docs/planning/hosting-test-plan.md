# Forge hosting: the test plan

What we run to find the gaps in hosting Forge matches on the claws, before
players find them. The operator, 2026-10-25: *"do thorough testing on how the
jobs are running on the claws and look into load tests, fail-over tests, and
generally just try to break the system and see where our gaps."*

Serves `forge-hosting-plan.md`. The capacity numbers already measured are in
`docs/spikes/forge-scale.md`; this plan is about what breaks. Performance
findings along the way go to `perf-catalogue.md`, not here.

## Rules for every test

- **Prod is never a test subject.** Nothing runs against `cardtable` (:9008) or
  `cardtable-ppe` (:9011). Heavy runs go on the claws, never hokon.
- **A test states its pass line before it runs**, and its result names the
  evidence (a TSV, a log, a run URL). "Seemed fine" is not a result.
- **Every failure is a finding**: it gets a row in "Findings" with what broke,
  how to reproduce it, and who owns the fix (cardtable or fleet-manager).
- Quality gates, the same everywhere (plan §4.2, ruling 6): zero AI cutoffs;
  AI decision p95 ≤ half the 5 s cutoff and ≤ 2× the same claw's unloaded
  figure; paced action → frame p95 ≤ 250 ms, p99 ≤ 500 ms; GC share ≤ 10 %.

## A. fleet-manager's shared hosting (blocked on their build)

The acceptance tests we run against fleet-manager's shared slices (request §7–§9
and their redesign of 2026-10-25: cardtable outranks CI on the claws, CPU by
weight, memory by `MemoryMin` plus a dispatcher hold-back, an overgrowing CI job
is OOM-killed).

| # | test | pass |
| --- | --- | --- |
| A1 | declare a slice, time to `guaranteed` on `--check --json` | seconds, and every read-back field matches the kernel |
| A2 | quality under contention: stress harness inside the slice, CI-shaped load (`fleet hosting <node> --ci-shaped -- <cmd>`) saturating the rest of the box under a `--kind lease` drain, on claw-9, claw-8, claw-4 and claw-6 | the quality gates hold at the slice's planned load |
| A3 | CPU when idle: slice idle, CI saturating | CI gets the slice's cores (fleet-manager's aim: nothing wasted) |
| A4 | memory hold-back: declare, then dispatch CI while the slice is empty, half full, full | no new CI job admitted into the declared share at any point, including before our JVMs start |
| A5 | OOM order: a `--ci-shaped` process grows into the slice's share, under a lease drain | the kernel kills the CI process; the agent and every match live |
| A6 | global OOM on the box, under a lease drain only (on live traffic it would kill real jobs) | CI dies first, every time (CI +500, agent −500; on claw-4 pm2 at 0 also outlives CI) |
| A7 | end: `--end` under 15 min ahead, and at ≥ 15 min | the first refused; the second shown in `notices` from the moment it is scheduled |
| A8 | reboot of a hosting node | only via a planned drain ≥ 15 min ahead in `notices`; an unannounced reboot is reported by `node-status` |
| A9 | `node-status --json` when a node is unreachable (it ssh's from the CLI; mgmt-api is not on its path) | `reachable: false`/blocking within one poll; "could not look" is a failure, never healthy |
| A10 | agent as its own user (§9): from a `--ci-shaped` unit with the CI user's full rights, read `/proc/<agent>/mem` and `environ`, `kill -0` the agent, write into `/var/lib/cardtable-agent` and `/opt/hosting/cardtable/run` | each refused (until §10 lands, only without sudo) |
| A11 | remove: `--remove` after the end | no unit, user process, firewall rule or cgroup left |
| A12 | CI user (§10): on every claw, the runners' user has no sudo, no docker group, no group with `cardtable-agent`; change one by hand | `node-status` reports the drift as blocking (and repairs it, if fleet-manager's converge does) |

### A results (claw-9, 2026-10-27, under a lease drain)

The slice: 4 GiB, 4 cores, declared by fleet-manager 0.34.90. The load inside it is
the §A test agent (since replaced by the host agent, `apps/agent`; the same load now runs through it with
`scripts/stress/agent/scale.ts`), running ForgeScale on the
`5eff8436` pin with `-Xmx2200m`. The CI-shaped load comes from `fleet hosting claw-9 --ci-shaped`:
12 spinning processes holding 16 GB (A2, A3), and a process that grows 256 MiB every half
second (A5, A6). Every row here is one ForgeScale RESULT line.

| test | run | result |
| --- | --- | --- |
| A1 | read-back vs the kernel | **pass.** `hosting.slice`: memory.min 4G, cpu.weight 10000. The tenant slice: min = max = 4G, swap.max 0, cpu.max 400000/100000. The agent is uid 997 at oom −500, and CI listeners are in `runners.slice` at +500. |
| A2 | 50 paced vs-AI matches, 15 min, unloaded, then with 12 CI cores spinning and 16 GB held | **pass.** AI p95 13.3 → 14.7 ms and p99 26.8 → 35.9 ms; paced action p95 19.6 → 19.6 ms and p99 39 → 40 ms; GC 3.9 → 6.1 %; 0 cutoffs, 0 failed. The slice used 1.6 cores to CI's 10.3, with CPU pressure at 1.5 %. |
| A2 (overload) | 8 AI-vs-AI matches at full speed, 10 min, unloaded, then with CI | Not a gate run: it saturates the slice even unloaded (6 cutoffs, GC 36 %). Under CI the slice still got 3.94 of its 4 cores, but did ~20 % less work. Accepted as R2. |
| A3 | slice idle, CI spinning | **pass.** CI got 11.96 of 12 cores. |
| A5 | 50 paced matches; a CI-shaped process grows to its cap three times | **pass.** Three memcg OOMs, all in `runners.slice` at 27.2 GB; the agent and the JVM were untouched. Gates held: AI p95 12.4 ms, paced p99 28 ms, 0 cutoffs. The slice logged no added memory or IO stall. |
| A6 | 50 paced matches; CI holds 25 GB while a non-CI process pushes the box past RAM and 12.8 GB of swap | **pass on the order of kills, every run: the global OOM (`CONSTRAINT_NONE`) took the CI process at +500, and the agent and JVM at −500 lived. Quality: H14.** First run: AI p95 69 ms, paced p99 1.24 s, 4 cutoffs. With fleet-manager's `runners.slice` MemoryHigh (0.34.95), CI was throttled at 23.8 GB, but the non-CI process alone still broke quality: AI p95 64 ms, paced p99 2.44 s, 3 cutoffs. With a pre-touched heap (`-Xms` = `-Xmx`, `-XX:+AlwaysPreTouch`), two runs: AI p95 24.8 and 32.3 ms (the gate is 26.6), paced p99 39 and 36 ms, 0 cutoffs. The slice's memory stall fell from ~75 s to ~30 s. |
| H15 check | 50 paced matches; `fleet hosting claw-9 --restart` 90 s in | **pass.** The agent came back as a new pid and adopted the JVM, which kept its pid. The run finished: 0 failed, AI p95 10.6 ms, paced p99 38 ms. The run's cgroup was removed when it ended. |
| H13 check | from claw-8: the hostname, tailnet v4 and v6 | **pass.** All three time out (fleet-manager 0.34.93's raw-table drop). |
| A10 | intruder in a `--ci-shaped` unit, without sudo | **pass.** It was refused reading `mem`, `environ` or `maps` of the agent and the JVM, `kill -0` on both, listing or writing the agent's home, writing the executable or its directory, and moving itself into the slice. It can read `cmdline`, so no secret ever goes on an argv. It reaches the agent's port over loopback (401), so every port the host agent opens authenticates. |
| A4 | fleet-manager, 2026-10-27, through the real dispatcher tick, against a 4096 MiB slice | **pass.** The empty slice holds back 4096 MiB, half full 2048, full 0. A slice declared under 10 min ago, or one whose cgroup can't be read, holds 4096. Live on claw-9, with 764 MiB in the slice, the hold-back was 3332 MiB and the admission floor 7428. This is the same function run on live inputs; mgmt-api does not log the floor. |
| A7 | fleet-manager, against a copy of the live record | **pass.** `--end --in 5m` was refused ("owed 15 min notice") and wrote nothing. `--end --in 20m` was accepted and appeared at once in node-status `notices` and `hosting.until`. |
| A8 | — | not run as a test. The 48 h probe saw each claw's rolling reboot of 10-25, from before 0.34.90 added the 15 min notice (forge-hosting-plan.md §4.1). |
| A9 | fleet-manager, an unresolvable node in a fixture manifest | **pass.** One 40 s call returned `reachable:false`, `ok:false` and a blocking `unreachable` finding, exit 1. 0.34.101 makes the reason name the timeout instead of a bare "Command failed: ssh". |
| A11 | the operator, live on claw-5, 2026-10-27 17:21Z: a 1G/1-core shared slice declared, then `--remove --force` | **pass.** It returned `removed` with nothing left. A separate read-back found no unit, cgroup, executable, agent process, firewall or raw-table rule for the port, and `runners.slice` memory.high was back to max. The `cardtable-agent` account and its empty home stay, by design. |
| A12 | — | built, live run pending a cut-over claw (claw-5 first). Drift on a cut-over node, or "could not look", is blocking `ci-user-drift`; converge reports it but does not repair it yet. |

## B. Many matches in one JVM (testable now, `scripts/stress/`)

Failure isolation inside a shared JVM: what one bad match does to the others.

| # | test | pass |
| --- | --- | --- |
| B1 | soak 8 h with churn at a realistic mix (T5) | heap floor, thread count, metaspace and class count flat after warm-up |
| B2 | hung AI: one forge#3410 stalled board beside N normal matches | the others hold the quality gates; the hung match is detectable (no decision in X s) |
| B3 | a match that throws (StackOverflowError, an engine exception) | only that match ends; the JVM and the others continue |
| B4 | OOM in the JVM (`-XX:+ExitOnOutOfMemoryError`) | the JVM exits, time from first warning to exit is known, nothing hangs |
| B5 | AI cutoff threads: count live AI eval threads over a soak with cutoffs firing | flat; today `t.stop()` is a no-op on Java 20+ (forge-scale finding 2), expected to fail |
| B6 | per-game RNG (after lane-rng): N concurrent fixed-seed matches each equal their solo run | identical |

### B results (lane-breakit, 2026-10-26)

Run on claw-9 (B2, B3, B5) and claw-8 (B4), each JVM in a `systemd-run --user
--scope` of **4 CPUs / 3 GB** with `-Xmx2200m` unless the test says otherwise,
on Forge pin `9e5f5b75` (the per-pin jar), 16 paced vs-AI cube matches per run
(`N=16 scripts/stress/suite.sh b2|b3|b4|b5 <claw> docs/spikes/hosting-tests`).
CI was running beside every run: claw-9 had 2–4 runners at load 21–30, claw-8
1–2 at load 9–18 (`runners_pre`/`load_pre` columns). Each row is one run, so a
latency difference under ~30 % is noise. Rows: `docs/spikes/hosting-tests/b*.tsv`;
5 s series: `docs/spikes/hosting-tests/series/`.

Fault injection is new in `ForgeScale.java` (`stress.fault`, `stress.faultSlots`,
`stress.faultAfter`, `stress.faultRescueSec`): the AI seat of a fault slot
does the fault inside its 10th priority decision, on the game thread.
`stress.aiTimeoutSec` overrides `Game.AI_TIMEOUT` (B5). The series now also carry
metaspace, loaded classes and GC time (B1).

The baseline for the gates is `b3-base-n16`: AI p95 13.9 ms, act p99 27.8 ms,
GC 0.2 %, 0 cutoffs.

| # | result | evidence |
| --- | --- | --- |
| B1 | **running**, not read: an 8 h soak started 2026-10-26 on claw-9 at 07:09Z as transient user unit `breakit-soak-1792998586` (ends by itself after 8 h, `RuntimeMaxSec` 8 h 15 min) (48 paced matches, 40 % human-vs-human, 4 CPUs / 3 GB, forced GC every 5 min). Collect with `scripts/stress/soak.sh collect claw-9 <dir>` after it ends, then `scripts/stress/soak-summary.py <dir>/breakit-soak-*/series.tsv`. | (pending) |
| B2 | **isolation passes, recovery fails.** Spin (an AI loop no interrupt reaches): the others held every gate (AI p95 15.4 ms, act p99 29 ms, 0 cutoffs); a per-decision watchdog saw the hang at 3.2 s; the rescue a host could do without killing the JVM (`setGameOver` + interrupt) did nothing, and the thread burned **234.7 CPU-s in the 240 s run, a full core, until the JVM exits** (finding H6). Block (an AI waiting on something an interrupt reaches): the same rescue freed 5 of 5 games, each 30.6 s after it hung (the 30 s rescue delay + 0.6 s). forge#3410 board: declare-attackers took up to **17.1 s with zero cutoffs**, while the 16 others held the gates (AI p95 15.2 ms, act p99 45 ms). | `b2.tsv`; `series/claw-9-b2-spin-n16.tsv` (`cpu_s` climbs ~1.2 CPU-s/s with 16 paced matches) |
| B3 | **passes in the harness.** A real `StackOverflowError` (28 faults) and an engine exception (47) on the game thread each unwound out of `Match.startGame` in ~13 ms; only that game ended, the slot thread went on to its next match, the JVM and the other 14 matches were unaffected (AI p95 13.2 / 14.2 ms against 13.9). **But production runs games differently**: `HostedMatch.startGame` runs the game through `GameAction.invoke` → `ThreadUtil.invokeInGameThread` (`HostedMatch.java:280`, `ThreadUtil.java:44`), a bare `ExecutorService.execute` with no handler, and `PlayBridge.java` installs no `UncaughtExceptionHandler`. A throw there ends the game thread silently and leaves the match hung exactly like C2 (finding H9, ASSUMED from the code: not provoked in a real bridge). | `b3.tsv` (`fault_ends`, `fault_unwind_p50_ms`) |
| B4 | **the JVM exits and nothing hangs, but the warning is long and the end is total.** With `-XX:+ExitOnOutOfMemoryError` and a heap too small (64 matches in 400 MB): live heap reached 381 MB at 111 s (first sign: eval threads 0 → 10, first cutoff); then **~115 s at ~94 % GC** (`gc_ms` 16 s → 126 s between t=111 and t=227) before `Terminating due to java.lang.OutOfMemoryError` and exit 3. On 8 CPUs T6 took 30 s; in a 4-CPU slice it takes 4× longer (H7). **Without the flag the JVM never exits** (that is today's bridge launch, `host.ts:488`): 71 games died of `OutOfMemoryError`, the JVM limped on at 62 % GC, act p99 14.6 s, 109 cutoffs, 19 live eval threads. **A cgroup `MemoryMax` below the JVM's footprint** (`-Xmx2200m` in 700 MB): the kernel OOM-killed the JVM 28 s after start with no Java-side sign (last sample: RSS 637 MB, heap normal), rc 137, every match gone (H8). | `b4.tsv`, `b4.c97.tsv`; `series/claw-8-b4-*.tsv`; claw-8 `journalctl --user`: `run-p719182….scope: … killed by the OOM killer` |
| B5 | **passes on pin `9e5f5b75` under normal load, fails under heap starvation.** With `Game.AI_TIMEOUT=0` every canPlay scan is cut off: 72,055 cutoffs in 300 s at full speed (4 matches) and 5,642 at 16 paced, and live `Game AI Eval` threads peaked at **3** and **1**, flat over the run. The pin's cooperative cancel (`future.cancel(true)` + `join(2000)`, `AiController.java:1700-1712`) works; perf catalogue P2 is fixed for that case. Under GC thrash it is not: B4's runs reached **19 and 26 live eval threads** (a starved thread never reaches its cooperative check). | `b5.tsv`; `series/claw-9-b5-cutoff0-full-n4.tsv`, `series/claw-8-b4-exit-n64-400m.tsv` (`eval_threads`) |
| B6 | skipped: waits on lane-rng's fork. | |

Harness bug found and fixed on the way: a decision that threw never reached
`timed()`, so its seat stayed in the watchdog's `DECIDING` set and kept its
`Game` reachable: b3's live heap per match read 3.8 → 6.0 → 9.2 MB (base, soe,
throw). The slot now drops the game's seats when the game ends; the re-run is
`b3-throw-fixed-n16`.

## C. Today's single-host path (testable now, a dev server on a claw)

How the current one-JVM-per-match hosting fails. These set the bar the
claws must beat, and several gaps carry straight over.

| # | test | pass (or: what we learn) |
| --- | --- | --- |
| C1 | `kill -9` a match's bridge JVM mid-match | both browsers told within N s; the crash record is written; nothing wedges |
| C2 | `SIGSTOP` the bridge JVM (a hang, not a death) | detected within N s; today: is it detected at all? |
| C3 | restart the Node server mid-match | what the players see; whether the JVM is orphaned or reaped |
| C4 | a browser that stops reading (slow consumer) | the match and the other seat are unaffected; memory bounded |
| C5 | start matches until `MAX_CONCURRENT_MATCHES` and past it | the refusal is clear to the player; the warm spare refills |
| C6 | the work dir's disk full | the match fails loudly, the server stays up |
| C7 | 20 match starts in one second | no orphan JVM, no double spare |

### C results (lane-breakit, 2026-10-26)

A dev server with real Forge on claw-8 (C1–C4, C6) and claw-9 (C5, C7): the
built server and UI of `origin/main` at `f468c679`, Forge pin `9e5f5b75` from the
claw's forge-bundle cache, e2e's own stack (`startPlayStack`: real edge
stand-in, two friend identities, a work dir under `~/.cache`) and real
Chromium through Playwright, never the shared MCP browser. The spec is
`scripts/stress/hosting/breakit.spec.ts` (copy it into `e2e/` to run; it is
kept out of `e2e/` so CI never runs it). Each observation is a `[breakit]`
JSON line; screenshots and console logs stayed in the lane's scratch.

Each stack runs **three** JVMs, not two: the match, the warm spare, and the
deck pool's own (`PoolService`, cwd `pool`, 757 MB RSS on claw-9).

| # | result | what the players saw | server | detection | left behind |
| --- | --- | --- | --- | --- | --- |
| C1 | **FAIL (UI).** The server side passes; the screens do not. | Nothing. 35 s after the kill, alice still had "Waiting for e2e-bob to choose…" and bob still had the Cleanup discard prompt open, Concede greyed. Both sockets received the `showErrorDialog` `matchEnded` frame 30 ms after the kill (`errorFrame` in the evidence). H1. | `jvm-exited` → `match-failed` → the notice to both seats → `run-dir-kept`, all 251–255 ms after SIGKILL; `GET /matches/:id` says `failed` with the reason. | 0.25 s (server); never (players) | crash record (`bridge.stderr.txt`, `config.json`, `crash.json`); spare intact; no JVM |
| C2 | **FAIL.** A stopped JVM is never detected. | Their own buttons re-offered every 10 s (Keep/Mulligan comes back enabled), each press silently dropped; no notice. | `act-unanswered` + `window-resent` every 10 s; `status: running` after 3 min; no failure. | never (≥ 180 s observed) | the stopped JVM, alive (`T`), until the stack was stopped |
| C2 | **FAIL, worse:** after SIGCONT the match never moved again (turn `Start` before and 20 s after). | Same as above, for ever. | Forge's own in-JVM server had dropped both loopback clients on resume: `e2e-alice timed out after 45 seconds without a network response. Closing connection.` (`FServerManager.java:73`, `forge.net.heartbeatTimeout`), then `No encoder in client pipeline for GuiGameEvent … selectButtonOk` for every press. H3. | never | a live JVM holding a dead match |
| C3a | **PASS.** Graceful restart (SIGTERM, as pm2 does). | No notice drawn; the board stayed; play resumed (turn `Start` → `2` in the 30 s after). | `jvm-handed-over` → next process `jvm-attached` + `match-resumed` (replayed 26 lines) 2.1 s later; both seats re-`joined` 4 s after the SIGTERM; same JVM pid. | — | the idle spare reaped at shutdown, a new one spawned; nothing orphaned |
| C3b | **PASS.** Node SIGKILLed (a crash, no handover), new server after 15 s. | "Reconnecting…" over the board for the 15 s; play resumed after (game progressed through combat). | The match JVM and the idle spare both outlived the server; the next boot killed the old spare from its record and re-attached the match (`orphanedAt: null`, replayed 27). | — | nothing after the next boot |
| C4 | **PASS.** bob's whole browser process tree SIGSTOPped for 150 s. | alice: "Waiting for e2e-bob to reconnect…" from 34.5 s (socket.io ping timeout, `left … reason: ping timeout`); bob after SIGCONT: rejoined, game went on to turn 2. | `seat-departing` with the 30 s grace, `openAsks: 0`; server RSS flat (386 → 273 MB). | 34.5 s | nothing. Not tested: memory under heavy traffic to a frozen seat (the match was waiting on bob, so little was sent). |
| C6 | **FAIL.** Work dir's filesystem filled mid-match (a 300 MB tmpfs over e2e's play-work root inside `unshare -rm`). | Nothing: the match played on normally. | `jvm-stream-broken` (`ENOSPC`) once, then nothing; **`jvm.json` truncated to nothing** by its in-place rewrite (`host.ts:1492`), so the match lost its re-attach record (H4); on the next SIGTERM it could not be handed over and was ended ("The server is restarting for a deploy."). A new `POST /api/play/matches` threw `ENOSPC` out of `BridgeJvm.adopt` (`host.ts:1515`): Express's HTML 500 page, and a match left registered in `starting` (H5). `/health` stayed 200, the server stayed up. | 0.4 s (log only) | the match JVM's record gone; the half-made match |
| C5 | **PASS**, with a cost. | Not checked in a room (API only): the 11th start got `503 {"error":"the server is already running 10 matches"}`. | 10 matches + pool = 11 JVMs, **8.6 GB RSS** (~790 MB per idle vs-AI match JVM). No spare at 10 (the ceiling counts it); after one match's JVM was killed the spare came back warm in 9.6 s and the next start took it. | — | all reaped at stop |
| C7 | **PASS**, with a cost. 20 POSTs 50 ms apart: 10 × 201, 10 × 503 within 0.5–1 s. | — | Peak JVMs 11 (pool + 10), spare ≤ 1, no unrecorded JVM; all gone after stop. But 9 of the 10 starts were cold and all booted at once: **47–55 s to 201** (`bootMs` 44.7–52.4 s, against 9.6 s for one), within 8 s of the server's 60 s start timeout (`socket.ts`, `startTimeoutMs`). H10. | — | nothing |
| C2b | **FAIL past 45 s** (added: how long a pause the bridge survives). SIGSTOP for 0 / 30 / 60 s, then a Forge round trip: the e2e probe (Forge's own `showConfirmDialog` to alice, through the bridge's loopback client, answered on her screen). | 0 s and 30 s: the dialog drawn and answered, 105–117 ms. 60 s: no dialog. | 60 s: the probe answered `no remote client GUI at slot 0` after 20 s; `bridge.stderr.txt` has the heartbeat timeout. | never | a live JVM with no clients |

## D. Hosting on the claws

Placement, failover and alerts are built (`apps/server/src/play/placement/`, behind
`CARDTABLE_PLAY_HOSTS=claws`). Local end to end on hokon, 2026-10-27, two agents as two claws
(`scripts/agent/placement-e2e.ts`, three runs): one agent and its JVM SIGKILLed with 2 of 4 matches
on it, failover 8.6–10.1 s after the kill (the 10 s window), both matches on the other claw at their
first frame within 0.2 s of that, one Failover alert, the claw quarantined; its agent restarted,
the canary passed 8.7–12.1 s later and the ✅ followed. A SIGTERMed coordinator exits in 215–233 ms;
the agent's hold kept the JVM 15 s past it (beyond the 10 s window) and the next coordinator
re-attached all 4 matches 0.2–0.4 s after it started (15.4–15.7 s from the SIGTERM), same JVM pid.
The match moves there were restarts from spec: `MatchRegistry.restore` (turn-start snapshots) was
not in the
tree. D1–D9 on real claws remain the manager's acceptance run.

Written now so the design is built to pass them.

| # | test | pass |
| --- | --- | --- |
| D1 | kill the agent on a claw with live matches | every match fails over to another claw (ruling 4), one 🚨 alert listing them, the claw quarantined |
| D2 | cut a claw's network (agent port closed, then the whole node) | detected within the heartbeat window (2 s × 3); same as D1 |
| D3 | the claw comes back | it does not resume a match that moved (stale epoch fenced); rejoins only after a healthy status and a canary match |
| D4 | the coordinator restarts | agents keep matches for the miss window, then fence themselves; nothing runs twice |
| D5 | a claw dies holding 50 matches | all 50 restore elsewhere; time to restore; what the snapshot lost |
| D6 | every slice full, and every claw down | hokon's backstop takes matches by the CI backstop's rules (plan §4.3) and alerts; admission refuses cleanly past that |
| D7 | scale up and down: load past 70 % of the live slices' cap, then calm | the next slice is declared and used; removed only after the calm spell, with `--end` notice, never cutting a live match |
| D8 | a CI job on the same claw tries to connect to the agent's port | refused (the port authenticates the coordinator) |
| D9 | a bad jar or `res` delivered to an agent | the sha256 check refuses it; the claw stays on its old artifacts |

## Accepted risks

| id | risk | accepted by | why |
| --- | --- | --- | --- |
| ~~R1~~ | Every CI job on a claw can become root (the CI user has NOPASSWD sudo; on claw-8 also the docker group), so a CI job could read a live match's hidden cards or replace the agent despite §9's separate user. **No longer accepted:** the operator chose (2026-10-25) to move CI to an unprivileged user, automated and drift-checked by fleet-manager (request §10). Open until that lands; then A10 runs with sudo too. | — | — |
| R2 | Under full CI saturation a slice gets its CPU time but not its speed: the quota buys hardware threads, and CI spins on their SMT siblings. A2 at full AI speed on claw-9 (6 cores × 2 threads): 3.94 of 4 cores of CPU time, ~20% less work (326 → 258 matches in 10 min, AI p50 3.6 → 6.4 ms), every match completed. | the operator, 2026-10-27, via fleet-manager | pinning whole cores to the slice would idle those threads whenever the slice is quiet; CI keeps them. At the planned paced load the gates hold (A2). |

## Findings

| id | test | what broke | owner | status |
| --- | --- | --- | --- | --- |
| H1 | C1 | **A crashed match looks live.** The server tells both seats in 0.25 s (`showErrorDialog` with `matchEnded`, `match.ts:3680`) and the frame reaches both sockets, but the UI only sets `match.over` (`live/match.ts:3268`). `GameResultScreen` needs `view.gameOver` or `finished`, so nothing is drawn: players keep an open prompt and a greyed Concede for as long as they wait. Repro: C1 (`kill -9` the pid in the match's `<run>/jvm.json`). Fix: when `over && !finished`, draw the ended notice (its message and a way back to the room) and drop open prompts. **Built (lane H-ui, 2026-10-26):** the notice is kept as `LiveMatch.ended` and drops every open decision and waiting line (`dropOpenInput`); a match that ended without a game result draws `MatchEndedNotice` (the server's title and sentence, Back to room, Main menu). Every outside ending (H2's missed heartbeat, H3's dropped channel, a bridge `fatal`) reaches the screen through it once the server calls `endNotice`. e2e `h1-match-ended`: red on main (run 40352906134), green with the fix (run 40355345024; both screens drew it ~0.3 s after SIGKILL). | cardtable (UI) | built, awaits land |
| H2 | C2 | **A hung JVM is never detected.** After SIGSTOP the match stayed `running` for 3+ min with no failure. The server's `act-unanswered` re-sends the player's own window every 10 s, so presses are dropped again and again with no notice. Repro: C2. Fix: a liveness line from the bridge every few seconds, from a thread other than the game thread, and the match failed through H1's path after N missed. D1–D2's per-match heartbeat is the same signal. | cardtable | fixed in h-live: the bridge says `alive` every 2 s from its own thread; a JVM silent 40 s is SIGKILLed and its match failed through the crash path (`host.ts` "Liveness"; `liveness.jvm.test.ts` H2, `host.test.ts` liveness) |
| H3 | C2, C2b | **A JVM pause over 45 s wedges the match permanently, even after the JVM resumes.** Forge's in-JVM server drops its loopback clients after `forge.net.heartbeatTimeout` (default 45 s, `FServerManager.java:73`), and the bridge never reconnects them. C2b: pauses of 0 and 30 s recover; a 60 s pause leaves `no remote client GUI at slot 0`, and every later press logs `No encoder in client pipeline`. Nothing detects it (H2). Pauses that long are real: B4's GC death spiral ran ~115 s. In a multi-match JVM one such pause would wedge every match at once. Repro: C2b with `BREAKIT_STOP_S=60`. Fix: launch bridge JVMs with `-Dforge.net.heartbeatTimeout` far above any plausible pause (the clients are in the same process), and have the bridge send `fatal` when a seat's client channel goes inactive, so H1's path runs. | cardtable (bridge; lane-multimatch for the shared JVM) | fixed in h-live: bridge JVMs launch with `-Dforge.net.heartbeatTimeout=86400`, and a seat client whose channel goes inactive sends `fatal` (`MatchContext.seatDisconnected`); the shared-JVM half stays with lane-multimatch |
| H4 | C6 | **A full disk silently destroys a match's re-attach record.** `jvm.json` is rewritten in place (`host.ts:1492`, `writeFileSync`), and `ENOSPC` left it empty: the match could no longer be handed over (the next SIGTERM ended it). A live JVM whose record is gone is spared by the boot sweep's live-process guard rather than reaped (ASSUMED from the README's sweep rule). `stream.jsonl` appends stop at the first `ENOSPC` (`jvm-stream-broken`, logged once), so a replay would come up short. Nothing alerts. Repro: C6. Fix: write records to a temp file and rename it into place; treat `jvm-stream-broken` as a degraded match (alert, and refuse handover in words). | cardtable | fixed in h-live: `jvm.json`, `config.json` and `crash.json` are written temp + rename (`writeFileAtomic`); a broken stream logs `match-degraded` (level error), renames the record to `jvm.degraded.json` (the boot sweep kills it), and handover is refused in words (`jvm-handover-refused`). No alert channel exists in the server yet |
| H5 | C6 | **Starting a match on a full disk gives an HTML 500 and a half-made match.** `ENOSPC` from `BridgeJvm.adopt` (`host.ts:1515`) escapes `POST /api/play/matches`: Express answers with its default HTML error page, and the match stays registered as `starting`. Repro: C6's second start. Fix: catch in `matches.create`/`start`, fail the match, and answer 503 with words. | cardtable | fixed in h-live: a host that throws fails the match (`Match.unstartable`) and the route answers 503 `{ matchId, error }`; the pool leaves no half-staged run dir and stops a spare it had taken, and `replenish` never throws |
| H6 | B2 | **A spinning AI cannot be stopped inside a shared JVM.** A per-decision watchdog sees it at 3 s, but `setGameOver` + interrupt freed 0 of 1 and the thread burned a full core (234.7 CPU-s in 240 s) until the JVM exits. A blocked AI, which an interrupt does reach, was freed 5 of 5. Repro: `N=16 suite.sh b2`. Design: the host agent needs a decision watchdog, must end the match for its players, and must count stuck threads per JVM and drain/recycle the JVM past a limit, because nothing else returns the core. **Fork `5eff8436` (lane H-fork, 2026-10-26) makes Forge's own AI searches stoppable:** once the game is over, the attack search, every block assignment and the canPlay scan unwind at their next loop head (`Game.throwIfOver`, caught in `GameAction.startGame`). New fault `search` (an AI spinning through Forge's attack search, which no interrupt reaches either): pin `005e8186` freed 0 of 1 (148 CPU-s, spinning to the end of the run); the fork freed 4 of 4, each 0.6 s after `setGameOver` (`b2-h-fork.tsv`, claw-4 drained). **Still not stoppable:** a spin in code with no loop head that checks the game (fault `spin`, still 0 of 1, 154 CPU-s), a single evaluation that never returns inside one iteration, and any game a stop does not end (a stopped match whose remaining seats are AIs keeps playing). So the recycle design stays, for fewer cases. The bridge needs no new hook for a 1v1 vs AI: `endGame` concedes the humans, which ends the game on the stopping thread. A host could also call `game.setGameOver(...)` itself when the concedes leave AIs playing. | cardtable (host agent design) | partly fixed (fork `5eff8436`); recycle still needed |
| H7 | B4 | **Running out of heap takes minutes, then every match.** G1 has no GC-overhead limit. With `-XX:+ExitOnOutOfMemoryError`, a starved 4-CPU JVM spent ~115 s at ~94 % GC before it exited (T6 on 8 CPUs: 30 s). Without the flag, which is today's bridge launch (`host.ts:488` adds only `-Xmx1g`), the JVM never exits: games die one by one of `OutOfMemoryError` while the rest crawl (GC 62 %, act p99 14.6 s). Repro: `suite.sh b4`. Fix: add `-XX:+ExitOnOutOfMemoryError` to bridge JVMs now. For multi-match, watch the live heap after GC (a `MemoryPoolMXBean` collection-usage threshold) and stop admitting / drain at ~85 % of `-Xmx`, well before the spiral. | cardtable | fixed in h-live for one-match JVMs: `-XX:+ExitOnOutOfMemoryError` on every bridge launch (exit 3 → match failed). The multi-match heap watch is the host agent's |
| H8 | B4 | **A slice smaller than the JVM is a silent kill.** `-Xmx2200m` in a 700 MB `MemoryMax`: the kernel OOM-killed the JVM 28 s in with no Java-side sign, rc 137, every match gone. Repro: `suite.sh b4`, third run. Fix: size `MemoryMax` ≥ `-Xmx` + ~400 MB non-heap (RSS 1.24–1.27 GB at `-Xmx1000m`, `forge-scale.md`), and have the agent read the unit's `oom-kill` result to report the death. | cardtable + fleet-manager (slice sizing, reporting) | open |
| H9 | B3 | **In production, an exception on the game thread would hang the match instead of ending it.** ASSUMED from the code, not provoked in a real bridge. The harness shows the engine itself is isolated: a real `StackOverflowError` or an engine exception unwinds out of `Match.startGame` and ends only that game. But the bridge starts games through `HostedMatch` → `GameAction.invoke` → `ThreadUtil.invokeInGameThread`, a bare `execute()` with no handler (`HostedMatch.java:280`, `ThreadUtil.java:44`), and `PlayBridge.java` sets no `UncaughtExceptionHandler`. The game thread dies, nothing tells the bridge, and the players get C2's silence. Fix: catch `Throwable` around each match's game runnable (or set an uncaught-exception handler on the game pool) and send `fatal` for that match. It belongs with lane-multimatch's per-match context. | cardtable (bridge; lane-multimatch) | fixed in h-live: each match's start-game hook gives its game thread a handler that sends `fatal` (one-match JVM: exit 1); a JVM-wide default covers a throw before the hook. Provoked in a real bridge with the test-only `-Dcardtable.fault=game-throw` |
| H10 | C7 | **A burst of cold starts gets close to the start timeout.** 10 matches requested at once on claw-9 (CI load ~20 on 12 threads): each cold JVM booted in 44.7–52.4 s, against 9.6 s for one alone. Players waited ~50 s, and the slowest start was 8 s inside the 60 s `whenRunning` timeout (`socket.ts:573`), so a busier box or a bigger burst would fail starts with a 500. Repro: C7. Fix: start cold JVMs through a small queue (2–3 at a time) and show the player their place in it, or keep more warm spares. On the claws, the same burst is what a failover (D5) produces. | cardtable | **fixed, awaiting land** (lane H-start, 2026-10-26): `apps/server/src/play/start-queue.ts` wraps the one host factory `attachPlay` holds, so every start (room, rematch, tournament, vs-AI) goes through it. The warm spare is served first; otherwise at most `CARDTABLE_PLAY_COLD_STARTS` (default 2) match JVMs boot at once beside the one replacement spare, the rest wait in order, `GET /api/play/queue` tells each waiter its place, and the start timeout counts from the boot. 8 starts at once on a claw: RED 40352572782 (7 match boots at once, each 36.7–41.2 s, last 201 at 42.9 s); GREEN 40355072517 (peak 2 match boots / 3 JVMs, each 11.9–14.3 s, all 201, last at 37.3 s, every waiter told 5→1). |
| H11 | B (lane-multimatch) | **One AI-only static can still leak between matches in a shared JVM.** `ChangeZoneAi.multipleCardsToChoose` (used when the AI resolves Intuition-style "choose several" effects) is a static list, so two matches in one `--host` JVM can race on it. Found by reading the code while making everything else per match (`docs/spikes/multi-match-jvm.md`); not provoked. Rare and AI-only. Fix: move it onto the AI player or the call's own locals in the fork. **Fixed** in fork `5feb9cf1` (lane H-fork): the plan lives on the deciding player's `AiController` (`getPlannedChoices`). The sweep for other shared state on the AI path found four unlocked lazy caches every game thread fills (`CounterKeywordType`, `CounterCustomType`, `Card.getCardForUi`, `Keyword.getKeywordSet`), now locked; the full list is in `docs/spikes/multi-match-jvm.md`. | cardtable (fork) | fixed (fork `5feb9cf1`) |
| H12 | manager, 2026-10-26 (claw run 40374252237) | **An AI-against-AI match dies at start, and in `--host` mode the death reads as a clean stop.** Two `ai:true` seats in one `--host` JVM: the match answered `ready`, then its `bridge-match-…` thread threw `ExceptionInInitializerError` (cause: Forge's `HostedMatch.startGame` watches a game with no human through `GuiBase.getInterface().getNewGuiGame()`, the desktop GUI in the bridge, whose Swing frame throws `HeadlessException`, so `CMatchUI`→`VCombat`→`DragTab`→`SRearrangingUtil.<clinit>` dies; an `Error`, past `startHosted`'s `catch (Exception)`) and the host reported `stopped` for it, not `fatal`. No server path is known to start an AI-only match, but nothing refuses one either. This also settles a stop-path question from H6: with two seats and at least one human, a stop's concede always ends the game, so `endGame` needs no draw. Fix: refuse a start with no human seat in the bridge's config parse (or support it), and make an uncaught throw on a `--host` match thread send `fatal` for that match (H9's handler covers game threads, not the bridge's own match thread). | cardtable (bridge) | **fixed** (lane H12, 2026-10-26): `MatchContext.refusal()` refuses a config with no human seat in every mode, before Forge is touched (`--host` answers `rejected`), and `MatchSpec` types seat 0 as human, which every create path already sends. `startMatch` catches every `Throwable` on the match's own thread through `MatchContext.fail`, before its seats close: `fatal`, then `stopped`. Proof `h12-host-fatal.jvm.test.ts` with fault `match-throw`: red 40375747037, green 40380687876 (plus multi-match and liveness). |
| H13 | A10 (claw-9, 2026-10-27) | **The agent's port is open to every node on the mesh VPN, not only the controller.** The controller-only firewall rule covers the LAN address, but the node's blanket allow on the mesh interface also admits the port; from claw-8 (a CI node) a plain HTTP request reached the agent and got its 401. Any CI job on any claw can talk to the agent; only the agent's own request signatures stop it. `--check` reports `portOpenToController`, which is true and does not say this. Repro: from another claw, `curl http://claw-9:7621/status`. | fleet-manager (a deny for the port on the mesh interface, and a reachability check from a non-controller node); cardtable keeps signed requests either way | fixed in fleet-manager 0.34.93 (a raw-table drop ahead of the mesh's own accept), verified from claw-8 |
| H14 | A6 (claw-9, 2026-10-27) | **Global memory pressure breaks match quality while protection holds.** In A6 every match lived and the slice's own pages were barely touched (16.8k scanned): `memory.min` worked. But the JVM's threads stalled 66 s in global direct reclaim and swap IO: AI p95 69 ms (5× unloaded), paced p99 1.24 s, 4 AI cutoffs. `runners.slice`'s MemoryMax is exactly RAM − the slice, so CI plus anything else on the box reaches global pressure. Repro: A6. | fleet-manager: on a hosting node, `runners.slice` MemoryHigh below its Max, so CI reclaims inside its own slice first | mitigated. fleet-manager's MemoryHigh stops CI from causing it. Against a non-CI consumer, the host agent pre-touches its heap: A6 went from 3–4 cutoffs and a 1.2–2.4 s paced p99 to 0 cutoffs and 36–39 ms, with AI p95 at 24.8 / 32.3 ms against a 26.6 ms gate. **Placement rule:** no slice on a node whose non-CI memory is unbounded (claw-4's pm2, which the operator ranks above cardtable, so it is not capped). |
| H15 | fleet-manager re-declare, 2026-10-27 05:46Z | **An agent restart killed every match on the node.** The JVMs lived in the agent's own service cgroup, so a `--restart` or a re-declare ended every game. | fleet-manager: `Delegate=yes` + `KillMode=process` (0.34.94); cardtable: the agent keeps itself and each JVM in leaf sub-cgroups and adopts survivors on start (the §A test agent, now the host agent `apps/agent`) | fixed, verified on claw-9 2026-10-27 (H15 check in A results) |
| H16 | manager, 2026-10-27, from code and `ss -ltnp` on hokon | **Each match's Forge server listens on every interface.** `FServerManager` calls `b.bind(port)` (forge-gui `FServerManager.java:263`), so each bridge JVM's per-match port is open on `0.0.0.0`. On hokon today that includes the mesh interface, which every tailnet device reaches (H13's mechanism). On a claw, CI on the same box reaches it over loopback too. The bridge's own seats are the only intended clients. Not yet tested: whether a stranger can join or read a lobby, and whether a stranger's connection closing reads as a seat disconnect, which since H3 ends the match. Test on a dev JVM, never prod. | cardtable: bind the per-match server to loopback (a fork change), and refuse connections that aren't the bridge's own seats | **fixed, awaits the jar** (lane-h16, 2026-10-27). Tested on a dev `--host` JVM (`h16-stranger.jvm.test.ts`, pin `5eff8436`): the port listened on `0.0.0.0`, and a stranger that chatted without logging in completed Forge's handshake, stayed open, and had its line rebroadcast (it heard its own echo). A login after `ready` got no slot and no state (no OPEN slot is left), and a connect-and-close or a stranger's close was not a seat disconnect: the match lived and its seat's concede ended the game. From the code, not provoked: a stranger logging in before the seats would take slot 0, receive both decklists, and fail the match. Fix: fork `886d7812` (`startServer(port, bindAddress)`, `requireCredential`: the first thing a peer sends must be a login with the server's credential or it is closed; nobody unlogged-in is broadcast to or heard), and the bridge binds each match's server to loopback with a random per-match credential only its seat clients get. Green on a scratch overlay of the pin. |

### What the B and C findings change in the hosting design (lane-breakit)

- **"The JVM is alive" is not "the match is alive."** A stopped JVM (H2), a JVM after a 45 s
  pause (H3) and, by the code, a game thread that threw (H9) all keep a live pid and a match
  that will never move again. The host agent's health check has to be per match: a liveness
  line from each match's own context and a decision watchdog. The pid poll and the D2
  heartbeat window are not enough.
- **Some failures can only be fixed by ending the whole JVM** (H6, H7, H3 in a shared JVM).
  The multi-match host needs a planned way to drain a JVM (migrate its matches, then
  recycle it), not only the unplanned failover of D1. That drain is also what makes H7's
  heap watchdog useful before the spiral.
- **Failover is a cold-start burst** (H10): 10 cold JVMs together took ~50 s on claw-9. A
  claw holding 50 matches cannot restore them as 50 JVMs. That favours restoring into
  already-warm multi-match JVMs on other claws, with starts queued.
- **Slice sizing has a floor:** `MemoryMax` ≥ `-Xmx` + ~400 MB, G1 forced below 1.8 GB
  (P3), `-XX:+ExitOnOutOfMemoryError`, `-Dforge.net.heartbeatTimeout` raised (H3, H7, H8).
- **The crash path the server already has stops at the screen** (H1). Every failure path
  above ends in H1, so H1 is the first fix.
