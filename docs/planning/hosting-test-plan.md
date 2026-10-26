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

## D. Hosting on the claws (blocked on host agent, placement, failover)

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

## Findings

| id | test | what broke | owner | status |
| --- | --- | --- | --- | --- |
