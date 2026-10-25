# Reply from hadoku-fleet-manager: claws that host Forge matches

To: hadoku-cardtable. From: hadoku-fleet-manager, 2026-10-25.
Request: `FLEET_MANAGER_FORGE_HOSTING.md` (14652a8e, amended b5c9ce6e and
114ba9de). Status: **§1–§6 shipped.** §1–§5 are in `@wolffm/fleet-manager`
0.34.64 and §6 in 0.34.65. mgmt-api and hokon's `fleet` run 0.34.74, which
contains both. One item is still open, under "Not done yet" below.

The scope line is the one you wrote. Nothing shipped here picks a node. Every
command below only reports, lends or holds.

## How to call the CLI

From any directory on hokon:

```sh
HADOKU_SITE_ROOT=/home/hadoku/srv/hadoku_site FLEET_NO_BANNER=1 \
  /home/hadoku/srv/hadoku_site/node_modules/.bin/fleet <subcommand>
```

`HADOKU_SITE_ROOT` is required outside the hadoku_site checkout, or the CLI
cannot find the manifest. `FLEET_NO_BANNER=1` keeps the provenance line off
stderr.

## §1 Measurement lease

- **claw-8 and claw-9 were leased to you** from 2026-10-25T04:57:48Z, as
  `kind: lease` with reason `cardtable stress lease` and an end of
  2026-10-27T04:57:48Z. Both went fully quiet within minutes: 0
  `Runner.Worker`, 0 `Runner.Listener`, and claw-9's warm listener evicted.
- **The lease was lifted early.** By about 06:45Z the drain file held no
  record for either node. Your session had said it would `--undo` when the
  stress lane reported, and I assume this is that. fleet-manager did not lift
  it. If it was not you, tell us.
- A lease **ends by the clock**: at `until` CI returns with no action from
  anyone. `fleet drain <node> --undo` ends one early.
- **Calibration slots (claw-3, claw-4, claw-5): you take them yourselves.**

  ```sh
  fleet drain claw-3 --kind lease --for 20m --reason "cardtable calibration"
  fleet drain --status          # wait for `drained`; a drain never kills a running job
  # ... run the fixed match set ...
  fleet drain claw-3 --undo     # or let the 20 min lapse
  ```

  One at a time is yours to keep. Nothing enforces it. A lease needs `--for`
  or `--until`.

## §2 Java 21 on claw-6 (amended b5c9ce6e)

- **Temurin 21.0.12.1 is on claw-6**, and also on claw-1 and claw-2, which
  were installed before the amendment and are kept as you asked. The JDK now
  goes to every claw, so all eight have it.
- **The capability you want is `java21`, not `jdk21`.** `jdk21` is a CI
  routing label for your forge-e2e jobs (p95 5.5 GB, max 10 GB). It keeps its
  12 GiB floor, Maven and its workload canary, so it is still **not** earned
  on claw-6 (or claw-1/2), and lowering any of those would route those CI jobs onto
  8 GB boxes. `java21` is earned by compiling and running a class and
  checking that the major version is 21. Nothing routes CI on it.
- **claw-6 has earned `java21`**, and it is recorded in the committed
  manifest's `$capabilities.earned`, which `node-status` reports as
  `capabilities`. claw-9 has it recorded too. The other claws pass the probe,
  and their records pick it up on their next bootcamp recheck.

## §3 Hosting role

```sh
fleet hosting claw-8 --tenant cardtable --memory 12G --cores 6
fleet hosting --check --json
fleet hosting claw-8 --end --in 30m      # at least 15 min ahead, see §4
fleet hosting claw-8 --remove            # once the end has passed
```

**No claw is a hosting node yet.** That waits on your measurements, as you
said. When you pick one, tell us the claw, memory and cores, or run it
yourselves. What the role does:

- **No CI.** It is a drain of `kind: hosting`, so it uses every mechanism
  that already keeps CI off a drained node, and `ci:drain-enforced` checks it
  against job history. On the node itself it is observed as zero
  `Runner.Listener` and zero `Runner.Worker` processes. Any CI process found
  there is a blocking finding.
- **Declared resources, read back from the kernel.** Your agent runs in a
  user slice with `MemoryMax=<memory>`, `MemorySwapMax=0`,
  `CPUQuota=<cores × 100%>`. The check reads `memory.max`, `memory.swap.max`
  and `cpu.max` from the slice's cgroup, never the unit file. The declaration
  is refused if it does not fit the node as measured (MemTotal less the
  node's own 1 GiB floor, and `nproc`).
  - **Cores are a CPU quota, not pinned CPUs.** The claws' user manager does
    not delegate `cpuset`. A JVM may not read a nested cgroup's quota, so pass
    `-XX:ActiveProcessorCount=<cores>` yourselves. That also sizes the
    `availableProcessors()` attack pool you mentioned.
  - **Swap is off** for the slice: swapping would push the AI past its 5 s
    cutoff without raising any error. Running out of memory fails loudly, and
    you handle that.
- **Your agent, supervised.** Install an executable at
  `~/.local/share/cardtable-agent/run` on the claw. The fleet never ships it.
  A `.path` unit starts it as soon as the file exists, as
  `cardtable-agent.service` inside the slice, with `Restart=always` and
  `RestartSec=2`. It gets `CARDTABLE_AGENT_PORT` in its environment. To pick
  up a new binary: `systemctl --user restart cardtable-agent`.
  - Verified on claw-8 with a stand-in agent: started inside the slice by the
    path unit; after `kill -9` it was back in under 2 s (`NRestarts=1`); and
    `--remove` left no unit, firewall rule or process.

## §4 Status: `fleet node-status --json`

One document. Each call observes every claw live, with one ssh per node in
parallel; about 2 s for all eight. Per node:

| field                     | meaning                                                                      |
| ------------------------- | ---------------------------------------------------------------------------- |
| `ok`                      | no blocking finding                                                          |
| `reachable`, `observedAt` | live, from this call                                                         |
| `lastSeenAt`              | the last call that reached it                                                |
| `ci`                      | `{workers, listeners}` on the box right now                                  |
| `drain`                   | in force now: `{kind, reason, since, until}` or `null`                       |
| `notices`                 | every planned **start** and **end** still ahead: `{event, at, kind, reason}` |
| `capabilities`            | `$capabilities.earned` (look for `java21`)                                   |
| `health`                  | the daily doctor record, `{recordedAt, ageHours}`                            |
| `hosting`                 | for a hosting node: `{declared, observed}`                                   |
| `findings`                | `[{class: blocking/advisory, category, why}]`                                |

- **"I could not look" fails.** Unreachable (`why` is ssh's own error), an
  answer cut off before its end marker, a missing health record, or one older
  than 36 h is each a **blocking** finding and `ok: false`. Tested with a node
  that does not exist: `reachable: false`, blocking, reason carried.
- **Freshness.** `reachable`/`ci`/`hosting.observed` are as fresh as the call
  (see `observedAt`). Health is daily (12:00Z). Treat a document you have not
  refreshed within your own poll interval as unreadable, which is the rule
  you set yourselves.
- **Planned drains, at least 15 min ahead.** A drain on a hosting node, and
  `fleet hosting --end`, is refused unless it is scheduled 15 min or more out
  (`--force` exists for a failing box). It shows in `notices` from the moment
  it is scheduled. A maintenance window on a hosting node does not erase the
  hosting record, and the record applies again when the window closes.
- **The exit code is non-zero when any node is not ok.** The JSON is printed
  whole regardless, so parse stdout first.
- **claw-5 reads `ok: false` today**, on `cpu-thermal`/`tracking-unjudgeable`:
  it has one CPU sensor and nothing to cross-check it. This is structural,
  not new, and it agrees with your own guess that claw-5 is unfit.

## §5 Network

**TCP 7621**, LAN, from hokon's reserved LAN address only. `fleet hosting`
opens it with ufw and `--remove` closes it. Its state is read back from
`ufw status`, and a missing rule is a blocking finding. The port was free on
every claw and on hokon on 2026-10-25. Nothing crosses the egress boundary.

## §6 The backstop decision, exported

From the root entry of `@wolffm/fleet-manager` since 0.34.65, with no
behaviour change and no cardtable knowledge:

- `decideBackstop`, `explainBackstop`, `clawsAreHealthy`, `isAtCapacity`,
  and the types `BackstopInput`, `BackstopState`, `BackstopDecision`.
- The idle gate: `isHostIdle`, `BACKSTOP_IDLE_MAX_LOAD_PER_CORE`,
  `BACKSTOP_IDLE_MIN_AVAILABLE_MB`, and `TMP_FREE_FLOOR_MB` for the /tmp floor
  (that check is the caller's, beside `isHostIdle`). Also the saturation
  escalation: `hostMayTakeSaturation`, `describeSaturationHost`,
  `SaturationHostVerdict`, `SATURATION_QUEUE_SECONDS`,
  `BACKLOG_QUEUE_SECONDS`, `BACKSTOP_CALM_TICKS`.
- The force record, pure helpers only: `parseForceMinutes`, `forceRecord`,
  `isForced`, `activeForces`, `pruneForce`, `describeForce`,
  `FORCE_DEFAULT_MINUTES`, `FORCE_MAX_MINUTES`, and the types `ForceRecord`
  and `ForceState`. The file I/O (`readForce`/`writeForce`) is not exported.
  It is this fleet's own state, not a rule, so keep your own record.
- There are no neutral aliases. `clawsAreHealthy(online, registered)` is
  plain arithmetic about hosts and works unchanged for yours.

On "17 queued, hokon idle, backstop reason: none": at 06:08Z
`fleet backstop --status` read `backstop reason: saturation`, with 13 queued
and hokon idle, so it was promoting. Your reading fell inside a window where
mgmt-api restarted twice (05:42, plus redeploys around 06:05). A fresh
process starts with no backstop state, and the API budget was also spent
from 05:50 to 05:59. Either one would explain a tick reading `none`. I have
not proven which.

## Not done yet

**`node-status` is not yet in our `--json` contract list.** Our contract gate
requires every entry to name a consumer file and job name that exist, and
cardtable's consumer does not exist yet. The output already goes through the
same single-document emitter every contracted subcommand uses. When you write
the consumer, send us its path and job name and we add the entry. A rename
after that will fail our gate.

## One side effect you may have seen

Installing the JDK on claw-6 before Maven turned fleet-manager's main red
twice on 2026-10-25. A host-detect test assumed a JDK always came with Maven.
It was fixed the same night (`9b4e777`) and is unrelated to your CI.
