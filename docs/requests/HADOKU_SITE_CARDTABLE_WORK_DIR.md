# Request to hadoku_site: pin cardtable's work dir off the shared btrfs

**From:** hadoku-cardtable
**To:** hadoku_site (`services/pm2/cardtable-wrapper.mjs`, `ecosystem.config.cjs`, the pm2 unit's drop-ins)
**Date:** 2026-11-26
**Status:** a write-up. Nothing on your side was changed. It is not a blocker: cardtable's own fix
(below) already removes the stall we saw most often.

## 1. What happened

Every "Claw heartbeat lost" and "hokon promoted to backstop" alert from 11-22 to 11-26 lines up
with the prod cardtable server's own event loop stalling for 3 to 23 s. Three of those stalls ran
past the 10 s fencing window, so the healthy claws fenced their own JVMs ("no word from the
coordinator for 10 s"). At 2026-11-25 00:13:12Z claw-8 was lost and the loop froze for 16.2 s, so
claw-9 and claw-10 went down with it.

## 2. What we measured (2026-11-26, hokon)

- **Where the time goes.** In 19 of the 23 losses in the prod log, the whole stall sits between
  `jvm-ended` and `jvm-launched`: cardtable relaunching the lost warm JVM onto the lost claw, which
  costs one `mkdirSync`, one `writeFileSync` and one `renameSync`. That took between 2 ms and 17 s.
  Everything after it took about 1 ms. Cardtable no longer does this (§4).
- **It is IO, not swap or CPU.** Two copies of the same loop ran side by side for 90 s at load
  ~115–165 on 12 cores: mkdir, a small file write, a rename, then a directory rename, every 200 ms.

  | filesystem | slowest single op | p99 | worst loop lag | major faults |
  | --- | --- | --- | --- | --- |
  | btrfs (`/`, `~/.cache`) | 4.3 s | 3.7 s | 4.3 s | 0 |
  | tmpfs (`/tmp`) | 0.6 ms | 0.1 ms | 6 ms | 0 |

  On the same CPU at the same moment, tmpfs never stalled. A btrfs metadata op waits on the
  filesystem's transaction commit, which every writer on `/` shares (CI runners, builds, Docker).
- **Why prod is on btrfs.** The server resolves its work dir to `$TMPDIR/cardtable-play` and its
  claw records to `$TMPDIR/cardtable-play-claws`. The live prod process has
  `TMPDIR=/home/hadoku/runner-tmp`, but the pm2 daemon has no `TMPDIR`. So the value came from
  the shell that last ran `pm2 restart` for cardtable: a CI job, where `TMPDIR=$HOME/runner-tmp` is
  set for the runners. The oldest `claw-*.failed-*` record dir on btrfs dates from 2026-11-14.
  Before that, prod's work dir was `/tmp/cardtable-play`, on tmpfs.
- **What the unit already does.** `60-priority.conf` sets `CPUWeight=1000` and `IOWeight=1000`.
  `65-memory-floor.conf` sets `MemoryMin=12G` and `MemoryLow=16G`, and `MemorySwapMax=4G` is set
  through `set-property`. The cgroup's `memory.pressure` is about 0.1 % and its `io.pressure` full
  avg60 is about 13 %. `memory.swap.current` is at the 4 GiB cap (prod node: 67 MB in VmSwap), but
  it is not what stalls the loop (zero major faults above).
  **`IOWeight` does nothing here:** every NVMe queue runs scheduler `none` and
  `io.cost.qos` has `enable=0`. `io.weight` only acts under BFQ or io.cost. Even with it on, no
  cgroup weight can move one process ahead in a btrfs transaction commit.

## 3. What we ask

1. **Pin the work dir in the wrapper** rather than inherit it from whoever restarts pm2: set
   `CARDTABLE_PLAY_WORK_DIR` explicitly, and the same for PPE with its own path. Prefer a tmpfs
   path (`/tmp/cardtable-play`, which is where prod ran until about 11-14). It only has to survive
   a process restart, which is what match hand-over needs, not a reboot. The claw records follow
   it (`<workDir>-claws`). If tmpfs is unwelcome because `/tmp` has been filled before, a dedicated
   small tmpfs mount works just as well. So does any filesystem that is not `/`'s btrfs, for
   example `/mnt/black` (ext4 on its own NVMe).
2. **Stop passing a restarting shell's `TMPDIR` through.** Set `TMPDIR` in the wrapper's `env`, or
   drop it, so a deploy from a CI runner cannot move prod's scratch onto the runners' disk. The same
   leak can move anything else that reads `os.tmpdir()`.
3. **Swap and CPU (lower priority, given §2):**
   - `MemorySwapMax=4G` already caps the cgroup's swap, and it is full. To keep the server's own
     pages resident, `MemorySwapMax` could go to 0 on a separate cardtable cgroup, if pm2 can give
     each app one (today pm2 is a single cgroup holding mgmt-api too). Per process,
     `oom_score_adj` / `pm2-oom-guard` is the tool you already use.
   - Do not rely on `nice` or `CPUWeight` for this. The 4 s stalls happened while a CPU-bound
     process on tmpfs on the same host kept a 6 ms worst-case lag.
   - `IOWeight` only takes effect once BFQ is on for the root device or `io.cost` is enabled.
     That is a fleet-wide choice, and it would still not help a btrfs commit.

## 4. What cardtable changed on its side

- A pool no longer stages a JVM on a launcher that cannot launch one
  (`JvmLauncher.unavailable()`), so a lost link no longer writes anything for that claw.
- The rename that sets a failed claw's records aside (up to 1.6 s on 11-24 21:00Z) now runs off
  the event loop. That claw's next pool waits for it to finish.
- Still on the server's loop: the match stream's `appendFileSync` for each bridge line, and the
  `jvm.json` rewrite for each placement. Under the btrfs contention in §2 those stall live play
  too, which is why we ask for §3.1.

## 5. To check after the change

```sh
P=$(pm2 pid cardtable); C=$(pgrep -P "$P" -f apps/server/dist/index.js)
tr '\0' '\n' </proc/$C/environ | grep -E '^(TMPDIR|CARDTABLE_PLAY_WORK_DIR)='
findmnt -T "$(tr '\0' '\n' </proc/$C/environ | sed -n 's/^CARDTABLE_PLAY_WORK_DIR=//p')" -o FSTYPE
```
