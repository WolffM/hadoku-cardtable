# Wave 24 lane D — prompts that do not nag: what was measured

Lane D owns `apps/ui/src/play/prompts/**`. It owns **what a prompt looks like
when it is shown**; lane E owns **whether it is shown at all**. Two of §D's five
items turned out to belong on the other side of that line, and this document is
the evidence for saying so rather than the assertion.

Everything below is either a run whose command is given, or a Forge file:line in
the read-only submodule at `/home/hadoku/repos/hadoku-cardtable/forge/`.

---

## §D.1 — "a cost that is the only way is not a question" (Scalding Tarn's *pay 1 life?*)

### The brief asked which ask carries it. The answer is: **none.**

On our bridge this never becomes a blocking ask, so nothing in
`apps/ui/src/play/prompts/**` ever renders it. The chain, every hop read:

| # | where | what happens |
| - | --- | --- |
| 1 | `forge-gui/src/main/java/forge/player/HumanCostDecision.java:717-741` | `visit(CostPayLife)`. **If the cost is `mandatory` it returns the payment with no question at all** (`:719-721`). Otherwise it builds `lblPayNLifeConfirm` ("Pay {0} life?") and calls `confirmAction`. |
| 2 | `HumanCostDecision.java:1515-1535` | `confirmAction` → `isLibgdxPort()` ? `getGui().confirm(...)` : `controller.confirmPayment(costPart, message, ability)`. |
| 3 | `forge-gui-desktop/src/main/java/forge/GuiDesktop.java:78-80` | `isLibgdxPort()` returns **false** — and our `BridgeGui extends GuiDesktop` (`apps/server/src/play/bridge/PlayBridge.java:1284`), with no override (`grep -n isLibgdxPort PlayBridge.java` → no match). |
| 4 | `forge-gui/src/main/java/forge/player/PlayerControllerHuman.java:2061-2081` | `confirmPayment`, non-libgdx branch → `InputConfirm.confirm(this, sa, question)`. |
| 5 | `forge-gui/src/main/java/forge/gamemodes/match/input/InputConfirm.java:67-87, 105-121` | an **Input**, not a dialog: `getGui().updateButtons(owner, yes, no, true, true, defaultYes)` + `showMessage(message, card)`. |

So it reaches the browser as `showPromptMessage` + `updateButtons` — the
non-blocking pair `apps/server/src/play/auto.ts` already reads (its
`onlyAnswer` / `autoPassReason` both require `prompt.method === 'showPromptMessage'`
and `buttons.method === 'updateButtons'`) — and the seat answers with
`selectButtonOk` / `selectButtonCancel`.
**It is the bottom-of-screen prompt line with two buttons, not a prompt
component.** The same is true of #16, Evolving Wilds' sacrifice:
`HumanCostDecision.java:1291-1301`, `visit(CostSacrifice)` with
`payCostFromSource()`, is `(mandatory || confirmAction(...))` — the identical
mechanism with a different sentence.

### Is declining a real choice Forge offers? **Yes, and it is a CANCEL.**

`visit(CostPayLife)` returns `null` on a "no" (`HumanCostDecision.java:733-740`),
which fails the `CostPayment` and rolls the whole activation back. So Forge does
offer a decline — but the decline is *"never mind, don't activate it"*, not
*"activate it without paying"*. Forge itself says which costs are not a question:
`Cost.isMandatory()` is set only by the literal token `Mandatory` in a card
script's cost string (`forge-game/src/main/java/forge/game/cost/Cost.java:259-261`,
read by `HumanCostDecision.java:36`), and Scalding Tarn's
`T PayLife<1> Sac<1/CARDNAME>` does not carry it — which is exactly why Forge
asks, and exactly why the question is not expressible from the sentence.

### Therefore: **a finding for lane E, not a change here.**

The decision belongs on the server, before any prompt exists, and the structured
fact it needs is *"this seat is being asked to confirm a cost on an activation it
initiated"* — which the current wire does **not** carry: the only thing that
distinguishes it from any other two-button Input is the localized string. That is
the reason `auto.ts` had to regex, and it is a fact lane E's yield model has to
supply from the Forge side (`YieldController`), not something a component can
recover.

Lane D's contribution is the guard, tested: `rules.ts`' `autoAnswer` never
answers a `confirm`, one-button or two (`rules.test.ts`, mutation
`confirm-auto-answered`).

---

## §D.2 — "a library search shows what is choosable first"

### Where Forge tells us which are choosable: **two lists in one ask.**

`ChangeZoneEffect`'s library search — the call Scalding Tarn's fetch and Rampant
Growth's ramp both make — builds two collections and sends both:

- **`fetchList`** → the ask's `optionList`, already filtered by the ability's
  `ChangeType` (`forge-game/.../ability/effects/ChangeZoneEffect.java:1096-1099`).
  These and only these may be answered.
- **`toReveal`** → the ask's `delayedReveal.cards`: the whole library
  (`:1047-1052`), captioned `"<source> - Looking at cards in "` (`:1062`,
  `lblLookingCardIn`).

`PlayerControllerHuman.chooseSingleEntityForEffect` (`:579-619`) puts both on
the wire and `tempShow`s both first (`:596-599`), which is what makes the names
visible to the seat at all.

### Measured, against the real jar

`apps/ui/src/play/prompts/search.jvm.test.ts`, one real Forge match, both seats
casting Rampant Growth. Dump at `CARDTABLE_PLAY_DUMP`:

```
method           chooseSingleEntityForEffect
title            "Select a card from your library"   isOptional true
optionList       20   (the Forests)
delayedReveal    zones ["Library"], owner player 0,
                 messagePrefix "Rampant Growth - Looking at cards in ",
                 cards 32   (the whole remaining library)
searchRows       32 rows — 20 choosable first, then 12 not offered
tiles drawn      32, art on 32/32, "card #id" on 0/32
```

So the reveal is a strict superset of the options, and "valid targets at the top,
the rest present but visibly not selectable" is expressible with no rule of ours
at all: `choosable` is membership in `optionList`, nothing more.

### What changed

`rules.ts` gains `searchRows(ask)` — the only place the order and the flag are
decided — and `ChooseSingleEntityPrompt` / `ChooseEntitiesPrompt` draw **one**
grid from it. Before this, `DelayedRevealNote` drew the revealed cards as a
second grid above the options, so a fetchland showed the whole library once
un-pickable and then its Islands and Mountains again below. `DelayedRevealNote`
is now the caption only.

A not-offered row is dimmed, has no tick at all (so no border can light up) and
carries the word `not offered` — three signals, because colour may not be the
only one. It is never `display: none`: the seat sees what Forge showed it.

---

## §D.3 — "those cards have art"

### The claim as written did not reproduce

In the real search above, **32 of 32 tiles carried art and a real name**; none
drew as `card #id`. The reveal path has gone through the board's own art chain
since wave 20 (`PromptShell.promptCardTile` → `KNOWN_ART_IDS` → `CardTile` →
`cardImageUrl`), so "renders card names with no art" is not what the current
build does for a library search. Said plainly rather than quietly fixed.

### But there was a real, related defect, and it is measured

`promptCardTile` resolved art as `scryfallIdFor(index, name, '')` — the bare-name
row only — while `adapter.ts` resolves a board card as
`scryfallIdFor(artIds, name, card.setCode)`, the exact printing first (in
`toBoardCard`; cited by symbol because lane A is editing that file this wave). Over the committed table plus the cube pool, **1396 `Name|SET`
keys name a different printing from their own bare-name row** (Arid Mesa|ZEN,
Baneslayer Angel|M11, Birds of Paradise|M12 … — the operator's own 2011 standard
cards are in that list). For every one of those, a prompt tile drew one printing
and the board drew another for the same physical card.

`PromptCardFacts` now carries Forge's `SetCode` for the face on show
(`lookup.ts`, read from the same `CardStateView` property `adapter.ts` reads),
`promptCardTile` takes it, and `promptTileFor(lookup, id, label?)` is the one
function every card-drawing prompt goes through — `ChoicePrompts`, `OrderPrompt`
and `ManipulateCardListPrompt`. A prompt and the board now ask the art-id table
the same question.

Pinned by `choices.test.ts` → *"uses Name|SET, not the bare name, for a card
whose printings differ"*, which derives its case from the table so it cannot rot
into a tautology, and mutation-tested (`art-key-drops-setcode`).

---

## §D.4 — "the zoom preview belongs above the search view"

### Root cause, read, not guessed — and **it cannot be fixed from lane D's files**

The inspector appends its panel into lane A's board overlay, and only there:

```
apps/ui/src/play/inspect/index.ts   mountInspector: const overlay = () => root.querySelector('[data-board-overlay]')
apps/ui/src/play/inspect/index.ts   show():          overlayEl.appendChild(el)
```

Prompt-grid tiles are found through the DOCUMENT — deliberate, and the module
header says so: *"prompt grids render outside the board"* — but the panel they
open still lands inside `.board`. And:

```
apps/ui/src/play/board.css          .board__overlay { position: absolute; inset: 0; z-index: 2; pointer-events: none }
apps/ui/src/play/live/live.css      .live__prompt   { position: absolute; z-index: 3; … }
```

(Cited by SELECTOR, not by line: lanes A and C are rewriting both files in this
same wave. Re-read at the end of lane D's work, with lane C's new
`.live__prompt` host in place, both values are unchanged — and lane C's own
`.live__phases` comment reasons about exactly this ordering, keeping the rail at
`z-index: 1` *"UNDER lane A's overlay root at z 2 — so the inspector's enlarged
card still comes out on top of the rail, which is the operator's #4 in the other
direction."* The prompt sheet is the one layer that is still above it.)

`.live__prompt` is a stacking context at `z-index: 3`; the board's overlay
paints at `z-index: 2` in the same parent (`.live`). So the enlarged card is
painted **under** the prompt sheet, always, and nothing inside `.prompt` can
escape `.live__prompt`'s stacking context — a `z-index` in `prompts.css` cannot
reach across it in either direction.

The fix is one line, in a file lane D does not own, and there are three candidates:

1. `inspect/index.ts` (owned by nobody this wave) — mount the panel in a layer
   above the prompt. The honest fix: the preview is not board furniture, it is an
   overlay over everything, and it is the only change that also fixes the next
   surface that lands over the board;
2. `board.css` — raise `.board__overlay` above `.live__prompt` (lane A; it would
   also put lane B's targeting arrow over the sheet, which may well be wanted);
3. `live.css` — lower `.live__prompt` below the overlay (lane C; it would put the
   sheet under the board's own overlay content, including the arrow).

**Not done, on purpose.** §D's brief says not to fix it by raising a `z-index` in
a file lane D does not own, and there is no other lever. Handed over with the
measurement.

---

## §D.5 — "a reveal shows both players at once and needs no OK"

### What a reveal actually is

```
PlayerControllerHuman.java:933-972   reveal(cards, zone, owner, message, addSuffix)
  :934                                 yieldController.maybeInterruptOnReveal()   ← lane E's hook, already there
  :947                                 tempShowCards(cards)                        ← why the seat can see the names
  :967                                 getGui().reveal(fm, collection)
  :970                                 getGui().updateRevealedCards(collection)
AbstractGuiGame.java:785-788         reveal(message, items) IS getChoices(message, -1, -1, items)
```

So a reveal is a `getChoices` ask with `min === max === -1`, which
`rules.ts`' `choiceBounds` already turns into the display-only list the
`getChoices-reveal.json` fixture carries. It has exactly one legal reply — the
empty list.

### "Both players at once" needs nothing from us, and must stay that way

`reveal` is called on **each player's own controller** by the effect, so a seat
is asked only when Forge revealed to that seat. The UI never decides to share,
and it must not: the projector redacts every card in a hidden zone
(`apps/server/src/play/visibility.ts` — *"`hidden` — a card in someone else's
hand, **any library**, a face-down exile pile"*), and a reveal is visible to a
seat only because `tempShowCards` → `PlayerMayLook` upgraded it for that seat.
The two seats are asked one after the other, because each `getChoices` blocks —
which is invisible the moment neither has to press anything.

### "Needs no OK" is blocked on a surface that outlives the ask — **finding, not done**

Auto-answering it would **delete the information**, which is the one thing a
shortcut may never do:

- `answerAsk` takes the ask off the open list the instant the reply is sent
  (`apps/ui/src/play/live/match.ts`, `answerAsk` → `closeAsk` then `send`);
- `LiveBoard` draws nothing at all for an ask that answers itself
  (`apps/ui/src/play/live/LiveBoard.tsx`, the `const ask = auto === null ? pending : null`
  line and its comment: *"Nothing renders for an ask that answers itself — not
  even for a frame"*).

So the reveal would flash and vanish. `apps/server/src/play/auto.ts` refuses the
same ask for the same reason, and lane D keeps that refusal rather than
contradicting it.

**What would unblock it, and it is already on the wire:**
`TrackableProperty.RevealedCardsCollection`
(`forge-game/src/main/java/forge/trackable/TrackableProperty.java:48`) is filled
by `updateRevealedCards` (`AbstractGuiGame.java:252-260`) on every reveal, and
`apps/ui/src/play/adapter.ts` does not read it. Draw that — a standing "recently
revealed" strip, lane A for the adapter and lane C for the surface — and the ask
can then be auto-answered with nothing lost. The "unless the seat can respond"
half is `setWeaklySelectable`, which is already the server's signal
(`auto.ts`'s `autoPassReason`), so that half is lane E's.

Lane D's contribution is the guard that stops this being added the wrong way
round: `autoAnswer` never answers a reveal, three ways (a `-1/-1` bound, a `0/0`
bound, and a one-card reveal), mutation-tested as `reveal-auto-answered`.

---

## Runs

| claim | command | result |
| --- | --- | --- |
| the lane's suites are green | `npx vitest run apps/ui/src/play/prompts` | exit 0 — Test Files 9 passed \| 1 skipped (10); Tests 168 passed \| 1 skipped (169) |
| the UI package typechecks | `npx tsc --noEmit -p apps/ui/tsconfig.json` | exit 0 |
| the lane lints | `npx eslint apps/ui/src/play/prompts` | exit 0 |
| Forge really sends the two lists | `CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=/tmp/claude-1000/w24-d-play CARDTABLE_PLAY_DUMP=… npx vitest run apps/ui/src/play/prompts/search.jvm.test.ts` | exit 0 — 1 passed, ~12 s per run, two runs (once mid-lane, once against the final code): optionList 20, revealed 32, art 32/32, unnamed 0/32 both times |

Not run, and it should be: `apps/ui/src/play/prompts/../live/prompts.jvm.test.ts`
drives a `chooseSingleEntityForEffect` of its own (Impetuous Lootmonger's heist)
through these components, and it costs two more real matches. Nothing outside
`apps/ui/src/play/prompts/**` references the reveal's DOM
(`grep -rn 'prompt-reveal\|prompt__reveal\|cards--reveal\|data-choosable' apps e2e`
outside this directory → no matches) and its driver picks
`input[data-testid="prompt-choice"]`, which only offered rows now carry, so the
change is compatible by construction — but "by construction" is not "measured".
The command is
`CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=/tmp/claude-1000/w24-d-play npx vitest run apps/ui/src/play/live/prompts.jvm.test.ts`.

Every run was prefixed with
`PATH="/home/hadoku/.local/share/fnm/node-versions/v24.18.0/installation/bin:$PATH"`,
exit codes read directly (`cmd > file 2>&1; echo $?`), and anything that builds
or runs Forge was serialized under `flock -x /tmp/claude-1000/w24.lock`.

The seven mutation runs — each one file, one edit, restored and `cmp`-verified —
are recorded in `apps/ui/src/play/prompts/evidence/mutations.txt`.
