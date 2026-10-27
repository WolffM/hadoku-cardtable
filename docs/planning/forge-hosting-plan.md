# Forge hosting at 10× — plan, 2026-10-24

The goal is 10× today's ceiling: **100 concurrent matches**, hosted on the claws
rather than on hokon. The site (Node server, ~85 MB) is not the problem; Forge
instances are. This doc records what is measured, the operator's rulings, and
the work in order. **VERIFIED** means a command or a file says so; **ASSUMED**
means it doesn't yet.

## 1. Operator rulings (2026-10-24)

1. **One JVM per match is out.** At ~750 MB each, 100 matches is ~75 GB.
2. **fleet-manager's scope is narrow:** get claws online, report claw status,
   and faithfully serve the resources it declares. It does **not** choose hosts.
3. **Cardtable owns placement.** Which claw gets a match, and why, is our logic.
4. **No second chances.** If a claw disconnects or fails while hosting a match,
   the match **always** fails over to a different claw. It never returns to the
   claw that dropped it.
5. **Every failover is an emergency alert** to Discord through the
   `DISCORD_CARDTABLE_ALERT_WEBHOOK` secret (vault broker, ACL granted
   2026-10-24). Other availability alerts go to the same channel (§7).
6. **Ethernet will not happen on claw-1, 2 or 3** (2026-10-25). They are on
   Wi-Fi, so the bar for being a Forge host rises instead (§4.1). They stay CI
   claws. The host pool is claw-4, 5, 6, 8, 9, which is enough.
7. **Quality before capacity** (2026-10-25): *"we dont want to deliver bad
   quality games."* Where performance and match count conflict, performance
   wins (§4.2).
8. **hokon is an emergency backstop only** (2026-10-25), exactly as it is for
   CI's JIT queue: *"make sure we have the same functionality that we have for
   the JIT queue"* (§4.3).

## 2. What is measured

**Memory** — `docs/spikes/jvm-per-match.md` (wave 9), VERIFIED:

- A JVM holds ~170 MB of live card DB and ~650 MB RSS before playing anything.
- In one shared JVM each extra match adds **~10 MB live heap / ~27 MB RSS**;
  8 matches fit in a 384 MB heap.
- That workload was AI-vs-AI quest precons finishing in 2–6 s. Real matches are
  20–40 min, human-paced, with cube cards. **Per-match heap for a real match is
  not measured** — 10 MB is a floor.
- Prod today (`/proc/*/smaps_rollup`, `jstat`, 2026-10-24): idle spare 784 MB
  RSS with 138 MB old-gen used; a lane JVM mid-match 689 MB / 195 MB. Pages
  shared between JVMs: 24 MB.

**CPU** — not measured per match. What the source says, VERIFIED at the pin:

- Each AI decision runs on its own new thread with a **5 s wall-clock cutoff**
  (`MATCH_AI_TIMEOUT`, `AiController.java:1686`). Past it the AI takes its best
  so far. **Under CPU contention the AI plays worse, not slower**, and only the
  log line `AI eval thread at timeout:` shows it.
- Declare-attackers builds a fixed pool of `availableProcessors()` threads per
  call (`AiAttackController.java:876`).
- CPU cost is additive per match; sharing a JVM saves memory, not CPU.
- Upstream: stalled, crowded boards make declare-attackers take 30+ s on a fast
  machine; Java 20 was ~6× faster than 11 on the same state
  (Card-Forge/forge#3410). Game data is released after a match; the reported
  leak is the desktop image cache (#8990). Upstream has no server guidance and
  its own tests run one JVM per networked game (`MultiProcessGameExecutor.java`).

**The claws** — `~/.hadoku-mgmt/benchmark.json`, sha512 MB/s relative to hokon.
sha512 is a proxy; Forge is branchy, pointer-chasing Java, so older cores may do
worse than this:

| node | CPU | c/t | single | all-core | RAM | jdk21 |
| --- | --- | --- | --: | --: | --: | --- |
| hokon | Ryzen 5 7600X | 6/12 | 1.00 | 1.00 | 64 GB | ✓ |
| claw-8 | i7-9700F | 8/8 | 0.70 | 0.93 | 16 GB | ✓ |
| claw-4 | i7-6700 | 4/8 | 0.58 | 0.41 | 16 GB | ✓ |
| claw-6 | i5-6500 | 4/4 | 0.55 | 0.35 | 8 GB | — |
| claw-2 | i5-8350U | 4/8 | 0.54 | 0.31 | 8 GB | — |
| claw-1 | i7-4710HQ | 4/8 | 0.51 | 0.29 | 12 GB | — |
| claw-3 | i7-6600U | 2/4 | 0.48 | 0.18 | 16 GB | ✓ |
| claw-9 | i7-5930K | 6/12 | 0.44 | 0.45 | 32 GB | ✓ |
| claw-5 | FX-8350 | 8/8 | 0.15 | 0.14 | 16 GB | ✓ |

Single-core speed decides whether a host can run **vs-AI** matches at all (the
5 s cutoff). Cores × speed decides **how many**. Human-vs-human matches are
near-idle and probably fit anywhere. claw-5 is ASSUMED unfit for vs-AI.

## 3. Stress tests

Run on a claw, never on hokon (prod). Constrain with cgroups (`MemoryMax`,
`CPUQuota`, `AllowedCPUs`); the JVM reads the quota, which also sizes Forge's
attack pool correctly. Harness: extend `scripts/spike/jvm/src/MatchLoad.java`
(engine path, no `FServerManager`) with a **paced human seat** (2–15 s per
decision), **cube decks** (`mtgo-vintage-cube-2025-04`), per-decision timing and
an AI-timeout counter.

**Struggling** means the first of: any AI timeout; p95 AI decision at 2× its
N=1 value; human action → frame p99 > 500 ms; GC time > 10%.

| # | test | answers |
| --- | --- | --- |
| T0 | real prod matches: CPU seconds and live heap per match, sampled | the real per-match profile; everything else is calibrated by it |
| T1 | density: N = 8…256 paced matches per JVM, heap floor per N | memory per real match |
| T2 | CPU knee: AI-vs-AI at full speed, 1/2/4/8 cores | matches per core before the AI degrades |
| T3 | realistic mix: 30/60/100% vs-AI, held an hour | matches per box |
| T4 | bad neighbour: one #3410 stalled-board match beside N normal | does one runaway AI hurt the rest? |
| T5 | soak 8–24 h with churn | leaks, threads, metaspace |
| T6 | failure: OOM (`ExitOnOutOfMemoryError`), hung AI, stack overflow | detection time, matches lost |
| T7 | GC choice, AppCDS, Java 21 vs 25 | free wins |
| T8 | resurrection fidelity (§5) | what a restore loses, and how fast it is |
| T9 | per-claw calibration: one fixed-seed match set at N=1 and N=cores on every claw | the placement table's input |

## 4. Architecture

- **Many matches per JVM, several JVMs per claw.** Spreads blast radius.
  Prerequisites in the fork: drive matches through the engine rather than
  `FServerManager` (a per-JVM singleton), and remove per-match statics from
  `PlayBridge.java` (`matchId`, `seed`, `scenario`, `chooser`, `protocol`) and
  the global RNG (§5).
- **A host agent on each claw** spawns JVMs and relays the existing line
  protocol over a socket. `host.ts` already hides the JVM behind `MatchHost` /
  `MatchHostFactory`, so `match.ts` does not change.
- **The coordinator** (the Node server) owns placement, holds every match's
  decision log and snapshots, and runs failover. Nothing a restore needs lives
  only on a claw.
- **Placement** (ours): inputs are fleet-manager's status (online, healthy,
  declared resources), our T9 calibration, and the match type. vs-AI matches go
  to fast-core hosts; human-vs-human anywhere with room. Spread matches across
  hosts rather than packing.

### 4.1 Host eligibility

Ruling 4 makes every network silence longer than the failover window cost every
match on that claw, so a host must prove a quiet link, not just be online. A
claw is eligible only while **all** of these hold, measured, never declared:

| bar | measured by | starting threshold (tune from data) |
| --- | --- | --- |
| link quiet | coordinator → claw probe, 1/s, rolling 24 h | zero silences ≥ 3 s; p99 RTT ≤ 50 ms |
| link stable | carrier changes on the default route, rolling 7 d | ≤ 1 |
| fast enough | T9 calibration at N=1 | AI p95 ≤ half the 5 s cutoff (vs-AI tier); paced action p95 ≤ 250 ms (any tier) |
| capacity | fleet-manager's observed resources for the role | room for ≥ 1 JVM at its measured size |
| toolchain | `jdk21` earned | earned |
| status fresh | fleet-manager `--json` | observed within its stated freshness |

A claw that drops below a bar takes **no new matches** at once. Its live
matches stay unless it actually fails (ruling 4). It regains eligibility only
after a full window clean again.

**Measured 2026-10-25** (300 pings at 5/s, hokon → claw over Tailscale, direct
on the LAN): wired claws average ~6 ms with worst 32–68 ms. The Wi-Fi claws:
claw-2 avg 57 ms / worst 0.5 s, claw-1 74 ms / **2.7 s**, claw-3 132 ms / 1.3 s.
The Wi-Fi claws fail the link bars on this sample, and claw-1–3 are also among
the slowest CPUs, so the fleet loses little hosting capacity. A 48 h probe
(`cardtable-netprobe`, 1 ping/s per claw plus link counters every 5 min) is
running to set the thresholds and the failover window from real outage data.

**The 48 h probe, 2026-10-25 05:42Z → 10-27 05:42Z** (1 ping/s hokon → each claw over
Tailscale, ~172 400 replies each):

| claw | link | RTT p50 / p99 / p99.9 ms | silences ≥ 3 s | longest, reboot aside |
| --- | --- | --- | --- | --- |
| claw-4 | wired | 4.1 / 81 / 399 | 3 | 3 s |
| claw-5 | wired | 4.0 / 79 / 389 | 2 | 3 s |
| claw-6 | wired | 4.1 / 78 / 376 | 5 | 3 s |
| claw-8 | wired | 4.1 / 83 / 371 | 5 | 3 s |
| claw-9 | wired | 4.0 / 81 / 438 | 6 | 4 s (two of them during the A6 swap test) |
| claw-1 | Wi-Fi | 3.3 / 84 / 332 | 2 | 3 s |
| claw-2 | Wi-Fi | 134 / 606 / 1201 | 21 | 7 s |
| claw-3 | Wi-Fi | 135 / 1033 / 1318 | 17 | 5 s |

- Every claw has exactly one 50–99 s silence. They fell an hour or so apart on 10-25: claw-2 07:10, claw-5
  13:21, claw-1 14:22, claw-3 15:21, claw-4 15:36, claw-6 16:23, claw-9 17:23, claw-8 18:24. Each claw's
  link counters reset across it, so this is a rolling reboot, the kind fleet-manager now announces 15 min
  ahead (0.34.90). It is a planned drain, not an outage.
- One 3 s silence hit every wired claw at the same second (10-25 16:43:23Z). That was hokon's side.
- **Failover window: 10 s** (5 missed 2 s heartbeats). Reboots aside, no wired claw was silent longer than 4 s
  in 48 h, so 10 s fails over on nothing seen here. Detection costs at most 10 s of a real outage.
- **The link bar becomes "no silence ≥ 10 s in 24 h outside an announced drain", and p50 ≤ 20 ms.** The
  plan's starting bar of zero silences ≥ 3 s would rule out every claw, hokon's own blip included. claw-2 and
  claw-3 fail the p50 bar (134 ms), and claw-1 passes it on this sample but not the 2.7 s worst of 10-25. The
  hosting pool is the wired claws 4, 5, 6, 8 and 9.
- p99 is ~80 ms on every wired claw, inside the 250 ms paced-action budget.

### 4.2 Quality first (ruling 7)

- **Admission control, never degradation.** A match starts only on a host with
  quality headroom for its tier. If none has it, the match waits or is refused
  with a plain reason, and the capacity alert fires. A match is never squeezed
  onto a host that would make it laggy.
- **Hosts run at about half their knee.** Each host's per-tier cap is ~50% of
  the N where T1–T3 first trip a "struggling" criterion (§3) on that claw.
  The headroom absorbs a #3410-style heavy board, a GC pause or a CI neighbour
  that should not be there.
- **Best host, not emptiest.** vs-AI matches go to the fastest single core with
  headroom (claw-8 first). Human-vs-human matches fill the remaining hosts.
- **Live quality is watched, not assumed.** Any AI cutoff hit, and paced-action
  p95 over 250 ms, count against the host in real time. A host over either bar
  takes no new matches until it is clean again.

### 4.3 hokon as backstop (ruling 8)

hokon is not in the host pool. It takes Forge matches only when the CI backstop
would take CI jobs, with the same rules. Those rules are fleet-manager's,
in `src/runners/backstop.ts` and `backstop-force.ts`, read 2026-10-25:

| CI backstop (fleet-manager) | Forge backstop (ours) |
| --- | --- |
| **Outage**: fewer than half the registered claws answer, or zero registered. Promotes regardless of queue | fewer than half the eligible hosts (§4.1) answer, or none are eligible |
| **Saturation**: the oldest queued run has waited ≥ 100 s (`SATURATION_QUEUE_SECONDS`, the measured p90) | a match has waited ≥ N s for a host under admission control (§4.2). N comes from data, as 100 did |
| **Idle gate** on saturation: load ≤ 4/core, ≥ 12 GB available, /tmp ≥ 2 GB (the last refuses even a forced mint) | the same gate, the same constants |
| Saturation yields to prod work (the pm2-host rung, deploys); an outage does not | the same: a deploy or reserved prod work beats saturation, never an outage |
| **Hysteresis**: stands down after 3 calm ticks, or at once when the queue is measured empty | the same: no new matches once calm |
| **Unmeasured is not dark**: no probe this tick → hold the current state | the same: stale or unreadable fleet status holds, never promotes or demotes |
| **Operator force**: time-boxed (default 1 h, ceiling 6 h), on disk, shown; does not beat a drain or quarantine, or physical admission | a Forge force switch with the same shape, separate from CI's |

What is ours on top:

- **Promoted hokon still obeys quality first.** Its per-tier cap is half its own
  measured knee, lowered by what prod is using at the moment.
- **Demotion takes no new matches.** Live matches finish on hokon; moving a
  healthy match is a restore, and that costs quality for nothing.
- **Promote and demote are alerts** (🔺/🔻, §7).

**One implementation, not two.** The decision is pure and tested in
fleet-manager but not exported from `@wolffm/fleet-manager`. Cardtable asks for
it to be exported (request §6) and calls it with its own inputs, rather than
keeping a copy that drifts.

## 5. Failover and resurrection

**Detection.** The agent heartbeats the coordinator every 2 s; 3 misses, a
socket close, a JVM exit or a match-level error **fails the claw for every match
on it**. No retry on the same claw (ruling 4).

**Fencing.** A failed claw is quarantined from placement. Its agent kills its
own matches when it loses the coordinator for longer than the miss window, and
the coordinator ignores any line from a stale epoch. Otherwise a claw that comes
back would run a second copy of a match that already moved. The claw rejoins
placement only after fleet-manager reports it healthy again **and** a canary
match passes. ASSUMED: this is the reading of "no second chances" for the
*claw*; for the *match* it is unconditional.

**Restore, in two layers:**

1. **Turn-start snapshots** via Forge's `GameState` (`initFromGame` /
   `applyToGame`, `forge-game/.../GameState.java`). The bridge already applies
   one for scenarios. Snapshots capture life, every zone *including library
   order*, counters, mana, attachments, remembered/imprinted/exiled-with links,
   lands played, phase and turn. They lose until-end-of-turn effects (they skip
   `DetachedCardEffect`), the stack beyond pre-cast spells, pending and delayed
   triggers, and control timestamps. Taken at turn start most of that has
   already expired: the restore is "back to the start of this turn". ASSUMED:
   card ids change on apply, so browsers get a full reload.
2. **Exact replay** from seed plus every decision, the AI's included, against
   the match's own jar pin. Needs: a **per-game RNG**, because `MyRandom` is one
   static for the JVM (`MyRandom.java:34`) and `forge-ai` draws from it ~120
   times (the shared JVM needs this change regardless, or matches consume each
   other's randomness); and a hook that records the AI's answers, which the
   bridge never sees today. Snapshots then double as checkpoints: replay to
   turn N and compare.

Today a JVM death ends the match: `config.json` and `stream.jsonl` survive in
the crash record, but the AI and thread timing are not seeded, so they cannot
rebuild it (`apps/server/src/play/README.md`, seed section).

## 6. fleet-manager's part

Only what ruling 2 allows; it goes to them as a request in `docs/requests/`:

- Claws online, and Java 21 on claw-6, the one wired claw without it. claw-1,
  2 and 3 do not need it for hosting (§4.1).
- Status we can read: online, health findings, drains, declared resources.
  Notice of a drain *before* it happens, so we can move matches off first.
- Resources served as declared: memory and cores reserved for the host role are
  not given to CI. Since 2026-10-25 that is a **slice** with CI on the rest of
  the box (request §7–§8): claw-9 4 cores / 4G, claw-8 and claw-4 2 cores / 3G
  each. The operator capped the target at 100 concurrent matches on at least 3
  claws, and asked that the slices be stood up as load rises rather than held:
  claw-9's is the base, claw-8's and claw-4's are added by cardtable at ~70% of
  the live slices' quality cap and removed after a calm spell (hysteresis as
  in §4.3). Failover while only the base stands goes to hokon's backstop until
  the next slice is up.
- Secrecy: CI runs as the same user as the agent and `ptrace_scope` is 0
  (fleet-manager's §7 reply), so `0700` stops nothing; the only barrier is that
  CI runs only our own workflows. **The operator ruled 2026-10-25: the agent
  runs as its own user** (request §9). Ours to build with it: the agent fetches
  its jar and `res` from the coordinator and checks their sha256 (no
  CI-writable path to its code), and its port authenticates the coordinator.
- No reboot of a host claw without a planned drain ≥15 min ahead.
- A leased claw for the T0–T9 measurement window.

## 7. Alerts (`DISCORD_CARDTABLE_ALERT_WEBHOOK`)

One message per incident, not per match: a claw dying with 20 matches is one
alert listing 20. A follow-up when it resolves. Availability only; nothing that
needs no action.

| level | alert | fires when |
| --- | --- | --- |
| 🚨 | **Failover** | a claw dropped a match: claw, cause, matches moved, where to, restore time, what the snapshot lost |
| 🚨 | **Match lost** | a failover could not restore: no capacity, or restore error |
| 🚨 | **Coordinator down** | prod `/health` fails from outside. The server cannot report its own death, so this check runs elsewhere (a hadoku_site cron is the likely home) |
| 🚨 | **Crash loop** | the cardtable pm2 process restarted more than twice in 10 min |
| ⚠️ | **Capacity** | a match was refused for lack of a host, or free slots fall below 20% fleet-wide or 0 in the vs-AI tier |
| ⚠️ | **Claw heartbeat lost** | a host claw goes silent with no match on it |
| ⚠️ | **AI degraded** | AI timeouts on a host above a threshold (set from T2) |
| ⚠️ | **Pin not servable** | a host claw lacks the jar or `res` for prod's pin |
| ✅ | **Recovered** | the incident above has cleared |

## 8. Order

1. Request to fleet-manager (§6) and a claw lease.
2. T0 on prod, T9 calibration, then T1–T8.
3. Fork: per-game RNG, engine-driven matches, AI decision recording.
4. Many matches per JVM in the bridge.
5. Host agent and remote `MatchHost`; placement; failover with snapshots.
6. Alerts. The coordinator-down and crash-loop checks can land first; they
   protect today's single box too.
7. Exact replay; cut over.
