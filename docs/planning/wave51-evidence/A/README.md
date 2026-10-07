# Lane A — the control box is fixed furniture; every other answer is the decision pop-up (wave 51)

Done by the manager session itself (the operator asked for no sub-agents this wave). Commits
`ace8660`, `e550eac`, `d52b2d5`, `704c8db` on `w51`.

## What changed

- `apps/ui/src/play/prompts/ConfirmPrompt.tsx`: `barRoute(bar, stackEmpty, owned)` →
  `next-phase | decision | none`, `offersEndTurn(bar)`, `END_TURN_LABEL`. `ConfirmPrompt`'s two
  buttons are optional, so the decision pop-up draws only the buttons Forge enabled.
- `apps/ui/src/play/live/LiveBoard.tsx`: the control box draws `Next Phase`, `End Turn`,
  `Full control`, `Concede` every frame. `Next Phase` is enabled only on `route === 'next-phase'`;
  `End Turn` only while Forge's second button is enabled and is `End Turn`. The `live-decision`
  pop-up (`live-decision-ok`, `live-decision-cancel`, Forge's words, Forge's prompt line through
  `plainRulesText`) draws every other enabled bar button, after every existing pop-up has had its
  claim. **Deleted:** `live-button-ok`, `live-button-cancel`, `secondLabel`, `showsSecondButton`
  (and the `live__ok`/`live__cancel` classes they wore).
- §A.6: `questionTopOf(root)` measures the topmost thing in the decision column (a pop-up's sheet,
  or a staged card) in `.board__mid`'s frame; a layout effect writes it to `--question-top` on
  `.live` on every render and on a ResizeObserver. `board.css`'s `.board__mid[data-question]` hangs
  the band from it (`top`), shrinks it to the room when the room is less than `--mid-h-asked`
  (`--mid-h: min(...)`), and `.board__mid[data-question] > .stack` puts the thumbnail row at the
  band's foot. `.stack__big` is untouched (tracker's scope note: it is deleted by the next stack
  redesign).
- Found by the full e2e gate (`w49-counterspell`, 2 red): the band now moves on a layout effect,
  AFTER the last frame from Forge, and the gesture layer paints Forge's arcs only on a frame. The
  counterspell arc's tail stayed where the band used to be (tail y 238, Counterspell's thumbnail at
  y 351–438, unchanged 1.5 s later). `match.ts`'s new `relayout(match)` wakes the match's
  subscribers without a new revision (React redraws nothing; the gesture layer repaints), and
  LiveBoard calls it only when `--question-top` actually changes (`704c8db`). `gestures/**` is the
  other session's, so the seam is on the match side.
- `live.css`: `.live__prompt[data-staged]` puts the decision pop-up at the column's foot while
  `.staging` (a click-cast card waiting for its target) holds the centre.
- Found while doing it: a SELECTION pop-up's `Done` was drawn only at `min === 0`, so a multi-pick
  selection (min 1, up to 2) was finished with the bar's OK. With that OK gone it would have had
  no button at all; `Done` is now drawn whenever Forge enables its OK (`e550eac`).

## Inputs found that the decision pop-up now carries

Each one is a `barRoute` unit case (`ConfirmPrompt.test.ts`, `describe('barRoute')`):

| input (Forge) | bar | where it goes |
| --- | --- | --- |
| `InputPassPriority`, stack empty | OK + End Turn | box: Next Phase + End Turn |
| `InputPassPriority`, spells on the stack | OK + End Turn | pop-up: OK; box: End Turn |
| `InputPassPriority` after a manual mana tap (`canUndoLastAction`, `InputPassPriority.java:171`) | OK + `Undo (N)` | pop-up: OK + `Undo (N)` (Next Phase greyed: its second button is not End Turn) |
| `InputAttack` (`InputAttack.java:90`) | OK + Alpha Strike / Call Back | pop-up: OK only (the second button stays refused, item 16) |
| `InputBlock` (`InputBlock.java:77`) | OK (+ disabled Cancel) | pop-up: OK |
| `InputSelectTargets` with no card to click (Lightning Bolt with only players) | disabled OK + Cancel | pop-up: Cancel |
| `InputLondonMulligan` (`InputLondonMulligan.java:65`) | OK + Auto | pop-up |
| `InputPayMana` with no payment window (Forge named no card) | Auto/"" + Cancel | pop-up |
| coin toss, T4 yes/no, an ask, the payment window, a W16/W18 selection, the pregame wait | — | unchanged: their own pop-up wins (`owned`) |

## Verified

- `pnpm vitest run apps/ui/src/play/live/LiveBoard.test.ts apps/ui/src/play/prompts/ConfirmPrompt.test.ts`:
  203 passed (before `e550eac`); `LiveBoard.test.ts` alone 172 passed after it.
- New `LiveBoard.test.ts` block `wave 51 — the control box is fixed furniture…` (8 tests): the four
  buttons in nine states (no bar, priority with/without a stack, Undo, yes/no, coin toss, a target,
  blockers done, a payment), at most one pop-up in each; Next Phase / End Turn press `selectButtonOk`
  / `selectButtonCancel`; a stack priority's pop-up has OK and no cancel; a target's Cancel alone;
  payment and selection pop-ups keep their inputs; §A.6's `--question-top` arithmetic and the
  `board.css` rule.
- Jar suites with CI's env (jar, res, `CARDTABLE_PLAY_WORK_DIR=~/.cache/cardtable-play-work/w51-A`):
  `board-play.jvm.test.ts` 1 passed, `combat-drag.jvm.test.ts` 1 passed. Both press "Forge's button
  one as the page draws it" (Next Phase if enabled, else `live-decision-ok`).
- Real Forge (lane B's `e2e/w51-control-box.spec.ts`, 3 runs green): the stack's thumbnail row
  bottom → the decision pop-up's top edge is **6px at 1280×800 and 6px at 1366×768**. Before
  `d52b2d5` the 1366×768 reading was **1px**: the pop-up there sits less than a full band below the
  board's top, so the old `max()` clamp kept the band's height and ate the gap. Screenshots
  `../B/stack-over-decision-1280x800.png` and `../B/stack-over-decision-1366x768.png` (gitignored,
  described in `../B/README.md`).

## Mutation

`barRoute`'s `&& stackEmpty` removed (a stack priority routes to `next-phase`):
`ConfirmPrompt.test.ts` + `LiveBoard.test.ts` → **4 failed, 199 passed (203)**; restored →
**203 passed (203)**. The four: `barRoute > priority with spells on the stack is a decision`, and in
`LiveBoard.test.ts` the four-buttons-in-every-state case, the stack-priority pop-up case, and the
§A.6 case (no pop-up, so no `--question-top`).

`relayout(match)` removed from LiveBoard's layout effect: `LiveBoard.test.ts` → **1 failed, 171
passed (172)** (the §A.6 case: "the band moved: subscribers repaint"); restored → **172 passed**.

## Not verified

- A Smallpox / sacrifice-selection screenshot specifically: the §A.6 proof uses the Lightning Bolt
  decision pop-up, the same `.live__prompt` host and the same measurement. A selection pop-up is
  measured by the same `questionTopOf` selector (`.live__prompt > *`).
- The staged-card layout (`data-staged`): in the real runs the click-cast Bolt parks where it was
  released (park-on-release), so `.staging` never drew and `data-staged` was never set.
