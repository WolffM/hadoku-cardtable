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

- Claws online, Java 21 on every claw that may host (claw-1, 2, 6 lack it), and
  our per-pin jar and `res` present.
- Status we can read: online, health findings, drains, declared resources.
  Notice of a drain *before* it happens, so we can move matches off first.
- Resources served as declared: memory and cores reserved for the host role are
  not given to CI. A CI job on a host claw could also read a live match's hidden
  cards from `/proc` or its run directory (the repo is public), so a host claw
  should not run CI at the same time.
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
