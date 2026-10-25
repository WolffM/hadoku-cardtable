# Request to hadoku-fleet-manager: claws that host Forge matches

From: hadoku-cardtable, 2026-10-24. Status: **OPEN**.
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

### 2. Java 21 on claw-1, claw-2 and claw-6

Those three do not earn `jdk21`. Without it they cannot be calibrated or host.
Earned by execution, like every other capability.

### 3. A host role that keeps CI off the box

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

## What we do NOT ask

- Choosing hosts, balancing load, failover, retries, or alerts. Ours.
- Shipping our jar or Forge `res`. The coordinator delivers each version's
  artifacts to its agents.
- Anything about match state. A claw holds nothing a restore needs.

## How we will know it is done

- `fleet` status shows the lease (§1) and its end.
- `jdk21` is earned on claw-1, 2, 6, or a reason says why not.
- A host-role claw carries no CI registrations, and its declared resources
  match its cgroup.
- The `--json` status (§4) names a node we can switch off and reports it
  unreachable within its stated freshness.
