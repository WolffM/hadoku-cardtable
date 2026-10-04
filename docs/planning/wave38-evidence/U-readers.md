# U — readers, before any edit

## `prompts/ConfirmPrompt.tsx` (`ConfirmPrompt`, `isConfirmPrompt`)

```
apps/ui/src/play/prompts/confirm.jvm.test.ts:41:import { isConfirmPrompt } from './ConfirmPrompt.tsx';
apps/ui/src/play/live/LiveBoard.tsx:257:import { isConfirmPrompt, ConfirmPrompt } from '../prompts/ConfirmPrompt.tsx';
apps/ui/src/play/prompts/ConfirmPrompt.test.ts:13:import { ConfirmPrompt, isConfirmPrompt } from './ConfirmPrompt.tsx';
```

## `prompts/DialogPrompts.tsx` (`ConfirmPrompt`, the `confirm`-ask one — a second, colliding export name)

```
apps/ui/src/play/prompts/index.ts:27:import { ConfirmPrompt, ShowInputDialogPrompt, ShowOptionDialogPrompt } from './DialogPrompts.tsx';
apps/ui/src/play/prompts/ChoicePrompts.tsx:117: * already answered by `DialogPrompts.tsx` — nothing here chains the two asks  (prose reference only)
apps/ui/src/play/prompts/rules.ts:131:   * — `showInputDialog`, numeric — is already answered by `DialogPrompts.tsx`'s  (prose reference only)
```

Rendered through `index.ts`'s `PROMPT_COMPONENTS.confirm` → `PromptFor` → `LiveBoard.tsx`'s `LivePrompt`
(generic ask dispatch, not a direct import by name). Locked to its current shape by two files outside
this lane's ownership: `PromptShell.tsx` (the shell it renders through — `data-prompt={method}`, the
`prompt__actions`/`prompt__submit` markup) and `prompts/rules.ts` (`confirmButtons`/`confirmProblems`,
which decide 1-vs-2 buttons). `apps/ui/src/play/prompts/dialogs.test.ts` (unowned) asserts its exact
output: `getAllByTestId('prompt-option')`, `data-answer`, and the one-button case. **Not merged into the
new unified component** — see the report for why; only its colliding export name changes.

## `prompts/PlayOrDrawPrompt.tsx` (`PlayOrDrawPrompt`, `isPlayOrDrawPrompt`, `PLAY_LABEL`, `DRAW_LABEL`)

```
apps/ui/src/play/prompts/ConfirmPrompt.tsx       (imports isPlayOrDrawPrompt, to exclude the coin toss)
apps/ui/src/play/live/LiveBoard.test.ts          (PLAY_LABEL/DRAW_LABEL text assertions, via LiveBoard)
apps/ui/src/play/prompts/confirm.jvm.test.ts     (prose reference only, no import)
apps/ui/src/play/prompts/PlayOrDrawPrompt.test.ts (its own test)
apps/ui/src/play/prompts/ConfirmPrompt.test.ts   (imports DRAW_LABEL, PLAY_LABEL)
apps/ui/src/play/prompts/PlayOrDrawPrompt.tsx    (itself)
apps/ui/src/play/live/LiveBoard.tsx:258          (imports isPlayOrDrawPrompt, PlayOrDrawPrompt)
```

## `live/ConfirmDialog.tsx` (`ConfirmDialog`)

```
apps/ui/src/play/live/replay-server.ts   (prose/type reference only)
apps/ui/src/play/live/match.ts:40,271    (prose: "showConfirmDialog here in ./ConfirmDialog.tsx" / "The ask ./ConfirmDialog.tsx draws")
apps/ui/src/play/live/match.test.ts      (prose reference only)
apps/ui/src/play/live/transport.ts       (prose reference only)
apps/ui/src/play/live/LiveBoard.test.ts  (testid `confirm-dialog`, `data-answer`, `data-call-id`)
apps/ui/src/play/live/LiveBoard.tsx:261  (imports ConfirmDialog, mounts it for ask.method === 'showConfirmDialog')
apps/ui/src/play/live/prompts.jvm.test.ts (prose reference only — reads the wire method, not the component)
apps/ui/src/play/prompts/PromptShell.test.ts (prose, "confirm, showConfirmDialog" as an example of a childless dialog — unowned)
apps/ui/src/play/prompts/index.ts        (LANE_B_METHOD comment references showConfirmDialog, not the file)
apps/ui/src/play/live/prefs.ts           (prose reference only)
apps/ui/src/play/live/prompt-driver.ts   (prose reference only)
apps/ui/src/play/prompts/types.ts:33     (LANE_B_METHOD, see below)
apps/ui/src/play/prompts/fixtures.test.ts (LANE_B_METHOD import, see below)
```

## `LANE_B_METHOD`

```
apps/ui/src/play/prompts/fixtures.test.ts:14,23
apps/ui/src/play/prompts/index.ts:79
apps/ui/src/play/prompts/types.ts:33,35,39
```
(docs files `wave38-2026-10-03.md`, `handoff/w38.md`, `retro-code-quality-2026-10-03.md` also name it
in prose — not code, not touched.)

## Every `live-button-ok` text/content assertion in `e2e/`

Full grep (every hit):

```
e2e/arrow.spec.ts:325-344        (enabled/click only, no text assertion)
e2e/w32.spec.ts:52,95-96         (locator helper + prose, no text assertion)
e2e/w36.spec.ts:170              toBeDisabled() — not text
e2e/w36.spec.ts:171              toHaveText('Keep')  <-- THE ONE TEXT ASSERTION
e2e/w35.spec.ts:870              toBeDisabled() — not text
e2e/play/confirm.ts:12           prose only
e2e/w31.spec.ts:54,57,89,91      locator helper + prose, no text assertion
e2e/play/hands.ts:64,72,75,94,240,251  prose + enabled-check only, no text assertion
e2e/play/scenario.ts:128,201     locator helper + prose, no text assertion
e2e/play/board.ts:42             locator helper (H's new file), no text assertion
e2e/w34.spec.ts:110,244          prose only
e2e/table-fit.spec.ts:31,340,603,773,774,776,1141,1982,1983  enabled-check / disabled-check only, no text assertion
e2e/play.spec.ts:386,971,973,1162,1246,1320,1347  enabled-check only, no text assertion
```

**Only `e2e/w36.spec.ts:171`** (`toHaveText('Keep')`) asserts the bar OK's TEXT while a pop-up is open.
Matches the wave file's blast-radius row exactly. Lane H flips this line to `toHaveText('OK')` after
this lane's commit lands — not touched here.

## Addendum — every `data-answer`/`data-default`/`data-call-id` in `e2e/` (added after H's regression report)

H's own run against this lane's in-progress tree went red at `e2e/play.spec.ts:1644`:
`confirm-dialog`'s `[data-answer="no"]` carried `data-default=""` instead of `data-default="true"`. The
original `live/ConfirmDialog.tsx` built the attribute as `ask.defaultYes || undefined` — a real
**boolean** `true`, which React stringifies on a custom `data-*` attribute to the literal string
`"true"` — and the merged component had instead written `isDefault === true ? '' : undefined`, an empty
string. Fixed in `ConfirmPrompt.tsx` (`data-default={b.isDefault || undefined}`, matching the original
exactly) and in this lane's own `ConfirmPrompt.test.ts`, which had only asserted presence/absence, not
the string value, and so did not catch it. **Reverted-FAILS 1 / restored-PASSES 1** (see the report).

Full grep, `data-answer|data-default|data-call-id` across `e2e/`:

```
e2e/play.spec.ts:1644   expect(...locator('[data-answer="no"]').getAttribute('data-default')).toBe('true')
e2e/play.spec.ts:1645   bobDialog.locator('[data-answer="yes"]').click()
e2e/play.spec.ts:1655   aliceDialog.getAttribute('data-call-id')
e2e/play.spec.ts:1752   aliceDialog.getAttribute('data-call-id')
e2e/play.spec.ts:1765   aliceDialog.locator('[data-answer="yes"]').click()
e2e/table-fit.spec.ts:1126   dialog.locator('[data-answer="yes"]').click()
e2e/table-fit.spec.ts:2011    getByTestId('confirm-dialog').locator('[data-answer="yes"]').click()
e2e/play/prompts.ts:27   reads data-method / data-call-id off [data-testid="live-prompt"] (the ask
                          wrapper div LiveBoard.tsx itself renders — not this component)
e2e/play/prompts.ts:31   page.locator(`[data-testid="live-prompt"][data-call-id="${callId}"]`)
e2e/play/prompts.ts:37   sheet.locator('.confirm__button[data-default]').click() — PRESENCE only,
                          unaffected by the string-value bug
e2e/play/prompts.ts:41   [data-testid="prompt-option"][data-default] — ShowOptionDialogPrompt's own
                          data-default (an option index), not this component's; presence only
e2e/arrow.spec.ts:218    sheet.locator('[data-default]').first() — presence only
```

Every one of these is `confirm-dialog`'s shape (`showConfirmDialog`), which is the only one of the
three merged call sites that ever carried `data-answer`/`data-default`/`data-call-id` — confirmed
against the original four components above: bar-confirm and play/draw never had them. No other
`data-answer`/`data-default`/`data-call-id` reader exists in `e2e/`.
