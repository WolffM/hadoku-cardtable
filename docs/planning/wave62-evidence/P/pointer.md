# §P — the pointer on the card, an arrow only while aiming, the back where the ghost was

## AE1 — the cursor is correctly showing what card is being hovered even if the screen size is vastly different

**Schema** (`packages/shared/src/presence.ts`):

```ts
export const PresenceOverSchema = z
  .union([
    z.object({ card: z.string().min(1), x: fraction, y: fraction }).strict(),
    z.object({ hand: z.number().int().nonnegative(), x: fraction, y: fraction }).strict(),
  ])
  .nullable();
```

`PresenceSchema` gains `over: PresenceOverSchema.default(null)` beside `pointer`. `pointer` still
carries the board fraction (unchanged — the fallback and the zone hint); `over` is populated only
when the pointer sits over an element the receiver can resolve by a STABLE key rather than a
fraction of the whole board:

- a public card (`[data-board-card]` — battlefield, graveyard, exile — or `[data-placed-spell]`,
  the stack's own layer): `{ card: <id>, x, y }`, fractions of THAT element's own box;
- the viewer's OWN hand (never the opponent's — see below): `{ hand: <index>, x, y }`.

The receiver (`placeOver` in `apps/ui/src/play/live/presence.ts`) resolves `over` on its OWN
board: a card id through the identical selector (a public card carries the same id on both
screens by construction), a hand index through the i-th `<li>` of
`[data-zone="hand"][data-owner="them"]` — the SENDER's hand, as the receiver draws it (backs,
since it is hidden). This is the whole point: the fraction is of the CARD, not the board, so it
survives any mismatch between the two screens' aspect ratios or `--card-max` scaling.

**Why hand hovering sends an INDEX, never the card.** A card in the viewer's OWN hand has a real
id and `[data-board-card]`, exactly like a battlefield card — but sending that id would leak which
card is under the cursor before it is played. `overOf` special-cases `[data-zone="hand"]
[data-owner="you"] li` ahead of the general card branch for exactly this reason, and reports the
slot's position in the list instead. Hovering the OTHER seat's hand (already drawn as backs on
the sender's own screen — nothing to anchor a fraction to, since the sender does not know what is
there either) answers `null`, and the caller falls back to the board fraction exactly as before
AE1 — the one case `over` does not improve, because there is no stable key to send.

**Falls back to the board fraction** when: the pointer is over nothing anchorable, `over` names an
element THIS board has not drawn (yet — the id crossed, but a frame has not caught up), or a
pre-deploy sender's message carries no `over` field at all (`.default(null)`).

## AE6 / AE10 — the arrow and the parked-card desync

**AE10** (`match.selectables !== null || stackAsk(match) !== null`, item 3): `handsOf`'s `from`
(the arrow's tail) is now gated on a new `PresenceHost.aiming` reader. Without it (the gate's
previous, unconditional behaviour) a parked card — waiting on Forge, or on an X-value slider with
no target at all — reported its own centre as `from` on every message, and the receiver drew an
arrow to it the whole time a card sat parked. `aiming` defaults to `false` when the host does not
wire it (the safe direction: no spurious arrow, rather than a legitimate one suppressed) — see the
"not mine to edit" note below.

**AE6, the release-point desync.** Measured, not assumed, before changing anything:
`drawCastLift`'s `[data-cast-lift]` positions the lifted card with `transform: translate(-50%,
-50%)` at `left`/`top` set to the POINTER's own coordinates on every `pointermove`, synchronously
— so while a `pointermove` keeps firing, the card's own box centre and the pointer coincide exactly.
The gap AE6 describes opens when the device's final `pointerup` has NO `pointermove` at the same
coordinates immediately before it (common — not every release is preceded by a move to that exact
spot): the lifted element is still sitting wherever the LAST move put it, while `resolveLift`'s own
`point` is the up event's own (slightly different) coordinates. The fix, in both files that compute
a release spot, reads the lifted element's CURRENT box centre instead of the raw event point,
falling back to the event point when nothing is lifted or has no box yet:

- `apps/ui/src/play/live/gestures/install.ts`'s `resolveLift` — the WIRE value only
  (`placement.at`, sent to Forge's own `selectCard` for a permanent with no target). Hit-testing
  (`placementAt(point)`, `overOwnHand`/`overOwnBattlefield`) still uses the real pointer, on
  purpose — only the "where does this live, visually" value moved.
- `apps/ui/src/play/live/presence.ts`'s `onPointerRelease` / new `liftedCentre` — the
  `sendRelease` spot (`placing.at`, `from`), which is what the OTHER seat's back actually waits at.

**Measured dx/dy**, local run against the jar (`e2e/presence.spec.ts`'s bolt-player case,
`[presence over] bolt release: …`):

```
[presence over] bolt release: pointer=(520,550.6484375) ghostCentre=(520,550.640625) dx=0 dy=-0.0078125
[presence over] bob's back centre=(694.28125,401.734375) vs alice's ghost centre mapped to bob's board=(694.2857142857142,401.7448939340813)
```

`dx≈0, dy≈-0.008px` — as expected: this harness's own `dragHandCard`/manual-drag helpers always
fire a `mouse.move` to the exact release point immediately before `mouse.up()`, which is the one
case the bug does NOT reach (the lifted element is freshly positioned at that point by the
preceding move). The fix targets the real-device gap — a release with no intervening move at the
release point — which this harness cannot manufacture through Playwright's own API; it is
exercised instead by reading the lifted element's live box rather than the raw event each time,
which is a strict superset of "trust the last move": identical when they already agree (every case
this harness can produce, confirmed above), correct when they do not (the real-device case AE6
reported). bob's back landed within 0.01px of alice's ghost, mapped across the two screens'
different board fractions (1280×800 / 1600×1000) — confirming the mirror math end to end, not only
the local read.

**All 8 cases in `e2e/presence.spec.ts` pass against the real jar** (`npx playwright test
presence.spec.ts`, local, 1.2–1.5 min, 8/8 on three separate runs), including the two new ones for
AE1 (cross-aspect-ratio cursor-on-card) and AE6/AE10 (no arrow at any point for a no-target cast).

## Mutation testing

**Unit level** (reverted → restored, exact counts):

- `packages/shared/src/presence.test.ts`: 15/15, all pass on the fix.
- `apps/ui/src/play/live/presence.test.ts`: 36/36 pass on the fix.
  - Dropping the `over`-first resolution in `draw()` (reverting to the old `placeSpot`-only line):
    **2 of 36 fail** (the two `receiving: card- and hand-anchored over` cases), 34 still pass.
  - Dropping the `if (!aiming) return { held, from: null }` line in `handsOf`: **1 of 36 fails**
    ("a parked card reports no `from` unless this seat is actually aiming"), 35 still pass.
- `apps/server/src/play/socket.test.ts`: 56/56 pass on the fix (not separately mutated — it pins
  the relay shape only, which the shared schema's own suite already proves).

**E2E level**, against the real jar, under the same two mutations:

- Dropping `over` → `AE1: her cursor lands on the exact card she hovers…` **FAILS** (confirmed:
  `expect(received).toBe(expected)… Expected: true, Received: false`, the cursor never settles
  inside the land's box on bob's differently-shaped board) — exactly item 6(a)'s prediction.
- Dropping the `aiming` gate → the `AE6/AE10: no arrow is ever drawn…` test **still PASSES.**
  Measured, not assumed: Memnite (the scenario this case uses) never enters the `'parked'`
  `data-cast-lift` state at all — a no-target card goes `'lifted'` → `'carried'` directly
  (`resolveLift`: `!spell && ghost !== null` picks `'carried'`), so `handsOf`'s `parked` branch,
  the one the gate protects, never runs for this card regardless of the gate. The gate's real
  window is a TARGETED spell between release (parked) and Forge's targeting ask opening
  (`match.selectables` still null) — a race typically tens of milliseconds wide locally, which this
  harness could not reproduce deterministically without either slowing Forge's response or
  reproducing AE10's sustained case (picking an X value, a `confirm`-style ask that is neither
  `selectables` nor a stack ask, held open for seconds) — no scenario with an X-cost spell exists
  in this lane's row to drive that case without adding a new one. **The gate is proven correct at
  the unit level only** (confirmed above); the e2e case stands as real product coverage for
  AE6/AE10's "no target at all" half, not as a mutation-catching guard for this specific line. Said
  plainly here rather than claimed falsely in the done-when checklist.

## Not mine to edit — reported, not fixed

`handsOf`'s `from` gate needs `PresenceHost.aiming` wired from the real match state. The host is
constructed in `apps/ui/src/play/live/LiveBoard.tsx`, inside the `installPresence({ canvas, host:
{ … } })` call (currently lines 1947–1961 of that file, in the object literal alongside
`theirPlayerId`/`theirCards`/`motion`). The one line to add there, with the import it needs:

```ts
import { stackAsk } from './gestures/stack.ts'; // already a sibling module; LiveBoard does not import it today

// inside the `host: { … }` object, beside `theirPlayerId`/`motion`:
aiming: () => match.selectables !== null || stackAsk(match) !== null,
```

`LiveBoard.tsx` is not in this lane's row, so this was reported rather than edited. Until it
lands, `aiming` is undefined and `handsOf` never reports `from` at all (the safe default) — no
spurious arrow, but also no legitimate one, until the manager lands this one-line follow-up.

## Ambiguities resolved while implementing

- **`over.card`'s type.** The wave file's schema sketch writes `card: string`; `data-board-card`
  and `data-placed-spell` are both read with `getAttribute`, which is always a string, so `z.string()`
  was the natural match — no numeric id ever needed parsing.
- **Which elements anchor `over`.** The Settled section lists "battlefield, stack, exile,
  graveyard"; item 2's own sender description names only `[data-board-card]` (plus the hand `<li>`
  case). Stack items are NOT `[data-board-card]` — they are `live/placed.ts`'s own
  `[data-placed-spell]` layer, drawn outside any zone. Resolved by checking both selectors in one
  branch (`overOf`/`placeOver`), so the Settled list is honoured without reading item 2 as
  excluding the stack by omission.
- **Which direction `over.hand` resolves.** Item 2 says the receiver resolves a hand index "to the
  i-th back of `[data-zone="hand"][data-owner="them"]`" — ON THE RECEIVER's board. Working
  backward from that: the only hand a sender may safely report an index for (without leaking a
  card id out of hand) is the SENDER's OWN hand, which the receiver necessarily draws as the
  backs of ITS OWN opponent (`owner="them"`, from the receiver's seat). `overOf` therefore reports
  an index only for the viewer's own hand, never for hovering the other seat's hand-as-backs on the
  sender's own screen (there is nothing stable to anchor to there anyway).
