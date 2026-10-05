# Wave 44 §A — cards move smoothly; selected looks selected

CSS-only lane. Files touched: `apps/ui/src/play/card.css`, new `e2e/motion.spec.ts`, this file.

## W13 — tapping, untapping, an attacker turning: shipped

> *"i really like the smooth animation of cards coming back to the hand on failure. can we
> smoothen that out for all the other things in the game like tapping lands?"*

The cast-lift float-back (`apps/ui/src/play/live/gestures/gestures.css`'s `[data-cast-lift='returning']`)
transitions `left`/`top` over `300ms cubic-bezier(0.3, 0.7, 0.3, 1)`. `card.css` now matches that
feel for the turned state (`data-tapped`/`data-attacking`, both sharing one `:is()` rule) and adds
a matching entrance for a card arriving on the battlefield.

### What animates and what snaps, and why

The turned state changes two things today: `.board-card__face`'s `aspect-ratio` flips from
`488/680` to `680/488` (the box goes from portrait to landscape), and `.card` switches from normal
flow to `position: absolute` with a `rotate(90deg)` transform. The first two are **layout
properties** — `aspect-ratio` changes the box `table-fit` measures rows from, and the
`position`/`width` switch is what reflows it. Animating either would mean `table-fit`'s own frame
sampler is reading a box mid-resize, which the wave brief rules out explicitly.

So only `transform` is in the new `transition` list:

```css
.board-card .card {
  transition: transform 300ms cubic-bezier(0.3, 0.7, 0.3, 1);
}
```

`aspect-ratio` and `position`/`width` still snap instantly, exactly as before this wave — the box a
tapped card turns inside of is already its final size the instant the attribute flips. Only the
rotation itself sweeps over the 300ms, so the card settles into place as it spins rather than
growing or shrinking mid-turn. It is not one continuous morph from the old box to the new one, but
it is transform-only, and it is visibly smooth — screenshots below.

"Attackers turning" needed no separate rule: `data-attacking` already shares the same `:is()`
selector as `data-tapped`, so the one transition rule covers tap, untap, and a declared attacker
turning, in both directions (gaining or losing either attribute).

### Arrival on the battlefield

```css
@keyframes board-card-arrive {
  from { opacity: 0; transform: scale(0.92); }
}

[data-zone='battlefield'] .board-card__face {
  animation: board-card-arrive 300ms cubic-bezier(0.3, 0.7, 0.3, 1);
}
```

Scoped to `[data-zone='battlefield']` — the attribute `Board.tsx`'s `ZoneShell` already writes on
both battlefield layouts (the type-separated tiers and the single-board rows) — so a hand's own
cards (dealt, drawn, returned) never play it. It fires once, on first paint of a given `<li
key={id}>`: React reuses the same DOM node for every later update to a card already on the board
(tapping, a counter, damage), so the animation does not replay on those. A page refresh mid-game
mounts the whole board fresh and plays it for everything already in play — a known, harmless side
effect of there being no other DOM signal for "this one just mounted"; `motion.spec.ts` confirms
the rule's scope (battlefield yes, hand no) rather than trying to time a live mount, which would be
timing-fragile for no extra proof.

### Leaving the battlefield: not possible in CSS alone

`Board.tsx` removes a dead or left-the-board card's `<li>` the instant Forge says it is gone. There
is no interval in which the leaving card's node and its "about to vanish" state both exist in the
DOM for a CSS transition or animation to run across — by the time any style could apply, the
element isn't there to apply it to. An exit animation needs `Board.tsx` to keep the card mounted
for one more frame (a `.tsx` change, a different lane's row this wave). Said plainly rather than
faked with a trick that wouldn't actually catch a real departure.

Both `prefers-reduced-motion: reduce` guards (one per new rule) turn the transition/animation off
entirely, matching the existing `[data-cast-lift='returning']` pattern in `gestures.css`.

### Real-Forge proof

`e2e/motion.spec.ts`, one test, against `land-only-pass.state` (already on disk — three untapped
Mountains + Raging Goblin in hand, seat 0's own uncontested Main Phase 1; not a new scenario file).
Clicks a Mountain's own mana ability (same mechanism as wave 35's R15 test) and reads real computed
style off the real DOM:

- before the turn: `transitionProperty` is exactly `transform` (not `all`, not empty — confirming
  the layout properties are NOT in the transition list), `transitionDuration` is `0.3s`, and
  `transform` is `none`;
- after `data-tapped` lands: the same `transitionProperty`/`transitionDuration`, and `transform` is
  now a rotation matrix, not `none`;
- a hand card's `animationName` is `none` (no arrival animation reaches the hand);
- the tapped battlefield card's `animationName` is `board-card-arrive` (the entrance rule is in
  force for a battlefield card, confirming the zone scoping).

**Run results** (`pnpm --filter @hadoku/ui --filter @hadoku/server build`, then from `e2e/`:
`heavy npx playwright test -c playwright.config.ts motion.spec.ts`, real Forge jar + res, no
`— SKIPPED:` in any run):

| run | result | time |
| --- | --- | --- |
| 1 | 1 passed | 16.3s |
| 2 | 1 passed | 15.3s |
| 3 | 1 passed | 18.1s |
| final-1 (after removing the one-off screenshot lines below) | 1 passed | 12.7s |
| final-2 | 1 passed | 12.4s |
| final-3 | 1 passed | 15.5s |

Six green runs total, three of them against the exact file committed.

**Mutation test**: `card.css` reverted to its pre-wave-44 HEAD (`git checkout -- apps/ui/src/play/card.css`),
UI rebuilt, spec re-run → **1 failed**:

```
Error: only transform is listed — the layout snap stays unanimated
Expected: "transform"
Received: "all"
```

(`transitionProperty`'s CSS-initial value is `all`, with a `0s` duration, when no `transition` is
declared at all — the browser's own default, not a typo; it is what proves the assertion is really
reading my rule and not a coincidence.) `card.css` restored from the saved copy, UI rebuilt, spec
re-run → **1 passed** again. Reverted fails 1/1, restored passes 1/1.

### Frames (viewed with the Read tool, not committed — `/tmp/claude-1000/w44-A/*.png`, scratch only)

Captured with three temporary `page.screenshot()` calls added to a local copy of the spec, run
once, then removed before the file above was finalized (the committed spec has no screenshot
calls — unconditional screenshots on every CI run would be pure overhead for a one-time look).

- **`frame-before-tap.png`** (full page): Alice's board before any click. Three Mountains in a row,
  upright, each wearing the accent-blue outline `[data-selectable]` already draws (R15: every
  tap-only-mana land is in Forge's actionable set at ordinary priority). Raging Goblin sits in the
  hand with the same accent outline (it's castable). Bob's side shows his own single Mountain.
  Nothing is mid-motion — this is the resting frame the "before" assertions were read from.
- **`frame-mid-turn.png`** (close-up crop of just the clicked land, ~120ms after the click): the
  card is visibly **mid-rotation** — "Mountain" reads diagonally across the tile, not upright and
  not yet at the full quarter-turn. Direct visual confirmation the rotation sweeps over time rather
  than snapping the instant `data-tapped` lands.
  **This frame is a side effect `before`/`after` do not probe for by themselves — the strongest
  single frame for "it actually animates," not "it merely changes."**
- **`frame-after-tap.png`** / **`frame-after-tap-closeup.png`** (taken right as the `data-tapped`
  poll resolves, so still early in the 300ms sweep): the hover/inspector panel Alice's cursor
  landed on after the click is open over "Mountain", and beneath it the clicked land and its
  neighbours are visibly tilted at a partial angle, with a red mana pip (`R1`) now showing beside
  Alice's name — the tap paid for itself. Same look as the mid-turn frame: captured early in the
  animation, not at its resting end, which is expected since the screenshot was taken the instant
  the attribute changed rather than 300ms later.

## W2 — selected vs. selectable: investigated, NOT shipped, reported rather than guessed

> *"when choosing to muligan something its hard to tell what is selected because everything is
> always green."*

### What the operator is describing, traced to the code

The London mulligan's bottom-pick has no modal of its own — it runs on the ordinary board, through
`InputLondonMulligan`'s `setHighlighted(entities, true/false)` ("my input is tracking this entity",
per `apps/ui/src/play/live/match.ts`'s own header on the method). `boardInteraction()` in that same
file folds the highlighted set into the exact same `selectable` set a merely-offered (not yet
chosen) hand card gets:

```
named = union(weaklySelectable, highlighted, mulliganHand(...), blockTargets(...), declaredAttackers(...))
```

— its own comment: *"the highlight joins the actionable set, which is what lets a seat un-mark
what it marked"*. By design, no separate fact reaches the DOM: both a card still offered and a card
already set aside for the bottom carry the identical `data-selectable` attribute, and `card.css`
draws the identical accent outline on both (lines ≈449–456). That is the literal mechanism behind
"everything is always green" — every hand card during a mulligan wears the same mark, whichever of
the two states it's actually in.

### Why this is not CSS-fixable

`git grep -n "data-selected"` across the whole tree returns nothing — no element anywhere, on
`.board-card`, `.seat`, or `.stack__item` (the three `[data-selectable]` draws on in `card.css`),
ever carries a `data-selected`-shaped attribute. I also checked every other place `card.css` draws
`[data-selectable]` for a second, already-chosen state hiding under a different name: the London
bottom-pick (above), a board-driven multi-select (`chooseEntitiesForEffect`/
`chooseSingleEntityForEffect` reaching the board directly — same code path, same fold), and the
"already-declared attacker" case (which is NOT ambiguous today: a declared attacker gets
`data-attacking` from Forge's own view and visibly turns via the W13 rule above, a real distinct
look already). None of the modal multi-card pickers (`ManipulateCardListPrompt.tsx`,
`ChoicePrompts.tsx`) use `.board-card` at all — they're native checkboxes/radios under
`prompts.css`'s own "the tick is the border" idiom, a different lane's file.

Making "selected" look different from "selectable" for real needs `match.ts`'s `boardInteraction`
to expose the highlighted/already-chosen id set as its own field (today it's merged, unrecoverable,
into `selectable`) and `Board.tsx`'s `CardOnBoard` to write it as a new attribute. Both are `.tsx`
changes to files outside this lane's row (`apps/ui/src/play/card.css`, `e2e/motion.spec.ts`,
`docs/planning/wave44-evidence/*` only). Per the wave brief's own instruction — *"If a change needs
a .tsx (an attribute that is not on the element today), stop and report"* — this is reported rather
than guessed at. I deliberately did not write speculative `[data-selected]` CSS for an attribute
nothing in the shipped app ever sets: it would be unprovable against real Forge, and dead code
until a TSX lane wires it up.

**Recommendation for the tracker/manager**: a follow-up item, one line each in `match.ts` (add a
`highlighted: ReadonlySet<number>` field to `LiveClickables`, parallel to `selectable`) and
`Board.tsx` (`data-selected={highlighted?.has(entry.id) || undefined}` on the existing `.board-card`
`<li>`), would make the CSS above a ten-minute follow-up. I have NOT written that CSS speculatively.

## made dead / deleted

`−0` lines. This wave adds motion and documents a gap; nothing existing was removed. `card.css`:
`+66 −0`. `e2e/motion.spec.ts`: new file, 130 lines.

## `pnpm run check`

Exit 0. **101 files, 3371 passed, 73 skipped** (run both before and after the e2e work, identical
numbers both times — `/tmp/claude-1000/w44-A/check.log`, `check-final.log`).

## Reverted on main (manager, 2026-10-05)

CI run 37256264858 on `1b032aa` failed forge-e2e in exactly one spec, `table-fit.spec.ts:716`:
`alice: every frame fits (first breaches: "battlefield of 1 cards scrolls inside itself", 1280x800,
turn 1)` — five consecutive frames 8–30 ms apart, i.e. an animation in flight. Neither the lane nor
the manager had run `table-fit` before landing; the "table-fit is unaffected" claim above was
reasoned, not run.

Mechanism: the turned state switches `.card` to `position: absolute; top: 50%; left: 50%` in one
frame while `transform` animates from `none` to `translate(-50%, -50%) rotate(90deg)`, so for the
first frames the card's corner sits at the box centre and the card hangs out of the battlefield.
Even a rotation-only animation overflows: a portrait card is taller than the landscape box it
turns into, and at 45° its bounding box is ~1.2× the box width each way. A tap animation in this
layout needs the zone to tolerate (or clip) transient overflow — a `board.css` / layout question
outside this CSS-only lane. `card.css` and `e2e/motion.spec.ts` were reverted to `e5d6dfd`; this
evidence stays for the next wave.
