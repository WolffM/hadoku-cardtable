# Wave 24 lane C — the frame gets out of the way

Files: `apps/ui/src/play/live/LiveBoard.tsx`, `LiveBoard.test.ts`, `live.css`.
Nothing else was touched. No commit, no index, no push (the manager commits).

| file | +/- |
| --- | --- |
| `apps/ui/src/play/live/LiveBoard.tsx` | +246 / −298 |
| `apps/ui/src/play/live/LiveBoard.test.ts` | +341 / −248 |
| `apps/ui/src/play/live/live.css` | +368 / −118 |

---

## §C.1 — the control bar stops being a bar

The operator accepted the bar's CONTENTS and rejected its SHAPE. So every
child is still there and the shape changed:

- `.live__buttons` left the flex flow. It is `position: absolute; right: 6px;
  bottom: 6px; z-index: 4` inside `.live`, over the board's bottom-right
  corner. The `3.25rem` row it used to occupy under the canvas is the table's
  now — measured: the board's box is `38,8,1264,760` at 1280×800 (it was
  760 − 52 = 708 tall with the bar in flow).
- Contents, unchanged and all in one container: Leave, `live-says`, `live-log`,
  Full control, OK, Cancel — plus Concede (§C.4). Laid out as a 6-column grid
  in four rows: the say, the log, OK | Cancel, and Leave | Full control |
  Concede. The two controls that are NOT answers to Forge are on their own row,
  below Forge's two, which is what keeps a reach for one off the other.
- `z-index: 4` puts it above lane A's overlay root (z 2) and the board's own
  `.board__warn` (z 3), and below nothing. The inspector draws inside the
  overlay, so the cluster is over it — which is right: it is a control panel,
  not a card.

### How `e2e/table-fit.spec.ts` stays green, claim by claim

The spec samples on **every animation frame** of a real match. Its claims and
what answers each:

> *"once the board is drawn, `live-buttons` has a nonzero box that lies inside
> the viewport, with `live-button-ok`, `live-button-cancel` and `live-says` in
> it"*

All four testids are unchanged and all three children are still descendants of
the one `live-buttons` container (`spec:301-311` queries exactly that way).
Asserted in jsdom: *"is ONE container, and the three things the fit spec looks
for are inside it"*.

> *"and that box is at the SAME place and size in every frame at a given window
> size — a fixed home, not a bar on demand"* (`spec:313-315`, and
> `spec:788` — *"the button bar has one home"*, `toHaveLength(1)`)

The cluster is drawn in every frame, as before, and its box cannot depend on
its content: the width and height are tokens and **every grid track is a fixed
length** (`repeat(6, 1fr)` columns, `34px 34px 30px minmax(26px, 1fr)` rows).
The say scrolls inside its own slot, the log clips, and the buttons ellipsise.
Measured in Chrome (below): one box per window size across every says/log/label
combination and every prompt height.

> `spec:395-397` — the bar is not null, has height, and its bottom is inside the
> window.

Measured: `639,978,288,153` at 1280×800 and `607,1064,288,153` at 1366×768;
both wholly inside the viewport.

> *"an open prompt lies inside the viewport and above the bar"* (`spec:337`:
> `r.bottom > barBox.top + 0.5` is a breach)

The prompt host stops above the cluster by construction —
`inset: 0 8px calc(var(--live-controls-h) + 16px)` — so the gap is exactly
16 − 6 = 10px whatever the sheet contains. Measured at 10px at both window
sizes for sheets of 80, 300, 700, 1400 and 5000px.

> `spec:740` — *"the bar stays, disabled, under an open question"*.

Unchanged: OK and Cancel are still `disabled={ask !== null || bar === null ||
!bar.enable*}`.

> `spec:1110`, `spec:1213` — the static-canvas probe measures `.board__bar`,
> which is `Board.tsx`'s turn bar (lane A's), not this cluster. Untouched.

### The one real bug this found, and the fix

`--live-controls-h` is both the cluster's `height` **and** what the prompt host
subtracts. It started as `9.75rem`, which is the sum of the cluster's pixel
tracks at a 16px root font size **and nothing else**. Measured in Chrome by
setting `document.documentElement.style.fontSize`:

| root font size | height the tracks need | `9.75rem` gave |
| --- | --- | --- |
| 16px | 153px | 156px |
| 14px | 153px | 136px (bottom row clipped) |
| 20px | 153px | 195px (39px of dead space) |

So the token is pixels — `153px` — and `LiveBoard.test.ts` adds the tracks up
off `live.css`'s own text rather than trusting the literal:

```
6 + 6 padding + 1 + 1 border + (34 + 34 + 30 + 26) rows + 3 × 5 gaps = 153
```

After the fix the cluster's box is `…,288,153` at all three root sizes.

**A correction to an earlier read of the same measurement.** The first
Chrome run reported a tall sheet's bottom edge 6px *inside* the cluster. That
was the fixture missing `* { box-sizing: border-box }` (`apps/ui/src/styles.css:44`,
which the real app always has), not the rem token: with `content-box` the
cluster's rect was padding+border larger than its `height` and the prompt
subtracted the smaller number. The rem→px change is right for the table above,
not for that overlap.

### And the `max-height` that had to go

`.live__prompt` used to carry `max-height: calc(100dvh - … - 3rem)`. With
`top`, `bottom` AND a `max-height` the box is over-constrained: `top` wins and
`bottom` is ignored, so a window where the cap bit would put the host's bottom
edge back down over the cluster — the one thing this placement exists to
prevent. Both insets now give the host its height outright, the sheet is a
shrinkable flex item inside it (`flex: 0 1 auto; min-height: 0; overflow-y:
auto`), and there is nothing left to cap. Measured: a 5000px sheet renders
611px tall, scrolls internally, and the page never scrolls.

---

## §C.2 — a vertical phase indicator

`PhaseRail` in `LiveBoard.tsx`. Presentation only: turn, step and whose turn
all come off `match.view`, which already carried all three. **Nothing new on
the wire, and no new names** — the thirteen constants are Forge's
`PhaseType` and the words are `PHASE_LABEL`'s, imported from `../adapter.ts`.

- Thirteen steps down the left edge, grouped the way a turn is
  (`data-group`: begin · main1 · combat · main2 · end) with a gap before each
  group, so a column of thirteen reads as five phases.
- The step the game is on is marked **three ways**, because colour may not be
  the only signal (§1): it is the only one that draws its name, its mark is the
  long one (the short ones are the same LAYOUT box scaled down, so nothing
  moves), and it carries `aria-current="step"`.
- Every other step keeps its name in the accessible tree (`clip-path: inset(50%)`
  sr-only), so a screen reader reads the whole turn.
- The current step's name is drawn to the RIGHT of the rail, over the board,
  because "Declare attackers" does not fit in a rail narrow enough to be worth
  having. The rail itself is `2rem` wide.
- Out of flow (`position: absolute`), `pointer-events: none`, `z-index: 1` —
  above the table's own cards, **below** lane A's overlay root at z 2, so the
  inspector's enlarged card still comes out on top of the rail rather than
  behind it (the operator's #4, in the other direction).

Measured at 1366×768: rail box `323,10,28,157`, right edge 38px, cluster's left
edge 1064px — no collision, both wholly inside the board's box, and the board's
box is unchanged by either.

---

## §C.3 — a prompt belongs where the player is looking

Teetering Peaks' ask *"appeared as text at the bottom of the screen"*. The
prompt HOST is now the whole region above the cluster with the sheet centred in
it, instead of a box pinned to the bottom edge.

Two consequences, both load-bearing:

1. the region stops above the cluster, so a centred sheet can never reach the
   cluster's home (the fit spec's claim above);
2. the host now covers the board, so it takes NO pointer events and the sheet
   takes them back (`.live__prompt > .prompt, > .confirm { pointer-events:
   auto }`). Without that, an open prompt would swallow every click on the
   table around it.

**What the prompt looks like inside is lane D's** (`prompts/prompts.css`) and
**the arrow is lane B's**. This lane changed neither. The only rule here that
touches a prompt's own element is the placement block that was already there
(`.live__prompt > .prompt`), plus the `pointer-events: auto` that the new host
requires.

---

## §C.4 — Concede

`concede` has been on the wire since the beginning
(`packages/forge-wire/src/tier-a.ts:52,199-202`) and had no button. Now it has
one, in the cluster, and **it sends nothing**: it opens a confirmation, and only
that confirmation's own yes calls `concede(match)` — lane B's sender in
`match.ts`. This lane added no sender.

- Words, as few as the rest of the UI: **Concede** / *You lose this game.* /
  `Cancel` · `Concede`.
- `role="alertdialog"`, and the **safe** button has the focus: Enter on a
  dialog nobody read must not end the game. Escape is Cancel.
- Pressable with a question open, like Leave — giving up is not an answer to
  what Forge asked.
- `conceding` is local component state, not a `LiveMatch` field: it is a
  question this component asked, nothing on the wire is parked on it, and a
  resync must not answer it.

### Why not `ConfirmDialog.tsx`

It is not in this lane and it was read rather than edited. It takes a
`ConfirmAsk` — `Extract<LiveAsk, { method: 'showConfirmDialog' }>`, i.e. a
frame off the wire with a `callId` Forge's game thread is parked on. There is
no such frame behind a concede button. Reusing it would mean synthesising a
fake wire ask to satisfy the type and putting a second `confirm-dialog` testid
on the page, where three Playwright specs and this file's own tests expect
exactly one. So the confirmation is built in `LiveBoard.tsx` and **reuses that
dialog's LOOK** — the `.confirm`, `.confirm__title`, `.confirm__message`,
`.confirm__actions`, `.confirm__button` classes already styled in `live.css` —
and none of its plumbing. `ConfirmDialog.tsx` is unmodified.

---

## The gesture layer handed to lane B

Deleted from `LiveBoard.tsx` (≈280 lines): `DRAG_SLOP_PX`, `DropTarget`,
`DragState`, `centreOf`, `cardBox`, `faceBox`, `boxOf`, `BOARD_ID`, `boardId`,
`targetUnder`, `commitDrag`, `Targeter`, the `drag` / `dragRef` / `overlay`
state, both `useLayoutEffect`s, `update`, `onPointerDown`, the `data-dragging`
attribute, the `<Targeter>` render, and the `createPortal` /
`useLayoutEffect` / `PointerEvent` / `LiveClickables` imports.

Deleted from `LiveBoard.test.ts`: the whole
`describe('dragging a card, and the targeter arrow')` block and its header
(14 cases), replaced by a note saying where they went.

Deleted from `live.css`: `.targeter`, `.targeter__shaft`, `.targeter__head` and
`.live[data-dragging]` — `gestures/gestures.css` owns all four now, so they
were duplicates. `.live .board { touch-action: none }` STAYS: it is about the
table rather than about a gesture, and `gestures.css` has no equivalent.

The call site, all that is left:

```ts
useEffect(() => {
  const canvas = rootRef.current;
  if (canvas === null) return undefined;
  const handle = installGestures({ canvas, match });
  return () => handle.dispose();
}, [match]);
```

`onChange` is deliberately omitted rather than passed as a no-op: the board
redraws off `match.revision` through `useSyncExternalStore`, and the arrow is
drawn into the overlay by the gesture layer itself, so there is nothing for a
callback to do. Lane B's signature at the time of writing is
`installGestures(options: GestureOptions): GestureHandle` with `onChange`
optional (`gestures/types.ts`), which this matches.

---

## Verification

Node 24 (`/home/hadoku/.local/share/fnm/node-versions/v24.18.0/installation/bin`)
on every command. Exit codes read directly.

| claim | command | result |
| --- | --- | --- |
| the lane's suite is green | `npx vitest run apps/ui/src/play/live/LiveBoard.test.ts; echo $?` | **exit 0**, 69 passed / 69, 1 file |
| the lane's files typecheck | `cd apps/ui && npx tsc --noEmit -p tsconfig.json` | no output, no errors |
| the lane's files lint | `npx eslint …/LiveBoard.tsx …/LiveBoard.test.ts; echo $?` | **exit 0** |

### Measured in Chrome, against a FIXTURE, never a live target

A standalone page in the scratchpad linking the real `live.css`, with pixel
stand-ins for the three files it does not load (`styles.css`'s palette and
`* { box-sizing: border-box }`, `screens.css`'s `.shell`, `board.css`'s
`.board`), driven through Playwright. It is a fixture: no server, no Forge, no
match.

At **1280×800** and **1366×768**, across three says (empty / one line / five
lines plus long OK and Cancel labels from Forge), five prompt heights (80, 300,
700, 1400, 5000px) and three root font sizes (14, 16, 20px):

| claim | result |
| --- | --- |
| `live-buttons` has ONE box per window size | `639,978,288,153` (1280×800) and `607,1064,288,153` (1366×768) — one each, over every combination |
| the box is wholly inside the viewport | true, every case |
| the three testids the spec looks for are in it | true, every case |
| the cluster's own contents fit its box | true, every case (`scrollHeight <= clientHeight`) |
| an open prompt's bottom is above the cluster's top | gap **10px**, every sheet height, both sizes |
| an open prompt is inside the viewport | true, every case |
| the page never scrolls | true, every case |
| the rail does not reach the cluster | rail right 38px, cluster left 1064px |
| rail and cluster are inside the board's box | true |
| the current step is named, the other twelve are 1px sr-only | name box `381,38,33,14`; 12 identical 1px boxes |

### Mutation tests — fixtures only, never a live target

| mutation | reverted | restored |
| --- | --- | --- |
| Concede's button calls `concede(match)` directly instead of opening the confirmation | *the button sends NOTHING* → **1 failed** / 68 skipped, exit 1 | **1 passed**, exit 0 |
| Concede's Cancel calls `concede(match)` on its way out | *cancel closes it and sends nothing* → **1 failed** / 68 skipped, exit 1 | **1 passed**, exit 0 |
| `data-testid="live-button-cancel"` renamed | *is ONE container…* → **1 failed** (`the cluster still holds live-button-cancel: expected null not to be null`), exit 1 | **1 passed**, exit 0 |
| `data-testid="live-buttons"` deleted from the container | *is ONE container…* → **1 failed**, exit 1 | (same test, same restore) |
| `--live-controls-h: 153px` → `152px` | *the exact sum of the cluster's own tracks* → **1 failed** (`expected 153 to be 152`), exit 1 | **1 passed**, exit 0 |
| `.live__buttons { position: absolute }` → `static` | *out of the flow in the bottom-right corner* → **1 failed**, exit 1 | **1 passed**, exit 0 |

Both mutated files were restored by checksum
(`LiveBoard.tsx` `68c085bf…`, `live.css` `abddd186…`).

### Could NOT verify

- **`e2e/table-fit.spec.ts` itself is green.** Running it is the manager's
  single post-wave pass, and this lane was told not to run `pnpm e2e` or build
  the UI. Everything above is the fixture-level proof of the same four claims.
  The command that settles it:
  `CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… pnpm e2e` (it serves the
  prebuilt dist, so `pnpm --filter @hadoku/ui build` first).
- **`e2e/arrow.spec.ts` and `apps/ui/src/play/live/combat-drag.jvm.test.ts`**
  drive the pointer layer this lane deleted. They are lane B's to keep green
  now; both are jar-gated and neither was run here.
- **How the frame LOOKS to the operator** — occlusion in particular. The
  cluster is 288×153 over the bottom-right of the board and the rail is 32px
  over the left edge, which is what "over the board" costs. The numbers are
  above; the judgement is theirs.

### Decisions made because the brief was ambiguous

1. **The confirmation is built in `LiveBoard.tsx`, not `ConfirmDialog.tsx`** —
   reasons above. The brief allowed either; this is the "otherwise" branch, and
   `ConfirmDialog.tsx` was read and left alone.
2. **The rail is on the LEFT**, because the cluster is bottom-right and the
   status line is top-right. Arena's is on the right; ours would have collided.
3. **The rail is absolutely positioned, not an in-flow column.** An in-flow
   rail would take ~32px of WIDTH from the board, and
   `e2e/table-fit.spec.ts`'s crowd probe asserts no card is narrower than its
   floor with 20 cards at 1280×800. That is exactly the margin that broke once.
   The operator asked for the height back, not the width, so the rail changes
   no box at all.
4. **Only the current step draws its name.** Thirteen labels would need a rail
   wide enough to hide a column of cards. The rest are in the accessible tree.
5. **Concede is never disabled.** Like Leave and Full control, it is a control
   on the match rather than an answer to Forge, and `concede` itself decides
   what is sendable.
6. **`onChange` is omitted** from the `installGestures` call rather than passed
   as an empty arrow, which would be dead code.
7. **`.targeter*` and `.live[data-dragging]` were deleted from `live.css`**
   rather than left as duplicates of `gestures/gestures.css`. One look, one
   owner. This creates a dependency on lane B setting `data-gesture-canvas` on
   the canvas — if they rename it, the grabbing cursor is lost (cosmetic only).

### Out of lane / handed back

- **`apps/ui/src/play/inspect/index.test.ts:30` failed the UI typecheck**
  mid-run (`TS2740`: a test fixture's `BoardCard` is missing
  `arrivedThisTurn`, `keywords`, `lethalDamage`, `attachedCardIds` and two
  more). That is lane A's `adapter.ts` widening `BoardCard` under a file nobody
  owns. It was **green again** on the re-run, so lane A appears to have fixed
  it; flagged in case it comes back.
- **`inspect/index.ts:271`** carries a comment naming
  `live/LiveBoard.tsx`'s `cardBox`, which no longer exists there (it is
  `gestures/targets.ts`'s now). One stale comment in nobody's file; not
  touched.
- `.playwright-mcp/` appeared in the worktree from this lane's browser runs and
  was removed. The tree holds only the three owned files plus this document.

---

# Addendum — the two interaction fields (after a7b8d9a)

`e2e/table-fit.spec.ts` went red on a real match: dragging a land between rows
did nothing, because the arrangement stood down whenever a card was
`selectable`, and outside an open selection `selectable` is Forge's ACTIONABLE
set — most of a player's own permanents on their own turn. Lane A split
`BoardInteraction` into two optional fields; this component is the only place
both can be read off one `LiveMatch`, so it is where they are filled.

The load-bearing fact, settled by lanes A and B and verified by the manager:
`setSelectables` has exactly two call sites in all of Forge
(`InputSelectEntitiesFromList.java:57`, `InputSelectTargets.java:68`), and
`InputAttack` / `InputBlock` are neither. So Forge publishes NO open selection
while attackers or blockers are declared, and *"a selection is open"* and
*"a card is actionable"* are different states.

## What changed, and what did NOT

**`selectionOpen` is NOT named here.** `LiveClickables` already carries it —
`boardInteraction` returns `selectionOpen: selection !== null`
(`match.ts:789`) — so it rides in with `...offered`. Naming it again would be a
second place for the two to drift. Checked against `match.ts` on disk, not
against the transcription.

**`declaringAttackers` IS named here**, as
`declaringAttackers: declaringAttackers(match)` (lane B's export over
`view.phase` and `view.activePlayerId` — structured state, never prompt text,
§0b). It cannot ride in on `LiveClickables`: `boardInteraction` is about what
Forge OFFERED, and this is about which input Forge is parked on.

Four cases in `LiveBoard.test.ts` assert the handover off the props `Board` was
CALLED with, not off the DOM: `Board` is wrapped by a `vi.mock` that captures
`props.interaction` and then renders the real component, so the other 69 cases
still exercise the real board.

## A test that passed a mutation, and why

The first version of the declare-attackers case did
`await waitFor(() => expect(captured.interaction!.declaringAttackers).toBe(true))`.
Inverting the field **did not fail it**: inverted, the field is already `true`
at rest, so the wait was satisfied before any delta arrived and the case never
reached the state it was about. Waiting on the thing under test is how a mutant
survives.

Rewritten: every wait is on `match.view` and on the phase rail's own rendered
attributes (`data-phase`, `data-whose`) — a settled render, independent of the
field — and the field is then asserted with a plain `expect`. The at-rest value
is asserted first, so an inverted field fails on line one.

## Verification

| claim | command | result |
| --- | --- | --- |
| suite green | `npx vitest run apps/ui/src/play/live/LiveBoard.test.ts; echo $?` | **exit 0**, 73 passed / 73 |
| typecheck | `npx tsc --noEmit -p apps/ui/tsconfig.json; echo $?` | **exit 0** |
| lint | `npx eslint …/LiveBoard.tsx …/LiveBoard.test.ts; echo $?` | **exit 0** |

## Mutation-tested

| mutation | reverted | restored |
| --- | --- | --- |
| `declaringAttackers` line deleted | **1 failed** / 72 skipped, exit 1 (`expected undefined to be false`) | **1 passed**, exit 0 |
| `declaringAttackers` inverted | **1 failed** / 72 skipped, exit 1 (`expected true to be false`) | **1 passed**, exit 0 |
| `selectionOpen` overridden to `offered.selectable.size > 0` (the original regression) | **1 failed**, exit 1 (`expected true to be false`) | **1 passed**, exit 0 |
| `selectionOpen` overridden to constant `false` | **1 failed**, exit 1 (`expected false to be true`) | **1 passed**, exit 0 |
| `selectionOpen` overridden to constant `true` | **1 failed**, exit 1 (`expected true to be false`) | **1 passed**, exit 0 |

`LiveBoard.tsx` restored by checksum each time (`38f9cb64…`).

## Now settled that this doc had as unverified

The manager's own runs: `e2e/play.spec.ts` passes (2 tests, 49.5s) and
`combat-drag.jvm.test.ts` passes (1 test, 16.7s) against real Forge. Only
table-fit's arrangement assertion was red, and that is what this addendum
fixes. `e2e/table-fit.spec.ts` itself remains the manager's run.
