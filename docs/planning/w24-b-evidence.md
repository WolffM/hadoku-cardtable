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

---

## Follow-up 2 — the partition re-cut after `e2e/table-fit.spec.ts` went red

### 1. Does Forge publish an open selection during declare-attackers? **NO.**

Settled from `/home/hadoku/repos/hadoku-cardtable/forge/` (read-only). `setSelectables`
has exactly **two** game-side call sites:

- `forge-gui/src/main/java/forge/gamemodes/match/input/InputSelectTargets.java:68`
- `forge-gui/src/main/java/forge/gamemodes/match/input/InputSelectEntitiesFromList.java:57`

(the rest of the tree's hits are the GUI implementations — `CMatchUI.java:683`,
`MatchController.java:543`, `RemoteClientGuiGame.java:497`,
`HeadlessNetworkClient.java:468` — plus `GuiChoose.java:276` in the desktop
client, which is not the game thread.)

`InputAttack` is neither. `InputAttack.java:52` — `class InputAttack extends
InputSyncronizedBase` — publishes only `updateButtons` (`:70-73`),
`setHighlighted` (`:292`, `:308-309`, `:321-328`), `pushAttackerCandidates` →
`setWeaklySelectable` (`:356`), and `clearActionableCards` on stop (`:99-101`).
`InputBlock` is the same shape (`InputBlock.java:73-90`, `:190-197`).

**So `match.selectables` is null throughout both combat declarations**, and a
rule that stood arranging down only for an open selection would leave the
attacker and the blocker natively draggable.

### 2. It WAS shadowed, and here is why jsdom would never have said so

**There is no `pointerup` after a `dragstart`.** Once the browser's native drag
begins it delivers drag events and ends with `dragend`, so `commitDrag` and
`commitMarquee` would never run — attack-by-drag (wave 20 and
`combat-drag.jvm.test.ts`) and §B.3 blocking-by-drag would silently do nothing.
jsdom models none of this, so the vitest suite would have stayed green: the same
shape as the table-fit red, mirrored. §B.1 (a click) and §B.4 (`pointermove`
only) were never at risk.

### the fix, all in this lane's files

**`match.ts`**

- `LiveClickables.selectionOpen: boolean` — **exactly `match.selectables !== null`**,
  which is what lane A's `BoardInteraction.selectionOpen?` (`Board.tsx:303`) reads.
  Set on every return path including the two early-outs, so a queued ask or a
  dropped socket empties `selectable` without closing the selection.
- `declaringCombat(match)` = `declaringAttackers || declaringBlockers`, with the
  Forge call sites above written into its header.

**`gestures/install.ts`**

- The `nativelyDraggable` guard moved to the TOP of `onPointerDown`, before every
  branch including the card branch, and gained `&& !declaringCombat(match)`:

```ts
if (nativelyDraggable(event.target) && !declaringCombat(match)) return;
```

- A new `dragstart` listener on the canvas that cancels the native drag for
  exactly the presses this layer claimed:

```ts
function onDragStart(event: Event): void {
  if (drag !== null || marquee !== null) event.preventDefault();
}
```

The two halves are symmetric and neither needs the other to be correct: outside
combat declaration this layer stands down on anything natively draggable, and
inside it the native drag stands down on anything this layer claimed.

### the capability that changed, deliberately

At ordinary priority, a press-and-drag on the viewer's own BATTLEFIELD card is
now the arrange gesture's, **even when Forge offered it** — because Forge's
actionable set names most of a player's own permanents ("you could"), and
claiming those presses is exactly what turned `table-fit` red. What is given up
is drag-to-activate a permanent already on the battlefield; a CLICK still plays
it (the slop keeps this layer out of a click), and that is pinned by a test.

**Wave 20's #6 — *"dragging a land onto the table"* — is unaffected**, because it
is a card in HAND and lane A only makes own-battlefield cards draggable
(`row !== undefined`). Its case was re-pointed at the hand, where the gesture
actually lives, and it asserts the hand card carries no `draggable` at all.

### verified

| claim | command | result |
| --- | --- | --- |
| both suites green | `npx vitest run apps/ui/src/play/live/match.test.ts apps/ui/src/play/live/gestures` | **exit 0** — **109 passed** (match.test.ts 73, gestures.test.ts 36) |
| typecheck | `npx tsc --noEmit -p apps/ui/tsconfig.json` | **exit 0**, zero diagnostics |

New/re-cut cases: declare-blockers claims the offered creature though it stays
draggable *and* cancels the native drag; outside combat declaration arranging
wins on an offered card *and* a click still plays it; declare-attackers may
box-draw from a draggable permanent *and* cancels the native drag; outside it a
draggable permanent starts no box-draw; wave 20's zone drop re-pointed at the
hand; `selectionOpen` is the open selection and not the actionable set, and
survives a queued ask; `declaringCombat` is the two combat inputs and neither
opens a selection.

### mutation-tested

| control | mutation | reverted | restored |
| --- | --- | --- | --- |
| the native drag must not swallow a claimed press | drop `event.preventDefault()` in `onDragStart` | **2 failed (exit 1)** | **2 passed (exit 0)** |
| arranging must not shadow attack | drop `&& !declaringCombat(match)` | **1 failed (exit 1)** | **1 passed (exit 0)** |
| …nor the box-draw | same mutation | **1 failed (exit 1)** | **1 passed (exit 0)** |
| `selectionOpen` is the open selection, not the actionable set | `selectionOpen: offered.size > 0` | **1 failed (exit 1)** | **1 passed (exit 0)** |

`install.ts` and `match.ts` restored and confirmed byte-identical (`diff -q`).

### still open, and not this lane's to decide

An untapped land at priority is both *"playable"* and *"the thing I want to
move"*. The default above resolves it in arranging's favour on the battlefield,
which is the operator-visible choice the table-fit red already forced. If
drag-to-activate is wanted back, the discriminator has to be one the player
controls — a drag handle on the card for arranging, or a modifier key — and both
live in lane A's markup.

---

## Follow-up 3 — drag-to-pay comes back, without re-opening the `table-fit` red

`e2e/play.spec.ts:970-972` pays for a cast spell by dragging a land **already on
the battlefield**; `e2e/table-fit.spec.ts` drags an equally-offered land between
rows to **arrange** it. Both cards are in Forge's actionable set, so `selectable`
cannot separate them. What separates them is which INPUT Forge is parked on — the
axis follow-up 2 already built for combat declaration.

### the signal: a better one exists on the wire, and we were throwing it away

`showPromptMessage`'s third argument. `IGuiGame.java:77` /
`ProtocolMethod.java:39` carry a `CardView`; `PlayBridge.java:737-742` already
sends it (and its `serializeNulls` comment at `:163` names
`showPromptMessage.card` as the reason that file sets it); forge-wire already
parses it (`tier-b.ts:241`, `card: CardRefSchema.nullable()`). `match.ts` read
`frame.message` and dropped the card. It is now `LiveMatch.promptCard`.

Why it is the right one: **it is FRESH.** `InputPayMana.updateMessage` announces
itself with the ability being paid for — `showMessage(getMessage(),
saPaidFor.getView())`, `InputPayMana.java:410` — while `InputPassPriority` passes
none. Lane E measured that Forge emits `updateButtons` BEFORE
`showPromptMessage` (`InputConfirm.java:107-121`) so the BAR lags and can go
stale; the prompt cannot, because the next input overwrites `promptCard` in the
same frame that carries its message. Lane E's captured stale case was *"priority
prompts under a stale Yes/No bar"* — a priority prompt carries no card, so this
predicate is false there by construction.

**An even cleaner signal exists and is NOT available:** `showManaPool` /
`hideManaPool` (`ProtocolMethod.java:47-48`) are called from exactly
`InputPayMana.java:63` and `:76` — the payment input's start and stop, and
nothing else in the tree. `PlayBridge.java:1181-1182` implements both as **empty
methods**, so they never reach our wire, and they are modelled nowhere in
forge-wire. Wiring them would be a two-line bridge change plus a tier entry, in
files this lane does not own. **Recommended as the follow-up that would let
`payingMana` drop to one fact.**

### `payingMana(match)` — four facts, and the one that is load-bearing

```ts
export function payingMana(match: LiveMatch): boolean {
  if (!match.inputLive || match.asks.length > 0) return false;   // an input is live, nothing queued in front
  if (match.selectables !== null) return false;                  // a payment opens no selection
  if (match.promptCard === null) return false;                   // FRESH: this prompt names an ability
  return match.buttons !== null && match.buttons.label1 === AUTO_PAY_LABEL;
}
```

- `promptCard !== null` — the freshness guard, above.
- `label1 === 'Auto'` identifies the input. Both of `InputPayMana`'s bars carry it
  (`:391` at the start, `:405` once a payment exists) and no other input puts it
  in button 1 — `InputLondonMulligan.java:65` puts `lblAuto` in button **two**. A
  button label, not a regex over prose, and the practice `auto.ts` already uses.
- `selectables === null` excludes the other inputs that announce themselves WITH a
  card (`InputSelectTargets.java:129`, `InputSelectManyBase.java:92-94`), and
  `InputSelectManyBase` matters because its `updateButtons`
  (`InputSelectManyBase.java:98`) is the enablement-only overload and leaves
  whatever labels were standing.
- `inputLive && asks.length === 0` is the same gate `boardInteraction` uses, so
  this can never contradict what is clickable.

**`enable1` is deliberately NOT required**, against the suggestion. It means
*"auto-pay is possible"* — `:405` fires only when `autoPayManaSources != null` —
not *"the payment input is running"*. A cost that cannot be auto-paid is exactly
when the player must tap sources by hand, which is the gesture this predicate
exists to allow, and freshness is carried by `promptCard` rather than by
enablement. Mutation (k) below is that argument as a test.

### `gestures/install.ts`

```ts
if (nativelyDraggable(event.target) && !declaringCombat(match) && !payingMana(match)) return;
```

and `onDragStart` is now a **capture-phase** listener that also stops
propagation:

```ts
canvas.addEventListener('dragstart', onDragStart, true);
function onDragStart(event: Event): void {
  if (drag === null && marquee === null) return;
  event.preventDefault();
  event.stopPropagation();
}
```

`preventDefault` alone aborts the browser's drag but still lets lane A's own
`onDragStart` run — and **a cancelled `dragstart` fires no `dragend`**, so that
lane's `arranging.end()` would never balance its `arranging.start()` and it would
be left believing a drag was in flight. Capturing on the canvas runs before any
handler on the card and before React's root listener, so for a press this layer
claimed lane A never sees the event at all. Mutation (m) is that.

### lane A and lane C need no change — checked, not assumed

- `Board.tsx:727,734`: `inOpenSelection = selectable && interaction?.selectionOpen === true`,
  `draggable = arranging !== undefined && row !== undefined && !inOpenSelection && !itsAttackToDeclare`.
  During a payment `selectionOpen` is false and it is not declare-attackers, so
  the land stays draggable — which is what `payingMana` is for. **Nothing to change.**
- `LiveBoard.tsx:540` already fills `declaringAttackers: declaringAttackers(match)`
  from this lane's export, and `selectionOpen` rides in with the spread
  (`:518-531`). **Nothing to change.**
- Lane A's `declaringAttackers` field covers declare-ATTACKERS only. Declare-**blockers**
  leaves the blocker draggable, so §B.3 still depends on this lane's
  `declaringCombat` exemption plus the capture-phase cancel. Both halves are load-bearing.
- Re-ran their suites: `npx vitest run apps/ui/src/play/live/LiveBoard.test.ts apps/ui/src/play/Board.test.ts` → **exit 0, 163 passed.**

### verified

| claim | command | result |
| --- | --- | --- |
| both suites green | `npx vitest run apps/ui/src/play/live/match.test.ts apps/ui/src/play/live/gestures` | **exit 0** — **121 passed** (match.test.ts 81, gestures.test.ts 40) |
| typecheck | `npx tsc --noEmit -p apps/ui/tsconfig.json` | **exit 0**, zero output |
| lanes A and C unaffected | `npx vitest run apps/ui/src/play/live/LiveBoard.test.ts apps/ui/src/play/Board.test.ts` | **exit 0**, 163 passed |

New cases: a payment claims the offered battlefield land though it stays
draggable, cancels the native drag, and lane A never sees the `dragstart`; a
payment whose cost cannot be auto-paid still pays; a **stale Auto bar** does not
claim the press and lane A DOES see that `dragstart`; an ordinary priority window
with its own bar is arranging's; `promptCard` is set and overwritten by every
prompt and travels with the prompt across a snapshot; `payingMana` is false for a
stale bar, a selection, a dead input, a queued ask and a priority window.

### mutation-tested

| control | mutation | reverted | restored |
| --- | --- | --- | --- |
| a payment claims the press (the `play.spec` red) | drop `&& !payingMana(match)` | **1 failed**, and the disabled-Auto case **1 failed** | **1 passed** each |
| the stale bar must not claim it (lane E's hazard) | drop `promptCard === null` | **1 failed** in each suite | **1 passed** in each |
| `enable1` must not gate the input | require `&& match.buttons.enable1` | **1 failed** | **1 passed** |
| a selection is not a payment | drop `selectables !== null` | **1 failed** | **1 passed** |
| lane A must not see a claimed `dragstart` | drop `event.stopPropagation()` | **1 failed** | **1 passed** |

`install.ts` and `match.ts` restored and confirmed byte-identical (`diff -q`).

### still given up, and that is correct

Drag-to-activate at **ordinary priority** — no payment, no combat declaration —
remains arranging's. `e2e/play.spec.ts`'s own comment expects the fetchland drag
at priority to send nothing, and `table-fit` needs that press. A click still
plays the card.
