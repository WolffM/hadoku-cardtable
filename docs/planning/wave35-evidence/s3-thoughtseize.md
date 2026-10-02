# R4 — "Thoughtseize: three steps … should be one choice"

Wave 35 §S item 3. Diagnosis first (against a real Forge jar), then the
settled fix implemented server-side, with no change to Forge or the browser.

## The card and the code path

`forge-gui/res/cardsfolder/t/thoughtseize.txt`:

```
A:SP$ Discard | ValidTgts$ Player | NumCards$ 1 | DiscardValid$ Card.nonLand | Mode$ RevealYouChoose | SubAbility$ DBLoseLife | ...
```

`DiscardEffect.resolve`'s `RevealYouChoose` branch
(`forge-game/src/main/java/forge/game/ability/effects/DiscardEffect.java:225-271`),
for a 2-player game, is three Forge calls in a fixed order:

1. `game.getAction().reveal(dPHand, p)` — the discarder's (`p`) WHOLE hand
   revealed to the caster only (`GameAction.reveal(..., dontRevealToOwner=true)`
   iterates every OTHER player). This is `PlayerControllerHuman.reveal` →
   its non-floating branch (`owner != getLocalPlayerView()`, and
   `useFloatingHandReveal` requires `UI_SELECT_FROM_CARD_DISPLAYS` AND
   `!isLibgdxPort()`, which this bridge's `BridgeGui extends GuiDesktop`
   makes true/false respectively — so the floating-zone branch is NOT taken
   here) → `getGui().reveal(fm, collection)` → `AbstractGuiGame.reveal` is
   literally `getChoices(message, -1, -1, items)`.
2. `chooser.getController().chooseCardsToDiscardFrom(p, sa, validCards, min,
   max, visibleToChooser)` — the caster's real choice.
   `PlayerControllerHuman.chooseCardsToDiscardFrom`'s `useSelectCardsInput`
   check fails for a card in an OPPONENT's hand under this bridge's actual
   preferences (confirmed empirically, see "preferences" below), so it falls
   to `getGui().many(title, "Discarded", min, max, validKeys, null)` →
   `AbstractGuiGame.many`: `if (max == 1) return getChoices(title, min, max,
   sourceChoices);` — ANOTHER `getChoices`, this time `min=max=1` and
   `choices` already correctly excluding lands (`DiscardValid$ Card.nonLand`
   is Forge's own filter via `CardLists.getValidCards`, not ours).
3. `p.getController().reveal(toBeDiscarded, ZoneType.Hand, p, "…has chosen
   cards from…")` — a SECOND reveal, this time `owner === p ===
   getLocalPlayerView()` (the discarder revealing to themself), so
   `useFloatingHandReveal` is false by construction regardless of
   preferences, and this ALWAYS takes the blocking `getChoices(-1,-1,...)`
   branch too — a dismissal only the discarder sees.

## The run (before any fix), against the real jar

Scenario: seat 0 (caster) holds Thoughtseize and one untapped Swamp; seat 1
(discarder) holds Elvish Mystic, Goblin Guide (two valid, nonland) and
Mountain (invalid) — two real choices, not one, so the server's own
"one option" `getChoices` shortcut (`auto.ts`'s `onlyAnswer`) does not
collapse the choice before it can be observed
(`apps/server/src/play/scenarios/thoughtseize.state`). The scenario was cast
and the target picked and paid for, and every frame to both seats recorded
(`apps/server/src/play/scenario-thoughtseize.jvm.test.ts`, against jar
`89e824c9…`):

```
seat 0 (caster), after the mana payment resolves the spell:
  ASK getChoices  min=-1 max=-1  "Looking at cards in B's hand"
                  choices=[Elvish Mystic, Goblin Guide, Mountain]
  ASK getChoices  min=1  max=1   "Choose 1 card(s) to discard"
                  choices=[Elvish Mystic, Goblin Guide]        <- Mountain already excluded

seat 1 (discarder), right after:
  ASK getChoices  min=-1 max=-1  "Looking at cards in your hand"
                  choices=[Elvish Mystic]                       <- just the one taken
```

Exactly as traced from the Java source: three real, distinct asks, in that
order. This is what the operator meant by "look at hand, choose, 'looking at
cards in your hand'" — the second reveal's own MESSAGE literally contains
that phrase.

## An earlier scenario draft was accidentally degenerate

The first version of `thoughtseize.state` gave the discarder only ONE
nonland card (Elvish Mystic) plus a land. With only one valid choice,
`onlyAnswer`'s existing "one option" rule
(`keys.length === 1 && frame.min === 1`) auto-answers step 2 BEFORE it ever
reaches the wire — which looked, at first, like confirmation that the whole
three-step shape collapses on its own. It does not: `onlyAnswer` only ever
removes a question that has exactly one legal answer, and with two valid
nonland cards (the final scenario) step 2 is a REAL choice that reaches the
browser every time. Noted here because it cost a full diagnostic pass before
the mistake was caught — the lesson for any future scenario author: give a
"choose among the valid cards" effect at least two valid options, or
`onlyAnswer`'s own correct behaviour reads as something else entirely.

## The fix: fold 1→2 into one ask, drop 3 — implemented in `match.ts`

Per the operator's ruling, both unconditionally, over the STRUCTURE of the
asks (never a card name or message string as the deciding fact — the same
rule `auto.ts`'s own header states for every one of its shortcuts):

- **Fold.** `Match.onFrame` (`apps/server/src/play/match.ts`) treats a
  `getChoices` reveal (`min === max === -1`) specially: Forge's own game
  thread is PARKED inside the `reveal()` call that produced it and will not
  even construct whatever comes next until it is answered — so, unlike an
  ordinary ask, "hold it and see what follows" is not available. Its one
  legal answer, `[]`, is sent back AT ONCE (same fact `onlyAnswer` already
  encodes for every other reveal), and its `choices` are kept a moment
  (`SeatState.pendingReveal`, `PENDING_REVEAL_FOLD_MS` = 2 s) in case the
  VERY NEXT ask to that seat is the real discard choice. When it is — a
  `getChoices` with `max === 1` whose `choices` are a SUBSET of the held
  reveal's — `Match.openMergedChoice` sends the browser ONE synthetic
  `chooseSingleEntityForEffect` ask instead: `optionList` is the narrow,
  real choice (Elvish Mystic, Goblin Guide), `delayedReveal` is the WHOLE
  revealed hand (Elvish Mystic, Goblin Guide, Mountain) — reusing the exact
  wire shape `apps/ui/src/play/prompts/ChoicePrompts.tsx`'s
  `DelayedRevealNote` already renders greyed for a library search (the
  "Rampant Growth shape" the ruling itself names). One browser reply maps
  back through `SeatState.mergedChoice` to the real `getChoices` key and
  answers Forge's still-open second ask.
- **Drop.** `Match.noteDiscardChoice`/`noteJustDiscarded` remember the card
  ids ANY discard choice just sent Forge — whether answered through the fold,
  through `onlyAnswer`'s own "one option" shortcut, or plainly by a human
  reply — for `JUST_DISCARDED_TTL_MS` (5 s). The next `getChoices` reveal
  whose `choices` are EXACTLY that set, for either seat, is the discarder's
  redundant echo and is answered `[]` immediately, logged
  `ask-auto-answered`, never shown to anyone.

### What this does NOT cover (a known, documented gap)

The fold only builds `chooseSingleEntityForEffect` (`choose.max === 1`). A
`RevealYouChoose` effect with `NumCards` greater than 1 would need
`chooseEntitiesForEffect` instead and is left UNMERGED (both real asks reach
the browser as themselves) rather than guessed at — no such card was in
scope for R4.

### A regression the manager caught, and the fix (corrected after first review)

The first version of this fold answered EVERY `getChoices` reveal `[]` the
instant it arrived and, if nothing claimed it as a discard choice within
`PENDING_REVEAL_FOLD_MS`, only logged `ask-reveal-unmerged` — the seat never
saw it. That is wrong for every OTHER reveal in the game that happens to
share this exact wire shape (min=max=-1): an opponent's hand shown by a
tutor, Secluded Glen's reveal to the OTHER seat, a library search coming up
empty, any `RevealYouChoose`-shaped card this fold's `max===1` check does not
recognise. `auto.ts`'s own header (`:551-569`) is explicit about why this
shape is never auto-answered elsewhere: "a shortcut may remove a question; it
may never remove information."

Fixed: `Match.openDisplayOnlyReveal` shows an UNMERGED reveal to the seat
exactly as it looked before this fold existed — the SAME frame, the SAME
callId, registered as an ordinary ask (`s.displayOnlyAsks` marks it so a
reply to it is consumed locally rather than forwarded to Forge, which already
has its answer and has nothing left waiting on that callId). It fires:

- **At once**, the moment a disqualifying ASK arrives (the next ask isn't a
  matching `getChoices` choice) — no need to wait out the timer;
- **At once**, if a SECOND reveal arrives while the first is still held (the
  first was never going to merge with the second either — previously this
  silently dropped the first one, a second, independent swallow bug the same
  review caught);
- **After `PENDING_REVEAL_FOLD_MS`** (250ms, cut from an initial 2s — a
  measured real fold answers within 10-30ms, so this is generous headroom
  for the "no ask follows at all" case, not a target) for the case nothing
  else disqualifies it first — this is now the FALLBACK, not the only path.

3 new unit tests in `match.test.ts` (`describe('wave 35 §S, R4: a reveal the
fold does not claim is never swallowed')`) prove: an unclaimed reveal still
reaches the seat once the window passes, and a reply to it sends nothing
further to Forge; a disqualifying ask releases it immediately; two reveals
back to back both get shown. **Mutation-tested**: reverting the three release
call sites back to doing nothing (the original bug) fails all 3 new tests;
restored, all 73 of `match.test.ts` pass. Re-verified against the real jar
after the fix (same 2 Thoughtseize cases, unaffected — the fold still
completes in well under the 250ms window).

## What G needs for the browser side (also in `/tmp/claude-1000/w35-seams/s.md`)

Nothing new to RENDER: the merged ask is `chooseSingleEntityForEffect`,
which `apps/ui/src/play/prompts/ChoicePrompts.tsx`'s `ChooseSingleEntityPrompt`
+ `DelayedRevealNote` already draws — the exact "valid at top, rest greyed"
treatment wave 24 §D.2 built for a library search. The two facts worth
checking on that side:

- `ask.delayedReveal.cards` is the WHOLE revealed hand (all three cards here);
  `ask.optionList` is the narrower, truly choosable subset (two of them) —
  greyed-vs-clickable is exactly "is this ref in `optionList`", nothing new.
- `ask.delayedReveal.zones` is `['Hand']` and `owner` is the OTHER seat (the
  discarder) — this was previously only ever a LIBRARY reveal; worth a quick
  look that a HAND-zone `DelayedRevealNote` reads sensibly (e.g., it should
  not claim these cards are about to be put anywhere, the way a search's
  phrasing might).

## Mutation counts

`apps/server/src/play/scenario-thoughtseize.jvm.test.ts`, both cases, against
the real jar:

- **Reverted** (the fold/drop code in `match.ts` replaced with the original,
  unmerged ask-forwarding): both cases fail — the "ONE ask" case because
  THREE asks reach the wire (two to the caster, one to the discarder) instead
  of one to the caster and none to the discarder; the "land is never legal"
  case is unaffected by the revert (it tests Forge's own validation, not the
  fold) and continues to pass either way, so it is UNIT-TESTED ONLY as a
  fold-mutation guard — it guards the key-mapping logic in
  `openMergedChoice`/the merge-reply path specifically.
- **Restored**: both pass.

(Filled in from the actual run: see `/tmp/claude-1000/w35-s/thoughtseize-folded-run.txt` for the full frame dump.)

## Files

- `apps/server/src/play/match.ts` — the fold and the drop (`onFrame`,
  `openAsk`, `openMergedChoice`, `noteDiscardChoice`/`noteJustDiscarded`,
  `SeatState.pendingReveal`/`mergedChoice`, `Match.justDiscarded`).
- `apps/server/src/play/scenarios/thoughtseize.state` (new)
- `apps/server/src/play/scenario-thoughtseize.jvm.test.ts` (new)
