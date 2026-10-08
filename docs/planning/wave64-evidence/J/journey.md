# J — the played-card journey, one owner

Design artifact for wave 64 §J (`docs/planning/wave64-2026-10-08.md`). Grounded in the operator's
own rules, read from `docs/planning/playtest-ledger.md`:

- **AD4** — the stack redesign: the cast stays where it was released; the opponent's placed card
  renders where they placed it; arrows follow; "Resolve {cardname}?"; cards stay visible until
  something resolves.
- **AD7** — a cast waiting on an X/target question: the phantom stops moving the moment the card
  parks, on both screens.
- **AC8** — from the opponent's seat, the phantom must not flash to a default position and
  correct itself; the placement rides WITH THE ACT, through the server, keyed by column, never by
  card.
- **AE6** — no arrow for a no-target cast; the placement's `at` is the lift's own box centre, not
  a desynced pointer position.
- **AE12** — the phantom must detach the instant the question is answered, without the pointer
  moving again; `held`/`parked`/neither are three distinct states on the wire, not inferred.

This file is the state table **as shipped by this run** (step 2: deletions and folds with no
behaviour change). Step 3 (the state-machine unification: one press-drag engine, one gap glide,
one arrow builder, one expiry clock) is **not** in this run — see "Deferred to step 3" below.

## The state table

One card, the CASTER's own screen state on the left; the column is what crosses the wire and what
each screen draws. "Sender" = the seat casting; "Receiver" = the other seat's screen.

| Sender state | Entered by | Sender's own screen | Message(s) on the wire | Receiver's screen | Timer |
| --- | --- | --- | --- | --- | --- |
| **in hand** | idle, or a press not yet past the drag slop | ordinary hand card | `presence` (throttled, `held:false`, `placing:null`) | nothing drawn for this card | — |
| **lifted** | press clears slop, or a click-armed press resolves | card follows the pointer, `data-cast-lift="lifted"`, sized to the battlefield | `presence`, `held:true`; `from` set only while aiming (a selection/stack ask is open) | a back following their pointer (no card identity ever crosses) | `PRESENCE_SEND_MS` (60 ms) throttle |
| **parked — needs a target** (AD7/AE12) | released outside the hand, the card needs a target/X/question | card pinned at the release point, `data-cast-lift="parked"`, the aim arrow (if any) leaves from it | `presence` sent AT ONCE outside the throttle (`sendRelease`): `held:false`, `placing.at` = the release spot — repeated on EVERY message while parked, not only once | a back **standing still** at `placing.at` (`data-waiting`) — nothing the opponent's pointer does moves it (AE12) | `WAITING_MS` (15 s) — the stand-in ages out if the id never shows |
| **parked — permanent, no target** | released over the viewer's own battlefield, column resolves (`placementAt`) | card pinned at the release point, `data-cast-lift="carried"` | `presence` (`placing.at`, as above) **and**, in the same client→server act, `forge:placement` (AC8) — `{slot, target, at}`, keyed by COLUMN, sent before any Forge frame | the row reserves a gap (`expectPlacement`); the stand-in glides release→gap and waits there (`data-waiting`) | `WAITING_MS`; `PENDING_PLACEMENT_TTL_MS` (`Board.tsx`) on the reservation itself |
| **parked → committed (spell)** | the card's id appears in `theirCards` (on the stack, never the battlefield) | `live/placed.ts` already draws the stack item at the park point — nothing new fires | none new; the reveal is BoardView's own next frame, not a presence message | `placeSpell`/`commitSpell` swap the back for the real (turned-over) card, same point | — |
| **parked → committed (permanent)** | Forge's frame draws the card on the battlefield | card appears in the reserved gap | none new | the reservation is consumed; the stand-in `flyTile`s from its wait position to the settled card | `FLOAT_BACK_MS` (`cast.ts`) governs the glide's own duration |
| **committed → landed** | the glide/fly finishes | real card visible, `data-cast-landing` cleared | — | ghost/back removed | — |
| **parked → cancelled** | Escape, right-click, or a release back onto the viewer's own hand | card floats home (`floatCastLiftHome`) | a release onto the OWN hand is never `sendRelease` — "always a cancel", so nothing is ever coming; a plain `presence` update (`placing:null`) follows on the next tick/MutationObserver fire | a FOLLOWING back (not yet parked) is removed at once; a PARKED back is given `CLEARED_GRACE_MS` before it is taken down, in case the id was a frame away | `CLEARED_GRACE_MS` (1.5 s) |

Two more wire facts ride beside the state above, independent of it:

- **`arranging`** — a battlefield rearrange of the sender's own card; mirrored live as a dimmed
  source card and a tile following the sender's hold point.
- **`handMove`** — a hand reorder just committed (indices only, never a card id or name); the
  receiver glides one of its own anonymous backs between the two slots, `HAND_MOVE_MS` (300 ms,
  the same number `gestures/hand.ts`'s own FLIP uses, so both screens move in step).

## What this run (step 2) actually shipped

**Deleted outright — J13, and with it J1/J2:**

The "inferred handoff" compat path — `backWas` (where the opponent's back last was, and when it
went) and `HANDOFF_MS` (2000 ms) — is gone from `live/presence.ts`. It used to fire when a card of
the opponent's appeared on the battlefield within two seconds of their back going, with NO
`forge:placement` message to explain it: a fallback for a sender that could not yet speak
`forge:placement` at all. Both apps ship that wire together (one deploy, one pm2 restart), so there
is no older sender left to fall back FOR — `onPlacement` is now unconditionally the one trigger for
a permanent's handoff, and it fires before any Forge frame about the card (AC8).

Deleting it also deleted, in the same commit:

- **J1** — the dead fallback lookup `` `.stack__item:has([data-card-id="w${id}"])` `` (wave 59
  deleted that class; `Board.test.ts:391` already asserts it is gone; nothing in the codebase
  pinned this lookup).
- **J2** — the duplicate tile-fly builder that lived in `handoff()`'s own tail (clone the tile,
  strip ids, wrap in `.presence__handoff`, call `landCastGhost`). `flyTile` was already the exact
  same code, already called from `onPlacement` and from `handoff()`'s OTHER branch
  (`forBattlefield`); deleting the duplicate leaves `flyTile` as the one tile-fly builder, called
  from two sites instead of three.

**A residual risk, found and reported, not fixed (file ownership; see "Written down before
close"):** a permanent release whose point fails `placementAt`'s `snapTo` (over the viewer's own
battlefield, but not over any row) sends no `forge:placement` at all — `install.ts:737`'s own
comment already calls this the "default spot" fallback case. With the inferred-handoff path now
gone, that one edge case animates nothing on the other screen (the card simply appears). Judged
acceptable for this run on the wave file's explicit instruction ("both halves of the wire ship
together") and because `overOwnBattlefield(node)` gates entry to this branch in the first place —
reported to the manager rather than decided unilaterally, since fixing it would mean widening
`placementAt`'s own geometry, outside this fold.

**Folded — the three `presence__back` builders → one `backElement()`:** `standBack`,
`glideHandMove`'s ghost, and `onPlacement`'s stand-in each built an identical
`div.presence__back` (`aria-hidden`, appended to the overlay root) by hand. One function now does
it; mutation-tested (below).

**Folded — the two tile-flies → one:** a consequence of deleting J13's dead tail, above; `flyTile`
is the one builder left.

**Deleted — J6, two dead producers with no caller left:** `gestures/auto-targets.ts`'s
`autoTargetArrows` (a stack item's own already-decided target) and `stackTargetArrows` (the
counterspell arc, unioning `match.stackTargetArcs` with `StackEntry.targetStackItemId`).
`install.ts`'s own reconciler had already stopped calling either — confirmed by grep, zero
production call sites for both — because `live/placed.ts`'s `.placed__arrow`s draw a stack item's
target FROM the placed element now; feeding the same facts to `install.ts`'s reconciler too would
have drawn every stack-item arrow twice. Deleted with their full test blocks
(`auto-targets.test.ts`) and the stale comments this lane owns (`adapter.ts:484–493`'s prose).
**Found, not fixed (out of file scope):** `match.ts`'s `stackTargetArcs` claim/prune machinery
(the `stackTargetIntent` tracking, `noteStackTargetIntent`, the prune in `foldFrames`) now has NO
reader left anywhere in the codebase — `stackTargetArrows` was its only consumer. `match.ts` is
not this lane's file this wave (J owns only `lastSelectedCard` there); reported to the manager.
Three stale comments in `match.ts` (lines 608, 629, 657, drifted from the wave file's 607/628/656)
still cite `stackTargetArrows` as live, for the same reason.

**Fixed — J14, stale prose:** `inspect/index.ts`'s claim that `Board.tsx`'s `StackThumb` renders a
stack thumbnail is wrong since wave 59 deleted `StackThumb`; it is `live/placed.ts`'s own
placed-card layer now. The `presence.ts:807`-era dead-fallback prose item is the same text J13's
deletion already removed.

**Not attempted — J11, the `draggable` seam.** The wave file names this as a step-2 fold
("`Board.tsx:2108–2110` sets it only so `install.ts:482` `nativelyDraggable` can stand down").
Investigated, not executed: the literal `draggable="true"` attribute (and its value) is asserted
directly by roughly 30 expectations across `Board.test.ts` and `gestures.test.ts` (both mine), AND
by `e2e/table-fit.spec.ts:1141` (**not mine, not in my file list**), whose own comment calls it
"the board's own drag source (the seam marker)" — an external contract on the literal attribute,
not merely on the pointer-drag behaviour it currently gates. Removing the HTML attribute (the
actual fold: `nativelyDraggable` would instead test `[data-arrange-card]`, which is already set
under the identical condition) would require either editing a file outside this lane's ownership
or leaving its assertion silently stale. Per the brief's own rule ("if you believe you need another
file, stop and report"), this is reported rather than guessed at. See "Written down before close".

## Deferred to step 3 (not this run)

J3 (`data-waiting`'s dual meaning), J4 (two gap glides), J5 (four arrow drawers), J7/J9 (four
expiry clocks, two placement writers), J8's remaining four back/ghost/stand-in builders
(`parkedGhost`, `presence__lift`, the arrange-ghost, `landCastGhost`'s own ghost — each serves a
genuinely different visual role and J8 itself says to keep `landCastGhost` "the one mover"), J10
(the three press-drag engines), and J12 (`lastSelectedCard` surviving a card-less prompt) are all
**kept as-is** this run — the wave file stages them for the second landing, after the design is
relayed and this landing is proven on a claw.

## Mutation proof (step 2's own deletions)

- **`backElement()` deleted** (mutated to build a bare, unstyled, undetached element): 8 of 39
  `presence.test.ts` tests fail (every test that stands, or glides, a back). Restored: 39/39 pass.
- **The inferred-handoff compat path (J13/J1/J2)**: running the CURRENT `presence.test.ts` against
  the pre-fold `presence.ts` (git `HEAD`) fails the new pin
  ("a permanent arriving with no `forge:placement` message animates nothing") — the old code DOES
  animate a handoff in that case, from the stale `backWas` inference. Restoring the folded
  `presence.ts` against the same test: 39/39 pass. This is the test that replaced the one proving
  the OLD (now-deleted) behaviour.
- **`auto-targets.ts`'s two deleted producers**: no mutation needed — both functions and their
  only callers (their own tests) are deleted together; there is nothing left to mutate. `knip`
  before/after (below) confirms no dangling export.

## knip, before/after, J's files

Measured with `npx knip --reporter json`, counting entries whose `file` is one of this lane's six
touched files, before (lane's files reverted to `HEAD` only, nothing else touched) and after
(lane's fold applied):

| file | before | after |
| --- | --- | --- |
| `apps/ui/src/play/live/presence.ts` | 0 issues | 0 issues |
| `apps/ui/src/play/live/gestures/auto-targets.ts` | 0 issues | 0 issues |
| `apps/ui/src/play/live/gestures/auto-targets.test.ts` | 0 issues | 0 issues |
| `apps/ui/src/play/inspect/index.ts` | 0 issues | 0 issues |
| `apps/ui/src/play/adapter.ts` | 1 unused export, 3 unused types (pre-existing, unrelated to this fold) | unchanged |

Flat, not because nothing was dead — `autoTargetArrows`/`stackTargetArrows` WERE dead — but
because they were exported AND their only importer was their own test file, which is itself
deleted in the same commit. `knip` flags a surviving unused export; deleting an export together
with its one caller leaves nothing for `knip` to flag either side of the diff. The real signal is
the diff stat: 72 insertions, 349 deletions, net **−277 lines**, across the six files this lane
touched this run.
