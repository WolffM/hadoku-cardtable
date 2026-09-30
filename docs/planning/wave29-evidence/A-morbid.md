# §A evidence — item 16.5, morbid's own condition

Wave 29 §A. Operator: *"things like morbid should be visible when they are
active. the 'orange glow' from hearthstone was always nice."* The wave file
splits this in two and says only one half is buildable this wave; this is the
investigation the other half was owed.

**Answer: NOT buildable this wave, and it is a bridge change, not a UI one.**
Nothing on the wire says a named conditional ability's condition (Morbid — "a
creature died this turn" — or any of Forge's other keyword conditions:
Threshold, Delirium, Landfall's own trigger state, Ferocious, and so on) is
currently satisfied. The achievable half — *"this card can do something right
now"*, driven by Forge's actionable set — shipped in this wave's `A:` commit
(`data-can-act`, `card.css`).

## What was checked, precisely

### 1. Every `BooleanType` property the wire carries

`packages/forge-wire/src/tier-c.ts`'s `PROPERTY_TYPES` is the full map of
`TrackableProperty` names to their wire type. Every property typed
`BooleanType` (52 of them):

```
Ability, Attacking, BlockAny, Blocking, CanPlay, CanSpecialize, Cloned,
ControlVotes, Detained, DoubleFaced, ExertedThisTurn, Facedown, FlipCard,
Flipped, Foretold, GameOver, HasAnnihilator, HasAvailableActions, HasBackSide,
HasChangedColors, HasDivideDamage, HasLost, HasPrintedPT, HasPriority,
HasUnlimitedHandSize, HasUnlimitedLandPlay, HasWard, IsAI, IsBoon, IsCommander,
IsEmblem, IsExtraTurn, IsRingBearer, MatchOver, Modal, Mulligan,
NeedsTapAnimation, NeedsTransformAnimation, NeedsUntapAnimation,
OptionalTrigger, OrigProduceAnyMana, PaperFoil, PhasedOut,
PromptIfOnlyPossibleAbility, Room, SA_IsSpell, Secondary, Sickness, SplitCard,
Tapped, Token, TokenCard, WasDestroyed
```

None of them names a keyword condition, generically or by name (no
`MorbidActive`, `ConditionMet`, `ThresholdActive`, or anything of that shape).
`HasAvailableActions` and `CanPlay` are the two item 16 actually uses — see
the `A:` commit — and neither is about a NAMED ability's condition; both are
about whether the card (or seat) has *any* legal action right now, which
Forge computes the same way whether or not a specific triggered ability's cost
or condition happens to be active.

### 2. The two string-shaped candidates the wave file named

`OverlayText` (`StringType`) and `MarkerText` (`StringListType`) are real
`CardView` properties — confirmed on the wire, not merely declared in the
schema — but the committed capture (`apps/ui/src/play/fixtures/tierc-game1-seq1-27.json`,
a real Forge match) never sends either as anything but `null`, on every card
that carries them:

```
"OverlayText":null,"MarkerText":null
```

(checked with `grep -in "OverlayText\|MarkerText" apps/ui/src/play/fixtures/tierc-game1-seq1-27.json`
— every hit in the file is one of these two null pairs, on Gemini Engine,
Fire Urchin, Rubblebelt Boar and every other card the capture holds.) So the
capture proves the FIELDS exist on the wire; it proves nothing about what they
would carry for a card that actually had something to show, because nothing
in the captured game ever populated them.

From Forge's own general design (its desktop client draws `OverlayText` as a
small badge on a card's corner — Saga chapter counters, Class levels, and
similar per-card state a specific card TYPE carries), both are shaped for a
CARD announcing its own numbered state, not for a keyword condition that is a
fact about the WHOLE GAME (how many creatures have died this turn, for
Morbid) evaluated against a specific ability on a specific card. Nothing rules
out a card-specific ability someday writing its condition into one of these —
but that would be true only for that card, not for "morbid is active" as a
general fact this client could read for every card that has a morbid ability,
which is what the operator's example asks for.

### 3. The prose fields, and why they are not the way in either

`OracleText` and `RulesText` both cross the wire (the capture carries
`OracleText` filled and `RulesText` null on every card checked). Even if
Forge's own text-generation ever inlined a live condition's truth into
`RulesText` for some card, reading it back out would be a regex over prose —
which this repo's own rule against scraping Forge's prose for structured facts
(the discipline `live/match.ts`'s header calls out for phases and inputs)
already forbids for less contentious cases than "did a creature die this
turn". Not pursued for that reason alone, independent of whether the capture
happened to show anything there.

## Why this is a bridge change and not a UI one

Computing "Morbid's condition is met" ourselves — watching the graveyard's
size change during the turn, per player, and cross-referencing every card
with a Morbid-shaped ability — is implementing a piece of Magic's rules
engine in the client. This repo's stated design is the opposite: Forge is the
rules engine and this client transcribes what it says, never re-derives it
(`live/match.ts`'s header has the running argument for phases, inputs and
combat facts; the same discipline applies here). The fact clearly exists
inside Forge's own `SpellAbility`/condition-check machinery — it has to,
for Forge to decide whether the ability itself may fire — it is simply never
serialized to `CardView`/`PlayerView`/`GameView` today. Surfacing it is a
Forge/bridge change: a new `TrackableProperty` (or a reuse of `OverlayText`
for this specific purpose, decided upstream) that a future wave's bridge and
wire packages would carry, not something `apps/ui/src/play/` can produce from
what already arrives.

## What shipped instead

Item 16's other half — *"this card can do something right now"* — is real
this wave: `BoardInteraction.actionable` (`Board.tsx`), fed by
`LiveBoard.tsx` from `boardInteraction`'s own offered set whenever no
selection is open, drawn as a soft warm blur (`data-can-act`, `card.css`) that
does not collide with the selection ring or the attack-intent outline. See the
`A:` commit for the mutation-tested claim.
