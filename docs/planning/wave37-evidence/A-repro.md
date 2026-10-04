# §A — the scenario-start race: the CI diff, a local repro, the cause, the fix, the proof

> The first priority window after a scenario applies must offer exactly what the scripted
> zones make castable, every time.

Wave 37's escalated lane-A run. It replaces the first implementer's draft. That draft's three
claims are settled at the end of this file (§6).

## 1. The CI-artifact diff (the first deliverable)

Evidence: `forge-e2e-evidence-1` from runs `37158514682` (fba269b), `37161388557` (5a4cae0)
and `37161585484` (1a693fe). Each stack's `play-work/stack-<id>/*/bridge.stderr.txt` is
Forge's own log from the bridge JVM. That JVM holds both the Forge server and the two
in-JVM Forge clients (`FGameClient`), so the log shows the server's sends and each
client's decodes. I put the failing `pk3Jk8` (T8, Q7/`lone-spell` shape) and the passing
`eQkqXQ` (Q7) side by side, normalised timestamps and hashes, and diffed them from match
start to the first priority window.

**Up to frame 40 both runs carry the same frames.** The 3 vs 12 `setWeaklySelectable`
and 0 vs 4 `getAbilityToPlay` counts in the wave file are what follows the window: the
passing run casts Memnite, and the failing run never sends a click. Forge was not parked
in another input. Seat 1 got the real `InputPassPriority` window (frames 37–40:
`setWeaklySelectable`, `showPromptMessage`, `updateButtons`, `alertUser`) in both runs.

**The difference is when Forge's client resolved the card ids**, ordered against when it
applied the delta that created those cards:

| | failing `pk3Jk8` | passing `eQkqXQ` |
| --- | --- | --- |
| seat 1's delta seq=4, which creates the scenario's 34 new objects (Memnite is id 112) | received as frame 33, **applied on `seat-1-ui` after frame 37 was decoded** | received as frame 33, **applied before frame 34 was decoded** |
| frame 34 `setWeaklySelectable` (our start-game-hook push) | `WARN TrackableSerializer: Could not resolve IdRef(tag=0, id=112)` | resolved |
| frame 37 `setWeaklySelectable` (`InputPassPriority`'s push, the real window) | `WARN … Could not resolve IdRef(tag=0, id=112)` | resolved |
| first MAIN1 `stop-decided` for seat 1 | `sources 0` | `sources 1` |

Here are the failing run's lines in order (`fail.txt` lines 129–146 in the lane scratch):

```
Received: GuiGameEvent 36: applyDelta
=== END seq=4 (1ms, 34 new …)          <- seat 0's copy of seq=4, applied
Received: GuiGameEvent 33: applyDelta   <- seat 1's seq=4, queued to seat-1-ui
WARN Could not resolve IdRef(tag=0, id=112)
Received: GuiGameEvent 34: setWeaklySelectable
Received: GuiGameEvent 35: applyDelta
WARN Could not resolve IdRef(tag=0, id=112)
Received: GuiGameEvent 37: setWeaklySelectable
=== START applyDelta seq=4 …            <- seat 1's seq=4 only now applied
Received: GuiGameEvent 38: showPromptMessage
```

**Across all three runs.** A script (`classify.py` in the lane scratch) took every stack,
found its first own-turn MAIN1 `stop-decided`, and listed the unresolved IdRefs logged
*after* the first `GameEventPlayerPriority`, which is where the real window's push lives:

| run | stack | spec | first window `sources` | unresolved after first priority |
| --- | --- | --- | --- | --- |
| 37158514682 | `pk3Jk8` | w36 T8 (fail) | 0 | 112, 112 |
| 37158514682 | `HpqIUJ` | w36 T1 (fail) | 0 | 112 |
| 37158514682 | `WaOGgF` | w35 R7 `bolt-player` (fail) | 0 | 102, 109 |
| 37161585484 | `3SbcoT` | w36 T1/T8 (fail) | 0 | 112, 112 |
| 37161585484 | `GtUEoA` | w36 T1/T8 (fail) | 0 | 112, 112 |
| 37161585484 | `d2xgem` | Q7 (pass) | **1** | 112 (the later re-push won) |
| 37158514682 | `eEfjRx` | auto-target (pass) | 3 | 102, 107, 108 (some cards lost; the spec's own card survived) |
| all three | every `Q14` stack (pass) | — | 0 | none: genuinely nothing castable |

Every lane-A red in these runs that reached a priority window shows the signature. No stack
with the signature reached the window carrying the card it lost.

**One red is a different mechanism.** `37161388557`'s w33 Doom Blade failure is stack
`R4Qi59`. It never reached the start-game hook: no `TurnBegan`, no turn-1 delta, and
Alice's page still shows her deck's random hand (library 34) under "Waiting for Bob…".
Its last `stop-decided` is seat 1 at 23:23:46.6 with `buttons [true, true]`, Forge's last
frame is `showPromptMessage` (frame 32), and then nothing follows for 90 s. Forge was
parked on seat 1's keep-or-mulligan input, which the e2e driver never pressed. That is
the e2e harness's mulligan driver, not the bridge. I'm handing it back to the manager
(lane E's file, `e2e/play/scenario.ts`) and not fixing it here.

## 2. Making it fail locally

`apps/server/src/play/scenario-start.jvm.test.ts` (new) starts `lone-spell` (seat 1,
Memnite) and `bolt-player` (seat 0, Lightning Bolt) against the real jar, one match at a
time. It waits for the seat's first own MAIN1 priority window (`inOwnMain(s, seat, 1)`)
and then checks two things:

- **window**: the last `setWeaklySelectable` the seat got before that window names the
  card. This is the CI symptom.
- **every push**: every `setWeaklySelectable` the seat got up to the window names it,
  including our own start-game-hook push. This is the same mechanism with a much shorter
  race window, because it goes out back to back with the delta.

**Conditions.** No artificial load: `taskset` was not needed. The host was at ambient
load, `uptime` load average 10–13 on 12 cores, with other lanes' e2e and production
running. Env: `CARDTABLE_PLAY_WORK_DIR=/tmp/claude-1000/w37-A2/work`, the deployed
`forge.jar`, and the pinned `forge/forge-gui/res`.

The first implementer's contention attempts failed for two reasons, neither of them this
bug. First, `Scenario.stop()` waits for the *process-wide* `liveJvmCount() === 0`
(`scenario.ts:304-307`), so two concurrent matches in one vitest process each wait on the
other and time out. Second, 8 JVMs pinned to one core hit `earlyoom`. Sequential starts
in one process reproduce the bug on the first try. For more pressure, run more
processes, not more matches per process.

## 3. The cause, from Forge's source (pin `9729168da1e`)

1. **The client resolves card references at decode time, on the netty thread.**
   `CObjectInputStream.resolveObject` → `TrackableSerializer.resolve`
   (`CObjectInputStream.java:92-93`, `TrackableSerializer.java:136-141`). An `IdRef`
   whose id the client's tracker does not hold becomes `null`, with the `WARN` above.
2. **A delta's new objects reach that tracker only when the delta is applied, on the GUI
   thread.** `NetworkGuiGame.applyDelta` creates them in "phase 1a"
   (`NetworkGuiGame.java:66-107`, `createObjectOnly` `:427-462`, `tracker.putObj` `:460`).
   The client handler is `super(true)` (`GameClientHandler.java:38`), so every protocol
   call goes through `FThreads.invokeInEdtNowOrLater` (`GameProtocolHandler.java:117-118`).
   In this bridge that is the seat's own single-thread `seat-N-ui` executor
   (`PlayBridge.java` `BridgeGui.invokeInEdtLater`). Only `setGameView` gets its objects
   registered synchronously on the netty thread, in `beforeCall`
   (`GameClientHandler.java:113-127`: `updateObjLookup` + `refreshTrackerCardViews`).
   `applyDelta` does not.
3. So when the server sends `applyDelta` (new cards) and then `setWeaklySelectable` naming
   them, the netty thread can decode the second frame before `seat-N-ui` has applied the
   first. The cards turn into `null`, `refs()` drops the nulls (`PlayBridge.java`
   `refs`/`refOf`), and the browser gets `[]`.
4. **Why a scenario start hits it.** `GameState.applyToGame` creates every scripted card
   fresh in the start-game hook. The server then sends the delta for all of them
   (34 objects in Q7), and moments later sends the two pushes that name them: our
   `refreshActionable` and `InputPassPriority`'s. The bridge's own
   `SeatGui.applyDelta` serialises the whole packet to JSON and emits it *before*
   `super.applyDelta` registers the objects (`PlayBridge.java` `SeatGui.applyDelta`),
   which widens the window. That ordering is shared with production, so I left it alone.

The brief's lead is right about the thread and wrong about the mechanism. The race does
live on `seat-N-ui`, but it is not a cache refill. It is the decode-time resolution on
the netty thread outrunning the delta application on `seat-N-ui`. `cachedActionableCards`
was never the problem: the server computed the right set every time, and the client threw
the cards away on arrival.

## 4. The fix (`PlayBridge.java`, scenario path only)

`BridgeGui.hostMatch`'s start-game hook now runs `applyToGame`, then a new `resyncSeats`,
then `refreshActionable` as before. `resyncSeats` calls Forge's own
`RemoteClientGuiGame.setResyncPending()` (`RemoteClientGuiGame.java:266-269`) for each
human seat. The next `updateGameView` on the game thread is the one
`setWeaklySelectable` runs before it sends (`:507-510`). It now sends the full state as
`setGameView` instead of a delta (`:223-227` → `sendFullState` `:275-283`). The client
registers a `setGameView`'s objects on the netty thread before it decodes the next frame
on that channel. Each channel has one netty thread and frames arrive in order, so every
later frame resolves the scripted cards.

This works by ordering, not timing: no retry, no wait, no timeout. No Forge file changed.
It uses the resync path Forge already runs on a checksum mismatch. The `setGameView`
frame it adds is a full baseline, and every consumer already treats it that way
(`visibility.ts` `foldFrames`, `apps/ui/src/play/live/match.ts:1667`). Every match start
already sends several of them (frames 3, 4 and 7 in the logs above).

**The no-scenario path is unchanged.** The diff adds a call inside the `if (text != null)`
block of `hostMatch` (`text` is `scenario`) and a private static method called only
from there. Nothing else changes; see `git diff apps/server/src/play/bridge/PlayBridge.java`.

## 5. Mutation proof

Same host, same conditions as §2, `CARDTABLE_SCENARIO_START_RUNS=N`, one file,
`--pool=forks --poolOptions.forks.singleFork=true`.

| arm | scenario | starts | first window lost | any push lost |
| --- | --- | --- | --- | --- |
| fix reverted (the `resyncSeats` call removed) | `lone-spell` | 20 | **10** | **19** |
| fix reverted | `bolt-player` | 20 | 0 | **20** |
| fix restored | `lone-spell` | 50 | 0 | 0 |
| fix restored | `bolt-player` | 50 | 0 | 0 |

A reverted-arm sample (`lone-spell`): seed 1000 `[] []`, seed 1001 `[] [91]`. The first
list is the hook push and the second is the window's, and both lost Memnite in seed
1000. `bolt-player`'s window survived every time here. Seat 0's window comes after more
game-thread work, so its executor had time to catch up. That is the same race with a
wider window, and CI's `WaOGgF` shows it can still lose. Earlier smaller runs agreed:
reverted, `lone-spell` lost the window 1/3 and the hook push 3/3. Fixed, 5/5 and 5/5
were clean for both scenarios.

**The e2e specs that were red in CI, run locally.** I built with
`pnpm --filter @hadoku/ui --filter @hadoku/server build` and ran from `e2e/`:
`playwright test w36.spec.ts w35.spec.ts -g 'T1 —|T8 —|R7 —' --repeat-each 5`. The
e2e ports were checked free first. The bridge is read from `src/`, so swapping it needs
no rebuild.

| bridge | T8 | T1 | R7 |
| --- | --- | --- | --- |
| HEAD (no fix) | **4 of 4 failed** | **3 of 3 failed** | 4 of 4 passed |
| fixed | 5 of 5 passed | 5 of 5 passed | 5 of 5 passed |

The HEAD run hit my 20-minute `timeout` after 11 of its 15 tests, each red taking 2.6
min. Its orphaned harness, server and spare JVM were killed by PID afterwards. A single
full `w36.spec.ts` run with the fix also passed 7/7.

Suite results are in §7.

## 6. The first implementer's draft claims, settled

- (a) "`seat-N-ui` only carries outbound frames." **Wrong.** `BridgeGui.invokeInEdtLater`
  sends every client-thread `invokeInEdt*` to that seat's executor, and the client
  dispatches every inbound protocol call that way (`GameClientHandler` `super(true)`).
  `applyDelta` is one of those calls, which is where the race lives.
- (b) "The cache is fresh at the real priority call." **True, and beside the point.** The
  set was computed correctly. It was lost on the client's decode.
- (c) The "Game BT" thread race. **Not observed and not the cause.** No failing stack
  shows it. Every one shows unresolved IdRefs.

## 7. Suites, one file at a time, fix in place

Env: as in §2. Runner: `/tmp/claude-1000/w37-A2/suites.sh`. Each file ran on its own with
`--pool=forks --poolOptions.forks.singleFork=true`. I checked each `Tests` line and
none was skipped.

| suite | first run | rerun / comparison |
| --- | --- | --- |
| `scenario-harness` | 2 passed | |
| `scenario-ability-repeat` | 2 passed | |
| `scenario-blockers` | **1 failed** (Q12) | see below: **flaky at HEAD too** |
| `scenario-combat` | 2 passed | |
| `scenario-glen` | 3 passed | |
| `scenario-order` | 2 passed | |
| `scenario-priority` | 2 passed | |
| `scenario-targets` | 2 passed | |
| `scenario-thoughtseize` | 2 passed | |
| `scenario-start` (new) | 2 passed (50 + 50) | |
| `auto` | **3 failed** | uses no scenario, so the change cannot reach it. **At HEAD's `PlayBridge.java` it fails the same 3 tests the same way** (`1 casts`, `0 live payments`, `0 payment rows`), so this is pre-existing. It goes to the manager. |
| `auto-pass-land` | 1 passed | |
| `priority` | 2 passed | |
| `lands` | 1 passed | |
| `blockers` | 2 passed | |
| `two-mana-pass` | 1 passed | |
| `socket-two-mana-pass` | 1 passed | |
| `socket-thoughtseize` | **1 failed**: HTTP 503 from `POST /api/play/matches` | rerun: **1 passed**. The 503 came from the route before any JVM was spawned, so no bridge code had run. I could not see which of the three 503 branches fired (`socket.ts:511-522`), because the test does not print the body. |
| `endturn` | 1 passed | |
| `jvm.test.ts` | 3 passed (rerun; the first invocation had a wrong path) | |
| `mulligan` | 2 passed | |

**`scenario-blockers` Q12 is a flake that predates this change.** With the fix it failed 4
of 5 consecutive runs. With the fix reverted it failed 3 of 5. The failure is the same
every time: "timed out waiting for the block-assignment input to open for the defender".
A diagnostic run (a temporary script, since deleted) caught it twice. In both, seat 1's
frames show an input with `setHighlighted` on, then off, and `clearWeaklySelectable`,
and then seat 1 sits at `Priority: B … Declare Blockers Step` with OK enabled. The test's
25 ms poll of the *latest* prompt never saw "Select creatures to block". Either that
input opened and closed between two polls, or it was never that input. **Not verified
which.** It is not the decode race this lane fixed: it fails just as often with the fix
in place. It goes to the manager.

## 8. Open, for the manager

- **The same decode race is not scenario-specific in principle.** Any object that is new
  to a client and named by a frame sent right behind the delta that creates it can be
  dropped the same way. In this repo's own evidence, the hook push lost its cards in
  almost every CI stack, including passing ones. In production, a freshly drawn card
  named by the next priority push is the obvious candidate. **Not checked** in
  production logs. The deeper fixes are out of this lane's scope: it is product
  behaviour, and Settled says the fix touches the scenario path only. They would be
  registering an `applyDelta`'s new objects on the netty thread (Forge's
  `GameClientHandler.beforeCall`, a Forge change), or having `SeatGui.applyDelta` call
  `super.applyDelta` before it serialises the frame (narrows the window, does not close
  it).
- `R4Qi59` (w33 Doom Blade, run 37161388557) is a mulligan-driver stall, not this race
  (§1).
- `scenario-blockers` Q12 and `auto` are red at HEAD as well (§7).
- `auto.jvm.test.ts` left a Forge JVM running after it finished (reparented to systemd,
  run dir under `CARDTABLE_PLAY_WORK_DIR`). I killed it by PID.

