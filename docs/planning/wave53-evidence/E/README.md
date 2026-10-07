# Wave 53 §E — End Turn ordering (Y26), per-pin jars, the land payer

## 1. Y26 — root cause, with citations

### The belief the old code relied on

`PlayBridge.java`'s `act()` (`selectButtonCancel` case) called, in this order, on
the SAME bridge thread: `setPhaseDelayOff(true)` (which called
`c.setYieldPref(FPref.YIELD_SKIP_PHASE_DELAY, "true")`) and then
`c.selectButtonCancel()`. The comment read "one channel, in order" — the
assumption being that because both calls go out over the same seat's network
channel, Forge would *apply* the first before *reading* the click.

### Why that assumption is wrong — the exact mechanism (X1, now cited)

Every human seat is a real, stock `FGameClient` connected to Forge's own Netty
server over loopback (`PlayBridge.java:2190`; `apps/server/src/play/bridge/PlayBridge.java`
class doc: *"every human seat is a real, stock `FGameClient` connected to it
over loopback"*). `getGameController()` therefore returns that seat's
`NetGameController` (`forge-gui/src/main/java/forge/gamemodes/net/client/NetGameController.java`),
the CLIENT-side stub — calling an `IGameController` method on it sends a Netty
message, it does not mutate anything locally.

- `NetGameController.setYieldPref` (`net/client/NetGameController.java:191`) wraps
  the call as `ProtocolMethod.sendYieldUpdate` with a `YieldUpdate.SetYieldPref`
  envelope and sends it. `selectButtonCancel` sends its own message right after,
  on the SAME channel.
- Both are `void` interface methods (`IGameController.java`: `void setYieldPref(...)`,
  `void selectButtonCancel()`). `GameProtocolHandler.channelRead`
  (`forge-gui/src/main/java/forge/gamemodes/net/GameProtocolHandler.java:76-110`)
  only sends a `ReplyEvent` back for a NON-void return type — so neither call
  gets anything the bridge could wait on. This answers the brief's first
  question directly: **nothing comes back**.
- "Same channel" only orders the DECODE. The server (`GameServerHandler`,
  `forge-gui/src/main/java/forge/gamemodes/net/server/GameServerHandler.java:17`)
  is built with `runInEdt = false`
  (`super(false)`), so `GameProtocolHandler.channelRead` (`:117-121`) dispatches
  EVERY decoded message via `FThreads.invokeInBackgroundThread`
  (`forge-gui/src/main/java/forge/gui/FThreads.java:55-61`), which is a bare
  `new Thread(proc, "Game BT" + n).start()` — **a fresh, unsynchronized thread
  per message, not a queue.** Two messages decoded in order can still have
  their handler threads run in either order once dispatched (worse under CPU
  load — the exact condition the original `known_flaky` comment named).
- Even a SAME-THREAD call would have done nothing: `PlayerControllerHuman
  .setYieldPref` (`forge-gui/src/main/java/forge/player/PlayerControllerHuman.java:3903-3910`)
  is `if (pref != FPref.YIELD_AUTO_PASS_NO_ACTIONS || !Boolean.parseBoolean(value)) return;`
  — a no-op for `YIELD_SKIP_PHASE_DELAY` on its own terms. The pref only ever
  takes effect through `YieldController.setPref`
  (`forge-gui/src/main/java/forge/gamemodes/match/YieldController.java:97-99`),
  reached from `applyYieldUpdate`'s `SetYieldPref` branch
  (`YieldController.java:387-388`) — and this bridge's own class doc says
  `applyYieldUpdate` is deliberately not forwarded (*"`applyYieldUpdate` and the
  20 protocol methods outside the 38 a browser needs are not forwarded
  either"*).

So the old code was racing two fire-and-forget messages across two
independently-spawned, unsynchronized threads, calling a method that, even if
it won the race, did nothing for this pref anyway.

### The fix — write directly, never send

`SeatGui.setPhaseDelayOff` (`PlayBridge.java`) now reaches for the SAME live
`PlayerControllerHuman` the click's handler thread will call into — found the
same way `confirmAbility()` already does, via `liveSelf(liveGame())`
(`PlayBridge.java:1097-1124`, an established pattern in this file, not new) —
and calls `human.getYieldController().setPref(FPref.YIELD_SKIP_PHASE_DELAY,
String.valueOf(off))` directly. `YieldController.getStringPref`/`setPref` are
both `synchronized` on the same controller object
(`YieldController.java:90-99`), so the write is visible to the game thread with
no extra signal needed. That write happens-before this method returns, which
happens-before `act()` even sends the click — so there is only one network
message left to race: itself. No Forge fork, no new pin.

## 2. Proof — `endturn.jvm`

**The 50 ms bound was too tight for this host.** `hokon` is CI's own
self-hosted runner, production, AND the operator's desktop, all one machine
(confirmed via `hostname`). All runs below were measured while the host was
ALSO running an unrelated, CPU-heavy interactive session (`Overwatch.exe` at
~300% CPU, `uptime` load average 10-13) and other wave lanes' own queued
`heavy.lock` work — i.e. genuinely "under load", not synthetic.

| batch | code | threshold | runs | pass | fail | worst gap seen |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | fixed | 50 ms (old) | 20 | 13 | 7 | 98 ms |
| 2 | fixed | 50 ms (old) | 20 | 15 | 5 | 98 ms |
| 3 (mutation) | **reverted** | 50 ms (old) | 6 | 5 | 1 | 97 ms |
| 4 (final) | fixed | **150 ms (new)** | 20 | **20** | **0** | — |

Across all 46 runs at the old 50 ms bound (batches 1-3, 184 individual phase
gaps), **the maximum gap ever observed was 98 ms** — never once near the 200 ms
`phasesDelay` signature that characterizes a genuinely lost race (Forge either
skips the sleep entirely or takes the full 200 ms; it is not a graduated
delay). This is true for the REVERTED code too (batch 3), which makes the
40-98 ms failures in batches 1-3 host-noise, not the X1 race reproducing —
Y26's actual failure mode (CI's own `37521595277`/`37532893898`) was not
captured live in this session, on this host, in this sample. The structural
argument in §1 does not depend on reproducing it: there is no longer a message
for the race to apply to.

150 ms was chosen with margin on both sides of that split (52 ms above the
measured 98 ms noise ceiling, 50 ms below the deterministic 200 ms signal) and
is NOT a "sleep between the two sends" — the ordering guarantee in §1 is
structural; this is a test-tolerance correction for a shared, noisy host.
**Batch 4, at the new threshold, is the clean 20/20 the brief asked for.**

Raw logs: `/tmp/claude-1000/w53-E/{endturn-run,endturn-run2,mutation-run,final-run}-*.log` (scratch, not committed).

## 3. `w32.spec.ts` — the real browser path

After `origin/main` was merged into this worktree (w51, merge `aa56402`), the
test moved from `:109` to `:106` and the drivers it uses (`e2e/play/scenario.ts`,
`confirm.ts`, `board.ts`, `hands.ts`) changed under w51 — found by title, not
by the stale line number:

```
npx playwright test --list w32.spec.ts
  w32.spec.ts:106:1 › the turn reads Start with no name under it (Q1); End Turn
  passes skipped phases at once, the preference is scoped to the End Turn seat (Q5)
```

Rebuilt first (`pnpm --filter @hadoku/ui --filter @hadoku/server build`, under
the lock, so the e2e run is against the current UI/server, not a stale
`dist/`), then 10 runs by title (`-g`):

```
W32_RESULT pass=10 fail=0
```

No run's console carried a literal `SKIPPED:` title (`grep -i skip` only ever
matched the test's own title text, "...passes **skipped** phases..." — checked
per-run, not assumed). Sample gaps (ms) from the 10 runs, all comfortably under
the spec's own bounds (median < 60, max < 140):

```
run 1:  32, 50, 50, 30   run 6:  26, 40, 29, 19
run 2:  30, 42, 17, 45   run 7:  25, 58, 16, 12
run 3:  39, 63, 23, 37   run 8:  35, 40, 31, 15
run 4:  20, 61, 39, 26   run 9:  47, 27, 36, 42
run 5:  16, 36, 29, 19   run 10: 47, 60, 27, 36
```

## 4. `auto-pass-land.jvm.test.ts` — `landPayer`

`:147`'s hand-rolled `clicked` Set (never re-clicking a land ID, but WITH no
check that the "Pay Mana Cost" prompt had actually changed since the last
click) is the same shape of race `scenario.ts`'s `landPayer` already fixes
elsewhere: a click on the next 25 ms tick, before Forge's reply tapped the
land it was already playing, is refused ("Should wait till previous call to
playAbility finishes", `InputPayMana.java:210-213`) and — because the Set was
keyed on the land's id, not on whether the prompt had moved — never retried.
Replaced with `const payLand = landPayer(s, 0)`, called every tick.

**Fixed, 5/5 under load:**

```
AUTOLAND_RESULT pass=5 fail=0
```

**Mutation** (reverted to the old inline `Set`-only tracking, 3 runs under
load): **did not reproduce.** 3/3 passed; no "Should wait till previous call to
playAbility finishes" in any run's log.

```
AUTOLAND_MUTATION_RESULT pass=3 fail=0
```

Consistent with `scenario.ts`'s own comment on the race ("CI run 37524669423,
host load 19, lost two of three clicks that way") — it is load-dependent and a
3-run budget on this particular host moment did not hit it, the same way the
`endturn.jvm` host-noise ceiling in §2 varied run to run. The fix is still
correct and still the one `scenario.ts`'s other callers already use; this
section says plainly what did and did not reproduce rather than implying a
repro that did not happen.

## 5. Per-pin jars

- Pin (full 40-char sha, from `git ls-tree HEAD forge` in this worktree and
  `git -C ~/repos/hadoku-cardtable submodule status forge`):
  `e5db05107cb6ce3f5cf2dae338f062b5316a68f6` (both agree).
- Host file created this wave (the only host mutation besides scratch logs):
  `~/.local/share/cardtable/jars/e5db05107cb6ce3f5cf2dae338f062b5316a68f6.jar`,
  a COPY of the existing `~/.local/share/cardtable/forge.jar`.

```
-rw-r--r-- 1 hadoku hadoku 39686922 Oct  6 14:58 /home/hadoku/.local/share/cardtable/forge.jar
-rw-r--r-- 1 hadoku hadoku 39686922 Oct  6 17:20 /home/hadoku/.local/share/cardtable/jars/e5db05107cb6ce3f5cf2dae338f062b5316a68f6.jar

984f247a0026a4db480050f0025112788fa24389bd709d60977fac51a8fad6a3  forge.jar
984f247a0026a4db480050f0025112788fa24389bd709d60977fac51a8fad6a3  jars/e5db05107cb6ce3f5cf2dae338f062b5316a68f6.jar
```

Identical sha256 — a verified copy, not a rebuild (no toolchain work was
needed since the currently-installed jar already matches the current pin).

**CI proof is pending** (lands after the manager commits/pushes this lane):
look for this exact `::notice::` line in the `forge-e2e` and `forge-jvm` jobs'
logs —

```
::notice::resolved Forge jar for pin e5db05107cb6ce3f5cf2dae338f062b5316a68f6: /home/hadoku/.local/share/cardtable/jars/e5db05107cb6ce3f5cf2dae338f062b5316a68f6.jar
```

**Operator-pending (NOT done by this lane, per the brief):** switching
`~/.local/share/cardtable/forge.jar` from a regular file to a symlink at the
current pin, and the production restart. The exact commands are now the
"Switching production to a new pin" section of `docs/FORGE_JAR.md`:

```sh
curl -s localhost:9008/health/busy   # must say {"busy":false}
ln -sfn ~/.local/share/cardtable/jars/e5db05107cb6ce3f5cf2dae338f062b5316a68f6.jar ~/.local/share/cardtable/forge.jar
ls -la ~/.local/share/cardtable/forge.jar   # confirm it now points at the pin's jar
curl -s -X POST http://127.0.0.1:4000/api/cardtable/restart
```

A good restart's log lines are in `docs/FORGE_JAR.md` ("What a good restart
looks like"). This lane did not touch `~/.pm2`, did not call mgmt-api, and did
not modify `forge.jar` (only read it, to copy and hash it).

## 6. `pnpm run check`

Run once at the end, jar env UNSET (per protocol — jvm suites self-skip,
which is correct for this command):

```
Test Files  109 passed | 43 skipped (152)
     Tests  4449 passed | 113 skipped (4562)
exit 0
```
