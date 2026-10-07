# §N — floating numbers (AB12)

## Colours (theme tokens, computed)

`numbers.css`/`numbers.ts` draw exactly four tokens, never an invented value:

| use | token | `styles.css` value (default theme) |
| --- | --- | --- |
| a life loss, or a hit's floating number, or the damage pill | `--danger` / `--danger-ink` | `--danger: var(--color-danger, #d4715f)`; `--danger-ink: color-mix(in srgb, var(--danger) 50%, var(--ink))` |
| a life gain | `--success-ink` | `color-mix(in srgb, var(--success) 30%, var(--ink))`, `--success: var(--color-success, #6da879)` |
| the struck-through old life value | `--ink-faint` | `var(--color-text-secondary, var(--color-text, #6a7280))` |
| every number's own outline, and the pill's background | `--bg` | `var(--color-bg, #14161a)` |

A damage **decrease** (a cleanup wipe) is not drawn at all — no number, no colour of its own. `damageColour` (a `delta > 0 ? danger : success` function) was removed for exactly this reason: once a decrease stopped spawning a number, its `success` branch was dead code. `--success`/`--success-ink` exist in this module only for a life gain now.

## Timings (as implemented, `numbers.ts`'s own constants)

| constant | value | Settled rule |
| --- | --- | --- |
| `RISE_PX` | 28 | "rises 28 px" |
| `RISE_MS` | 700 | "over 700 ms" |
| `FADE_MS` | 280 | "opacity 1 → 0 over the last 280 ms" (the rise keyframe holds opacity to 60% of the timeline, then fades the last 40% — `420/700` ≈ 60%, leaving exactly 280 ms of fade) |
| `POP_MS` | 90 | "pops to 1.25× for 90 ms first" — a popped number's total lifetime is `POP_MS + RISE_MS` = 790 ms, because the rise animation is CSS-delayed by `POP_MS` so it starts once the pop finishes |
| `POP_THRESHOLD` | 5 | "a change of 5 or more pops" |
| `STACK_OFFSET_PX` | 12 | "offset 12 px sideways" |
| `STACK_STAGGER_MS` | 80 | "start 80 ms apart" |
| `TICK_STEP_MS` | 150 | "ticks in 150 ms steps" |
| `OLD_VALUE_MS` | 1500 | "keeps the old value struck through for 1.5 s" |
| `DEATH_FADE_START_MS` | 350 (`RISE_MS / 2`) | "the fade to the graveyard starting at the number's halfway point" |
| `DEATH_FADE_MS` | 420 | the drift-and-fade-out duration once a dying number turns toward its owner's graveyard (not fixed by Settled; chosen to read at a similar pace to the rise it replaces) |
| `PILL_OFFSET_PX` | 10 | how far left of the P/T corner's own centre the damage pill sits, beyond half the corner's own (live, measured) width — the gap plus the pill's own roughly-constant half-width. Not a Settled number; the rule is "beside the P/T", this is this module's reading of it |

## The damage pill: damage that stays

`syncPills` (called at the end of every `notify`) keeps one small pill beside `.board-card__pt` for every battlefield creature `view.players[].battlefield[].damage` currently reports above zero — holding just the number, `--danger`/`--danger-ink` ink, `--bg` outline/background, never animated (it is a standing fact, not an event). It is re-anchored off the P/T corner's own LIVE box every call, so it follows the badge wherever `card.css` currently draws it (including the tracker's `ff95769` fix, which moved `.board-card__pt`'s `bottom` to `calc(2px + var(--pile-fan))` — this module reads that box fresh each time and needed no code change for it). It is removed the instant `damage` reads zero (a cleanup wipe) or the card is no longer on any battlefield.

## Proof — claws, `verify/w56-N`

Three green dispatches of `w56-numbers.spec.ts` (one of them also carrying `table-fit.spec.ts`), on `ff95769` (origin/main, after the tracker's P/T-corner fix):

- `37680806586` — `w56-numbers.spec.ts table-fit.spec.ts`, **7/7, 0 skipped** (table-fit's own 5 tests included — the P/T-corner check the tracker fixed is green here).
- `37681654639` — `w56-numbers.spec.ts` alone, 2/2, 0 skipped.
- `37681948122` — `w56-numbers.spec.ts` alone, 2/2, 0 skipped.

Evidence line each run (identical modulo float jitter):
- `{"step":"bolt","onAlice":{"text":"-3","colour":"danger",...},"onBob":{"text":"-3","colour":"danger",...}}`
- `{"step":"blocked-damage","number":{"text":"-1","colour":"danger",...}}`
- `{"step":"pill-present","pill":{"text":"1","box":{...}}}` — the pill beside the Wall of Stone's P/T corner, holding `1`
- `{"step":"pill-after-cleanup","pillAfterCleanup":null}` — gone once the turn's cleanup wipes the damage

**Two other dispatches on this same branch/sha were NOT counted and are not regressions**, both environment, not product:
- `37679372933` (`w56-numbers.spec.ts table-fit.spec.ts`): table-fit's first two tests passed (one in 1.9 min, usually ~30s), then every remaining test failed identically on `TimeoutError: apiRequestContext.post: Timeout 20000ms exceeded` — a generic network timeout across unrelated tests (W6, W15, W19, both of this module's own), with the host already at `load average: 7.14, 7.64, 8.03` at the run's own first line. Host contention, not a product or test defect.
- `37681315086` (`w56-numbers.spec.ts` alone): the bolt test's own cast-drive loop never saw the stack fill (`stackCount` stayed `0`); the blocked-attacker test in the SAME run passed clean, including the pill. A single-run flake in the cast loop, not reproduced in either neighbouring dispatch (one run earlier, one run later, both clean on the identical spec and sha).

An earlier pre-`ff95769` pair of dispatches (before the tracker's fix landed) failed table-fit's live-match test on the exact same `.board-card__pt` overflow the tracker traced and fixed; a parallel `verify/w56-N-control` branch (the wave's then-HEAD with none of this lane's files) reproduced the identical pixel numbers, proving it was never this lane's — see the tracker's own note on `ff95769` for the fix itself.

## Mutation counts (`numbers.test.ts`, 26 tests)

| mutation | reverted (fails) | restored (passes) |
| --- | --- | --- |
| drop the diff (`diffViews` short-circuits to empty) | 12/26 fail | 26/26 |
| drop the stagger (`stackLayout` always `delayMs: 0`) | 2/26 fail | 26/26 |
| drop the pill (`syncPills` returns immediately) | 4/26 fail | 26/26 |

## Anchors (as implemented)

- **Life**: `[data-player-face][data-player-id="<id>"]` — the existing face markup `Board.tsx` already draws (no new attribute needed; `data-viewer` on the same element is how the module tells a graveyard's owner apart as `you`/`them` without a second source of that fact).
- **Damage (the floating number, a hit only)**: the card's own `.board-card__pt` corner badge — the same element `PowerToughness` already draws and colours `hurt` (`card.css`). The transient number is a second, independent element layered over it; the badge itself is untouched.
- **Damage (the pill, standing)**: beside `.board-card__pt`'s own live box — see "The damage pill" above.
- **A dying creature**: the P/T corner's last known viewport box (`lastSeenBox`, captured the moment damage last changed while the card was still on a battlefield — the badge is `onBattlefield`-only, so by the time a death is noticed the real element is already gone) drifting to `[data-zone="graveyard"][data-owner="you"|"them"]`'s own box.
- Everything is drawn into `[data-board-overlay]`, the same root `presence.ts` and the inspector already use.

## What could not be proven against real Forge

No scenario file in `apps/server/src/play/scenarios/` has a life-gain card in any hand (checked by grepping every `humanhand=`/`aihand=` line). A "Healing Salve spawns +3" case and the "creature dies" fade-to-graveyard case are therefore proven only in `numbers.test.ts` (jsdom, fake timers), not against a real Forge match. A minimal scenario that would close this gap (not committed — this lane owns no scenario file):

```
# a life-gain proof for the floating-numbers spec
turn=1
activeplayer=human
activephase=MAIN1
humanlife=20
ailife=20
humanhand=Healing Salve
humanbattlefield=Plains
humanlibrary=Plains;Plains;Plains;Plains;Plains;Plains
humangraveyard=
aihand=
aibattlefield=
ailibrary=Mountain;Mountain;Mountain;Mountain;Mountain;Mountain
aigraveyard=
```
