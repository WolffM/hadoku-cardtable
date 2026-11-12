# Request to hadoku-fleet-manager: `DelegateSubgroup=` on the agent unit

**From:** hadoku-cardtable, 2026-11-12 (wave 105, lane A). **Status: OPEN.**

## Context

cardtable's host agent (`apps/agent`) runs as `cardtable-agent.service` on every hosting claw, with
`Delegate=yes` and `KillMode=process` (so a restart kills only the agent's own process, H15). It
caps one extra service beside its JVMs — the draft bot — in its own cgroup leaf, under a memory
limit. w103's canary found this breaks every restart that happens while the draft bot has ever run:
the agent enabled `+memory` in the unit's own `cgroup.subtree_control` to make the memory controller
available to that leaf (cgroup v2 only grants a controller to a cgroup's children one hop at a time,
so every ancestor between the unit and the leaf using it needs the grant too), and left it there.
cgroup v2's "no internal process" rule then refuses to add ANY process to a cgroup whose own
`subtree_control` is non-empty — and systemd places a restarted unit's new main process directly
into the unit's own cgroup, before any of the agent's own code runs. The claw's own log:

```
Found left-over process 3576655 (java) in control group … Failed to spawn executor: Device or
resource busy … Failed with result 'resources'.
```

**cardtable's fix, landing this wave, closes one of the three ways this can happen outright, and
prepares cleanup for the other two that neither can reach without this ask:**

1. A **planned restart** (`deploy.sh install`, `systemctl restart`) now clears the grant on
   `SIGTERM`/`SIGINT` before the process exits — the agent has a signal handler for the first time.
   This closes the restart path completely, on its own, as long as the agent gets to shut down
   cleanly first.
2. A **stuck grant from an old build** has cleanup code ready (`migrate()`) — but it **cannot reach
   that state on its own**: with the unit's own `subtree_control` already non-empty, systemd
   refuses to place a new main process before ANY of the agent's own code, `migrate()` included,
   ever runs — the identical refusal this whole request is about. `migrate()` only ever gets to run
   for real once this ask lands (systemd then places the main process in a leaf directly, sidestepping
   the block) or after a human clears the stuck grant by hand first.
3. **What is not fixed, and cannot be from this side:** a **crash** (`SIGKILL`, an OOM-kill of the
   agent's own main process) while the draft bot is capped and up. Nothing in the agent's own code
   runs between the kernel killing the process and systemd trying to spawn the next one, so no
   amount of cleanup logic on our side reaches it — this is exactly what `DelegateSubgroup=` fixes,
   and it is also what lets (2)'s cleanup ever run against a stuck grant on its own.

## What we ask

**`DelegateSubgroup=agent` on `cardtable-agent.service`.** Measured on every claw just now:
systemd 257, unit file `/etc/systemd/system/cardtable-agent.service`, `Delegate=yes`,
`KillMode=process`, `DelegateSubgroup=` currently empty (unset).

`DelegateSubgroup=` is a systemd ≥ 254 unit directive (257 is on every claw already, so no systemd
upgrade is needed): with it set, systemd spawns a unit's main process into a **named subdirectory**
of the unit's own cgroup, not the unit's own cgroup directly — sidestepping the "no internal
process" rule entirely, regardless of what the delegate (us) has enabled in the unit's own
`subtree_control`. That is the one case (3 above) nothing on our side can close.

**Name it `agent`, to match what our own code already does.** The agent has, since before this
wave, moved its own process into a leaf named `agent/` immediately after starting (`cgroups.ts`
`delegate()`: a cgroup v2 requirement of our own — a cgroup can carry child cgroups with controllers
enabled, or member processes, never both, so the agent's own process cannot stay in the unit's root
once anything is capped there). That code already reads `/proc/self/cgroup` rather than assuming it
starts at the unit's root, and already strips a trailing `/agent` back to the unit path — written in
anticipation of exactly this directive. With `DelegateSubgroup=agent`, systemd places the restarted
main process into `<unit>/agent/` itself; our code finds it already there, computes the same unit
path it always has, and its own `mkdirSync`/`writeFileSync` into `agent/cgroup.procs` becomes a
no-op (the pid is already a member). We proved this in a unit test against a fake tree shaped like
your directive's effect (`apps/agent/src/agent.test.ts`, "resolves the unit correctly when it starts
already inside the agent subgroup"); we cannot prove the real kernel behaviour from here.

**If `agent` cannot be the name** (a reserved word, a collision with something `DelegateSubgroup`
itself creates, or any other constraint we would not know to ask about): tell us the name it must be
instead and we will change `delegate()`'s one regex (`/\/agent$/`) to match. Either way, say which
name, since our code only ever auto-detects that it is already inside **one specific, named**
subgroup — it does not discover an arbitrary one.

## What we do NOT ask

- Anything about the draft bot's own memory cap, or `caps/` under the unit — ours, already landing.
- A fix for the crash path from any mechanism other than `DelegateSubgroup=`. If you know a reason
  it cannot be set on this unit, say so and we will take the operational risk (a crash while the
  draft bot is capped needs a claw recovered by hand, as w103's claw-10 was) rather than block on it.

## How we will know it is done

- `systemctl cat cardtable-agent.service` shows `DelegateSubgroup=agent` (or the name you chose, with
  our code updated to match).
- A claw with the draft bot capped and up survives `kill -9` of the agent's main pid: the next
  `systemctl status cardtable-agent.service` shows it running again, with no "Device or resource
  busy" in the unit's journal, and the live JVM(s) it had are adopted, not fenced. We will run this
  ourselves under a lease drain once the directive is live; tell us when that is.
