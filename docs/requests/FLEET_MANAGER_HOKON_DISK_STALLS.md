# Request to hadoku-fleet-manager: hokon's root disk stalls take the tailnet down with it

From: hadoku-cardtable, 2026-11-27. Status: **OPEN**.

## What happened

On 2026-11-27 between 04:39Z and 07:30Z the claws fenced cardtable's Forge JVMs several times
(`FENCE_MS` = 10 s with no word from the coordinator on hokon), and prod lost matches. Cardtable's
own share of it was synchronous `fsync` on its event loop; that is fixed on cardtable's side
(room and draft snapshots are written off the loop, `packages/game-server/src/persist/snapshot-writer.ts`).
The rest is not cardtable's to fix:

- **hokon's root LV was saturated by writes from other workloads.** atop (`/var/log/atop`):
  the root LV (LUKS over btrfs) 96–101 % busy, PSI `io full` 57–75 %, and the writers were
  `rust-lld`/`cargo` builds and `claude` sessions (about 59 GB written in 7 minutes). No cardtable
  CI ran in that window. A btrfs `fsync` under that load forces a transaction commit and blocked
  for 7–27 s.
- **tailscaled blocked on the same disk.** A tailscaled thread sat in D state and its journal lines
  arrived batched under one timestamp. While it was stuck, hokon's tailnet link went quiet to
  **every claw at once** (05:32Z, 06:39Z) and to claw-8 alone (05:55Z), with cardtable's event loop
  not stalled (no `agent-watch-stalled`). Every claw then fenced, correctly, because from where it
  stands the coordinator had gone.

## What we ask

1. **Keep tailscaled off the contended disk.** Its state dir and logs on tmpfs (or
   `--no-logs-no-support` / a state dir that is not fsynced on the root LV), so a host write storm
   cannot stop the node's networking.
2. **Bound other workloads' write load on hokon's root LV**: an IO weight or `io.max` for build and
   session slices (cgroup v2), or their build dirs on another device, so one cargo build cannot
   hold every other process on the root disk in D state for tens of seconds.
3. **Tell us if hokon is expected to see this again**, so we can decide whether to move the
   coordinator off hokon or lengthen `FENCE_MS` (that is the operator's call, and not asked here).

## How to see it

- `atop -r /var/log/atop/atop_20261127 -b 06:05 -e 06:12` (PRD for writers, DSK for busy %).
- `journalctl -u tailscaled --since '2026-11-27 05:30Z' --until '2026-11-27 06:45Z'`: lines
  batched under single timestamps.
- cardtable's prod log: `snapshot-write-slow` (added 2026-11-27) records every snapshot write over
  1 s from now on, so the next storm shows up as a disk stall rather than as lost claws.
