# Wave 35 §S follow-up, item 3 — Q17's transient-stack race

## The finding (lane E)

`w33.spec.ts`'s Q17 test — *"casting your own spell does not stop you at
priority while it sits on the stack"* — flakes 1-in-3 to 1-in-6 once R15 made
the window it exercises reachable far more often than before. Asked to
diagnose from the server's side whether a stop is genuinely offered while a
spell is on the stack, and fix it if it is ours.

**It is ours**, and reproduces far more reliably in isolation than the "1-in-3
to 1-in-6" framing suggests: run alone, repeatedly, against the pre-this-item
code (`git show HEAD:apps/server/src/play/match.ts`, i.e. everything already
landed this wave except this item), it failed **10/10**.

## Mechanism 1 (the bigger one): `updateButtons` forwarded before the decision

`onFrame` used to call `this.send(s, frame)` for EVERY frame unconditionally,
with `maybeAutoPass` only deciding whether to press OK on it AFTER the send
had already happened. For a window this seat's own `decideStop` was always
going to auto-pass — its own spell newly on the stack, `policy.passOwnSpell`
— the `updateButtons` frame carrying a live, enabled OK still reached the
wire first, for however long the auto-pass command took to round-trip back
through the bridge. `enabledOk` on the real board genuinely read `true` for a
window nothing ever meant to ask the player about.

First attempt at a fix — withhold that `updateButtons` frame outright when
`maybeAutoPass` decides on the spot — still failed 1/1. Root cause: the
board's buttons persist from whichever `updateButtons` arrived last, and the
window immediately BEFORE this one (the seat's own MAIN1 entry) is itself a
genuine, correctly-enabled stop (wave 20 #7's own-main-phase carve-out) —
withholding the new frame just leaves that EARLIER stop's own enabled OK
showing through the whole auto-passed window instead of a disabled one.

Fixed: `updateButtons` is still always sent, but when `maybeAutoPass` decides
to pass, both buttons go out disabled (`enable1`/`enable2`/`focus1: false`)
instead of whatever Forge actually said — the board reflects "nothing to do
here" the instant the window opens, same moment the server presses OK itself.

## Mechanism 2: `updateButtons` can arrive before the `showPromptMessage` that describes it

Even with mechanism 1 fixed, the race still reproduced (confirmed directly:
reverting the fix alone — `disableStaleButtons`'s call site deleted — brought
back 1/3 failures, the ratio e-runs.md itself reported). The second cause,
found from `onFrame`'s OWN existing comment two lines below (about
`InputPayMana`): **`updateButtons` is not guaranteed to arrive after the
`showPromptMessage` describing the same window** — Forge can send the new
buttons first and the prompt second. `maybeAutoPass` was triggered only on
`updateButtons`, so when it ran against a STILL-STALE `s.prompt` (reading the
earlier, genuinely-a-stop window), it correctly judged "this is a real stop,
don't pass" for that stale snapshot — and was never asked again once
`showPromptMessage` caught `s.prompt` up to the true stack-non-empty window,
unless some LATER `updateButtons` happened to re-arrive.

Fixed the same way `maybeAutoPay` already handles this exact Forge ordering
quirk (triggered on both frame types): `maybeAutoPass` now also runs on
`showPromptMessage`, and if it decides to pass there, a disabled copy of
`s.buttons` (the real one already on the wire, enabled) is sent to correct it.

## A SECOND cast action, not just one

Casting a hand card goes through `clickHandCard`'s Arena-cast gesture
(click arms it, a mouse move to the battlefield settles it — wave 35 R7),
which is TWO client actions, not one. Whichever one actually submits
`selectCard` to the server now also has its own protection:
`fromClient`'s `case 'act':` calls a new `disableStaleButtons(s)` the instant
ANY act is forwarded, disabling whatever buttons this seat was just shown
(if they were live) before Forge has had any chance to speak about the
consequence of that act — closing the gap between "I just acted" and "Forge's
next real word", regardless of which specific act closes it.

## Counts

- **Reverted to HEAD** (nothing from this item applied): **0/10** e2e runs
  passed (10/10 failed), confirmed via `pnpm --filter @hadoku/server build`
  + 10 isolated `playwright test … -g "Q17"` runs.
- **`disableStaleButtons` alone, mechanism 1's call site removed**: 1/3
  failed — matches lane E's own reported ratio closely.
- **Both mechanisms fixed** (final state): **61/66** e2e runs passed across
  five separate batches (6/6, 9/10, 14/15, 15/15, 17/20) — roughly a 92%
  pass rate, up from 0% in isolation and the reported ~70–85% before this
  item. The 5 residual failures all reproduce the exact same assertion and
  symptom (an enabled OK observed on the very first 25 ms poll after the
  cast), not a new or different failure mode.
- `pnpm exec vitest run apps/server/src/ apps/ui/src/ packages/`: **3292
  passed, 0 failed** (98 files, 30 jvm-gated skipped) after both fixes.
- `pnpm --filter @hadoku/server typecheck` and `eslint` on every touched
  file: clean.

## What is NOT fixed, and why it is very likely outside this lane's files

A residual ~8% failure rate remains, with the identical symptom and
assertion each time, and no new timeout or crash — consistent with genuine
transport/event-loop-level reordering between the disable frame this file
now sends synchronously and the stack-zone `applyDelta` Forge's own state
update produces, rather than a THIRD application-logic ordering bug in
`match.ts` itself (two were found and fixed; a diagnostic pass confirmed both
`updateButtons`-first and `showPromptMessage`-first orderings are now
covered). Closing the remainder completely would most plausibly need a
CLIENT-side complement — the UI optimistically treating its own just-submitted
act as invalidating its own currently-shown buttons, independent of any
server round trip at all — which lives in `apps/ui/src/play/live/**`, not
`apps/server/src/play/**`.

## Files changed

- `apps/server/src/play/match.ts` — the two `maybeAutoPass` trigger points
  (on `updateButtons`, now deciding before sending and disabling rather than
  withholding; and on `showPromptMessage`, for the out-of-order case) plus
  the new `disableStaleButtons`, called from `fromClient`'s `act` case.
- `apps/server/src/play/match.test.ts`, `apps/server/src/play/socket.test.ts`,
  `apps/server/src/play/browser/browser.test.ts` — no behavioural change
  needed once buttons are DISABLED rather than withheld (frame counts are
  unchanged; only content differs, and none of these assert full frame
  equality) — confirmed, not guessed: all three were red with the
  withhold-based first attempt and green again once it was replaced.
