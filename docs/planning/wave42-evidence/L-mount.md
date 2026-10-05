# L — mounting P's off-board picker (W18, W16)

Per `docs/planning/wave42-evidence/P-contract.md` (lane P), `apps/ui/src/play/live/LiveBoard.tsx`
computes, every render, `classifySelection(match.selectables, battlefieldCardIds(match.view))`
(`classifySelection`/`SelectionPrompt` from `../prompts/index.ts`, lane P's
`SelectionPrompt.tsx`) and mounts off the result:

- **`'off-board'`** (W18, the soft-lock — Relentless Dead's graveyard target, no board element to
  click) and **`'on-board'`** (W16, Worldbreaker — a legal board target existed, but no prompt text
  ever explained the choice) both mount `SelectionPrompt` (`live-selection-host`), Forge's own prompt
  line as the title, every named card as a tile, `done`/`cancel` only while Forge has enabled them.
  For `'on-board'` the board's own highlighted ring is untouched underneath — this is additive, not a
  replacement, per the contract.
- **`'none'`** — nothing from this file.

**No `'confirm'` kind.** The wave file's own hypothesis — that Sanctum of Ugin's "may sacrifice
yourself" trigger reaches the wire as a min-0 `setSelectables` naming only its own prompt-subject
card — was wrong. Lane P measured it directly (`sanctum-worldbreaker.jvm.test.ts`): Sanctum asks through the
ORDINARY bar confirm (`updateButtons {label1:"Yes", label2:"No", enable1:true, enable2:true}` +
`showPromptMessage`), which `isConfirmPrompt(bar)`/the existing `confirmPrompt` branch (wave 36's
T4, pre-dating this wave, not touched by this lane) already handles correctly. P deleted the
speculative `'confirm'` `SelectionKind` from `classifySelection` once this was confirmed, and this
lane removed its own mount for it in the same pass:

- `LiveBoard.tsx`: removed the `selectionConfirm` local, the `live-selection-confirm-host` /
  `live-selection-confirm` render block (its own `ConfirmPrompt` mount reusing `selectCard` on the
  selection's sole card), and every use of `selectionConfirm` in `questionOpen`,
  `stagedHandCardId`'s blocked set, `showsSecondButton`, and the control bar's OK
  disabled/label logic. `classifySelection`'s call site dropped its third argument
  (`match.promptCard`) to match P's own final two-argument signature.
- `LiveBoard.test.ts`: removed the two tests exercising the `'confirm'` shape ("a min-0 selection
  of exactly the card the prompt named is the yes/no pop-up…" and "saying yes to the min-0
  selection sends the same act…") and their shared `buttons` frame helper (now unused); reworded
  the describe block's own header comment and title to drop the "yes/no" framing.

**Made dead / deleted this pass**: LiveBoard.tsx −28 lines net (the 25-line selection-confirm
JSX block + its comment, plus three 1-line comment trims around the booleans it touched);
LiveBoard.test.ts −38 lines net (39 lines of the two removed tests + their shared comment, minus
the now-unused `buttons` helper, plus 2 lines the describe header's own explanation grew by).

`battlefieldCardIds` (`LiveBoard.tsx`) is unchanged by this pass — still "every id the board can
draw a clickable tile for," every permanent on either seat's battlefield, off `match.view` directly.

`'off-board'`/`'on-board'` still do not touch the bar or `showsSecondButton` at all — per the
contract, those two are additive to whatever the board and bar already offer; that was never true
of the deleted `'confirm'` branch, which is why removing it also meant removing its entries from
`showsSecondButton` and the OK button's own disabled/label logic.

## What this lane did NOT touch

`apps/ui/src/play/prompts/SelectionPrompt.tsx`, `selection.test.ts`, `offboard.jvm.test.ts`,
`sanctum-worldbreaker.jvm.test.ts`, `worldbreaker.jvm.test.ts`, the
`index.ts` re-export, and every `w42-*.state` scenario file are lane P's.

## Proof

- `apps/ui/src/play/live/LiveBoard.test.ts`, describe block "W18/W16 — a selection that is an
  off-board target or a silent on-board choice", now 3 tests (the `'confirm'` pair removed), all
  green: a selection naming a card off any battlefield renders the picker with no "Done" (min 1)
  and the stack stands aside; a selection naming only on-board cards still gets the titled picker,
  board highlight untouched underneath; clicking a tile sends `selectCard` for that card.
- `tsc --noEmit` on `apps/ui`: clean on every file this lane owns (`LiveBoard.tsx`,
  `LiveBoard.test.ts`). Lane P's own `offboard.jvm.test.ts`/`sanctum-worldbreaker.jvm.test.ts`/
  `worldbreaker.jvm.test.ts` were still catching up to their own signature change at the moment
  this was checked (same `classifySelection` two-argument change, their side) — not this lane's
  files, not re-run here per the manager's instruction (unit tests only, no jar suites).
- `eslint` on `LiveBoard.tsx`/`LiveBoard.test.ts`: clean.
- `npx vitest run apps/ui/src/play/live/LiveBoard.test.ts`: **164 passed, 0 failed.**
- `npx vitest run apps/ui/src/play/live/LiveBoard.test.ts apps/ui/src/play/live/match.test.ts`:
  **273 passed, 0 failed** (275 before this cleanup, minus the 2 removed `'confirm'` tests).

No jar suites or e2e run for this pass, per the manager's instruction (they are running those).
