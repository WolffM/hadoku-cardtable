# Wave 24 lane B — the pointer: attack, block, target

Evidence for §B items 1–4, the `concede` sender, and the re-homing of wave 20's
gesture code out of `LiveBoard.tsx`. Every command below was run with Node 24
(`PATH=/home/hadoku/.local/share/fnm/node-versions/v24.18.0/installation/bin:$PATH`)
from the worktree root, and every exit code was read directly rather than
through a pipe.

## What changed

| file | what |
| --- | --- |
| `apps/ui/src/play/live/match.ts` | `concede`; the combat readers (`declaringAttackers`, `declaringBlockers`, `blockTargets`, `isBlockAssignment`, `attackIntents`); two new handle fields (`attackIntent`, `lastSelectedCard`) |
| `apps/ui/src/play/live/match.test.ts` | `concede` (3 cases) and combat off the state channel (5 cases) |
| `apps/ui/src/play/live/gestures/` | new: `index.ts` (the seam), `types.ts`, `targets.ts`, `commit.ts`, `arrow.ts`, `marquee.ts`, `intent.ts`, `install.ts`, `gestures.css`, `gestures.test.ts` |

## The seam lane C calls

```ts
export interface GestureOptions {
  canvas: HTMLElement;          // the match's root — pointer handling is delegated here
  match: LiveMatch;
  onChange?: () => void;        // the gesture layer's own visible state changed
}
export interface GestureHandle { dispose(): void; }
export function installGestures(options: GestureOptions): GestureHandle;
export function concede(match: LiveMatch): boolean;   // in ../match.ts
```

`installGestures` is framework-free. It finds `[data-board-overlay]` under
`canvas` itself on every paint, attaches `pointerdown` to `canvas` by delegation
and `pointermove` / `pointerup` / `pointercancel` to `window`, and creates its
own DOM inside the overlay. With no overlay NOTHING is drawn and every gesture
still sends — the arrow is guidance, not the mechanism. Everything drawn is
`pointer-events: none`.

## The items

### §B.1 — an attacker is marked at SELECTION

`selectCard` records the intent (`noteAttackIntent`) whenever
`declaringAttackers(match)` holds, so a CLICK marks exactly as a box-draw does.
`attackIntents(match)` derives three answers and `gestures/intent.ts` writes them
to `data-attack-intent` on the card's own `<li>`:

- `sent` — the frame is out and Forge has not answered (`spent` still holds the id);
- `declared` — Forge's own `Attacking` says so; its drawing takes over;
- `refused` — Forge answered and the card is still not attacking.
  `pushAttackerCandidates` drops the attackers it HAS declared
  (`PlayerControllerHuman.java:1613-1614`), so an id Forge re-offers is an id it
  did not take. **The disagreement is shown, not papered over.**

The phase comes off `GameView.Phase` / `PlayerTurn` (the state channel), never
off prompt text — §0b's rule. **No tapped state is ever faked:** this layer
writes one attribute and reads none of lane A's; `data-tapped` and
`BoardCard.tapped` stay Forge's alone, and the mark is a DASHED outline where an
offer is a solid one so the line style carries the meaning as well as the colour.

### §B.2 — box-draw multi-select

A press on the table (not on an offered card) while this seat is declaring
attackers starts a marquee. On release, every card whose box the marquee touched
AND which `boardInteraction` currently offers is sent as its own `selectCard`, in
DOM order. Two guards, and the outer one is redundant on purpose: `commitMarquee`
filters by the offered set, and `selectCard` re-checks Forge's CURRENT offer for
every id. **An id Forge did not offer cannot leave however the box was drawn.**

### §B.3 — blocking by drag

`InputBlock.onCardSelected` takes a click on any attacking card and makes it the
*current attacker*; the click AFTER that becomes its blocker
(`InputBlock.java:112-160`). But `pushBlockerCandidates` publishes only the
defender's own creatures (`PlayerControllerHuman.java:1621-1647`), so an attacker
never reached the offered set. `blockTargets` transcribes `combat.isAttacking` —
which has been on the state channel as the card's `Attacking` property all along
— gated on the two facts that identify the input: declare-blockers with this seat
not the attacker, and Forge having HIGHLIGHTED something
(`setCurrentAttacker` is the only thing that highlights in this phase,
`InputBlock.java:190-197`).

The frames go out ATTACKER first, which is the order Forge needs — except when
Forge has already made that attacker the current one (it highlighted it), where
the attacker's click would be a no-op and one frame is sent.

### §B.4 — the arrow draws for click targeting too

`gestures/arrow.ts` draws the same SVG with the same classes, the same `data-*`
and the same geometry as wave 20's `Targeter`, so `e2e/arrow.spec.ts` keeps
reading exactly what it read before. `data-mode` is the only new attribute:
`drag` or `click`. The click arrow's tail is `match.lastSelectedCard` (the card
the player clicked to cast or activate) and, failing that, the first stack entry
whose source card is drawn — a triggered ability was never clicked at all. No
origin, no arrow.

## Verified

| claim | command | result |
| --- | --- | --- |
| both suites green | `npx vitest run apps/ui/src/play/live/match.test.ts apps/ui/src/play/live/gestures` | **exit 0** — 2 files, **99 tests passed** (match.test.ts 70, gestures.test.ts 29) |
| my files typecheck | `npx tsc --noEmit -p apps/ui/tsconfig.json` then filter to `live/match`, `gestures/`, `live/LiveBoard` | **no diagnostics in any file this lane owns** |
| no regression in lane C's suite from the `match.ts` changes | `npx vitest run apps/ui/src/play/live/LiveBoard.test.ts` | exit 0, 68 passed (run before lane C began editing) |

Every case in `gestures.test.ts` asserts on **what went on the wire** — the
frames the replay server received, read back through `safeParseClientFrame` as
`[method, id]` pairs. The arrow, marquee and intent cases additionally assert
existence, snapping and the one thing the mark must not claim.

## Mutation-tested

Against FIXTURES only (the replay server on an ephemeral loopback port). Each
line is: revert → the named test must FAIL; restore → must PASS.

| control | mutation | reverted | restored |
| --- | --- | --- | --- |
| a box-draw never sends an id Forge did not offer | remove `commitMarquee`'s own `offered.has(id)` filter | **1 passed** (defence in depth: `selectCard` still refuses) | 1 passed |
| …and the guard that actually holds it | ALSO remove `selectCard`'s `boardInteraction` guard | **1 failed** (exit 1) | **1 passed** (exit 0) |
| the intent mark never fakes Forge's tapped state | `intent.ts` also writes `data-tapped="true"` | **1 failed** | 1 passed |
| …and not in the handle either | `noteAttackIntent` also flips `card.tapped` in the view | **1 failed** | 1 passed |
| a drop on nothing legal sends nothing | `commitDrag` drops the `[data-zone]` check | **1 failed** | 1 passed |
| a block's two frames go out ATTACKER first | send source-then-target, as the generic drag does | **1 failed** | 1 passed |
| the attacker Forge already holds needs no click | `already = false` (always click the attacker too) | **1 failed** | 1 passed |
| a box-draw only starts while this seat declares attackers | remove the `declaringAttackers(match)` gate | **1 failed** | 1 passed |
| `concede` reaches the wire exactly once per call | `concede` sends twice | **1 failed** | 1 passed |
| `concede` is not gated on the board | gate it on `boardInteraction().selectable.size` | **1 failed** | 1 passed |

Every mutated file was restored and confirmed byte-identical to its pre-mutation
copy (`diff -q`) before the final run.

## A finding handed back: `combat-drag.jvm.test.ts`'s prose is already stale

`apps/ui/src/play/live/combat-drag.jvm.test.ts` (commit `fb34cfe`) states:

> neither the defending player nor the attacking creature is ever an offered
> drop TARGET in combat, and `commitDrag`'s snap branch is not the one that
> fires

That was measured **before** `setHighlighted` folding landed — `git merge-base
--is-ancestor fb34cfe bc9ba52` says the test predates *"L: Forge's mark crosses
the bridge, and a marked card is clickable"*. Since wave 22 lane L, the
highlighted current attacker HAS been in `boardInteraction`'s offered set, so at
HEAD a drop on it took `commitDrag`'s generic branch and sent
`selectCard(blocker)` then `selectCard(attacker)` — two frames **in the wrong
order for `InputBlock`**, which would re-point the cursor at the attacker after
the blocker had already been assigned to whichever attacker Forge had
auto-selected. Nobody re-ran the jar-gated suite after lane L, so it was never
caught.

This lane's block branch fixes that: one frame (the blocker) when Forge already
holds that attacker, two in Forge's own order when the player pointed at a
different one. `combat-drag.jvm.test.ts`'s assertion of exactly one frame is
therefore expected to stay green, and its module prose should be corrected —
it is in no lane's file list, so it is handed back rather than edited here.

## Could not verify

| claim | why | the command that would settle it |
| --- | --- | --- |
| the block gesture behaves as above against a REAL Forge, with one attacker and with several | jar-gated; the lane brief forbids `pnpm e2e`, and the Forge e2e ports are shared with wave 23 | `CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=<scratch> npx vitest run apps/ui/src/play/live/combat-drag.jvm.test.ts` |
| the arrow's endpoints in a browser that has boxes, for the CLICK mode | jsdom has no layout, so nothing here asserts a coordinate; the manager runs the wave's single e2e pass | `pnpm --filter @hadoku/ui build && pnpm e2e -- e2e/arrow.spec.ts` |
| `data-attack-intent`'s outline is visible over lane A's new stacking | lane A's `Board.tsx`/`card.css` were mid-edit throughout this lane | a browser pass after lane A lands |

## Decisions taken because the brief was ambiguous

1. **The box-draw starts on empty table space, not on a creature.** A press on a
   card Forge offered stays the wave-20 drag, which is also how an attacker is
   declared by dragging it forward and is what `combat-drag.jvm.test.ts` proves
   against a real engine. Arena lets a marquee start on a creature; taking that
   press would have changed a jar-proven gesture, so it was not taken.
2. **`blockTargets` is gated on a non-empty highlight**, not merely on the phase.
   At the defender's ordinary priority in the declare-blockers step nothing is
   highlighted, and offering the opponent's attackers there would be an
   affordance Forge would refuse.
3. **One frame, not two, when Forge already holds the attacker** — see the
   finding above.
4. **The intent is keyed by turn** (`attackIntent: { turn, ids }`), because
   declare-attackers comes round again and an id from turn 8's combat is not an
   intent in turn 13's.
5. **`lastSelectedCard` is dropped by `clearSelectables`**, with the input that
   took the click, so the click arrow never draws from a stale origin.
6. **`data-gesture-canvas`** is set on the canvas so `gestures.css` can dress the
   drag and box cursors without naming lane C's `.live`.

## Out of lane

- Not committed, not staged, not pushed: the manager commits this lane.
- No `package.json` touched.
- `LiveBoard.tsx`, `LiveBoard.test.ts` and `live.css` are lane C's; the old
  gesture code and the `.targeter*` rules are still in them and are C's to
  delete. Nothing here edits them.
- `apps/ui/src/play/Board.tsx` had live type errors throughout this lane (lane
  A's in-flight `boardPT` / `Arranging` work) and `apps/ui/src/play/inspect/index.test.ts`
  had one too (`BoardCard` gained fields). Reported, not fixed.

---

## Follow-up after `94a9a0e` — the press is partitioned with lane A's arrange gesture

Lane A's §A.1 arrange gesture makes every card on the viewer's own battlefield
`draggable="true"` with HTML5 `dragstart`/`dragover`/`drop` on the `<li>`
(`Board.tsx:644,658-662`). That press and `install.ts`'s `onPointerDown`
overlapped in two places. Lane A owns the first (an OFFERED card becomes
non-draggable: `draggable = arranging !== undefined && row !== undefined &&
!selectable`). This is the other half.

### the change, in `gestures/install.ts` only

A new `nativelyDraggable(node)` helper — walk up from `event.target` for
`[draggable="true"]` and require it to be inside `canvas` — and one guard:

```ts
if (!inside(event.target)) return;
if (nativelyDraggable(event.target)) return;   // lane A's arrange gesture owns this press
if (declaringAttackers(match)) { /* box-draw */ }
…
if (match.selectables === null) return;
drag = { source: null, … };                    // the source-less pointing gesture
```

**The card-drag branch above it is untouched and still wins on an offered card**
— `targetUnder` returns a card only when `boardInteraction` offered it, and that
branch returns before the guard is reached. So the guard can never cost a legal
drag source, and with lane A's half in place such an element is by construction
never one Forge offered. Either half alone closes the bug; both is the point.

**One stated widening.** The guard sits before BOTH fallback branches, not only
before the `source: null` one, because the box-draw has the same twin: a marquee
started on a draggable permanent would rearrange the battlefield AND declare
attackers in one press. The zone `<ul>` is not draggable, so a box-draw on empty
table space is unaffected — pinned by a test.

### verified

| claim | command | result |
| --- | --- | --- |
| both suites green | `npx vitest run apps/ui/src/play/live/match.test.ts apps/ui/src/play/live/gestures` | **exit 0** — **104 passed** (match.test.ts 70, gestures.test.ts 34; 5 new cases) |
| typecheck | `npx tsc --noEmit -p apps/ui/tsconfig.json` | **exit 0** |

The five new cases pin the partition from both sides: an offered card is still
this layer's *even when the element is draggable*; a non-offered draggable card
starts nothing and sends nothing on release (proven against a barrier); a
draggable card starts no box-draw either; and empty table space still starts both
the box-draw and the source-less pointing gesture. Each sets `draggable="true"`
by hand rather than waiting for lane A, so the partition is pinned whichever
order the two halves land in.

### mutation-tested

| control | mutation | reverted | restored |
| --- | --- | --- | --- |
| a non-offered draggable card starts no gesture and sends nothing | remove `if (nativelyDraggable(event.target)) return;` | **1 failed (exit 1)** | **1 passed (exit 0)** |
| …and its box-draw twin | same mutation | **1 failed (exit 1)** | **1 passed (exit 0)** |

`install.ts` restored and confirmed byte-identical (`diff -q`) before the final run.

### unchanged, on lane C's request
`data-gesture-canvas` keeps its name; nothing in `gestures.css` names `.live` or
`.board`, so lane C's `.live .board { touch-action: none }` stands alone.
