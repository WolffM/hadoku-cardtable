# §U — the mulligan pick reads once (AB2)

The operator, Playtest 12: *"'Return 1 card(s)…' → 'Return 0 card(s)…' is awkward. remove the
'auto' button, grey out OK until the criteria has been met."*

## What changed

`apps/ui/src/play/live/LiveBoard.tsx`:

- While `choosingMulligan(match)` is true and the bar is not a confirm prompt (the London
  mulligan's bottom pick), the decision pop-up now holds the FIRST "Return N card(s) to the
  bottom of your library" sentence Forge sends for the pick, in a `useRef`, and keeps showing it
  for the whole pick — ignoring every later count-down sentence Forge sends as cards are set
  aside or taken back.
- The hold is gated on the sentence matching Forge's own pattern
  (`MULLIGAN_BOTTOM_PICK = /^Return \d+ card\(s\) to the bottom of your library\.?$/`), not merely
  on `mulliganPick` turning true. Found during claws proof, not assumed: Forge's own `Mulligan`
  delta can land one frame ahead of this pick's own `showPromptMessage`, so the render in between
  still carries the PREVIOUS question's text (the Keep/Mulligan confirm, e.g. "Do you want to
  keep your hand?") while `mulliganPick` already reads true. Latching onto that transitional frame
  locked the whole pick onto the wrong sentence — reproduced once against real Forge, fixed by
  gating the latch on the sentence itself.
- `button2` (Forge's "Auto") is no longer drawn while `mulliganPick` is true —
  `decisionCancel` now requires `!mulliganPick`.
- `button1` ("OK") stays gated on `bar.enable1` alone during the pick (unchanged: `!mulliganPick
  || bar.enable1` already reduces to `bar.enable1` when `mulliganPick` is true).
- The held text resets to `null` the instant `mulliganPick` turns false (the pick ends), so the
  next pick gets its own fresh first sentence.

## The one text the operator will read

`"Return 1 card(s) to the bottom of your library"` — held unchanged through the whole pick, OK
disabled until a card is set aside then enabled, no second button at any point.

## Unit test

`apps/ui/src/play/live/LiveBoard.test.ts`, describe block `T2`, new case: *"AB2: the FIRST 'Return
N card(s)…' sentence holds for the whole bottom pick, with one button, and lets go once the pick
ends"*. Sequence: `showPromptMessage('Return 1 card(s)…')` + `updateButtons(false)` + `Mulligan:
true` → decision text is the Return-1 sentence, OK disabled, no `live-decision-cancel`;
`showPromptMessage('Return 0 card(s)…')` + `updateButtons(true)` → decision text is STILL the
Return-1 sentence (not Return-0), OK now enabled, still no `live-decision-cancel`; `Mulligan:
false` then a fresh `Return 2 card(s)…` + `Mulligan: true` → decision text is the NEW Return-2
sentence (proof the hold let go).

`pnpm exec vitest run apps/ui/src/play/live/LiveBoard.test.ts`: **177 passed** (whole file, no
regressions elsewhere).

## Mutation

Reverted the held-text render (`message={mulliganPick ? mulliganPickText.current ?? '' :
decisionMessage(...)}` → `message={decisionMessage(match.prompt ?? '')}`), leaving everything
else in place:

- Unit test: **1 of 177 FAILS** — `AB2: the FIRST "Return N card(s)…" sentence holds…` fails with
  `expected 'Return 0 card(s)…' to contain 'Return 1 card(s)…'`. Restored: 177/177 pass.
- Real-Forge e2e (claws, same mutation): **1 of 1 FAILS** — `expect(received).toBe(expected)`,
  `Expected: "Return 1 card(s)…OK"`, `Received: "Return 0 card(s)…OK"`. Restored: 7/7 pass.

## Real-Forge proof (claws, `WolffM/hadoku-cardtable`, `forge.yml`, `-f only=e2e -f specs='w31'`)

Built off a verify commit carrying HEAD plus only this lane's three files
(`apps/ui/src/play/live/LiveBoard.tsx`, `apps/ui/src/play/live/LiveBoard.test.ts`,
`e2e/w31.spec.ts`), pushed to `verify/w55-U`, deleted after the runs below.

| run | result | w31.spec.ts |
| --- | --- | --- |
| 37668133492 | success (1m53s forge-e2e) | 7 passed, 0 skipped |
| 37668432363 | success (1m9s forge-e2e) | 7 passed, 0 skipped |
| 37668639264 | success (1m50s forge-e2e) | 7 passed, 0 skipped |

**3/3, 21/21 individual test cases, 0 skipped.** The London-pick case
(`w31.spec.ts:116:1`, *"reload with a selection open: the London bottom pick survives a refresh
and can be answered (P10)"*) passed every run, now also asserting (new in this wave): no
`live-decision-cancel` while the pick is open, the decision text is unchanged after Forge's own
count-down sentence moves on past the first one, and still no second button once OK is enabled.

## e2e additions

`e2e/w31.spec.ts` (`reload with a selection open…`, lines ~149-153 and ~196-201): captured the
pop-up's text the moment the bottom pick opens (`firstPickText`), asserted no
`live-decision-cancel` at that point, and after the pick is answerable (OK enabled, Forge having
sent its own count-down sentence in between) asserted the decision text is still exactly
`firstPickText` and still no `live-decision-cancel`.
