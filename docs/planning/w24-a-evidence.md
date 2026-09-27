# Wave 24 lane A — the battlefield is the player's

Evidence for §A items 1–5. Every number here was produced by a command in this
file, on this branch, under Node 24
(`PATH="/home/hadoku/.local/share/fnm/node-versions/v24.18.0/installation/bin:$PATH"`,
prefixed to every command below and elided for legibility).

Files this lane changed: `apps/ui/src/play/Board.tsx`, `Board.test.ts`,
`board.css`, `card.css`, `adapter.ts`, `adapter.test.ts`, and this document.
`fold.ts` was read and **not** changed: nothing in §A needs the fold to do
anything new.

---

## 0. The question §A.3 said to answer first: printed versus current

**Answer: the wire carries the CURRENT power and toughness and no printed base
at all. The printed base comes from `apps/ui/src/draft/pool.json`, keyed by card
name, and a card that file has never heard of has no base — which the board draws
as plain, never as buffed.**

Established from four separate places, not from reasoning:

1. **`TrackableProperty.java`** (read at
   `/home/hadoku/repos/hadoku-cardtable/forge/forge-game/src/main/java/forge/trackable/TrackableProperty.java`,
   read-only, the main checkout's submodule). `Power` and `Toughness` are :132–133.
   Grepping the whole enum for `Printed|Base|Original` returns exactly three
   constants, and none of them is a P/T:

   ```
   121:    OriginalColors(TrackableTypes.ColorSetType),
   125:    OriginalManaCost(TrackableTypes.ManaCostType),
   139:    HasPrintedPT(TrackableTypes.BooleanType),
   ```

   `HasPrintedPT` is a **boolean**, and Forge sets it only for vehicles and
   spacecraft — `CardView.java:1102`:
   `updateHasPrintedPT((currentStateView.isVehicle() || currentStateView.isSpaceCraft()) && currentState.hasPrintedPT())`.
   It is not a number and it is not a base.

2. **The card states are the four the manager named** and nothing else:
   `CurrentState` / `AlternateState` / `LeftSplitState` / `RightSplitState`
   (:109–112). There is no original or printed state to read a base off.

3. **A census of the committed capture** (`fixtures/tierc-game1-seq1-27.json`,
   all 27 packets, both arms, grouped by object type):

   | type | the properties that matter here |
   | --- | --- |
   | `CardState` | `Power:36  Toughness:34  Keywords:19  HasPrintedPT:3  Type:59  Name:59` |
   | `Card` | `Damage:7  LethalDamage:37  Sickness:76  Tapped:73  Attacking:11  Blocking:3` |

   So P/T is a **face** property and damage is a **card** property, which is how
   `adapter.ts` reads them. `AttachedCards` and `EntityAttachedTo` appear **zero
   times** — see §2. No `Base*` key appears at all; `adapter.test.ts` asserts
   that over the real packets rather than taking it on trust.

4. **`pool.json` is the only printed-P/T source we have.** 534 cards, 193 with a
   `power`; `art-ids.json` carries ids and nothing else (its own header says
   *"Ids only — no URL, no host, no image metadata"*). Distinct printed powers in
   the pool include `*`, and toughnesses include `1+*`, which are not numbers —
   `printedPTIndex` drops those rows, so such a card draws plain.

**Consequence, stated plainly:** every card in the committed capture is from a
Forge precon deck and **none of them is in the cube pool** — checked by name for
Fire Urchin, Vulshok War Boar, Goblin Replica, Oxidda Golem, Island and Mountain,
all `false`. So on the committed fixture every creature draws a PLAIN badge, and
the buffed/hurt states are exercised by renaming a fixture card to a cube card
(`Giver of Runes|PRM`, a real 1/2 in the pool) and moving its `Power`/`Toughness`
and `Damage` on the wire. That is the operator's own case, driven from the wire:

```
adapter.test.ts › '§A.3 #12/#18 … draws the operator’s case from the wire'
  wire: Power 3, Toughness 4, Damage 3, printed base 1/2 (from pool.json)
  drawn: power 3 buffed, toughness 1 hurt
```

**`LethalDamage` arrives (37 times in the capture) and is deliberately NOT the
number drawn.** `Card.java:5978-5986`:

```java
public final int getLethalDamage() {
    for (Card c : getAssignedDamageMap().keySet()) {
        if (c.hasKeyword(Keyword.DEATHTOUCH)) {
            return 0;
        }
    }
    return getLethal() - getDamage() - getTotalAssignedDamage();
}
```

It returns 0 outright against deathtouch, so it is not "toughness left". The
board computes `Toughness - Damage` itself. `LethalDamage` is carried on
`BoardCard` because it is on the wire and someone will want it.

---

## 1 & 5. Free placement and deliberate stacking (#1, #19)

`rowFor()` is still the DEFAULT and is still the only thing that decides where an
unarranged card goes. What changed is the shape of a row: it is a list of
**piles** rather than a list of cards, and a drop on a card is three gestures
rather than one.

| where the drop lands | what it means |
| --- | --- |
| the row's own box | at the row's end, on its own (unchanged; this is the gesture `e2e/table-fit.spec.ts` drives) |
| a card's **top** third | stack it ON TOP of that card |
| a card's **bottom** third | stack it UNDERNEATH that card |
| a card's **middle** third | reorder: in front of that card's pile (unchanged) |

Read off `clientY` against the card's own rect (`dropOnCard`). The arrangement
store's type went from `Record<slot, number[]>` to
`Record<slot, number[][]>` — one inner array per pile, bottom card first.

**How a pile is drawn, and why it cannot move the canvas.** The pile's `<li>` IS
its bottom card; the cards above it are `li.board-card` inside that element's own
`ul.board-card__pile`, fanned by `card.css` inside ONE card's box:

- every card of the pile is narrowed by the whole fan, so the deepest card's
  right edge is `fan + (w − fan) = w`, exactly the grid track's width;
- the pile's height is `fan + (w − fan) · 1.3934`, which is **less** than one
  card's `w · 1.3934` for any fan, because 1.3934 > 1. A pile is never taller
  than the card it replaces.

A lane's `flex-grow` is therefore its **pile** count, not its card count, so a
stack asks for one card's worth of width and every card on the battlefield still
comes out one size. `Board.test.ts` pins the parting of those two numbers:
a stacked lands lane draws 3 columns for 4 cards, `flex-grow: 3`, label `Lands 4`.

**A lone card renders exactly the markup it rendered before piles existed** — no
wrapper, no nested list, no `data-pile-size`, no `data-pile-depth`. That is why
the parity ledger below has nothing about piles in it.

**Forge's `UI_STACK_CREATURES` / `UI_MAX_STACK_DEPTH`, read for the shape of the
idea** (`forge/forge-gui/src/main/java/forge/localinstance/properties/ForgePreferences.java:93,96`
— `UI_STACK_CREATURES ("false")`, `UI_MAX_STACK_DEPTH ("4")`; consumed by
`forge-gui-mobile/.../VField.java:33` and `VCardDisplayArea.java:380`). We took
the idea, not the implementation:

- stacking here is **never automatic** — Forge's `UI_STACK_CREATURES` groups
  non-token creatures for you; the operator asked for a gesture, not a setting;
- the depth is **not refused**. Forge caps the number of attached panels it will
  draw; we cap the **fan** at Forge's 4 (there is simply no rule for a fourth
  step, so a pile of nine fans exactly as far as a pile of four) and draw every
  card. Refusing a drop the player made is worse than a tight fan.

**A bug this found.** A drag started on a card INSIDE a pile bubbled to the base
card's own `dragstart` handler, which then overwrote which card was being
carried: dragging the equipment off a creature dragged the creature instead.
`start` now calls `stopPropagation`. `Board.test.ts`'s "cannot be pulled apart"
is the test that caught it.

---

## 2. Equipment renders stacked with what it equips (#11)

**`AttachedCards` is the authority; `EntityAttachedTo` is read and never builds a
stack.** That is not a style preference:

- `AttachedCards` is a `CardViewCollectionType` (`tier-c.ts`'s
  `STATE_PROPERTIES`), which crosses as a `list` of `int`. Card ids only.
  Unambiguous.
- `EntityAttachedTo` is a `GameEntityViewType`, which the server flattens to a
  bare int (`DeltaSyncManager.toNetworkValue`). **A `GameEntity` is a card OR a
  player, and the two id spaces overlap** — player 1 and card 1 are both `1` on
  the wire. An aura on a player would stack onto whichever card shares the
  number.

Both are let through to a seat: `apps/server/src/play/visibility.ts`'s
`FACE_ONLY_KEEP` lists `'EntityAttachedTo'` and `'AttachedCards'` on consecutive
lines. Both are read onto `BoardCard`; only the host's list makes a pile, and
`attachedToId` becomes `data-attached` on the card — a second, non-colour signal
that Forge attached it rather than the player stacking it (`card.css` draws a lit
leading edge).

**Forge's truth is applied AFTER the player's arrangement** (`withAttachments`,
called at the end of `group`). So:

- an equipped creature is one pile on a fresh board, with the **creature at the
  bottom** — which is the card drawn whole and in front, so its own art, its own
  P/T badge and its own chips are all still visible;
- dragging the host anywhere takes the gear with it;
- dragging the gear out puts it straight back;
- `Regroup` restores the default grouping **and** the equip stack;
- a chain (gear on gear) resolves to the root host, and a cycle cannot lose a
  card — it is drawn on its own instead.

**The committed capture has no attachment in it.** Census: `AttachedCards` and
`EntityAttachedTo` appear 0 times across all 27 packets, and `adapter.test.ts`
asserts that over the real packets — so the relation is exercised by writing the
documented encoding into the real state and reading it back out, and by
view-level tests in `Board.test.ts`. That is the honest limit of what the
committed fixture can prove, and it is recorded here rather than papered over.
A capture containing an Equipment would strengthen this; the command that would
produce one is `scripts/spike/tierc/run.sh capture` with a deck list holding an
Equipment (see `fixtures.ts`'s provenance note and `fixtures/capture-hook.patch`).

**Decision: an aura you control on their creature stays on your own side.** Only
cards on the SAME battlefield are folded into a pile, because that is the list
Forge puts the aura in. Drawing it across the table would mean inventing a
cross-seat stack the engine never described.

---

## 3. P/T tells the truth (#12, #18)

`adapter.ts`'s `boardPT` decides what the numbers mean; `Board.tsx`'s
`PowerToughness` decides what they look like.

- **power** = Forge's current power.
- **toughness** = current toughness **less damage marked** — what is left of it.
- **buffed** (blue) = above the printed base. **hurt** (red) = damage is marked,
  or the number is below the base. **plain** = no base known, or nothing to say.

The operator's case: a 1/2 with +2/+2 that has taken 3 arrives as `Power 3`,
`Toughness 4`, `Damage 3`, and draws `▲3 / ▼1` — power buffed, toughness hurt.

**The badge is the board's, not the tile's.** `CardTile`'s `.card__stat` draws
the printed stat at the tile's foot and the art `<img>` covers it; `CardTile` is
also not this lane's file. So the board draws its own badge, out of flow, clipped
to the card, `pointer-events: none` — it cannot change a card's box and cannot
eat a click Forge offered. The damage **chip** is dropped when a badge is drawn,
because the badge carries the same number, in red, with a marker and in words.

**Colour is never the only signal.** Three per state:

| state | ink | weight | marker |
| --- | --- | --- | --- |
| buffed | `var(--c-blue)` | 700 | `▲` |
| hurt | `var(--c-red)` | 700 | `▼` |
| plain | `var(--ink)` | inherited | none |

plus the whole thing in words in the badge's accessible name
(`power 3, up from 1, toughness 1, 3 damage marked`). Read with no colour at all,
`▲3 / ▼1` still says buffed and hurt. `Board.test.ts` asserts the marker glyph
per state AND greps `card.css` to prove each state's rule sets a `font-weight` as
well as a `color`.

**An unknown base draws plain, never buffed.** Asserted over every card of the
committed capture — all 24 of them have `printed: null`, and `boardPT` calls
every state `plain`.

---

## 4. Haste is not summoning sickness (#17)

**The wire carries what this needs, and the committed capture proves it.**
`Keywords` (`TrackableProperty.java:146`, `KeywordCollectionViewType`) is a
`CardStateView` property — 19 occurrences in the capture — and crosses as each
keyword's `original()` text (`tier-c.ts`: `KeywordsValue = {t:'keywords', v: string[]}`).
Dumped from the fold:

```
card 76 Oxidda Golem      {"t":"keywords","v":["Affinity:Mountain","Haste"]}
card 21 Fire Urchin       {"t":"keywords","v":["Trample"]}
card 60 Hellkite Whelp    {"t":"keywords","v":["Flying"]}
```

So haste is a real token on a real captured card, and a keyword's parameter comes
after a colon. The check is therefore **membership on a token**, not a match
against prose: `k.split(':')[0].trim().toLowerCase() === 'haste'`. `Haste` takes
no parameter — `Keyword.java:100`:
`HASTE("Haste", SimpleKeyword.class, true, "This creature can attack and {T} as soon as it comes under your control.")`.

`summoningSick` is now `Sickness && !hasHaste(keywords)`; Forge's raw answer is
kept as `arrivedThisTurn`. The chip follows `summoningSick`.

**The test uses the capture's own flag, not one it invented.** Oxidda Golem's
`Sickness` is already `true` in the capture while it sits in a graveyard — which
is both why the adapter only reports sickness for a creature on a battlefield and
why moving that card onto the battlefield gives a genuinely hasty, genuinely sick
creature. The contrast is Vulshok War Boar (no keywords at all), which does need
a flag written in.

**What the wire does NOT carry, said rather than inferred.** Forge has effects
that let a creature attack *as though* it had haste without granting the keyword;
those are static abilities, not keywords, and `TrackableProperty` has no "may
act" flag. Such a creature still wears the chip. The fix is a wire property Forge
does not currently expose, not a regex over its card text — **reported, not
worked around.**

---

## Verification

Every command was run from
`/home/hadoku/repos/hadoku-cardtable/.claude/worktrees/w24-manager`, with the
Node 24 prefix, and every exit code was read directly (`cmd; echo $?`), never
through a pipe.

| claim | command | result |
| --- | --- | --- |
| this lane's suites are green | `npx vitest run apps/ui/src/play/Board.test.ts apps/ui/src/play/adapter.test.ts apps/ui/src/play/fold.test.ts` | **exit 0** — 3 files, **114 passed** (Board 80, adapter 25, fold 9) |
| the UI typechecks | `npx tsc --noEmit -p apps/ui/tsconfig.json` | **exit 0**, no diagnostics |
| the board's downstream consumers still pass | `npx vitest run apps/ui/src/play/inspect/index.test.ts apps/ui/src/play/live/LiveBoard.test.ts` | **exit 0** — 86 passed (inspect 17, LiveBoard 69) |
| the parity pin moved, and only by the badges | `npx vitest run apps/ui/src/play/live/parity.test.ts -t 'renders exactly the markup'` | **exit 1**, expected — see the ledger below |

### Mutation tests

Each reverted on the **fixture-driven** suite, never against a live target, then
restored and re-run. `Board.tsx` was byte-compared against its pre-mutation copy
after the last restore.

| control | mutation | reverted | restored |
| --- | --- | --- | --- |
| **a.** the arrangement sends nothing to the engine | `place()` also calls `interaction?.onSelectCard(cardId)` | **exit 1 — 2 failed** (`drag to arrange › sends nothing to the engine`, `drag to stack › sends nothing to the engine: no sender is called by any arrangement gesture`) | **exit 0 — 2 passed** |
| **b.** only the viewer's own battlefield is arrangeable | the opponents' `PlayerArea` gets `arranging={arranging}` instead of `undefined` | **exit 1 — 3 failed** (`is the viewer’s own battlefield only`, `a card dragged onto the opponent’s battlefield stays where it was`, `rejects the gesture on an opponent’s battlefield`) | **exit 0 — 9 passed** |
| **c.** Forge's attachment truth survives a rearrange | `group` applies `withAttachments` only when the arrangement is empty | **exit 1 — 3 failed, 2 passed** — and the split is the point: the fresh-board stack and the cross-seat aura still pass, while `holds after the player rearranges`, `cannot be pulled apart` and `holds through Regroup` all fail | **exit 0 — 5 passed** |

### The parity pin

`apps/ui/src/play/live/parity.test.ts` is not this lane's file and was not
edited. It now reds with:

```
BASELINE_SHA256 = db9c44404304ea26ae008f8f5d77b52187fa33170e8fb445544c52a5e131f25b
BASELINE_LENGTH = 34754
```

(was `78d3849befc5fd43e0e388d78ba49b758f402ee6d93cc119664899af79239695` / `34052`.)

**Ledger: +702 characters, all of them P/T badges, measured not estimated.**

```
 +702   three `.board-card__pt` badges, 234 characters each — one per creature
        on a battlefield in the committed fixture (Vulshok War Boar 5/5,
        Goblin Replica 2/2, Fire Urchin 1/3). Every one of them is PLAIN: no
        card of the capture is in the cube pool, so no state attribute and no
        marker glyph is rendered, which is why all three are the same length:

          <span class="board-card__pt" data-pt="" aria-label="power 5, toughness 5">
            <span class="board-card__pt-n" data-pt-of="power">5</span>
            <span aria-hidden="true">/</span>
            <span class="board-card__pt-n" data-pt-of="toughness">5</span>
          </span>

   ±0   piles: `data-pile-size` and `data-pile-depth` appear 0 times. Nothing
        is stacked and nothing is attached in the fixture, and a lone card
        renders byte-for-byte as before.
   ±0   `data-attached`: 0 occurrences — the capture carries no attachment.
   ±0   chips: no card on a battlefield in the fixture has `Damage`, so no
        damage chip was dropped in favour of a badge.
 ─────
 +702   34052 → 34754
```

Confirmed arithmetically: `3 × 234 = 702` and `34754 − 34052 = 702`, so the
ledger accounts for the change exactly and nothing else in the board's markup
moved.

---

## The seam, for lane B's benefit

This lane binds **HTML5 drag-and-drop and nothing else**:

| event | element |
| --- | --- |
| `dragstart`, `dragend` | a battlefield card's `<li>` (`.board-card`, including a pile member) |
| `dragover`, `drop` | the same `<li>`, and the row's `<li>` (`[data-board-row]`) |

**No pointer event is bound anywhere in `Board.tsx`** — no `pointerdown`,
`pointermove`, `pointerup`, `pointerover` or `pointercancel`; no mouse or touch
handler either. The overlay root (`[data-board-overlay]`) is still empty and
still has no handler. Nothing here reads, writes or styles `data-attack-intent`.

This lane's own attributes, none of which collide: `data-arrange-reset`,
`data-pile-size`, `data-pile-depth`, `data-attached`, `data-pt`, `data-pt-state`,
`data-pt-of`.

**One hazard worth naming.** A `draggable="true"` element swallows a native
mousedown-drag in every browser, and the viewer's battlefield cards are
`draggable`. If lane B's box-draw for attackers starts from a pointerdown on a
card, it will be competing with the browser's own drag on that element. That is
lane B's to resolve (`touch-action`, or `preventDefault` on `dragstart` while a
box-draw is live) and it is stated here so nobody discovers it in the e2e.

## Guarantees still held, byte for byte in behaviour

- `data-card-id="<id>"` on every card's `<li>`, unique across the board **at
  every pile depth** — asserted with a per-id `querySelectorAll(...).toHaveLength(1)`
  over all 24 cards with a pile of three built first;
- `data-board-card` beside it, with the same value;
- `data-player-id` / `data-player-face` on every player's face;
- `data-board-row` on each of the four battlefield rows, in order, with
  `data-empty`;
- `<div className="board__overlay" data-board-overlay="" />`, a positioned root
  covering the canvas exactly, empty, at the board's top level;
- every `data-testid` `e2e/play.spec.ts` reads: `life`, `player`, `hand-count`,
  `library-count`, `turn`, `phase`, `active-player`, `turn-bar`, `board-mid`,
  `card` (from `CardTile`) — unchanged, and `e2e/` was grepped for `data-testid`
  before any markup moved;
- a row's `:scope > ul.zone__cards > li.board-card` children are one per visual
  column, which is what `e2e/table-fit.spec.ts` measures a card's box from and
  what `rowsOf` walks.

---

## Addendum — `draggable` and `data-selectable` are mutually exclusive

Raised by the manager after the first pass, and it is the same hazard the "for
lane B" section above named, diagnosed properly: not cosmetic, and the fix is in
this lane's file.

**The overlap.** `CardOnBoard` computes `selectable` and `draggable` on adjacent
lines and they were not exclusive. Lane B's committed gesture layer starts its
targeter drag on `pointerdown` over any card `interaction.selectable` holds
(`live/gestures/install.ts`'s `onPointerDown`); a `draggable="true"` element
starts the **browser's own** HTML5 drag from that same press. `draggable` was true
for every card on the viewer's battlefield, offered or not. So a press-and-move on
an offered card on your own battlefield fired **both** gestures: this lane's
rearrange, and B's pointer drag, which sends `selectCard` on release. Double
action on exactly the cards where both lanes are live at once — your own lands
during a payment, your own creatures while something is targeting.

**The fix, one condition** (`Board.tsx`):

```ts
const draggable = arranging !== undefined && row !== undefined && !selectable;
```

A card Forge is offering belongs to Forge; arranging is what you do with a card
Forge is not asking about. That is the wave's "Forge decides, we render its
answer" rule applied to a gesture rather than to a rule, and it needs no
coordination at runtime: the attribute the browser reads is the same fact the
pointer lane tests, so a natively-draggable element is **by construction** never
one Forge offered. Lane B is adding the symmetric half in its own file; nothing
under `live/gestures/` was touched from here.

**Two of this lane's own tests were dragging cards that are now, correctly, not
draggable**, and both had to be rearmed rather than relaxed. `sends nothing to
the engine` (both copies) had declared the very cards it dragged selectable, to
prove a stray call would land. Under the new rule that makes the drag a no-op and
the test vacuous — it would have passed by doing nothing. Both now arm the
senders with **the viewer's HAND** and both players, assert
`[data-selectable].length > 0` so the arming is real, and drag battlefield cards
Forge is not offering. The pile case builds its pile first with nothing offered,
then re-renders with the member offered — the arrangement is in the module store
and survives the remount, so the same pile is redrawn with Forge's offer on it.

### Verification of the addendum

| claim | command | result |
| --- | --- | --- |
| this lane's suites are green | `npx vitest run apps/ui/src/play/Board.test.ts apps/ui/src/play/adapter.test.ts apps/ui/src/play/fold.test.ts` | **exit 0** — **118 passed** (Board **84**, adapter 25, fold 9) |
| the UI typechecks | `npx tsc --noEmit -p apps/ui/tsconfig.json` | **exit 0**, no diagnostics |
| the board's consumers still pass | `npx vitest run apps/ui/src/play/inspect/index.test.ts apps/ui/src/play/live/LiveBoard.test.ts` | **exit 0** — 86 passed |

| control | mutation | reverted | restored |
| --- | --- | --- | --- |
| **d.** a card Forge offers is not draggable | drop `&& !selectable` | **exit 1 — 3 failed** (`a card Forge offers is NOT draggable…`, `with every card offered, nothing on the board is draggable`, `holds for a card inside a pile`) | **exit 0 — 4 passed** |

`Board.tsx` was byte-compared against its pre-mutation copy after the restore —
identical.

### The parity pin did NOT move

```
BASELINE_SHA256 = db9c44404304ea26ae008f8f5d77b52187fa33170e8fb445544c52a5e131f25b
BASELINE_LENGTH = 34754
```

Unchanged from the first pass, and the reason is structural rather than luck:
`parity.test.ts` renders `<Board view={…} />` with **no `interaction` prop**, so
`interaction === undefined`, so `selectable` is false for every card on the
board and `draggable` is exactly what it was. Measured on the rendered markup:
`draggable="true"` appears **5** times (the viewer's five permanents, as before)
and `data-selectable` **0** times. The ledger above stands with no new entry:
`34052 → 34754`, all +702 of it the three P/T badges.

---

## Second addendum — the stand-down is an OPEN SELECTION, not "actionable"

The first addendum's rule was too blunt and the real e2e caught it: a permanent
`e2e/table-fit.spec.ts` dragged between rows was not `draggable`, so `dragstart`
never fired, `carried.current` stayed null and the card did not move.

**Why it was wrong.** `interaction.selectable` flattens two claims Forge keeps
apart, and only one of them is a question:

| Forge method | who publishes it | what it means |
| --- | --- | --- |
| `setSelectables(cards, min, max)` | **exactly two call sites in all of Forge**, both selection inputs — `InputSelectEntitiesFromList.java:57`, `InputSelectTargets.java:68` | *"I am asking, and a click on one of these is the answer."* |
| `setWeaklySelectable(cards)` | priority, mana payment, declare attackers, declare blockers, via `PlayerControllerHuman.pushActionableCards` (`:1543-1617`) and `pushBlockerCandidates` (`:1621-1646`) | *"You COULD do something with this."* |

Verified by grepping the vendored Forge for both, read-only. On your own turn the
actionable set is most of your own lands and creatures, so gating the arrangement
on it killed free placement for most of a game — the opposite of *"i dont want
these snapping zones… put cards wherever they want"*. **An actionable highlight is
Forge saying "you could", not "I am asking".**

**The narrowing**, in `Board.tsx`:

```ts
const inOpenSelection = selectable && interaction?.selectionOpen === true;
```

`BoardInteraction.selectionOpen?: boolean` is a new, optional, documented field.
The board is TOLD which of the two states is live rather than inferring it from
set membership, because this file may not start reasoning about Forge's inputs.
**Absent means no selection is open** — the safe default, and the state every
fixture and `live/parity.test.ts` render in.

### The shadowing half: `selectionOpen` does NOT cover declare-attackers

Established, not assumed. **Forge publishes no open selection while attackers are
declared.** `setSelectables` has the two call sites above and `InputAttack` is
neither of them; all it publishes is `updateButtons`
(`InputAttack.java:87-95`), and `onStop` calls `clearActionableCards`
(`:98-101`). So `match.selectables` is null through the whole step and its
creatures arrive as the ACTIONABLE set.

Left alone, that is a real regression of §B, not a cosmetic nit: the interaction
lane's pointer layer stands down on any natively-draggable element, so a
`draggable` creature during declare-attackers means **you cannot attack with it**
— and "attackers can be declared by box-draw" is one of the wave's done-whens.

So a second optional field carries the fact:

```ts
const itsAttackToDeclare = interaction?.declaringAttackers === true && rowFor(entry) === 'creatures';
```

- **Only creatures**, and by the card's OWN type line rather than the lane the
  player has dragged it into — lands and everything else stay arrangeable,
  because no gesture of the other lane starts on them here.
- **Absent means not declaring attackers.** Safe default, and what every fixture
  renders in.
- The fact is structured state, never prose: phase `COMBAT_DECLARE_ATTACKERS`
  and this seat is the active player — which is exactly what lane B's exported
  `declaringAttackers(match)` already computes (`match.ts:957-960`).

### What has to be set, and where

Both fields default safe, so nothing breaks unset; both are inert until filled.
One place fills both — `apps/ui/src/play/live/LiveBoard.tsx:516-521` (lane C),
from values lane B already exports:

```ts
const interaction: BoardInteraction = {
  ...offered,
  selectionOpen: match.selectables !== null,   // the narrow fact, from match.ts
  declaringAttackers: declaringAttackers(match), // already exported by match.ts:957
  onSelectCard: (cardId) => selectCard(match, cardId),
  onSelectPlayer: (playerId) => selectPlayer(match, playerId),
};
```

`declaringAttackers` is already imported in that file's neighbourhood for lane
B's gesture install; `match.selectables` is a public field of `LiveMatch`
(`match.ts:441`). Nothing under `live/` was edited from this lane.

**Residual risk to state plainly:** until `declaringAttackers` is filled, a
creature is draggable during that step and arranging shadows attacking. Until
`selectionOpen` is filled, the board is fully arrangeable at all times — which is
the operator's requirement and the e2e's expectation, so the unset state is the
*safe* one and the field only ever takes affordance away.

### Verification of the second addendum

| claim | command | result |
| --- | --- | --- |
| this lane's suites | `npx vitest run apps/ui/src/play/Board.test.ts apps/ui/src/play/adapter.test.ts apps/ui/src/play/fold.test.ts` | **exit 0** — **124 passed** (Board **90**, adapter 25, fold 9) |
| parity, LiveBoard, inspector | `npx vitest run apps/ui/src/play/live/parity.test.ts apps/ui/src/play/live/LiveBoard.test.ts apps/ui/src/play/inspect/index.test.ts` | **exit 0** — **88 passed** (parity 2, inspect 17, LiveBoard 69) |
| the UI typechecks | `npx tsc --noEmit -p apps/ui/tsconfig.json` | **exit 0**, no diagnostics |

| control | mutation | reverted | restored |
| --- | --- | --- | --- |
| **e1.** an open selection stands the arrangement down | `inOpenSelection = false` | **exit 1 — 4 failed** | **exit 0 — 7 passed** |
| **e2.** merely actionable does NOT (the e2e red, as a unit test) | `inOpenSelection = selectable` — the blunt rule restored | **exit 1 — 2 failed** (`an ACTIONABLE card on your own battlefield is still draggable — the e2e red`, `defaults to no selection open when the field is absent`) | **exit 0 — 7 passed** |
| **f.** the attack declaration stands it down on creatures | `itsAttackToDeclare = false` | **exit 1 — 2 failed** (`stands down on your own CREATURES…`, `is by the creature's own type line…`) | **exit 0 — 10 passed** |

`Board.tsx` was byte-compared against its pre-mutation copy after every restore —
identical each time. **e2 is the important one:** it holds the e2e's red as a unit
test, so the blunt rule cannot come back without a red in this file first.

### The parity pin did NOT move

`apps/ui/src/play/live/parity.test.ts` now **passes** at the pin the manager
recorded with commit `3db801c`:

```
BASELINE_SHA256 = db9c44404304ea26ae008f8f5d77b52187fa33170e8fb445544c52a5e131f25b
BASELINE_LENGTH = 34754
```

Nothing to re-record and no new ledger entry. Structural, not luck:
`parity.test.ts` renders `<Board view={…} />` with **no `interaction` prop**, so
both new fields are absent, both default to "no", and `draggable` is exactly what
it was — the same five occurrences measured in the first addendum. The ledger
stands at `34052 → 34754`, +702, all three P/T badges.
