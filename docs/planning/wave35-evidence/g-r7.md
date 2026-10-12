# R7 — Arena casting: frames of a drag-to-target

> The `.png` screenshots this file names were removed from the repository on
> 2026-10-11; the written descriptions stand on their own.

Captured against a REAL browser (Chromium via Playwright), not jsdom: a standalone
`startReplayServer` (`apps/ui/src/play/live/replay-server.ts`, scratch-run with
`tsx`, never shipped) replaying the committed fixture capture plus a
`setWeaklySelectable` naming the viewer's hand, served to
`apps/ui/src/play/live/harness.html?match=...&server=...` under
`pnpm --filter @hadoku/ui dev`. 1280×800 viewport. The gesture code under test is
`apps/ui/src/play/live/gestures/install.ts` + `cast.ts`, unmodified from what
ships — this is the real `installGestures` wired through the real
`LiveBoard`/`Board`, not a stand-in.

**Manager's correction, after the first pass of this evidence (and the lane's
own first draft of `install.ts`): the cast is sent AT THE SETTLE, not at
release.** Forge's own round trip — from the cast to whatever targeting ask it
opens next — happens WHILE the gesture is still held (or, for a click-lift,
still armed with no button down). This file documents the corrected
behaviour; the frame numbers below are not contiguous because the first pass's
frames (00–08) are still valid VISUALS (the lift/settle/arrow mechanics did
not change in appearance) but are captioned here for what they actually prove
now, not what the first draft claimed.

All five hand cards (`Leapfrog` id 54, `Ral's Dispersal` id 17, `Fearless
Halberdier` id 46, `Hellkite Whelp` id 60, and a fifth) were sent as Forge's
actionable set. The frames below drag `Leapfrog` (id 54).

## The settle sends the cast — frames 00–05

1. **`g-r7-00-initial.png`** — before any gesture: the hand along the bottom,
   each card with the selectable (orange) border Forge's actionable set gives it.
2. **`g-r7-01-lifted-at-press.png`** — the instant after `pointerdown`, pointer
   not yet moved. `data-cast-lift="lifted"` on the card's own `<li>`, confirmed
   via `page.evaluate`; visually near-identical to frame 0 at zero displacement.
3. **`g-r7-02-lifted-following-pointer.png`** — pointer moved short of the
   viewer's own battlefield. The card has visibly detached from the hand row
   and floats at the pointer; the hand's remaining cards reflowed to fill its
   slot. No arrow, and **nothing has been sent yet** — the settle has not
   happened.
4. **`g-r7-03-settled-on-battlefield.png`** — pointer crosses into
   `[data-zone="battlefield"][data-owner="you"]`. **This is the moment
   `selectCard(54)` is sent** (confirmed against the replay server's own
   received-frames log, reproduced below): the card is pinned where it
   crossed in, and the targeter arrow (unchanged, `arrow.ts`, the same eight
   snap points every other drag uses) now runs from the card to the pointer.
5. **`g-r7-04-arrow-follows-after-settle.png`** — pointer moved on. The card
   has not moved an inch from frame 3; only the arrow's far end moved. The
   cast was already sent two frames ago — this motion is purely the (not yet
   open) search for a target.
6. **`g-r7-05-released-cast.png`** — released back over the viewer's own
   battlefield, where the replay server (a dumb frame log; it never opens a
   targeting ask on its own) has nothing to offer. The server's received-frames
   log for this whole gesture: **exactly one frame, `selectCard(54)`** — sent
   at the settle (frame 3), and the release was its quiet, sends-nothing end.

## Escape before the settle — frames 06–07 (unaffected by the correction)

7. **`g-r7-06-before-escape.png`** / **`g-r7-07-after-escape.png`** — lifted,
   never crossed into the battlefield, Escape pressed: the card snaps back
   into its normal hand position, no arrow, `data-cast-lift` cleared, and the
   server's received-frames log is unchanged across the sequence — nothing was
   ever sent, so there was nothing to undo. This half of Escape's behaviour is
   identical before and after the correction: before the settle, the cast
   simply never happened.

## A plain click — frame 08 (mechanism corrected; see "what this run does not
## show" below)

8. **`g-r7-08-click-lift.png`** — a press-and-release at the same point (no
   drag) on `Ral's Dispersal`. Visually indistinguishable from idle at zero
   displacement, same as frame 1. **What this frame does NOT show, and the
   first draft of this doc wrongly implied it did:** under the corrected
   design the release of a plain click does not end the gesture or send
   anything — it ARMS the gesture (`held: false`) and the card keeps following
   the pointer with no button down until it settles on its own. That sequence
   (click → bare hover move → settle → cast sent with no button held → a
   second click resolves it) is proven in the jsdom suite
   (`gestures.test.ts`, `"a plain click lifts the card, and it keeps
   following the pointer with NO button held..."`, mutation-tested below) but
   was not re-captured as its own frame sequence in the browser this pass —
   see "what I could not get a clean browser capture of."

## The scenario the manager asked for by name — frames 10–13

**Forge's reply to the cast — a fresh targeting ask — arrives WHILE the drag
is still held, and the same gesture answers it on release.** The scratch
replay server was extended to watch for the client's `selectCard` and, 400ms
later, send a `setSelectables` naming every player legal (`match.ts`'s
`boardInteraction` makes every player a legal target the instant any
selection is open — the same fact the pre-existing "onto the opponent's seat"
jsdom case already relies on), standing in for Forge's own round trip.

9. **`g-r7-10-settled-cast-sent.png`** — settled; `data-cast-lift="settled"`
   confirmed. Server log at this point: `CLIENT FRAMES: [...selectCard
   {id:54}...]` — the cast, sent at the settle.
10. **`g-r7-11-target-ask-open-still-held.png`** — ~600ms later (after the
    scratch server's simulated Forge reply), pointer nudged while STILL HELD
    — the server log by now also shows `Forge's reply: opening a targeting
    selection after the cast of 54`.
11. **`g-r7-12-arrow-snapped-to-opponent.png`** — pointer moved onto the
    opponent's face. The arrow's own `data-target`/`data-snapped` attributes,
    read directly off the SVG: `{"target":"player:1","snapped":"true"}` —
    the arrow is snapping to a REAL legal target that did not exist when the
    gesture started, using the unchanged eight-snap-point machinery.
    Screenshot shows the opponent's portrait ringed and highlighted.
12. **`g-r7-13-answered-on-opponent.png`** — released on the opponent. Full
    server received-frames log for this gesture:
    ```
    [selectCard {id:54}, selectPlayer {id:1}]
    ```
    The cast once, at the settle; the target once, at the release that
    answered Forge's follow-up ask — never the card a second time. This is
    the exact shape of "a legal target answers the question" the ruling
    describes, now proven against a targeting ask that genuinely did not
    exist until Forge replied mid-gesture.

## What I could not get a clean browser capture of, and why

I attempted two more real-browser sequences this pass and am reporting both
honestly rather than papering over them:

- **A second concurrent lane navigated the SAME shared Playwright browser tab
  out from under this capture at least twice** (`page.url()` came back
  `about:blank` once and `http://localhost:5173/...harness.html?scenario=token`
  — unmistakably another lane's work, not mine — once), corrupting two
  evaluate-based checks mid-sequence. The Playwright MCP browser is a shared
  resource across concurrently-running lanes right now; I did not keep
  fighting it for more frames once this was confirmed.
- **Independent of that: in my scratch harness specifically (not in the
  jsdom suite), the control bar's OK button renders `disabled` and no Cancel
  button renders at all, from the moment the page loads, before any gesture**
  — `spectator`, `askOpen` and `playOrDraw` all read false by every check I
  could make from the DOM (no `[data-testid="live-prompt"]`, no status line,
  `bar.label1` reads `"OK"` confirming `match.buttons` is populated), so by
  my own reading of `LiveBoard.tsx`'s disabled condition this should not be
  disabled. I could not root-cause it within this pass's budget. Because of
  it, I could not get a trustworthy browser screenshot of the post-settle
  Escape/drop-on-hand sending `selectButtonCancel` (`pressButton`'s own
  `bar.enable2` guard would plausibly refuse it under whatever is making the
  DOM button disabled too, though `pressButton` and the DOM button read the
  same `match.buttons` field by two independent code paths, so this is not a
  proof the send itself would fail — only that I couldn't visually confirm
  it against this one scratch setup). **I am treating the jsdom suite as
  authoritative for this sub-item** — it drives the exact same
  `commitDrag`/`pressButton`/`cancelCastNetwork` code through a real
  replay-server + real `Board` + real `installGestures`, the same harness
  dozens of already-passing, already-reviewed gesture tests in this file
  use, and it passes, with the mutation count below. I would rather say this
  plainly than claim a screenshot I do not trust.

## Mutation counts (the authoritative proof for every sub-item, `gestures.test.ts`)

All of these revert a single piece of the Arena-casting state machine in
`install.ts`, run the full 60-case `R7` + pre-existing suite, record the
failure count, then restore and confirm 60/60:

| Reverted | Failures | Restored |
| --- | --- | --- |
| `isHandCard` gate (always `false`) | 5 of 60 | 60/60 |
| Click-suppression (`onClickCapture` never fires) | 1 of 60 | 60/60 |
| Escape handler (no-op) | 1 of 60 | 60/60 |
| Drop-back-on-hand refusal (`heldDrag.moved && overOwnHand` check disabled) | 1 of 60 | 60/60 |
| **Send-at-settle** (`selectCard` call removed from the settle transition) | **6 of 60** | 60/60 |
| **Click arms-and-continues** (`onPointerUp`'s zero-move branch skipped) | 2 of 60 | 60/60 |
| **Armed-gesture resolve** (`onPointerDown`'s top-of-function check skipped) | 1 of 60 | 60/60 |
| **Post-cast Cancel send** (`cancelCastNetwork` body emptied) | 2 of 60 | 60/60 |
| `source: null` after cast, in `finishCast` | 0 of 60 — see note | 60/60 |
| Reflowed-sibling stale hit-test (simulated: two zero-move clicks, second on a different offered card) | caught by construction, see note | 60/60 |

**The `source: null` override is redundant with `match.ts`'s own
`match.spent.cards` guard** (confirmed by reading `boardInteraction`/
`selectCard`): once a card is cast, `selectCard` marks it spent and
`boardInteraction` excludes spent cards from `offered.selectable`, so
`commitDrag`'s own internal re-check already refuses to resend it even
without my explicit override. I kept the override because it states the
invariant explicitly rather than leaning on a different module's bookkeeping
as the only guard, but no mutation in this suite independently distinguishes
it — noted rather than claimed as independently tested.

**The reflowed-sibling bug (first found in last pass's real-browser run) is
now prevented BY CONSTRUCTION, not by a point-fix**: `finishCast` is a no-op
whenever `!state.cast`, and two zero-movement clicks can never reach
`cast: true` (settling requires real pointer movement into the battlefield),
so there is no code path left that reads a stale `event.target` before a
real cast has happened. The regression test
(`"two clicks with no movement into the battlefield never send anything,
even onto a reflowed SIBLING"`) passes unconditionally under the current
design; I did not find a single-line mutation that reopens the original bug
shape without also being caught by one of the broader mutations above.

## What this still does not cover

- No frame of a drag releasing directly on a legal target where that target
  was ALREADY offered before the cast (an already-open multi-select ask) —
  that shape is unchanged from before this wave and already covered by the
  pre-existing "onto the opponent's seat" test; it is a different, simpler
  case than the one this file's frames 10–13 prove.
- The replay server never simulates Forge actually removing the cast card
  from hand or placing it on the battlefield (it is a dumb frame log), so no
  frame shows the board's own state changing as a result of the cast — only
  the gesture's own sends are proven here. `e2e/play.spec.ts`-style specs
  against a real jar are lane E's.
