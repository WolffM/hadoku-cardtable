# w102 — `class Match`'s member map (shell vs. session)

Every member of `class Match` (`apps/server/src/play/match.ts:1269-4961`, measured at w101's scaffold),
in declaration order, classified for w102's split into `MatchShell` (seats, grace, rejoin, watchers,
per-seat emit, parking, recording hooks, the activity window, concede timing) and `ForgeSession`
(asks, windows, auto-pass, holds, Forge acts). **Both** names a member that genuinely does both —
these are w102's real work, because splitting the class means deciding where the mixed logic goes
rather than just copying a method across.

**Line numbers below are pre-move** (as the file stood when this map was written, before
the pure moves out of `match.ts`). Those moves (the outcome helpers, the frame helpers, the
registry) sit entirely *outside* `class Match` — nothing inside the class itself was added, removed
or reordered — so every number below is a **constant 341 lines too high** against the file as w101
left it: `class Match` now opens at `match.ts:928` (was `:1269`) and closes at `:4594` (was `:4935`),
same 3,666-line body. Subtract 341 from any line number here to find the member in the current
file, or re-measure from `:928` before using this map for real in w102.

Classified by what the member's content concerns, not by who calls it (a shell lifecycle method that
happens to call a session cleanup helper does not make the helper "both" on its own).

| member | lines | shell / session / both | why |
| --- | --- | --- | --- |
| `id` | 1270 | shell | match identity |
| `epoch` | 1272 | shell | restart/resume identity (never changes meaning) |
| `status` | 1273 | both | shell owns the lifecycle values (`starting`→`stopped`), but nearly every session decider gates on `status !== 'running'` |
| `failure` | 1274 | shell | end reason, read by the status route |
| `winner` | 1275 | shell | outcome |
| `winnerSeat` | 1282 | shell | outcome, from Forge's `losers` |
| `concededBy` | 1284 | shell | outcome / concede timing |
| `drawnFor` | 1286 | shell | outcome (server-forced draw) |
| `timedOut` | 1288 | shell | chess-clock concede timing |
| `clock` (`ChessClock`) | 1295 | shell | concede timing |
| `flagTimer` | 1297 | shell | clock-flag timer |
| `startedAt` | 1303 | shell | match lifecycle |
| `endedAt` | 1305 | shell | outcome |
| `seats` (`SeatState[]`) | 1306 | both | the roster itself is shell, but `SeatState`'s own fields are almost entirely session bookkeeping (asks, prompts, holds) |
| `invalidFrames` | 1308 | session | Forge-frame parse counter |
| `inputOfRaw` / `inputOfFrame` | 1314-1315 | session | window/act identity tracking |
| `watcher` (projector, seq, history, heldLog, heldLogTimer, openReveal) | 1331-1340 | shell | the watcher channel is explicitly a "watchers" concern |
| `deps` | 1342 | both | the seam every method reads/writes through |
| `spec` | 1343 | shell | match config |
| `art` (`ArtIds`) | 1345 | shell | display data, not play logic |
| `host` (`MatchHost`) | 1346 | both | shell owns start/stop/handOver; session's `command()` sends through it every act |
| `now` | 1347 | both | plain utility, read everywhere |
| `runningWaiters` | 1348 | shell | boot/start gating |
| `bootWaiters` | 1350 | shell | boot/start gating |
| `queuePlace` | 1355 | shell | start-queue position |
| `probes` | 1356 | session | server-initiated diagnostic Forge dialog |
| `overTimer` | 1357 | shell | post-game grace |
| `concedeWatch` | 1359 | shell | concede timing (explicit category) |
| `replaying` | 1365 | both | gags `command()` (session) during a shell-owned resume/replay |
| `rejoinTimer` | 1367 | shell | rejoin grace (explicit category) |
| `endedTold` | 1369 | shell | one-shot `deps.ended` latch |
| `justDiscarded` | 1380 | session | R4 reveal/discard-echo suppression |
| `framesRing` | 1388 | session | decided-window telemetry |
| `framesLogged` | 1389 | session | one-shot latch for `framesRing`'s flush |
| `lastWaitingOnKey` | 1398 | session | de-dupe key over `waitingOnFor` (an ask/window fact) |
| `lastHoldsKey` | 1400 | session | de-dupe key over `holdsFor` (an ask/window fact) |
| `waitingOnTimer` | 1405 | session | grace timer over a wait appearing |
| `pendingWaitingOnKey` | 1407 | session | paired with `waitingOnTimer` |
| `coinToss` | 1409 | both | detected from a Forge button frame (session), but told on the seat roster (shell) |
| `deckNames` | 1411 | session | card-name-ask narrowing |
| `latestSnapshot` | 1418 | shell | parking/restart snapshot (explicit category) |
| `restartAsk` / `restartDeclined` / `restartKey` | 1421-1425 | both | a player-to-player negotiation over resuming the match (parking-adjacent, shell), gated on in-game facts (turn, `restorable`) that are session-shaped |
| `constructor` | 1427-1539 | both | builds both the shell roster (`seats`, `watcher`, clock) and every session field of `SeatState` |
| `unstartable` | 1546 | shell | host-start failure |
| `start()` | 1553 | shell | boot the JVM |
| `resume()` | 1574 | shell | re-attach after a server restart (explicit: parking) |
| `armRejoinGrace()` | 1602 | shell | rejoin grace (explicit category) |
| `refuseStart()` | 1621 | shell | start failure path |
| `hostEvents()` | 1626 | both | wires `onLine`/`onExit` (both) and `queued`/`booting` (shell) into the host |
| `owners()` | 1644 | shell | seat ownership, for the on-disk record |
| `remember()` | 1653 | shell | the parking/rejoin on-disk record |
| `clockLeft()` | 1659 | shell | concede timing |
| `syncClock()` | 1669 | both | reads `waitedOn` (a session fact: is the seat's window open) to drive the shell-owned clock |
| `stopClock()` | 1691 | shell | concede timing |
| `waitedOn()` | 1697 | session | reads `waitingOnFor`, a pure ask/window fact |
| `flag()` | 1707 | shell | concede timing (clock hits zero) |
| `watchConcede()` | 1724 | shell | concede timing (explicit category) |
| `onReplayedCommand()` | 1755 | both | a parking/resume mechanic (shell) whose only effect is closing a session ask |
| `command()` | 1762 | session | sends a Forge act, arms the act watch |
| `armActWatch()` | 1811 | session | lost-ask safety net over a Forge act |
| `resendWindow()` | 1834 | session | re-sends a held window |
| `endClick()` | 1852 | session | click-outcome log |
| `onRefused()` | 1876 | session | Forge turned an act away |
| `disabledBar()` | 1882 | session | window bar helper |
| `disarmActWatch()` | 1889 | session | pairs with `armActWatch` |
| `seatOf()` | 1899 | shell | participant→seat lookup |
| `claim()` | 1907 | shell | seat binding |
| `whenRunning()` | 1928 | shell | boot gating |
| `snapshot()` | 1956 | shell | per-seat reconnect snapshot (explicit category) |
| `seatIdentities()` | 1990 | both | the roster itself is shell, but every entry's `waitingOn`/`holds`/`coinToss` is read off session facts |
| `waitingOnFor()` | 2083 | session | the core ask/window classification read by nearly everything else |
| `tellRoster()` | 2147 | shell | broadcasts the roster |
| `holdsFor()` | 2154 | session | wraps `waitingOnFor` |
| `tellSeats()` | 2163 | both | broadcasts (shell) a fact computed from session state |
| `checkWaitingOn()` | 2176 | both | the central ask/window-change gate (session) that also re-broadcasts the roster (shell) |
| `offeredToOthers()` | 2237 | session | cross-seat offered-card visibility |
| `seatAvatarChanged()` | 2253 | shell | roster re-tell on an avatar change |
| `seatState()` | 2265 | shell | diagnostic per-seat state read |
| `resendAfterSnapshot()` | 2284 | shell | per-seat emit on reconnect (explicit category) |
| `resendEndNotices()` | 2316 | shell | outcome notices on reconnect |
| `fromClient()` | 2326 | session | the browser→Forge act/reply/abort dispatcher |
| `seatDisconnected()` | 2497 | shell | disconnect grace (explicit category) |
| `anyoneHere()` | 2524 | shell | presence check |
| `seatConnected()` | 2529 | shell | reconnect bookkeeping |
| `handOver()` | 2568 | shell | deploy continuity (explicit: parking) |
| `serverStopping()` | 2588 | shell | tells seats the server is going down |
| `probe()` | 2594 | session | server-initiated Forge dialog |
| `forceDraw()` | 2615 | shell | outcome (server-forced draw) |
| `stop()` | 2624 | shell | match lifecycle |
| `tellEnded()` | 2636 | shell | one-shot `deps.ended` latch |
| `outcome()` | 2643 | shell | outcome classification |
| `live()` | 2652 | shell | table-card display |
| `liveKey` | 2673 | shell | de-dupe for `liveChanged` |
| `activeSeconds` | 2680 | shell | the activity window (explicit category) |
| `activity()` | 2683 | shell | the activity window (explicit category) |
| `noteActivity()` | 2690 | shell | the activity window (explicit category) |
| `noteLive()` | 2696 | shell | table-card change detection |
| `send()` | 2707 | both | per-seat emit (shell by name) that is inseparable from session-only bookkeeping (`wireButtonsLive`, `coinToss`, look-holds) |
| `emit()` | 2721 | both | same as `send()`: the wire-level emit, tangled with `inputOfFrame`/reveal-closing (session) |
| `revealEndedBy()` | 2747 | session | reveal-closing logic |
| `closeWatcherReveal()` | 2760 | both | watchers (shell) told that a session-owned reveal closed |
| `holdForLook()` | 2772 | session | look-ahead hold tied to a decision |
| `releaseLookHold()` | 2791 | session | pairs with `holdForLook` |
| `sendWindow()` | 2804 | session | sends a paired prompt+buttons window |
| `noteCoinToss()` | 2817 | both | detects a Forge button frame (session) and updates the roster (shell) |
| `keep()` | 2836 | shell | per-seat history/tally bookkeeping (reconnect/snapshot machinery) |
| `sendState()` | 2841 | both | routes a state frame to the seat (shell history) and the watcher channel (shell), but also triggers `noteActivity`/`noteLive` (shell) and `releaseLog` (session) |
| `learnShown()` | 2860 | session | reveal/discard visibility learning |
| `watcherSource()` | 2878 | shell | watchers |
| `watchedSeat()` | 2887 | shell | watchers |
| `activeSeat()` | 2893 | shell | table display |
| `sendWatcher()` | 2905 | shell | watchers (explicit category) |
| `tellWatchers()` | 2927 | shell | watchers (explicit category) |
| `watcherSnapshot()` | 2944 | shell | watchers + per-seat emit on reconnect |
| `onLine()` | 2957 | both | the central bridge-line dispatcher: `gameover`/`snapshot`/`fatal` are shell, `frame`/`dropped`/`input` are session |
| `onFrame()` | 3087 | session | the core per-frame ask/window/act classification engine |
| `holdPromptWindow()` | 3367 | session | pairs a window's two halves |
| `armPendingTimer()` / `clearPendingTimer()` | 3419-3430 | session | window-pairing timer |
| `decideWindow()` | 3446 | session | runs every auto-decider on a window |
| `armStuckWindow()` / `disarmStuckWindow()` / `showStuckWindow()` | 3522-3550 | session | the withheld-window safety net |
| `releaseHeldClick()` / `dropHeldClick()` | 3560-3591 | session | held-click replay/drop |
| `logOffered()` | 3598 | session | offered-card telemetry |
| `flushPendingPrompt()` / `flushPendingWindow()` | 3608-3629 | session | window-pairing flush |
| `holdOffer()` / `releaseOffer()` | 3645-3661 | session | offered-set hold with its window |
| `forwardUnpaired()` | 3663 | session | sends an unpaired window half |
| `recordWindow()` | 3680 | session | one row of the window-decision ring |
| `logFrames()` | 3700 | session | flushes the window-decision ring (content is session; called from shell lifecycle (`stop`/`fail`)) |
| `setFullControl()` / `fullControl()` | 3714-3726 | session | the escape hatch from every auto-decider |
| `setTriggerDecision()` / `triggerDecisions()` | 3736-3752 | session | Forge trigger-confirm memory |
| `setAutoYield()` | 3761 | session | auto-pass override |
| `setPhaseStop()` / `phaseStop()` | 3782-3802 | session | stop preferences |
| `restartState()` | 3805 | both | reports the restart negotiation (shell/parking-adjacent) built from in-game facts |
| `restorable()` | 3818 | both | gates restart (shell) on the latest snapshot + status (shell) but is really "can the session be re-entered here" |
| `restartAct()` | 3830 | both | the restart ask/allow/decline/cancel protocol: a shell-level feature, gated on session facts (`activeSeat`, `restorable`) |
| `answerRestart()` | 3863 | both | same as `restartAct` |
| `restartNow()` | 3880 | shell | hands off to `deps.restartTurn` (the registry's restore) |
| `closeRestartAsk()` | 3887 | both | restart-ask bookkeeping |
| `tellRestart()` | 3893 | both | broadcasts the restart state (shell) computed from session-adjacent facts |
| `stopHolds()` | 3908 | session | enforces a seat's phase stop |
| `setStopPolicy()` / `stopPolicy()` | 3943-3961 | session | per-seat shortcut policy |
| `say()` | 3970 | both | a synthesized per-seat notice (shell: per-seat emit) whose content is almost always a session fact (full control on/off) |
| `onGameLog()` | 3999 | session | Forge's log, held on the same reveal-gating machinery as `onFrame` |
| `releaseLog()` | 4028 | session | pairs with `onGameLog` |
| `holdWatcherLog()` / `releaseWatcherLog()` | 4044-4077 | shell | watchers' own log hold |
| `notesOf()` | 4080 | session | builds the `SeatNotes`/`PromptFacts` every auto-decider reads |
| `spellCopiersOffered()` | 4110 | session | auto-decider input |
| `autoGateFacts()` / `answerGateFacts()` | 4139-4155 | session | the one shared guard+read every auto-decider uses |
| `maybeDeclineYieldSuggestion()` | 4197 | session | auto-decider |
| `disableStaleButtons()` | 4229 | session | act-side bar correction |
| `maybeAutoPass()` | 4258 | session | the central auto-pass decider |
| `maybeAutoPay()` | 4357 | session | auto-decider |
| `maybeOnlySacrifice()` | 4375 | session | auto-decider |
| `releaseHeldSelection()` / `dropHeldSelection()` | 4392-4404 | session | held-selection bookkeeping |
| `foldHighlighted()` | 4407 | session | incremental highlight folding |
| `noteTargetPick()` | 4419 | session | target-pick bookkeeping |
| `maybeSameTarget()` | 4432 | session | auto-decider |
| `choose()` | 4447 | session | chosen-ability bookkeeping |
| `maybeConfirmChosenTarget()` | 4452 | session | auto-decider |
| `maybeConfirmChosenCost()` | 4469 | session | auto-decider |
| `maybeConfirmFreeSearch()` | 4486 | session | auto-decider |
| `maybeCancelUnpayable()` | 4516 | session | auto-decider |
| `logUnclassified()` | 4542 | session | ask telemetry |
| `trackPayment()` | 4554 | session | payment-prompt bookkeeping |
| `openView()` | 4583 | both | names the seat's Forge player (session), but also flips the match to `running` and arms the rejoin grace (shell) |
| `closeAsk()` | 4607 | session | ask bookkeeping |
| `noteJustDiscarded()` / `noteDiscardChoice()` | 4614-4632 | session | R4 reveal/discard-echo suppression |
| `openAskFrame()` | 4647 | session | the one ask-opening tail |
| `autoReply()` | 4655 | session | answers an ask the seat is never shown |
| `openAsk()` | 4671 | session | registers and auto-answers one ask |
| `narrowNames()` | 4725 | session | card-name-ask narrowing |
| `openMergedChoice()` | 4753 | session | R4's reveal+choice fold |
| `releaseReveal()` | 4800 | session | releases frames held behind a reveal |
| `showReveal()` | 4807 | session | shows a reveal |
| `revealMustForceNotice()` | 4842 | session | reveal display rule |
| `closeAllAsks()` | 4846 | both | closes every session ask AND clears shell-owned seat-departure timers, as one match-ending sweep |
| `fail()` | 4861 | shell | match lifecycle (status → `failed`) |
| `tellSeatsItEnded()` | 4881 | shell | watchers/seats told the match ended |
| `finishSeat()` | 4897 | shell | per-seat outcome notice |
| `endNotice()` | 4905 | shell | per-seat outcome notice |
| `onExit()` | 4921 | shell | JVM-exit lifecycle |

## Counts

Counted by table row (a row naming several members, e.g. `inputOfRaw` / `inputOfFrame`, counts
once — `awk -F'|' '/^\| `/{gsub(/[ *]/,"",$4); c[$4]++} END{for(k in c) print k,c[k]}'` against
the table above):

- **shell: 72**
- **session: 78**
- **both: 30**

Total rows: 180.

## Every "both" member — w102's real work

`status`; `seats` (the roster vs. `SeatState`'s own fields); `deps`; `host`; `now`; `replaying`;
`coinToss`; `restartAsk`/`restartDeclined`/`restartKey`; the constructor; `hostEvents()`; `syncClock()`;
`onReplayedCommand()`; `seatIdentities()`; `tellSeats()`; `checkWaitingOn()`; `send()`; `emit()`;
`closeWatcherReveal()`; `noteCoinToss()`; `sendState()`; `onLine()`; `restartState()`; `restorable()`;
`restartAct()`; `answerRestart()`; `closeRestartAsk()`; `tellRestart()`; `say()`; `openView()`;
`closeAllAsks()`.

Two clusters stand out:

1. **The restart-ask protocol** (`restartAsk`/`restartState`/`restorable`/`restartAct`/`answerRestart`/
   `closeRestartAsk`/`tellRestart`) is a shell-level feature (a snapshot-based resume) implemented
   entirely in terms of session facts (`activeSeat`, in-game turn number, `PromptFacts`-adjacent
   gating). w102 has to decide whether `MatchShell` calls into `ForgeSession` for "is this turn still
   restorable," or whether the whole cluster moves to the shell with a narrow session query.
2. **`send()`/`emit()`/`sendState()`/`checkWaitingOn()`** are the wire-level pipeline every frame goes
   through. They are nominally "per-seat emit" (shell), but they read and write session-only state
   (`wireButtonsLive`, `inputOfFrame`, reveal-closing, look-holds) on every call. These cannot be
   split along a clean method boundary — w102 will need a narrow interface `ForgeSession` exposes back
   to `MatchShell` (or vice versa) for exactly this traffic.

`openView()` and `onLine()` are the two single-method seams where the switch from "starting" to
"running" (shell) is triggered directly by a session-classified event; w102's dispatch between the
two split classes most likely happens at exactly these two points.
