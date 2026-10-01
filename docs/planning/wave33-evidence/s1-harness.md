# §S item 1 — the scenario harness: is `applyToGame` safe to call directly from the start hook?

**Question the brief asked to settle first**: whether `GameState.applyToGame` is
safe to call on the game thread from `HostedMatch`'s start-game hook, or needs
the `invoke` the bridge already does elsewhere.

**Answer: yes, directly, with no extra `invoke`.** Verified by reading the
real Forge source in `/home/hadoku/.cache/cardtable-w8/forge-build` (`forge/`
is not initialised in this worktree and wave 33 may not touch it or run a jar
install — see `AGENTS.md`), line by line through the exact call chain, below.
`scenario-harness.jvm.test.ts` then verifies the OUTCOME (the scripted state
actually took effect) against a real match; this file is the thread-safety
argument for WHY the call is made the way it is.

## The seam: `HostedMatch.setStartGameHook`

Forge's own puzzle screens use exactly this seam —
`forge-gui-mobile/src/forge/screens/home/puzzle/PuzzleScreen.java:63`:

```java
hostedMatch.setStartGameHook(() -> chosen.applyToGame(hostedMatch.getGame()));
```

`PlayBridge.java`'s `BridgeGui.hostMatch()` is the one place that builds a
`HostedMatch` for this bridge (`GameLobby.startGame()`'s returned `Runnable`
calls `GuiBase.getInterface().hostMatch()` — `GameLobby.java:551`), so it is
where the hook is installed:

```java
@Override public HostedMatch hostMatch() {
    final HostedMatch hm = new HostedMatch();
    final String text = scenario;
    if (text != null) {
        final GameState state = new GameState();
        state.parse(Arrays.asList(text.split("\\r?\\n")));
        hm.setStartGameHook(() -> state.applyToGame(hm.getGame()));
    }
    return hm;
}
```

## Where the hook runs, and on what thread

1. `GameLobby.startGame()`'s `Runnable` calls `hostedMatch.startMatch(…)`
   (`GameLobby.java:551-552`), which calls `HostedMatch.startGame()`
   (`HostedMatch.java:158`).
2. That method's last act is
   `game.getAction().invoke(() -> { … match.startGame(currentGame, startGameHook); … })`
   (`HostedMatch.java:280-294`). `GameAction.invoke` (`GameAction.java:2526-2531`):

   ```java
   public void invoke(final Runnable proc) {
       if (ThreadUtil.isGameThread()) {
           proc.run();
       } else {
           ThreadUtil.invokeInGameThread(proc);
       }
   }
   ```

   Called from the bridge's `main` thread (not the game thread), this
   dispatches onto Forge's dedicated game thread and the lambda runs there.
3. Inside that lambda, `Match.startGame(currentGame, startGameHook)`
   (`forge-game/Match.java:80-99`) calls
   `game.getAction().startGame(this.lastOutcome, startGameHook)`
   (`GameAction.java:2322`), which runs the mulligan step
   (`MulliganService(first).perform()`, `:2351`, skipped only for
   `GameType.Puzzle` — this bridge never uses that type, so the mulligan
   always runs first) and then calls
   `game.getPhaseHandler().startFirstTurn(first, startGameHook)` (`:2373`).
4. `PhaseHandler.startFirstTurn` → `setupFirstTurn` (`PhaseHandler.java:1006-1021`):

   ```java
   public void setupFirstTurn(Player goesFirst, Runnable startGameHook) {
       setPlayerTurn(goesFirst);
       advanceToNextPhase();
       onPhaseBegin();
       givePriorityToPlayer = false;
       if (startGameHook != null) {
           startGameHook.run();
           givePriorityToPlayer = true;
       }
   }
   ```

   `startGameHook.run()` is a direct, synchronous call on whatever thread is
   executing `setupFirstTurn` — which, per step 2-3, is the SAME game thread
   `GameAction.invoke` dispatched onto at the very top. No new thread is
   created for the hook.

## Why `GameState.applyToGame` does not need a second `invoke`

`GameState.applyToGame` (`GameState.java:582-584`):

```java
public void applyToGame(final Game game) {
    game.getAction().invoke(() -> applyGameOnThread(game));
}
```

It already wraps itself in `invoke`. Since the hook is already running ON the
game thread (above), `ThreadUtil.isGameThread()` is true, so `invoke` takes
the `proc.run()` branch and runs `applyGameOnThread` **inline, synchronously,
on the same call stack** — not the `ThreadUtil.invokeInGameThread` branch,
which would hand the work to the game-thread pool and could deadlock if the
calling thread were later made to wait on it. Nothing here waits on anything;
it is one more direct call, same thread, same stack. `PlayBridge.hostMatch`'s
hook therefore needs no `invoke`, no `BridgeGui.invokeInEdtAndWait`, and no
`client.ui.submit(...).get()` (the per-seat UI-thread marshalling `SeatGui`
uses for protocol calls FROM Forge TO a seat's client — irrelevant here, since
this hook runs before any seat's `IGuiGame` methods are reached for the first
time).

## Why the mulligan still happens

`GameAction.startGame` only skips `MulliganService` for `GameType.Puzzle`
(`:2349`); `PlayBridge` always builds a `Match` with `GameType.Constructed` or
`GameType.Draft` depending on `data.isLimitedMode()` (`GameLobby.java:549`;
this bridge never sets limited mode), never `Puzzle`. So the ordinary mulligan
step (the random opening hand each `RegisteredPlayer`/Forge dealt before
`applyToGame` ever runs) happens first and is answered normally — the
existing `Scenario.keepHands()` helper answers it with a keep, exactly as for
any other match. The scripted hand/battlefield/library then REPLACES whatever
the mulligan left, because `GameState.setupPlayerState` clears every zone
before repopulating it (`GameState.java:1139-1143`) — so it does not matter
what the random opening hand was.

## What this means for `devAdvanceToPhase` scenarios (two-triggers, the combat ones)

The same reasoning extends to anything the hook does INSIDE
`applyGameOnThread` that blocks on a human input — `PhaseHandler.devAdvanceToPhase`
firing an upkeep trigger that asks the controller to order it, or landing in
`COMBAT_DECLARE_BLOCKERS` and opening a real `InputBlock` for the defender
(`GameState.java:637-642, 647-650`). Each of those inputs blocks the GAME
THREAD exactly as every ordinary priority window, mulligan question or combat
input already does during normal play (`InputSyncronizedBase.showAndWait()`
parking on a latch) — nothing about running it from inside the start-game hook
changes that mechanism. The ask reaches the browser (or, in these suites,
`Scenario.asks`) over the wire precisely as any other ask does, and the game
thread resumes when the reply arrives. There is no deadlock risk because
nothing on the READING side (the bridge's stdin thread, which calls
`SeatGui.resolve`) is itself waiting on the game thread.
