# §H — the hand reorders, seen by both (AD1)

## The gesture's rules

A press on the viewer's own hand `<li>`, Forge-offered or not, is now a
REORDER unless it leaves the hand:

- **Where it's claimed.** `install.ts`'s `onPointerDown` gets a new branch,
  ahead of the native-drag stand-down (`nativelyDraggable`) and the
  offered/`under` computation, so it sees a non-offered hand card BEFORE
  `Board.tsx`'s own `useArrangeDrag` would. It is skipped for three cases,
  each already a carve-out the old code had for a different reason: the
  London mulligan's bottom pick (`choosingMulligan`); an open ASK
  (`match.asks.length > 0`, same as the old `castFromHand` gate — an open
  dialog outranks the actionable set); and a selection that NAMES this exact
  card as a choice (`match.selectables?.cards.has(id)` — a discard, a
  reveal — left to the existing `under.kind === 'card'` branch, which still
  answers it by click or drag exactly as before). A stack-ask or an
  attacker/tap box-draw in progress also keep their existing precedence.
- **One state machine, not two.** The press reuses `install.ts`'s own
  existing `drag`/`resolveLift` machinery (`lifted: true`, the same click-arm
  semantics `DragState.held` already had) rather than inventing a second one.
  `./hand.ts` supplies only what's new: the DOM geometry, the board-sized
  lift, the indicator preview, and the commit+FLIP. The handoff from reorder
  to cast is a pure mode change read live off `overOwnHand(event.target)` on
  every move — not a branch decided once at the press — so the SAME lifted
  element, mid-gesture, can cross the hand boundary any number of times with
  zero visual seam.
- **Board-sized from the first frame.** `hand.ts`'s `sizeHandLift` reads
  `--card-w` off `[data-zone="battlefield"][data-owner="you"]` and sets it
  inline on the card the moment it lifts — independently of the
  board-sized-lift rule in `cast.ts`/`gestures.css` (not edited here).
  `clearHandLiftSize` lets the override go the instant the pointer leaves the
  hand (that other rule takes sizing from there) or the reorder settles (back
  to the hand's own, smaller, ambient value).
- **The preview.** `updateHandIndicator` reuses the battlefield rearrange's
  own markup wholesale — `[data-arrange-indicator]`, `[data-arrange-target]`
  (`board.css`, not touched here) — marking the nearest sibling ("before" it)
  or the slot's own end. No live reflow of siblings while dragging: the
  indicator alone previews the landing spot, the same economy
  `useArrangeDrag` already uses for the battlefield.
- **The commit.** `resolveLift`'s own `overOwnHand(node)` branch — previously
  "float back, nothing sent" for EVERY hand-card release — is now "commit the
  reorder, nothing sent" (the ONE behavioural line that changed in that
  function). `hand.ts`'s `commitHandReorder` reads the hand's current DOM
  order, computes the nearest drop target from the release point, calls
  `Board.tsx`'s `commitHandMove` (never Forge — a hand reorder is invisible
  to the engine by construction, same guarantee the battlefield's own
  rearrange makes), queues `handMove` for presence when the index actually
  changed, then FLIPs every hand card whose box moved — the dragged one
  included, by first letting its own `data-cast-lift` go so its true resting
  box can be measured, then animating the delta with `transform`/`transition`
  (300ms, `cubic-bezier(0.3, 0.7, 0.3, 1)` — the house curve, the same number
  `gestures.css`'s `[data-cast-lift='parked'|'returning']` already use).
  `[data-hand-flip]` (`hand.css`) keeps a card out of the player's way for
  the ~300ms it's mid-flight.
- **Native HTML5 drag on hand cards is deleted in effect, not in markup.**
  `Board.tsx`'s `CardOnBoard` still sets `draggable="true"` on a non-offered
  hand card — that attribute is the SEAM `useArrangeDrag`'s own `onDown`
  reads (`event.defaultPrevented`), not a mechanism of its own (see
  `useArrangeDrag`'s own header comment: the browser's native drag was
  already replaced by a synthetic pointer drag, wave 32 Q4b). Claiming the
  press in `install.ts` — which now happens for every hand press — makes
  `useArrangeDrag`'s `onDown` stand down (`event.defaultPrevented`) and its
  `onDragStart`/capture listener cancel the one real native drag start that
  attribute could still trigger. I did not touch `Board.tsx`'s `draggable`
  computation, `handStandsDown`, or `useArrangeDrag`/`CardOnBoard` at all —
  outside my file scope, and unnecessary: the existing "two gestures stand
  down for each other" seam already gets the job done. The CONSEQUENCE is
  that `useArrangeDrag`'s own hand-handling becomes unreachable in the
  integrated app (it still runs, and is still correctly tested, when
  `Board.tsx` is rendered without the gesture layer — `Board.test.ts`'s
  `describe('drag to arrange your own hand (#2)')` suite, untouched, still
  passes in full, because it drives `useArrangeDrag` directly with no
  `install.ts` installed to intercept the press first).

## Presence (AD1's other half)

- `packages/shared/src/presence.ts`: a new `handMove: { from, to } | null`
  field, `.strict()`, defaulted so a pre-deploy sender's message (which never
  had it) still parses. Both are non-negative hand INDICES in the sender's
  own order — never a card id, never a name.
- `apps/ui/src/play/live/presence.ts`: `hand.ts` calls the new exported
  `queueHandMove(from, to)`; every live `installPresence` instance registers
  a listener (the same module-level-Set seam `Board.tsx`'s
  `carryCastOffStack` already uses between lanes with no import of each
  other's internals) and sends at once, outside the throttle — the same
  reason `sendRelease` already does: a release with no further pointer move
  must not wait on one that may never come.
- Receiving: `glideHandMove` reads `[data-zone="hand"][data-owner="them"] li.card-back`
  at `move.from`/`move.to`, clones a plain `.presence__back` (the SAME
  element an opponent's held card already draws — `[data-waiting]` is
  borrowed only for its existing 300ms house-curve transition, not for the
  "waiting on a placement" meaning it carries elsewhere in that file) from
  one box's centre to the other's, and removes it after `HAND_MOVE_MS`
  (300ms). Every back in a hidden hand is interchangeable, so there is
  nothing for a RESTING state to prove — the glide alone is the whole
  signal, which is why no DOM reorder of the real backs was needed on the
  receiving side at all.

## Tests

- `apps/ui/src/play/live/gestures/hand.test.ts` (new, 12 cases): `handCardPress`,
  `handOrderIds`, `sizeHandLift`/`clearHandLiftSize`, `updateHandIndicator`/
  `clearHandIndicator`, and `commitHandReorder` (the order written, the
  target, the queued indices, a same-spot no-op queuing nothing, the FLIP).
- `apps/ui/src/play/Board.test.ts`: `handOrder`/`withHandMove` pinned
  directly (pure-function cases) plus a new `commitHandMove` describe block
  proving the cross-lane seam — a mounted `Board` redraws on its own the
  moment `commitHandMove` is called, no `rerender()` needed, and the result
  survives a re-render the same way a drag-driven one does. The PRE-EXISTING
  `describe('drag to arrange your own hand (#2)')` suite is untouched and
  still green in full (see "Native HTML5 drag… in effect, not in markup"
  above for why it still describes real, reachable-in-isolation code).
- `packages/shared`/`apps/server/src/play/socket.test.ts`: the relay pin —
  `handMove` round-trips through the server's generic presence relay
  unchanged (no server code needed editing: `socket.ts`'s relay already
  spreads `parsed.data`), plus a malformed case (`to: -1`).
- `apps/ui/src/play/live/presence.test.ts` (3 new cases): `queueHandMove`
  sends at once outside the throttle with the two indices and nothing else
  new; a spectator's call sends nothing; a disposed instance never hears it
  again. Receiving: "bob sees a back in alice's hand move from position 0 to
  2" (the exact case the brief names), plus an out-of-range index (a hand
  that resized mid-flight) drawing nothing and throwing nothing.
- `e2e/drag.spec.ts` (+2 cases): a hand card dragged WITHIN the hand and
  released between its neighbours sends nothing to Forge; a hand card Forge
  did NOT offer (the one press the old native arrangement used to own
  entirely) still casts correctly once the press leaves the hand.
- `e2e/presence.spec.ts` (+1 case): "a hand reorder is mirrored: bob sees a
  back in alice's hand glide from one position to another, never the card" —
  a `MutationObserver` installed on bob's page before the drag, since the
  glide is a transient ~300ms ghost a poll started afterward could miss.

## Mutation results (measured, see "written down before close")

- Drop the FLIP (`commitHandReorder`'s call to `flipHand`, commented out):
  `hand.test.ts` 11/12 pass, exactly the FLIP case fails
  ("card 100 is mid-FLIP: expected null to be ''").
- Drop `handMove` (the receiving side's `glideHandMove` call in `draw`,
  commented out): `presence.test.ts` 20/21 pass, exactly the "bob sees a
  back…" case fails ("a back glides, even with no pointer in the message at
  all: expected null not to be null").

Both reverted immediately after measuring; the production files are at
their intended final state.

## Done-when, checked against the brief

- `hand.test`, `Board.test`, `presence.test`, `socket.test` fail when the
  feature is reverted: shown above for `hand.test`/`presence.test`
  (mutation-measured); `Board.test`'s new `commitHandMove` describe block and
  `socket.test`'s relay assertions fail trivially if `commitHandMove`/
  `handMove` are removed, since the exports/field themselves would not exist
  (a compile failure, the strongest possible "fails when reverted").
- `drag`, `presence`, `played-card`, `w46-attack` green on a claw: **not run
  by me** — see "what I could NOT verify" in the closing report. `played-card.spec.ts`
  and `w46-attack.spec.ts` are wave 59's files (listed in the concurrent-work
  section as specs it owns); I did not touch either and have no reason to
  expect my change affects them (neither drives a hand-card press), but I
  have not run them.
