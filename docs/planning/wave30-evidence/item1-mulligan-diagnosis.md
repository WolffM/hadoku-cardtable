# Item 1 — the mulligan, diagnosed against real Forge

Operator, 2026-09-30: *"mulligan isn't working. after clicking mulligan, the only
next button i can press is 'auto' the cards in my hand should light up and let me
pick one to send to the buttom."*

**Cause: Forge's `Mulligan` flag never reaches the browser.** Everything else on
that screen is correct.

## The reproduction, and what it printed

`mulligan-probe.jvm.test.ts.txt` beside this file is the probe, run against a
real Forge match (seed 7, two 30-Mountain/30-Memnite decks). It answers the coin
toss, presses **Mulligan** at the keep prompt, and prints what the board sees.
Copy it to `apps/ui/src/play/live/` and run it one file at a time with the jar
vars set.

At the London step it printed:

```
prompt   = "Return 1 card(s) to the bottom of your library"
buttons  = label1 "OK" (enable1=false), label2 "Auto" (enable2=true)
inputLive= true      asks = 0      selectable = 0
GAMEOBJ  = ["_type","_id","Players","GameType","Title","WinningTeam",
            "NumGamesInMatch","PoisonCountersToLose"]
```

That is the operator's screen exactly: OK disabled, Auto live, hand dead.

## Why the hand is dead

`boardInteraction` (`apps/ui/src/play/live/match.ts`) offers the hand during a
mulligan only through `mulliganHand`, which begins
`if (!readGameBool(state, 'Mulligan')) return null;`. **The Game object has no
`Mulligan` key**, so the guard returns null, nothing else names a card at that
moment (no selection, no actionable set), and `selectable` is empty.

Three hypotheses were tested and are WRONG — do not re-test them:

1. *An open ask blocks every click* (`asks.length > 0` → `nothingClickable`).
   Measured `asks = 0`. The server's auto-answer path returns before sending, so
   the browser never sees those asks at all (`match.ts:858-874`).
2. *`pressButton` leaves `inputLive` false* because only `showPromptMessage`
   sets it true. Measured `inputLive = true`, and a unit probe of press →
   buttons-only kept the hand clickable.
3. *The projection redacts Game objects.* Other Game properties arrive fine —
   `PoisonCountersToLose` is in the list above.

## Where to look, in order

The flag is lost somewhere between Forge setting it and the client folding it,
and the client half is already correct:

1. **The bridge.** Does `PlayBridge`'s delta carry `Mulligan` at all? Dump the
   raw bridge lines (`CARDTABLE_PLAY_DUMP=<dir>`) and grep them for it. If it is
   absent there, nothing downstream can fix it.
2. **The server's projection** (`apps/server/src/play/visibility.ts`) — it passes
   a `GameView` through whole today, but confirm against the dump rather than the
   comment.
3. **Forge itself.** `TrackableProperty.Mulligan` is modelled on our wire
   (`packages/forge-wire/src/tier-c.ts`, `Mulligan: 'BooleanType'`), and the
   client's own header cites `GameView.java:141-146`, set at
   `InputLondonMulligan.java:60`, cleared at `:105`. Verify it is actually set on
   the GameView the delta is built from.

## Why no test caught it

`apps/ui/src/play/live/match.test.ts:926` covers the whole mulligan loop and
passes — because it **synthesises** the flag (`mulligan(m, true)`). The only
real-Forge mulligan coverage is `prompts.jvm.test.ts`, whose plan uses
`mulliganWith: 'Serum Powder'` at the KEEP prompt and therefore never reaches the
London bottom-the-cards step. **The step the operator hit has no real-Forge
coverage at all**, which is the second thing to fix: whatever the cause, the test
that proves it must drive a real mulligan, not a synthetic flag.
