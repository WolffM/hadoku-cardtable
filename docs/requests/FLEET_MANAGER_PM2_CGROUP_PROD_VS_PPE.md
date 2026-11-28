# Request to hadoku-fleet-manager: keep PPE's memory from reclaiming prod's

**From:** hadoku-cardtable (lane pool-jvm-memory)
**To:** hadoku-fleet-manager (`deploy/systemd/pm2-protection/`)
**Date:** 2026-11-28
**Status:** roadmap ask, **not for before Sunday's tournament** and not a blocker. Cardtable's own
fix (below) removed the garbage that filled the swap; this asks about the shared cgroup that
let it land on prod.

## What we measured (hokon, 2026-11-28 ~19:20Z)

- `pm2-hadoku.service` holds prod cardtable, PPE cardtable, the tunnel and mgmt-api in one
  cgroup: `memory.current` 11.8 G, `memory.high` 20 G, `memory.low` 16 G, `memory.min` 12 G,
  `memory.swap.max` 4 G with `memory.swap.current` 3.7 G, `memory.peak` 21.6 G,
  `memory.events high` 805,886, `memory.swap.events fail` 64,159,299.
- Prod's idle pool JVM (PoolService, pid 767963) had 1.67 G of that swap and 115 MB resident.
  PPE's pool JVM, in the same cgroup, was fully resident at 1.77 G.
- Protection is per cgroup, so `MemoryLow`/`MemoryMin` protect the whole of PPE as much as prod.
  When PPE runs a soak (pre-soak, 2026-11-28: PPE ~9.4 G anon), prod's quiet processes are the
  ones the kernel reclaims.

## What cardtable changed (main, rides the next release)

Every Forge JVM runs a G1 periodic GC after 5 idle minutes, which hands committed heap back and
keeps the live set paged in. The pool JVM is capped at 768 MB (it was uncapped: 8 G, a quarter of
`MemoryMax`). Measured: the pool settles at ~340 MB heap / ~500 MB RSS instead of 1.1–1.75 GB.

## The ask

Give prod and PPE separate memory protection: for example cardtable-ppe in its own unit or
sub-cgroup with no `MemoryLow` of its own, so the 12–16 G floor protects prod and the tunnel,
not PPE's soaks. How (a second PM2 daemon, systemd delegation, or another way) is yours to
choose. We have no change to make on our side for it.
