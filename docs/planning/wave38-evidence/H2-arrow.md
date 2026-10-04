# H2 — `arrow.spec.ts` against the Arena cast model

Continues `H-arrow.md`. Spec-only change: `e2e/arrow.spec.ts`. No product file touched.

## H's diagnosis, checked

From the code (`apps/ui/src/play/live/gestures/install.ts`, `cast.ts`):

- A press on an offered card in the viewer's own hand at priority starts a drag with
  `stage: 'lifted'`. `paint()` draws `drawCastLift` and clears the arrow while lifted.
- The first `pointermove` whose target is inside `[data-zone="battlefield"][data-owner="you"]`
  sets `stage: 'settled'`, `stagedAt: at`, `cast: true`, and sends `selectCard(source)` right there.
- From then on the arrow is `drawArrow({ from: drag.stagedAt, … })`: the tail is the settle point.
- `pointercancel` after the settle calls `cancelCastNetwork`, which is `pressButton(match, 'cancel')`.

From a real run (Forge jar env, this lane's first run on `two-mana-pass`): the press plus a sideways
move past the slop gave `data-cast-lift="lifted"` and **zero** `targeter` elements, and the lifted
card's centre was the pointer. That is the old spec's red: it never crossed alice's battlefield, so
no arrow ever existed. H was right on both counts.

Also seen in that run: `two-mana-pass` does not hold a payment window. Goblin Piker was paid and
resolved without stopping (`Stack: 1 to Resolve.` then `Stack: Empty`). So it gives the settled arrow
nothing to snap to, and the spec moved to `auto-target`.

## What the spec keeps

Its intent is that **the drawn arrow is attached to its source and follows the pointer to the
target, snapping to the nearest of the target card's eight edge points, drawn in the overlay's
coordinates, with the head pointing at the target.** All of that is still asserted, at 1 CSS px:

- the overlay is offset from the viewport origin;
- `data-source` is the cast card, `data-target` is `card:<id>`, and `data-snapped` is set;
- the tip is the nearest of the eight edge points to the tail, on exactly one of them, and is
  neither the card centre nor the pointer. The pointer sits in the target's corner furthest
  from that point;
- the head is set back `13·cos(0.42)` along the shaft and points at the target;
- both ends are inside the overlay;
- unsnapped, over the stack zone, the tip is the pointer and the tail has not moved.

## What changed, and why

| Before | Now | Why |
| --- | --- | --- |
| `enterMatch` with random decks, then a 5-minute forwarding loop until alice is offered two cards | `startScenarioMatch(…, 'auto-target')`: Doom Blade and 2 Swamps vs one Memnite | Gives a castable card with a real card target. Forge's own targeting ask offers bob's Memnite, so the snap target is Forge's choice, not ours. |
| One straight drag, hand card to hand card | Press on Doom Blade, move 20 px sideways (still in hand), then one jump to a bare spot of alice's battlefield (the settle), then to Memnite's corner | This is the Arena gesture. One jump makes `stagedAt` exactly the spot we chose. |
| (none) | While lifted: `data-cast-lift="lifted"`, **no** `targeter`, the lifted card's centre is the pointer, stack empty | The first half of the model, which the old spec's red was about. |
| Tail = source card's centre | Tail = the settle point, and more than 10 px from where the card was picked up | `install.ts` pins the tail at `stagedAt`. In a real match the card's own element is gone after the settle (logged: `doom blade's own element after the settle: null`), so there is no card box to measure against. |
| Source and target "far apart" = centres > 20 px | Tail to target centre > 20 px | Same check, against the new tail. |
| Settle point: (none) | The bare spot of alice's battlefield furthest from Memnite, picked from a 9×5 grid by `elementFromPoint` | The first attempt used the zone box's corner, and the hit test showed another element covering it. |
| `pointercancel` then "src is still offered: nothing touched the game" | `pointercancel`, then: arrow gone, Doom Blade back in alice's hand **and** offered again, stack 0, the targeting text gone, no Swamp tapped, Memnite still there | The cast is Forge's from the settle, so the cancel is Forge's own Cancel. `InputSelectTargets` enables Cancel because Doom Blade's target is not `Mandatory` (`TargetSelection.isMandatory`, `InputSelectTargets.showMessage`). The spec now asserts what that Cancel does. |
| `TITLE` ternary | `makeTitled(forge)` from `play/board.ts` | One shared copy. |

Made dead / deleted: the forwarding loop, `bothFacesOnTable`, the `openFriend` / `enterMatch` /
`offered` / `promptMethod` / `answerConfirm` / `confirmYes` imports, and the old header's history
notes. `git diff --shortstat HEAD -- e2e/arrow.spec.ts`: 1 file changed, 206 insertions(+), 309 deletions(-).

## Not a product red, but worth a look

The operator's words in `cast.ts` say *"the card settles there … then just the arrow follows the
mouse"*. The arrow does what those words say. The **card** does not stay visible at the settle in a
real match: after `selectCard` Forge's view update takes it out of the hand, and nothing re-draws it
while the target is chosen. w35's own spec recorded the same thing (`e2e/w35.spec.ts`, the R7 test's
comment). This spec neither asserts the card is there nor pins it as absent. It only logs the fact,
so a later fix that keeps the card visible will not turn this red.

## Runs

Jar env, `w38run` lock, built dist, `npx playwright test -c playwright.config.ts arrow.spec.ts`.
Results are in the lane report. Each green run has `— SKIPPED:` 0 and `1 passed`.
