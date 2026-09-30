# P7 - the mulligan order, driven against real Forge

Test: `apps/server/src/play/mulligan.jvm.test.ts`, second `it`. Two human seats, seed 7,
two flood decks. Seat 0 takes Mulligan once, then Keeps; seat 1 Keeps. Every
`showPromptMessage` either seat receives is recorded in order with the seat's hand
size at that frame (folded from the wire frames up to it).

## Before (wave-8 jar, `LondonMulligan.mulliganDraw()` tucks)

```
seat0 keep? (7 cards)
seat0 return (7 cards): Return 1 card(s) to the bottom of your library   <- before any decision
seat1 keep? (7 cards)
seat0 keep? (6 cards)                                                    <- asked again, shortened
seat0 after: Priority: A
```

## After (fork commit 917bb193, `keep()` tucks)

```
seat0 keep? (7 cards)        -> Mulligan
seat1 keep? (7 cards)
seat0 keep? (7 cards)        -> Keep
seat0 return (7 cards): Return 1 card(s) to the bottom of your library
seat0 after: Priority: A     (no second keep prompt after the return)
```

Cause: `LondonMulligan.mulliganDraw()` drew and immediately called
`tuckCardsViaMulligan`; `MulliganService.runPlayerMulligans` then asked keep-or-mulligan
again on the shortened hand. Fix: `mulliganDraw()` only draws; `keep()` (inherited
`kept = true`, then) tucks `tuckCardsDuringMulligan()` cards. `HoustonMulligan` already
worked this way. `InputConfirmMulligan` does not print `cardsToReturn`, so the keep prompt
text is unchanged. The AI path (`PlayerControllerAi.tuckCardsViaMulligan`) takes any hand
and is now called from `keep()`; the `firstMulliganFree` arithmetic is untouched in
`tuckCardsDuringMulligan()` (read, not driven: the test is two-player).

## Mutation

Reverted (wave-8 jar): mulligan.jvm.test.ts 1 failed / 1 passed. The first `it`
(Mulligan flag true at the London step) passes on both jars by design.
Restored (fork jar): 2 passed / 2, run 7 times, 7 of 7 green.
