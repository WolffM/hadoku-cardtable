# R13 — "Secluded Glen's 'you may reveal a Faerie' was decided for me"

Wave 35 §S item 1. The ledger's framing (`docs/planning/playtest-ledger.md`,
R13): the match log showed no auto-answered choice and every choice the
operator actually made took 2.7–112 s, so the reveal never reached the seat as
a question — "either Forge decided it, or the server pressed OK on an input
(`maybeAutoPass`'s one-press rule)."

**Neither.** Both suspected causes were reproduced against, and refuted by, a
real Forge jar (`scenario-glen.jvm.test.ts`, 3 passing cases, scenario file
`scenarios/secluded-glen.state`). The jar used was `89e824c9…` (lane F's
`9729168d` land-tapping build, installed mid-lane; irrelevant here — see "the
jar swap" below).

## The card, and the code path

`forge-gui/res/cardsfolder/s/secluded_glen.txt`:

```
R:Event$ Moved | ValidCard$ Card.Self | Destination$ Battlefield | ReplaceWith$ DBTap | ReplacementResult$ Updated | ...
SVar:DBTap:DB$ Tap | ETB$ True | Defined$ Self | UnlessCost$ Reveal<1/Faerie> | UnlessPayer$ You | ...
```

`AbilityUtils.handleUnlessCost` (`forge-game/.../AbilityUtils.java:1403`) routes
the `UnlessCost` through `Player.getController().payCostToPreventEffect` →
`PlayerControllerHuman.payCostToPreventEffect` (`PlayerControllerHuman.java:2221`)
→ `PlaySpellAbility.payCostDuringAbilityResolve` → for a `CostReveal` part,
`payCostPart` (`PlaySpellAbility.java:440`) → `controller.chooseCardsForCost(list,
sa, cpl, 1, /* isOptional */ true, prompt)` (`PlayerControllerHuman.java:2619`),
which constructs a real `InputSelectCardsFromList` (`min=max=1`, cancel
allowed) — **one of the two input classes `apps/ui/src/play/live/match.ts`'s
own module header already documents as calling `setSelectables`.**

## The run

Scenario: seat 0 holds exactly `Secluded Glen` and `Faerie Seer` in hand, an
uncontested turn-1 Main Phase 1, empty battlefields
(`apps/server/src/play/scenarios/secluded-glen.state`). The test clicks
Secluded Glen (`s.select(0, glen.id)`) — the same `selectCard` act the real
board sends for any land drop — and records every frame sent to seat 0.

```
+6ms  ASK getAbilityToPlay  {abilities:[{id:191,label:"Play land"}]}
+29ms ACTIONABLE cleared
+40ms SELECTABLES [82] min=1 max=1          <- names card 82, the Faerie Seer
+40ms ASK tempShowZones     {...}
+59ms PROMPT "Secluded Glen (81)\n\nSelect 1 Faerie card(s) to reveal (or: enters tapped. )"
+59ms BUTTONS [OK-] [Cancel]
```

Three real-Forge cases, all green:

1. **"Forge DOES ask"** — `setSelectables` names exactly `[faerieSeerId]`,
   `min=1 max=1`; the land has NOT reached the battlefield yet (the game
   thread is genuinely parked on this choice, not auto-resolved); OK is
   disabled and Cancel is enabled.
2. **Selecting the Faerie Seer** → the land enters **untapped**, and the
   Faerie Seer stays in hand (revealed, not spent).
3. **Pressing Cancel** → the land enters **tapped**, Faerie Seer untouched.

So: Forge asks, for real, every time — ruling out "Forge decided it." And the
wire/server carry the choice faithfully in both directions.

## Why `maybeAutoPass` cannot be the cause either (two independent reasons)

`match.ts`'s `maybeAutoPass` (server-side; `apps/server/src/play/match.ts:1224`)
only ever presses `selectButtonOk`, gated through `decideStop`
(`apps/server/src/play/auto.ts:970`):

1. **`!facts.confirmLive` refuses first.** The reveal window's bar is
   `[OK-] [Cancel]` — OK (`enable1`) is `false` until a card is selected.
   `decideStop`'s very first live check (after the open-ask and `mine`
   checks) is `if (!facts.confirmLive) return null;` — so even if everything
   else about this window looked like a stop, the disabled OK button refuses
   it on its own.
2. **The window is not classified `'priority'` anyway.** `readPromptFacts`
   only calls a window `'priority'` when the message starts with `Priority:
   ` (`PRIORITY` regex, anchored at the start). Secluded Glen's reveal prompt
   is `"Secluded Glen (81)\n\nSelect 1 Faerie card(s) to reveal …"` — it never
   matches, so `window` comes out `'other'`, and `decideStop`'s `if
   (facts.window !== 'priority') return null;` refuses regardless of every
   other fact.

Grepped independently: no code in `apps/server/src/play/**` ever sends a
`selectCard`/`selectPlayer` act on a seat's behalf — the only server-initiated
acts anywhere are `selectButtonOk` (`maybeAutoPass`, `maybeAutoPay`) and
`selectButtonCancel` (`maybeCancelUnpayable`). So the server could not have
silently clicked the Faerie Seer for the player either.

## What this leaves unexplained, and why it is not this lane's file to fix

If the operator's lived session really did see this "decided for them" with no
visible choice, the gap is not in `apps/server/src/play/**` or `match.ts` (this
lane's files) — both are proven, by a real-Forge, mutation-grade run, to carry
the question and its answer correctly and unprompted by any shortcut. The
remaining candidate is purely a **rendering/affordance** question: this input
is a plain `setSelectables` selection, not one of the fifteen wire `ask`
methods `apps/ui/src/play/prompts/**` draws a dedicated modal for. A player
who just dropped a land (ordinarily a zero-further-decision action) gets no
modal telling them "a Faerie card in your hand is now a live choice" — only a
highlighted card in their own hand and a free-text `match.prompt` line whose
on-screen treatment is G's/L's to own, not S's. **Recommend the manager route
a follow-up to G or L**: does the free-text prompt for a plain (non-`ask`)
selection get drawn anywhere prominent, or does a selection whose "question"
is Forge prose rather than a dialog risk going unnoticed? This lane's evidence
rules out every cause in its own files; it does not rule out a rendering gap
in files this lane does not own.

## The jar swap mid-lane

The manager reported lane F's jar (`9729168d`, untapped lands with a tap-only
mana ability now in `setWeaklySelectable` at priority) was installed while
this item was in progress. Irrelevant here: this scenario's battlefields are
empty throughout (no lands in play besides the one being cast), so the change
cannot affect it. Re-ran after the swap to confirm — identical frames,
byte-for-byte, both before and after (`sha256 89e824c9…`).

## Files

- `apps/server/src/play/scenarios/secluded-glen.state` (new)
- `apps/server/src/play/scenario-glen.jvm.test.ts` (new) — 3 cases, all
  passing against the real jar; no server-side code changed, because nothing
  in this lane's files was found broken.
