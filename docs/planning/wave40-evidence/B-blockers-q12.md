# B — Q12 (`scenario-blockers`): the block input closes with nobody pressing

**Status: reproduced, diagnosed further than wave38's `J-blockers.md`, not fixed.** The cause is not
in a file this lane owns, and the lead `J-blockers.md` left open (`match.ts`'s own stale auto-pass OK
landing on the next input) is now **ruled out** by evidence, not just unverified.

## Reproduced

First run, no load needed: `scenario-blockers.jvm.test.ts` alone, `--fileParallelism=false`.

```
✓ Q10: a defender with no creature is passed through Declare Blockers, with nothing to assign
✗ Q12: a defender with one creature is NOT auto-passed through Declare Blockers, and can assign the block
  timed out waiting for the block-assignment input to open for the defender
  (dump: /tmp/claude-1000/w40-B/work/the-block-assignment-input-to-open-for-the-defender-1791143249589.dump.json
   — last 20 frame methods: s1:setWeaklySelectable, s1:updateButtons, s1:showPromptMessage, s1:updateButtons,
   s1:setHighlighted, s1:clearWeaklySelectable, s1:applyDelta, s0:applyDelta, s0:setWeaklySelectable, …)
```

## What the dump shows (item 1's new infrastructure — the first time this flake has a millisecond timeline)

Every seat-1 frame between the window opening and closing, from the dump's `frames` array:

```
t=17773  s1 showPromptMessage "Priority: B … Declare Attackers Step"   (enable1=false)
t=17776  s1 clearWeaklySelectable
t=17782  s1 setHighlighted
t=17782  s1 setWeaklySelectable [90]                    <- Forge offers the scripted Memnite (id 90)
t=17782  s1 updateButtons {OK enable1:true, Cancel}
t=17782  s1 showPromptMessage "Select creatures to block Memnite (85) or select another attacker…"
t=17789  s1 updateButtons {OK enable1:false, Cancel}    <- +7ms: OK already disabled again
t=17794  s1 setHighlighted
t=17794  s1 clearWeaklySelectable                       <- +12ms: window closed
t=17798  s0 showPromptMessage "Priority: A … Declare Blockers Step"    <- block decision is DONE
```

**The whole window is open for 12 ms.** No human, no test act, and no act this test's own code sent
(`scenario-blockers.jvm.test.ts` presses only seat 0's Declare-Attackers-Step OK, via
`passDeclareAttackers`; it never calls `keepHands()`/`passUntil` again and sends nothing for seat 1
until the test's own later, deliberate `s.select(1, blocker.id)` — which never got the chance to run,
because `waitUntil` had already timed out on the prompt text). The `decisions` array in the dump —
every `auto-passed` log line for the whole match — has exactly three entries, and none of them is
seat 1 at Declare Blockers Step:

```json
[
  {"evt":"auto-passed","seat":0,"phase":"Declare Attackers Step"},
  {"evt":"auto-passed","seat":1,"phase":"Declare Attackers Step"},
  {"evt":"auto-passed","seat":0,"phase":"Declare Blockers Step"}
]
```

`match.ts`'s `maybeAutoPass` logs `auto-passed` **unconditionally, immediately before** it sends the
`selectButtonOk` act (`match.ts:1609-1610`) — there is no code path that sends one without logging it.
Since no such line exists for seat 1 at this window, **`maybeAutoPass` did not send the click that
closed it.** `maybeAutoPay` is the only other place `match.ts` sends `selectButtonOk` (logs
`auto-paid`, also unconditional) — not applicable here (no payment prompt was open). So wave38's
lead — *"the only press in flight for seat 1 is the server's own `auto-passed` OK … the stale OK lands
on the next input"* — **is ruled out**: there is no stale act in flight from `match.ts` at all.

## Where the close actually comes from

The bridge's own stderr (captured in the dump's `stderrTail`) shows, in the same window:

```
… Received: GuiGameEvent 46: setWeaklySelectable (1 args)
… Received: GuiGameEvent 47: updateButtons (6 args)
… Received: GuiGameEvent 48: showPromptMessage (3 args)
… Received: GuiGameEvent 49: applyDelta (1 args)
… Received: GuiGameEvent 50: showCombat (0 args)
… FGameClient: Client sent GuiGameEvent 51: selectButtonOk (0 args)
… Received: GuiGameEvent 51: selectButtonOk (0 args)
… Received: GuiGameEvent 52: setHighlighted (2 args)
… Received: GuiGameEvent 53: clearWeaklySelectable (0 args)
… Received: GuiGameEvent 54: applyDelta (1 args)
… [GAME EVENT] B declared blockers: {B={Memnite (85)=[Memnite (85)]}}
```

A `selectButtonOk` genuinely closes `InputBlock`'s window (`InputBlock.onOk()` — confirmed from Forge
source, `forge/forge-gui/src/main/java/forge/gamemodes/match/input/InputBlock.java:97-106`:
`onOk()` calls `CombatUtil.validateBlocks` and, if it's null — an empty block is always valid —
`stop()`s the input with whatever was assigned, i.e. none). **Whose click this is cannot be read off
this log.** `GuiGameEvent`'s id is a single `private static int staticId` shared by the WHOLE JVM
(`forge/forge-gui/src/main/java/forge/gamemodes/net/event/GuiGameEvent.java:7`) — both seats' traffic,
inbound and outbound, is one interleaved counter, not a per-channel sequence, so numeric adjacency to
events 46-50 (seat 1's own block-window push) does not prove event 51 is seat 1's. This was checked
and ruled out as a lead, not assumed.

**Ruled out, with evidence, not just reasoning:**

- `match.ts`'s two logged auto-send paths (`maybeAutoPass`, `maybeAutoPay`) — above.
- A controller-identity mixup in the bridge (two `SeatGui` instances resolving to the same
  `IGameController`, so seat 0's own click lands on seat 1's input) — read Forge's own
  `FGameClient.setGameControllers`/`GameClientHandler.beforeCall`
  (`forge/forge-gui/src/main/java/forge/gamemodes/net/client/GameClientHandler.java:100-108`): each
  client's `openView` dispatch calls `setOriginalGameController` with THAT connection's own
  `myPlayers`, independently of `SeatGui.openView`'s override (which only emits the wire frame and,
  correctly, does nothing else — `openView` has no inherited default to skip). Per-client registration
  is correct; this is not where the bug is.

**Not ruled out, and not fixable in this lane's files:** something closes `InputBlock` within single
digits of milliseconds of it opening, with no test act and no logged server decision. Whether that is
Forge's own engine (an internal auto-resolve this evidence does not name) or a `match.ts` code path
that sends an act without ever calling `this.deps.log` first (unlike every OTHER send in that file) is
the open question. Settling it needs either instrumentation inside the bridge that tags which seat's
channel an inbound `GuiGameEvent` arrived on (a bridge change, but NOT an ordering fix — out of this
wave's "by order, never by timing" instruction, since there is no known ordering bug here to fix), or
reading `match.ts` end to end for every `command()` call against the live wire trace — `match.ts` is
not a file this lane owns (only the log keep/replay in it is, per the wave file's lane table).

## Rate

1 failure on the first run here (this lane did not need load to reproduce it — contradicts nothing in
`wave38-evidence/J-blockers.md`'s 2-3-of-4-and-5 rate; different host, different moment, same order of
magnitude). No further runs were spent reproducing it again: the dump already answers what w38 could
not (exactly which input closed, in how many milliseconds, and that `match.ts`'s own logged decisions
do not explain it), and this lane's budget went to the two assigned long-pole items instead (the
`auto-pass-land`/Thoughtseize R4 shape — see `B-auto-pass-land.md`).

## For the manager

- **Not fixed. Still goes on `known_flaky`.** Do not remove this pinned line.
- The `scenario-blockers.jvm.test.ts` diagnostics are now the shared `scenario.ts` dump mechanism
  (item 1) rather than the file's own ad hoc `frameTrail` helper, which was deleted (−18 lines) in
  favour of it — same information, plus the bridge stderr tail and a written JSON file CI can keep as
  an artifact.
