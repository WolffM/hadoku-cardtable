# Item 1 — the mulligan flag, root-caused (not fixed)

Continues `item1-mulligan-diagnosis.md`, which eliminated three hypotheses and
narrowed the search to three places, in order: the bridge's delta, the
server's projection (`visibility.ts`), Forge itself. This pass clears the
first two — with a real-Forge test, not a reading — and finds the true cause
sitting entirely inside vendored, unmodified `forge/`. **No fix is applied.**
This is a report, and the reason is below.

## The test

`apps/server/src/play/mulligan.jvm.test.ts` drives a real Forge match (seed 7,
two 30-Mountain/30-Memnite decks — the same deal the diagnosis doc's probe
used) through this lane's own primitives (`host.ts`, `match.ts`,
`visibility.ts` — the same ones `jvm.test.ts` and `auto.jvm.test.ts` already
use), answers the coin toss, presses Mulligan at the keep prompt, reaches the
London "Return 1 card(s) to the bottom of your library" step, and asserts
directly on the Game object (`TYPE.game`, `_type: 3`) this lane's own
`foldFrames` builds from what the bridge sent. It does not touch
`apps/ui/src/play/live/match.ts` (lane A's file) at all — the assertion is one
step upstream of it, on the wire this lane owns.

**Reproduced 3/3 runs** (the wave's budget), the last two dumped:

- Run 1 (no dump): fails immediately.
- Run 2 (`CARDTABLE_PLAY_DUMP` set): fails identically; dump captured.
- Run 3 (same, plus a 3 s trailing wait with no further action sent, to rule
  out a simple polling-too-early race): **still fails, and zero additional
  wire frames arrive in those 3 s.** This is what turned "the flag is late"
  into "the flag is never sent for the life of this input" — see below.

```
AssertionError: expected [ '_type', '_id', 'Players', …(5) ] to include 'Mulligan'
```

The seven keys present at every step, including the London step itself:
`_type, _id, Players, GameType, Title, WinningTeam, NumGamesInMatch,
PoisonCountersToLose`. `Mulligan` is never among them, on any frame, at any
point in the match — not in `setGameView`'s initial full walk, not in any
`applyDelta`'s `newObjects` or `objectDeltas`.

Mutation counts, naming the suite: `mulligan.jvm.test.ts: 1 failed / 1` on
every one of the three runs above (against **today's** code — there is no
fix to test the reverse of).

## 1. The bridge's delta — cleared

`apps/server/src/play/bridge/PlayBridge.java`'s `applyDelta` override does
nothing but forward whatever `DeltaPacket` it is handed and call
`super.applyDelta(packet)`; `openView`'s first full sync is
`new DeltaSyncManager().collectDeltas(view)` — stock Forge, unmodified
(`PlayBridge.java:685`, `:706-715`). The dump (below) shows the packets this
code forwards genuinely never carry the key. The bridge is not dropping it: it
was never in the packet to drop.

## 2. The server's projection — cleared

`visibility.ts`'s `foldFrames` merges `newObjects`/`objectDeltas` verbatim
into its state map (`foldInto`, `visibility.ts:235-259`) and the Game object
is never filtered (`projectObject` only redacts `TYPE.card`/`TYPE.cardState`,
`visibility.ts:394-417`). Confirmed directly from the dump: the raw packet
seat 0's bridge line carries **already** lacks `Mulligan` on the Game object,
before `foldFrames` (this lane's code) ever touches it.

## 3. Forge itself — the actual cause, read from source in the deploy tree

`forge/` is gitignored in this worktree and empty; the **deploy tree**
(`/home/hadoku/repos/hadoku-cardtable/forge/`, a read, never a build or a run)
has the real checkout. Read there, not modified:

- `forge/forge-game/.../game/GameView.java:141-145`:
  ```java
  public boolean isMulligan() { return get(TrackableProperty.Mulligan); }
  public void updateIsMulligan(boolean value) { set(TrackableProperty.Mulligan, value); }
  ```
- `forge/forge-gui/.../match/input/InputLondonMulligan.java:56-65`
  (`showMessage()`, called on entry and after every card click):
  ```java
  public final void showMessage() {
      final Game game = player.getGame();
      game.getView().updateIsMulligan(true);         // sets it — correctly
      ...
      getController().getGui().updateButtons(...);    // no sync
      showMessage(sb.toString());                     // no sync either
  }
  ```
  `showMessage(String)` always calls the 1-arg `IGuiGame.showPromptMessage`
  with `card = null` (`InputBase.java:120-121`) — never the CardView-carrying
  overload.
- `forge/forge-gui/.../net/server/RemoteClientGuiGame.java:330-337`:
  ```java
  public void showPromptMessage(..., final CardView card) {
      // card == null is the await/auto-pass timer path, which fires while
      // the game thread is live — walking the graph there races it.
      if (card == null) {
          send(ProtocolMethod.showPromptMessage, playerView, message, null);   // NO SYNC
      } else {
          syncAndSend(ProtocolMethod.showPromptMessage, playerView, message, card); // syncs
      }
  }
  ```
  and `:346-348`, `updateButtons` is a plain `send(...)` too — never
  `syncAndSend`.
- `updateGameView()` — the ONLY place `DeltaSyncManager.collectDeltas` is
  called and an `applyDelta` sent — runs exclusively from `syncAndSend` /
  `syncAndSendAndWait` (`:181-184`, `:171-175`), which `showPromptMessage`
  (card == null) and `updateButtons` never call.

So the sequence for `InputLondonMulligan.showMessage()` is: set
`Mulligan = true` on the live server object → tell the client the buttons →
tell the client the prompt text — and **nothing in that sequence walks the
trackable graph**, so the just-set property never reaches a `DeltaPacket`.
Confirmed nothing else does either: `InputQueue.setInput`'s only observer is
the input-proxy that calls `showMessageInitial()` (`InputQueue.java:39-48`,
`InputBase.java:76-80`) — no second path exists. The 3-second trailing wait in
run 3 measured this directly: the step sits open, waiting for the player, and
Forge sends literally nothing further until it is answered — by which point a
client gated on `Mulligan` (as `apps/ui/src/play/live/match.ts`'s
`mulliganHand` is) can never have offered the hand, because nothing ever told
it to.

There IS a real per-client resync mechanism
(`NetworkGuiGame.requestFullStateResync()` → `IGameController.requestResync()`
→ `ProtocolMethod.requestResync`, a real client→server protocol method,
`Mode.CLIENT`), but it is wired only to a checksum-mismatch path
(`NetworkGuiGame.java:180-194`) and the server side
(`GameServerHandler.beforeCall`, `RemoteClientGuiGame.setResyncPending`)
explicitly defers the flush to "the next time the GAME THREAD calls
`updateGameView()`" for thread-safety (`RemoteClientGuiGame.java`'s own
comment on `updateGameView`: "Game-thread-only"). Since nothing calls it for
the rest of this input either, requesting a resync from here would not
actually unblock anything — it would just sit pending next to the property
that is already sitting unset.

## Why this is a report, not a patch

The cause is entirely inside vendored, unmodified `forge/`
(`InputLondonMulligan`'s two-call sequence never syncing; `RemoteClientGuiGame`'s
`card == null` fast path never walking the graph). `AGENTS.md`: *"Don't modify
`forge/` until the fork exists."* `forge/` in this worktree is gitignored and
empty — there is nothing here to patch even if the rule were waived, and the
deploy-tree checkout was read, never touched.

The one alternative fully inside this lane's files
(`apps/server/src/play/bridge/PlayBridge.java`) would be to **synthesize** the
flag in `SeatGui.showPromptMessage`/`updateButtons`, keyed on Forge's fixed
localizer strings for this input (`lblKeep`/`lblMulligan`/`lblOK`/`lblAuto`,
the button pair; `lblReturnForLondon`'s fixed template, the prompt). That is
matching Forge's OWN protocol-level, non-free-text signals — not user prose —
and this codebase already does something structurally similar in `auto.ts`
(`/^Priority: /`-anchored parsing of `showPromptMessage`, documented as "the
ONE adapter"). But it would make this bridge assert a game fact
(`Mulligan = true`) that Forge itself never told it, on the strength of a
label match rather than of a synced property — a step past "project what Forge
sent" into "infer what Forge meant," which `visibility.ts`'s whole design
(faithfully mirror the object graph) argues against, and which a locale change
to Forge's own strings would silently break. That is a call the operator or
the manager should make with the trade stated, not one a lane makes
unilaterally under "implementation work." Reported, not guessed, per this
lane's own instructions.

## Appendix — the dump, as text (run 3, `CARDTABLE_PLAY_DUMP`, seat 0's lines)

`/tmp` is tmpfs, so this is the record. Every frame seat 0 received, in order,
to the London step and 3 s past it (nothing further arrived):

```
setGameView / openView / setGameView  (×2 each, initial sync)
applyDelta   newObjects=243 objectDeltas=0   game object present in newObjects,
             keys: _type,_id,Players,GameType,Title,WinningTeam,
             NumGamesInMatch,PoisonCountersToLose  (no Mulligan)
updateButtons  label1=Play  label2=Draw  enable1=true  enable2=true
showPromptMessage  "A, you have won the coin toss.\n\nWould you like to play or draw?"
applyDelta   newObjects=28  objectDeltas=2   game object in NEITHER (unchanged
             since the last delta, per Forge's own dirty tracking)
updateButtons  label1=Keep  label2=Mulligan  enable1=true  enable2=true
showPromptMessage  "A, you are going first!\n\nDo you want to keep your hand?"
[the harness presses "Mulligan" here — selectButtonCancel]
applyDelta   newObjects=26  objectDeltas=1   game object in NEITHER
updateButtons  label1=OK  label2=Auto  enable1=false  enable2=true
showPromptMessage  "Return 1 card(s) to the bottom of your library"
[3 s wait, nothing further arrives]
```

The `objectDeltas` entries in the last two `applyDelta`s are the redrawn
`Hand`/`Library` (player-type objects, confirmed in the full dump) — Forge
does walk the graph for those, because `InputConfirmMulligan`/the redraw path
crosses a `syncAndSend` elsewhere. The Game object specifically never does,
for the reason cited above.

## What's left, precisely

- The failing jvm test stands as the reproduction and stays red until item 1
  is actually fixed — one of: (a) a `forge/` patch once the fork exists
  (`InputLondonMulligan.showMessage()` calling something that syncs, e.g.
  `setHighlighted` with an empty set up front, mirroring how wave 22 already
  special-cased this same Input for entity marking — `PlayBridge.java:772-785`);
  or (b) an explicit, documented decision to synthesize the flag in
  `PlayBridge.java` off the button/message signals above, accepting the
  locale-fragility trade.
- Until then, `apps/ui/src/play/live/match.ts`'s `mulliganHand` gate
  (`if (!readGameBool(state, 'Mulligan')) return null;`) is correct code
  starved of a fact Forge never sends for this input — not a bug in that file,
  and not this lane's to change regardless.
