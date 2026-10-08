# Wave 60 §M — mana symbols in the pop-up; a board-sized lift

## 1. The ability pop-up draws glyphs, not letters (AD6, Z10, Y23)

Already shipped before this wave started: `4595a67` (in `78be9ef`, ui 0.32.60) made
`apps/ui/src/play/prompts/ChoicePrompts.tsx`'s `GetAbilityToPlayPrompt` draw each
ability's label through `RulesText` with `plainRulesText` as the button's `aria-label`,
pinned by `apps/ui/src/play/prompts/choices.test.ts:280` (`the {R} is a mana symbol, not a
letter`). The lane built a second component (`AbilityOffer.tsx`) for the same thing; the
manager deleted it unlanded as a duplicate, and lane B did not mount it. What this lane
ships for AD6 is the spec below, which had been matching options by rendered text.

Glyphs `RulesText` draws for the fixture's tokens (`ManaPip`/`readManaToken`):

| token | `readManaToken(token).mana` | font class drawn | `aria-label` text |
| --- | --- | --- | --- |
| `{1}` | `'1'` | `ms ms-1 ms-cost` | `1` |
| `{R}` | `'r'` | `ms ms-r ms-cost` | `R` |

**e2e**: `e2e/w58-painland.spec.ts`'s `answerChoice` used to pick an option
by `hasText` against the button's own rendered text — which, once the glyph
is a font icon and not a letter, no longer contains `G`/`U`/`R` for `hasText`
to find. It now reads each option's `aria-label` (falling back to
`textContent` for any prompt without one) and matches `prefer` against that.
Run locally against the real jar (`CARDTABLE_FORGE_JAR` pinned
`702b207eda874df8bae60435284f40836ed8799c.jar`, under the shared
`w60-e2e.lock`): **1 passed** (12.2s) — Yavimaya Coast taps for a colour,
untaps, mana and life both round-trip.

## 2. A lifted card is the battlefield's own size (AD2)

`apps/ui/src/play/live/gestures/cast.ts`'s `drawCastLift`, for mode
`'lifted'` only, now reads the viewer's own battlefield zone's CURRENT
`--card-w` (`getComputedStyle` on `[data-zone="battlefield"][data-owner="you"]`)
and pins it onto the lifted card element itself
(`el.style.setProperty('--card-w', …)`), rather than letting the card keep
whatever `--card-w` its hand row cascaded to it (which, per `board.css`'s own
T6 comment, has no `--card-max` ceiling and can be bigger). `clearCastLift`
removes the override when the gesture ends. `gestures.css` adds
`.board-card[data-cast-lift='lifted'] { width: var(--card-w); }` at higher
specificity than `.board-card`'s own rule (`card.css`), so the override wins
regardless of stylesheet order.

**The size rule:** the lifted card's width is the battlefield's `--card-w`
from the very first frame of the lift — not the hand's, and not something
that shrinks into place later.

**Mutation pin** (`gestures.test.ts`, "a lifted card is sized like the
battlefield's own card, not the hand's"): with the battlefield zone's
`--card-w` stubbed to `64px` and the card's own (simulated hand) `--card-w`
stubbed to `112px`, lifting the card asserts `--card-w` becomes `64px`.
Reverting the `cast.ts` change: fails —
`expected '112px' to be '64px'`. Restored, passes.

## Test commands run

```
pnpm exec vitest run apps/ui/src/play/live/gestures/gestures.test.ts
#      Tests  117 passed (117)   (manager, isolated worktree: HEAD + this lane's four files)
# cast.ts reverted to HEAD: Tests 1 failed | 116 passed (117); restored: 117 passed

pnpm exec tsc -p apps/ui/tsconfig.json --noEmit    # exit 0
pnpm exec tsc -p e2e/tsconfig.json --noEmit        # exit 0
```

e2e, local, under `/tmp/claude-1000/w60-e2e.lock`, real jar:

```
pnpm exec playwright test w58-painland.spec.ts     # 1 passed (14.8s)
pnpm exec playwright test drag.spec.ts played-card.spec.ts   # 11 passed (1.9m)
```

Neither `drag.spec.ts` nor `played-card.spec.ts` was edited — both are run
here only because `drawCastLift`'s `'lifted'` sizing is on the path every
hand-card cast takes, and the done-when line in the wave file names them.
