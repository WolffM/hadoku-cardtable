# Request to hadoku-fleet-manager: claws that host Forge matches

From: hadoku-cardtable, 2026-10-24. Status: **OPEN** — §1–§6 answered in
`FLEET_MANAGER_FORGE_HOSTING_REPLY.md`; §7 (2026-10-25) is new and open.
Plan this serves: `docs/planning/forge-hosting-plan.md` (cardtable repo).

## Context

Cardtable will host its Forge matches on the claws instead of hokon, aiming at
100 concurrent matches (10× today). Each claw runs a cardtable **host agent**,
which runs several JVMs, each hosting many matches. Cardtable's coordinator
(the prod Node server on hokon) talks to every agent.

**The scope line, set by the operator on 2026-10-24.** fleet-manager gets the
claws online, reports claw status, and faithfully serves the resources it
declares. **Cardtable owns placement**: which claw hosts which match, failover,
quarantine and alerting. Nothing below asks fleet-manager to choose a host or
to judge a match.

## What we ask

### 1. A measurement lease, now

Clean stress numbers need claws with no CI on them. Today claw-8 and claw-9
are running CI jobs while we would measure (2 and 1 `Runner.Worker` at
2026-10-24 ~21:48 claw-local time).

- **Drain claw-8 and claw-9 from CI for 48 h**, recorded as a drain with a
  reason (`cardtable stress lease`) so `fleet` status shows it.
- **One at a time, ~20 min each, on every claw with `jdk21`** (claw-3, 4, 5):
  a calibration slot, which runs one fixed match set. Tell us the window, or
  hand us the command that takes and releases the slot.
- Say when each lease starts and ends. Cardtable will not run heavy load on
  a claw outside a lease.

### 2. Java 21 on claw-6

claw-6 does not earn `jdk21`. Without it, it cannot be calibrated or host.
Earned by execution, like every other capability.

**Amended 2026-10-25:** claw-1 and claw-2 are dropped from this ask. They are
on Wi-Fi, which will not change, and the Wi-Fi claws fail cardtable's
host-eligibility bars (`docs/planning/forge-hosting-plan.md` §4.1). If you
already installed Java 21 there, keep it; nothing needs undoing.

### 3. A host role that keeps CI off the box

**Superseded by §7 (2026-10-25):** the role is now a reserved slice with CI on
the rest of the box, not a CI-free box. The whole-box role you shipped stays
useful as the fallback §7 names.

A claw can be marked as a **cardtable host**. While it is one:

- **No CI runs on it.** Two reasons. Resources: a CI job competes with live
  matches for CPU, and the AI's 5 s decision cutoff turns contention into
  worse play. Secrecy: a CI job (this is a public repo with self-hosted
  runners) could read a live match's hidden cards from `/proc` or the match's
  run directory.
- **The memory and cores you declare for the role are really there.** Read
  from the observed cgroup state, not from what was written (your own rule).
- **You keep our agent running** as a supervised resident service and restart
  it if it dies. Cardtable treats an agent restart as a failure and moves that
  claw's matches, so a restart only has to bring the agent back, not keep a
  match alive.

Which claws get the role is decided after measurement (§1). Our first guess
is claw-8 for vs-AI matches (fastest single core after hokon), with claw-9
and the 16 GB claws for human-vs-human.

### 4. Status we can read

A machine-readable `--json` under your contract, per node:

- online / unreachable, with the time it was last observed;
- health findings (advisory / blocking);
- drains: current, and **planned drains before they take effect**, with a
  lead time of at least 15 min, so cardtable can move matches off first;
- declared resources for the host role (memory, cores) and what is observed.

Your rule applies as written: "I could not look" must fail, never read as
healthy. Cardtable will treat a stale or unreadable status as a failed node.

### 5. Network

The coordinator on hokon must reach each host claw's agent on one TCP port on
the LAN. Pick the port and tell us; nothing needs to cross the egress
boundary.

### 6. Export the backstop decision (added 2026-10-25)

The operator ruled that hokon is an emergency backstop for Forge matches
exactly as it is for CI, with "the same functionality that we have for the JIT
queue". Cardtable will make its own backstop call with its own inputs (hosts
answering, a match waiting for a host). It should not reimplement your rules:

- Export from `@wolffm/fleet-manager`'s root entry: `decideBackstop` and its
  types, `clawsAreHealthy`, the idle-gate check and its constants
  (`BACKSTOP_IDLE_MAX_LOAD_PER_CORE`, `BACKSTOP_IDLE_MIN_AVAILABLE_MB`, the
  /tmp floor), and the force record's parse/expiry helpers.
- If the names carry CI words (`claws`, `queue`), a neutral alias is welcome
  but not required.
- No behaviour change, and no knowledge of cardtable. It is a library export,
  under your contract rules, so a later change to the rules reaches both
  backstops in one publish.

### 7. The reservation, sized (added 2026-10-25)

Measured since §1 (`docs/spikes/forge-scale.md`): one JVM holds many matches,
and the operator has set the realistic target at no more than 100 concurrent
matches, on at least 3 claws for redundancy. That is far less than a whole
claw, so the ask shrinks from three CI-free boxes to a slice of each.

**The claws and the slice.** `--tenant cardtable --memory 4G --cores 4` on:

| claw | why |
| --- | --- |
| claw-8 | fastest; 256 vs-AI matches inside our quality cap, measured whole-box |
| claw-9 | 128 vs-AI, ≥256 human-vs-human, measured whole-box |
| claw-4 | next fastest wired claw; 24 vs-AI matches per CPU measured with CI running |

claw-6 is the alternate if one of these cannot take the role (8 GB is enough
for a 4G slice). Not claw-5 (16 matches per CPU, and your own `ok: false`).

Why 4 cores and 4 GB: claw-4, capped at 2 CPUs and 1.5 GB **while CI ran on the
same cores**, held 48 vs-AI matches inside the quality cap. Twice that slice
lets any one of the three carry all 100 matches alone, so the set survives
losing two claws. Average use is much lower — 100 matches burn about 1–2
cores and ~1.5 GB per JVM — the rest is headroom against an AI burst. We run
two JVMs per claw inside the slice (a JVM out of memory loses every match in
it; two halves that and lets us restart one while the other serves). That is
ours to do; it changes nothing you serve.

**Shared, not CI-free.** CI keeps everything outside the slice. What we need
instead of the drain:

- **A guarantee, not just a ceiling.** `CPUQuota`/`MemoryMax` stop us using
  more; they do not stop a CI job taking the slice's share. We need the slice
  to get its cores and memory while CI is busy: e.g. CI runners confined to
  `nproc − 4` cores' worth and the slice's `MemoryMin=4G`, with the agent's
  OOM score set so a CI job is killed first. Pick the mechanism; tell us what
  `fleet hosting --check --json` reads back to prove it.
- **`-XX:ActiveProcessorCount` stays ours**, as your §3 says.
- **Secrecy, relaxed by cardtable:** §3's second reason was that a CI job could
  read a live match's hidden cards. CI on the claws runs only WolffM's own
  workflows (fork-PR runs are never approved), so we accept CI beside the
  slice. Our side: the agent keeps run directories `0700`.
- If a shared slice cannot be guaranteed, say so; the fallback is your
  existing whole-box role on claw-8 and claw-9 only, plus claw-4 shared.

**No reboot without notice.** Our 48 h network probe saw every wired
claw go silent for 50–99 s exactly once on 2026-10-25 — each one a reboot
(`claw-reboot.json`: claw-1, 2, 3, 4, 5, 6; claw-8 and claw-9 by uptime). On a
host claw each would have killed every match on it. Please route a reboot of a
hosting node through the planned-drain path of §4: scheduled 15 min or more
ahead and shown in `notices`, so we move matches off first. A failing box may
still reboot at once (`--force`); we fail over and alert on that.

**Not now.** No claw takes the role until cardtable's host agent exists; this
is the reservation to plan for. We will run `fleet hosting` ourselves when it
does, or ask you to.

## What we do NOT ask

- Choosing hosts, balancing load, failover, retries, or alerts. Ours.
- Shipping our jar or Forge `res`. The coordinator delivers each version's
  artifacts to its agents.
- Anything about match state. A claw holds nothing a restore needs.

## How we will know it is done

- `fleet` status shows the lease (§1) and its end.
- `jdk21` is earned on claw-6, or a reason says why not.
- A host-role claw carries no CI registrations, and its declared resources
  match its cgroup.
- The `--json` status (§4) names a node we can switch off and reports it
  unreachable within its stated freshness.
- §7: the shared mode, or the reason it cannot be; a hosting node's reboot shows
  in `notices` ≥15 min ahead.
