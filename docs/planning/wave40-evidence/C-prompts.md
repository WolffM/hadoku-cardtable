# C — `prompts.jvm` "choices": the stall is Forge's own engine, not the driver

## The dump

Added a temporary dump-on-timeout to the `choices` test (`writeFileSync` in a `catch`
around the `drive(...)` call, reading `bridge.stderr.txt` from the still-live run
directory before `h.stop()` runs — a clean stop removes that directory). Ran it once to
completion under `heavy` (180s drive timeout, ~200s total, not killed early):

```
cd apps/ui && heavy npx vitest run src/play/live/prompts.jvm.test.ts --fileParallelism=false -t "choices"
```

Result: fails exactly as before (`the scenario did not finish in 180000 ms`), dump
written to `$CARDTABLE_PLAY_WORK_DIR/choices-dump.json` (1.0 MB: `h.asks`, open-ask
check, last 80 raw bridge lines, last 80 emitted envelopes, last 80 server log entries,
both seats' live DOM, and the bridge's own stderr tail).

## What it shows

**The server-side `ask-answered` log confirms the confirm reply was sent and accepted**
(`{"evt":"ask-answered","seat":1,"callId":"s1-1","method":"confirm","ms":379}`) — this
run even shows `framesAfter: 1` for that ask (not 0 like an earlier manual run), so the
client-side bookkeeping is not uniformly "nothing happened": a little did.

**The bridge's own stderr (Forge's internal protocol trace) is the real finding.** The
last 120 lines of the ENTIRE stderr file, at the moment of the 180s timeout, span only
`13:07:41`–`13:07:44` — three seconds, right at the very start of the match (events
8–40) — even though the test ran from `13:07:22` to roughly `13:10:42` (200s). Forge
produced **zero** further log output for the remaining ~176 seconds before the harness
gave up. The last real activity, in order:

```
GuiGameEvent 34: selectCard        <- seat 1 clicks Serum Powder (the driver's mulliganWith act)
GuiGameEvent 35: showPromptMessage
GuiGameEvent 37: updateButtons
GuiGameEvent 38: showWaitingTimer
GuiGameEvent 36: confirm            <- "Use Serum Powder (116)'s ability?"
FGameClient: Client sent Reply (36): true      <- answered Yes
GameProtocolHandler: Protocol confirm processed in 491 ms
RemoteClientGuiGame: Sending batch of 1: [GameEventZone]   x2
applyDelta seq=5 (1 events, 0 new, 1 delta)
applyDelta seq=6 (1 events, 0 new, 1 delta)
```

Two small zone deltas (consistent with exiling Serum Powder) land, and then **nothing
else is ever logged by the JVM again.** No further `GuiGameEvent`, no further batch, no
exit, no exception — total silence for the rest of the budget. `h.match.id`'s server log
tail ends at the same `ask-answered` line; the raw bridge-line stream (`h.raw`) and the
emitted-envelope stream (`h.emitted`) both end at the same two `applyDelta` frames.

**Both seats' live DOM at the moment of timeout** (`driver.roots[n].innerHTML`, captured
in the dump) confirm there is no open ask, no bar-driven confirm pop-up
(`live-confirm-host`), and no play/draw prompt on either side — just the ordinary board.
Seat 1's control bar **does** carry a "Keep" label (the mulligan's `InputConfirmMulligan`
pair, matching the module header's description of that shape) and its own `live-says`
area still shows the **original, pre-Serum-Powder** prompt text verbatim: *"A is going
first. B, you are going 2nd. Do you want to keep your hand?"* — but that OK/Keep button
is `disabled`. This is stale state left over from before the ability was used; nothing
afterward ever re-enabled it or replaced it, which lines up exactly with the stderr going
silent at the same point.

## Conclusion: not a driver bug, not fixable in this lane's files

This is a genuine stall inside Forge's own engine thread (or the bridge wrapping it),
triggered partway through resolving Serum Powder's ability at the mulligan step — the
JVM simply stops producing any protocol traffic at all, for both seats, for the rest of
the test's budget. It is not:

- a DOM/test-id mismatch in `prompt-driver.ts` (the `confirm` ask was found, clicked, and
  the reply **was** sent and accepted — `ask-answered`, `framesAfter: 1`);
- the T4 pop-up change (`ConfirmPrompt.tsx`'s bar-driven `live-confirm-host`) intercepting
  anything here — neither seat's DOM shows that component mounted at the time of the
  stall, and `game-driver.ts`'s generic fallback (`decide()`'s `buttons?.enable1 === true
  ? ['OK', OK] : null`) reads the raw wire `notes.buttons`, not the DOM, so a UI-only
  change could not block it even in principle; `bar.enable1` is genuinely `false` on the
  wire, because Forge never sent an `updateButtons` enabling anything after the ability's
  two zone deltas.

Two independent real-JVM runs (an earlier manual run and this dumped one) hit the
identical stall shape: `confirm` answered, two small zone deltas, then total silence.

Per this lane's own file list, the only files this lane may touch are
`apps/server/src/play/match.ts` (log keep/replay only), `match.test.ts`,
`apps/ui/src/play/live/prompts.jvm.test.ts`, `flow.jvm.test.ts`, and
`apps/ui/src/play/live/prompt-driver.ts` — none of which contain the actual Forge engine
or the bridge (`apps/server/src/play/bridge/PlayBridge.java`, lane B's). **Not fixed
here.** This needs someone who owns the bridge (lane B's territory, or a dedicated wave)
reading what Forge's `PlayerControllerHuman`/`InputConfirmMulligan`/Serum Powder's own
script does after `chooseBinary`/`confirm` returns `true` at the mulligan step, with
`jstack` on the hung JVM or added bridge-side tracing — nothing visible from the Node
side names a thread, a lock, or an exception.

The temporary dump-on-timeout code has been removed from `prompts.jvm.test.ts`; the file
is back to its original, unmodified state (diff confirmed clean against the pre-lane
version). The pinned CI `known_failing` line for this test
(`the fifteen prompts against a real Forge match choices: confirm, order, tempShowZones,
getChoices, showInputDialog, chooseSingleEntityForEffect`) should **stay pinned** — it is
not fixed, and the cause is outside this lane's files.
