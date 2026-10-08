# §I — the inspector covers neither the pop-up nor the card (AE2)

The operator, 2026-10-08: *"when hovering a card, try to make sure the expanded
version doesn't cover the thing that is being hovered … theres an active
decision on my screen, and if i hover serum visions it blocks the card itself.
for hovering cards on the board let's try to be a bit smarter about where to
place the expanded img."*

Proof below.

## What changed

`apps/ui/src/play/inspect/index.ts`'s `placeBesideModal(hover, modal, area)`
already took the hovered card's rect as `hover`, but only used it to level the
panel's top edge — it never checked whether the panel it chose actually
COVERED that card. It now tries four candidates, in this order, and returns
the first with ZERO overlap against both `modal` and `hover` at the preferred
width (`PREF_W`, 264px):

1. **left of the pop-up** — a `GAP` clear of it, top level with the card;
2. **right of the pop-up** — the same;
3. **above the card** — a `GAP` clear of it, left edge level with it;
4. **below the card** — the same.

If none is clean at the preferred width, each candidate is shrunk (its own
anchor edge held fixed — the edge against the pop-up for 1/2, the edge
against the card for 3/4) to the widest size at which it clears both rects,
and the widest of the four wins. The shrink is a binary search (50
iterations) rather than a closed form, because the four candidates interact
with two independent rects (`modal` and `hover`) in ways that do not reduce
to one room formula the way the old left/right-of-modal-only version did.

A card in the viewer's own hand is unaffected — it still always uses
`placeInspector`, never this function, exactly as before.

## A second, unrelated fix this forced

`doc.querySelector('.live__prompt:not(:has([data-testid="live-pregame-wait"])))`
is the query that decides "is a real decision open, or is the only
`.live__prompt` on screen just the waiting pop-out (which is not a decision)".
Lane D (in this same shared worktree) had already renamed that pop-out's
testid from `live-pregame-wait` to one component, `live-waiting-pop`
(`LiveBoard.tsx`'s new `WaitingPop`, wave 62 §D). Keeping the OLD testid here
— which is what the wave file's §I brief says to do while D is not yet
"landed" — turned out to actively REGRESS `e2e/w36.spec.ts`'s T1 ("the hover
zoom sits against the hovered card"): with D's rename already present as
files in the shared worktree (not yet committed, but very much running),
the stale exclusion no longer matched the waiting pop-out, so a REAL
`WaitingPop` on screen made this code treat it as a decision window and
place the panel beside it instead of in the board overlay — exactly the kind
of regression the brief's own "a lane that stops drawing an attribute greps
`e2e/` for it" rule is about, just arriving from the other direction (a lane
renaming an attribute).

Decision taken: the exclusion now reads the testid D's code ACTUALLY uses in
this worktree (`live-waiting-pop`), not the one the wave file says to keep
until D lands. Verified both ways (see below) — keeping the old testid passes
my own new unit tests (which construct their own fixture DOM and are immune
to this) but fails `w36.spec.ts` T1 against the REAL app; the new testid
passes everything, including T1. **The manager should land D before or
together with I** (the wave file already says D lands first) — no rebase is
needed on top of D's current code, since I already matches it.

## Unit tests — mutation counts

`place.test.ts` gained a `describe('placeBesideModal avoids the hovered card
too (AE2)', …)` block, three cases:

- a card sitting under the pop-up's left edge (where the panel would
  otherwise go) pushes the panel RIGHT instead;
- a card at the far right of the board still lets the panel open to the
  pop-up's left, undisturbed;
- a tall, full-width pop-up with the card below it shrinks the panel to
  stand ABOVE the card (the one candidate with real room — below is
  squeezed to nothing against the area's own floor).

`index.test.ts` gained one integration-level case (`beside a decision
window, the panel also clears the hovered card itself (AE2)`) that stubs
`getBoundingClientRect` on the hovered card, the pop-up, and the host
container with real (non-zero) numbers — jsdom zeroes every box by default,
so without the stub this file's existing tests cannot see the geometry fix
at all — and asserts the panel's exact inline `left`/`top`/`width`.
It also gained a second exclusion case (`the waiting pop-up is not a decision
window for a BOARD card either`), because the existing hand-card case never
actually exercised the exclusion string (`inHand` short-circuits before the
`querySelector` runs for a hand card).

Reverted to the pre-fix `placeBesideModal` (the old left/right-of-modal-only
room logic, hover ignored for overlap) via a scripted patch-and-restore,
same tree otherwise:

| | place.test.ts | index.test.ts | total |
| --- | --- | --- | --- |
| fix in place | 19/19 pass | 27/27 pass | 46/46 |
| fix reverted | 17/19 pass, **2 fail** | 26/27 pass, **1 fail** | 42/45, **3 fail** |

The 3 failures on revert are exactly the 3 new AE2 cases above; nothing else
moved. Restored and re-confirmed green (46/46 → 47/47 once the exclusion
test was added) before finishing.

```
pnpm exec vitest run apps/ui/src/play/inspect/   # from repo root
```

## e2e — real Forge, real pixels

`e2e/w33.spec.ts`'s test 9 ("Ponder's full oracle text is readable by
hovering the placed card, while it sits on the stack") is the decision case
the wave file names at :510–533 (shifted a few lines by this change). Ponder's
own post-resolution ask is documented in that same test as unreliable against
real Forge (measured 5/5 failing the same way in an earlier wave), so a real
decision pop-up is not something this scenario can depend on opening — the
test instead synthesizes one: a `<div class="live__prompt" data-testid="w62-
decision-fixture">`, the real class `inspect/index.ts` keys off, sized and
positioned like the real prompt column (`docs/planning/
board-layout-2026-09-27.md`: 59.4% across, 24% down, 24.1% × 48% — a
realistic box, not an arbitrary one), appended into bob's own page via
`page.evaluate` before the existing hover. After the existing oracle-text
assertion, two new ones:

- the inspector's rect and the placed card's (Ponder's) rect do not intersect;
- the inspector's rect and the pop-up's rect do not intersect.

Measured real boxes from one run (pixels, via Playwright `boundingBox()`):

```
bigBox:   {x: 788.1, y: 232.0, w: 131.9, h: 183.7}
itemBox:  {x: 468.0, y: 232.0, w: 104.0, h: 144.9}
modalBox: {x: 760.3, y: 172.8, w: 308.5, h: 345.6}
```

Disjoint from both, confirmed.

Ran under the shared w62 e2e lock, with the Forge jar/res env, against the
prebuilt dist (built fresh first in the same locked command):

```
flock /tmp/claude-1000/w62-e2e.lock -c '
  pnpm --filter @hadoku/ui build
  cd e2e && npx playwright test -c playwright.config.ts w33.spec.ts w36.spec.ts
'
```

Result: **15/15 passed** — all 9 of `w33.spec.ts` (including the Q7/Q10/Q12/
Q14/Q17/Q18/Q1b/Ponder/Doom-Blade cases this file already had) and all 6 of
`w36.spec.ts` (T4 ×2, T7, T10, T8, and T1 — the exact test that regressed
before the testid decision above was taken).

`e2e/w31.spec.ts` was also run (separately, since its own log-driven wait
makes it the slowest file in this suite): **7/7 passed**, including the one
test that opens the inspector from a log name (test 4, "combat is one rail
step outside combat and six inside … a log name opens the one inspector").

## Files changed

- `apps/ui/src/play/inspect/index.ts` — `placeBesideModal` (four-candidate,
  hover-aware), the exclusion testid, doc comments.
- `apps/ui/src/play/inspect/index.test.ts` — one new integration case (real
  stubbed rects), one new exclusion case (board card, not hand), the existing
  waiting-pop-up fixture's markup updated to D's actual `WaitingPop` shape.
- `apps/ui/src/play/inspect/place.test.ts` — three new `placeBesideModal`
  cases; one existing case's width assertion loosened from `toBe` to
  `toBeCloseTo(…, 6)` (the shrink path is now an iterative search, not a
  closed form, so its output is a hair off exact at double precision).
- `e2e/w33.spec.ts` — the Ponder test (test 9, "the decision case"), inside
  the owned line range: a synthesized decision pop-up and two new
  non-intersection assertions, nothing else touched.
- `docs/planning/wave62-evidence/I/inspector.md` — this file.

`inspect.css` was read and needed no change — nothing about the panel's
look changes, only where it is placed, and placement stays entirely inline
style set by `index.ts`.

## Decisions made because the brief was ambiguous

1. **The exclusion testid** (`live-waiting-pop` vs the brief's literal
   "keep the old testid") — see above. Chose the one that matches the
   ACTUAL code in this shared worktree, because the alternative is a
   demonstrated regression (`w36` T1), not a theoretical one.
2. **"The decision case" at `e2e/w33.spec.ts:510–533`** is the Ponder
   stack-hover test — there is no OTHER test in that file with a real
   decision pop-up open at those lines, and Ponder's own post-resolution ask
   is documented (in that same test) as too unreliable to depend on. Added a
   synthesized pop-up rather than either (a) inventing a new scenario file
   (lane I owns no `.state` files this wave) or (b) skipping the pop-up-vs-
   panel assertion entirely.
3. **Binary search over a closed form** for the shrink phase — a closed-form
   "widest clean width per candidate" would need to handle up to four
   independent constraints (two area edges, `modal`, `hover`) whose
   interaction changes depending on which side is shrinking; a 50-iteration
   bisection is exact to below double precision and was simpler to get
   right. One pre-existing test's width assertion (`toBe(184)`) was loosened
   to `toBeCloseTo(…, 6)` as a result — the claimed behaviour ("the right
   wins, width 184") is unchanged, only the precision of the assertion.
