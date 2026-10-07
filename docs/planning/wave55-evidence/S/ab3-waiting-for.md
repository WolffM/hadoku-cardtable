# AB3 — "Waiting for Hadoku" flashes after both seats kept

## The operator's claim

> "Waiting for Hadoku" flashes after both seats kept: a state drawn for the
> frames between Forge's mulligan end and the first priority prompt.

## Finding: a client gap state, not a forwarded window — item (1) does not cover it

The frame timeline below is the two-human recorded transcript this lane
already carries (`apps/server/src/play/fixtures/bridge-two-seats.ndjson`,
seat 0 = "Seat 1", seat 1 = "Seat 2", seat 1 went first), read line by line
right across the mulligan-end → first-priority boundary AB3 names:

```
20 frame 1 notify updateButtons
21 frame 1 notify showPromptMessage  "Seat 2, you are going first!\n\nDo you want to keep your hand?"
22 frame 0 notify updateButtons
23 frame 0 notify showPromptMessage  "Seat 2 is going first.\nSeat 1, you are going 2nd.\n\nDo you want to keep your hand?"
24 frame 1 notify showPromptMessage  "Waiting for Seat 1..."
25 frame 1 notify updateButtons
26 frame 1 notify applyDelta
27 frame 0 notify applyDelta
28 frame 1 notify showPromptMessage  "Priority: Seat 2\nTurn: 1 (Seat 2)\nPhase: Upkeep step\nStack: "
29 frame 1 notify updateButtons
30 frame 0 notify showPromptMessage  "Waiting for Seat 2..."
31 frame 0 notify updateButtons
```

Both "Waiting for …" lines (24, 30) are **Forge's own transient status**,
`AbstractGuiGame.lblWaitingForPlayer` — `scenario.ts:478` already documents
this exact string as "Forge's generic 'the other seat hasn't acted yet'
status", sent routinely all game, not just at the coin-toss/mulligan
handoff. Seat 0's copy (line 30) is forwarded normally: its buttons carry
nothing actionable, none of the three deciders (`maybeAutoPass`,
`maybeAutoPay`, `maybeConfirmChosenCost`) match a "Waiting for …" message (it
is not `Priority:`, has no `Pay Mana Cost:` line, and is not a chosen-ability
confirm), so `decidePendingWindow` always finds `answered === false` for it
and forwards the pair exactly as before this wave. **Item (1)'s withholding
fix changes nothing about this window, in either direction.**

That rules out "a forwarded window the server answers" — the other half of
the brief's own disambiguation is confirmed instead: what the operator saw is
the **client's own synthesized indicator**, not a passthrough of Forge's
prose. `apps/ui/src/play/live/LiveBoard.tsx`:

- `isWaitingForOpponent` (`:437-442`) is `!myMoveNow(match)` whenever a board
  exists and the game has not ended.
- `myMoveNow` (`:406-423`) is true only for an open ask, the London mulligan's
  own bottom pick, an open selection, a live payment, or `match.buttons.enable1`.
- The banner text itself is `Waiting for {theirName}…` (`:2046`, `:2336`) —
  `theirName` is this app's OWN display name for the opponent (what the
  operator read as "Hadoku"), never Forge's own "Seat 2" spelling. Forge's
  "Waiting for Seat 2..." string is not displayed verbatim anywhere; it is
  read only to decide `inputLive`/`prompt`, and the banner is a second,
  independently-computed indicator that happens to say the same thing in
  different words.

So "Waiting for Hadoku" is drawn whenever `myMoveNow` reads false — which is
true for the ENTIRE stretch between this seat's own keep-confirmation and
whatever next sets `match.buttons.enable1` true, regardless of what Forge is
doing wire-side in between (a genuinely-forwarded "waiting" prompt, a
withheld auto-pass, or simply nothing having arrived yet). It is not keyed to
any single server frame, so it cannot be "covered" by changing which frames
this lane forwards or withholds.

## Disposition

Per the brief's own fork: this is the client's own gap state, not a
forwarded-window case. Left to the tracker, unfixed by this lane — the file
(`LiveBoard.tsx`) is also outside S's ownership this wave (P owns the
presence host object in it; U owns the mulligan decision pop-up; neither
region is `myMoveNow`/`isWaitingForOpponent`).
