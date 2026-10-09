# Wave 64, lane T — prompt text/UI, the e2e drivers

## §T folds (T1–T9), as landed

| item | what moved | files | net lines |
| --- | --- | --- | --- |
| T1 | one `OptionButton` component for `showOptionDialog`, `confirm`, `getAbilityToPlay`'s choice button | `PromptShell.tsx` (+component), `DialogPrompts.tsx`, `ChoicePrompts.tsx` | component added once in `PromptShell.tsx`; both call sites in `DialogPrompts.tsx` shrank from two hand-rolled `<button>` blocks to two `<OptionButton>` calls |
| T2 | `COLOUR_TOKENS`/`colourToken` (DialogPrompts.tsx) deleted; folded into `ManaPip.tsx`'s `COLOR_WORD`/`colorWordToken` | `ManaPip.tsx`, `DialogPrompts.tsx` | -16 lines net in `DialogPrompts.tsx` (the local table + helper deleted); `ManaPip.tsx` +16 (one copy, now the authority, with its own test) |
| T3 | `LiveBoard.tsx`'s `live-says` (`plainRulesText`) and the payment window's `RulesText` read the same pipeline — settled by T4's fix (see below), no separate code change needed |
| T4 | `plainRulesText` strips `CARD_ID_SUFFIX` too (drift fix) — **except** two card-TILE-label call sites (`ChoicePrompts.tsx`'s `GetChoicesPrompt`, `OrderPrompt.tsx`'s `labelOf`) that switched to `translateTargetWords` instead, to keep `nameFromForgeLabel`'s id-match safety intact (a blind strip there let a MISMATCHED parenthetical id's art be guessed — measured, see Mutation below) | `lookup.ts`, `ChoicePrompts.tsx`, `OrderPrompt.tsx` | `lookup.ts` +9 (doc reorg + one new line) |
| T5 | one `dropBeforeIndex` (the drop-before arithmetic `OrderPrompt`/`ManipulateCardListPrompt` each wrote by hand); one `cardOrWordsFace` (the card-vs-words face both built by hand) | `rules.ts`, `PromptShell.tsx`, `OrderPrompt.tsx`, `ManipulateCardListPrompt.tsx` | `OrderPrompt.tsx` -2, `ManipulateCardListPrompt.tsx` -2 |
| T6 | e2e helper folds — see table below | `e2e/play/board.ts`, `e2e/play/prefs.ts` (new), `e2e/play/combat.ts` (unchanged, already had `passDeclareAttackers`/`phaseOf` — w33 now reads them), `e2e/w32/w33/w35/w59-stack/draft.spec.ts` | net **-115** across the five spec files (see numstat below) |
| T7 | one `apps/ui/src/play/prompts/answer-table.ts` (method → `AnswerKind` + shared testid strings); both `prompt-driver.ts` and `e2e/play/prompts.ts` switch on `kind` instead of carrying their own method-by-method case lists and two separate `SELF_ANSWERING` sets | `answer-table.ts` (new, 74 lines, plain data/types, no DOM), `prompt-driver.ts`, `e2e/play/prompts.ts` | the two drivers' own case-dispatch logic is now data-driven from one table; `e2e/play/prompts.ts`'s local `SELF_ANSWERING` set deleted, re-exported from the table |
| T8 | knip | see **Knip** below — **not fully done**, see Honesty note |
| T9 | one `genuinelyAsked(match, seat, {ownDecisionOpen, waitingForOpponent})` in `match.ts`; `LiveBoard.tsx`'s inline `viewerOpen`/`opponentOpen` combining formula ("F's seam filter") deleted, replaced by two calls to it. `withGatedPriority` (the view-transform) and its 4 existing pins are UNCHANGED — the seam that moved is the combining formula beside its call, not the transform itself. `YIELDING` moved from `LiveBoard.tsx` to `match.ts` (exported), one copy. | `match.ts`, `match.test.ts` (new `describe('genuinelyAsked…')`), `LiveBoard.tsx` | `match.ts` +33 (new function + regex + tests use it); `LiveBoard.tsx` net -13 at that site |

### T6, in detail

| helper | old copies | new home |
| --- | --- | --- |
| `turnFastModeOff` (server-confirmed) | `w59-stack.spec.ts` (local) | `e2e/play/prefs.ts` (new) — `w59-stack.spec.ts` now imports it |
| `castByDrag` | `w59-stack.spec.ts` (local, ~40 lines) | `e2e/play/board.ts` (alongside `castCard`, its click-based twin) |
| `offered()` name-filtered | `w35.spec.ts`'s local `offeredNamed` | `e2e/play/board.ts` (`offeredNamed`, beside `offered`) |
| `promptMethod` | `w35.spec.ts`'s local `promptMethodOf` (byte-identical body) | deleted; `w35.spec.ts` now imports `board.ts`'s own |
| `serverLog` body | `draft.spec.ts`'s inline `readFileSync(...).split(...).filter(...).map(...)` | `draft.spec.ts` now calls `board.ts`'s `serverLog({serverLogFile})` |
| `passDeclareAttackers` + `phaseOf` | `w33.spec.ts`'s own copies (near-identical to `combat.ts`'s, built for `w54-blockers.spec.ts`) | `w33.spec.ts` now imports both from `play/combat.ts` |
| the median End Turn-gap assertion | `w32.spec.ts:150` (`expect(median(endTurnGaps)...)`) | deleted, with the now-unused `median()` helper; the max-gap assertion (the actual claim) stays |

Not folded (named, not touched — outside my row or outside T6's named scope):
- `played-card.spec.ts:192`'s own inline Fast Mode toggle (no server-log confirmation) — `played-card.spec.ts` is lane J's file.
- `w47-pace.spec.ts:148-162`'s own inline toggle (it is deliberately the ONE spec that flips Fast Mode mid-match to test pacing itself, not a generic "turn it off" helper — folding it into `turnFastModeOff` would change what it proves, so I left it; named here per the brief's own "if folding leaves a copy in someone else's spec, name it").
- The priority/payment "grind loop" (`grindPriority`) and the cast-wait loop (`castUntilOnStack`) named in T6 were **not built** — see Honesty note. `w51-control-box`/`w56-numbers`/`w33`'s own copies of the cast-wait loop, and `w35`/`w46-attack`/`w33`/`w32`/`w56-numbers`'s own grind loops, are UNCHANGED.

## T9/T10 — the priority flag and the waiting pop-out

- **T9**: landed as described above. `LiveBoard.test.ts`'s "the priority flag is gated on a real decision" suite (F's 4 pins, wave 63) stayed green through the fold without edits — proving the combining formula moved, not changed.
- **T10**: **deferred to the tracker**, per the manager's mid-task relay: a hotfix gating the pop-out to decisions-only is landing on `main` from elsewhere, with its own unit pin, before I would have landed mine. I made no edit to the pop-out's render condition (`LiveBoard.tsx`'s `theirAsk`/`waitingForOpponent` region) — I drafted one (a `theirGenuineAsk = theirAsk !== null && theirAsk.method !== 'priority'` gate) and reverted it cleanly rather than risk a duplicate/conflicting gate. The operator's own answer, for whoever lands it: *"'Waiting for Hadoku…' shouldn't be showing at all times, that was not the intent. i wanted this to show when player is resolving an effect not simply when waiting on them."* — decisions + pregame only, never a held priority window; the `priority` fact stays on the wire for T9's flag.

## The Underground River bug (the operator's 4th report: Z10, Y23, AD6, 2026-10-08) — made first, ahead of the rest

**Measured** (`e2e/w64-river.spec.ts`, against the real jar, scenario `apps/server/src/play/scenarios/underground-river.state`):

`Produced$ Combo U B` (an exactly-two-colour mana ability) does not reach the wire as `confirm` or `getChoices` at all. `PlayerControllerHuman.chooseColor`'s `chooseColorCommon` (forge-gui) checks `getGui().isLibgdxPort()` first; false for this bridge (`RemoteClientGuiGame.isLibgdxPort()`), so it takes `InputConfirm`'s OTHER branch — a plain `InputConfirm` object, `showAndWait()`ed, which answers through the ORDINARY BAR (`showMessage`/`updateButtons`), never `getGui().confirm()`. The two colour NAMES ("Blue", "Black") land as Forge's own `label1`/`label2`, and `LiveBoard.tsx` mounts `ConfirmPrompt.tsx` for them (`isConfirmPrompt(bar)` — the SAME component that already draws the shockland pay-life Yes/No and the mulligan Keep/Mulligan). `ConfirmPrompt.tsx`'s button rendered `{b.label}` as plain text — no `ManaPip`, ever. Measured, before the fix:

```
[river] where=direct-tap method=getAbilityToPlay label=": Add ." aria="Tap: Add C." pip=true
[river] where=direct-tap method=getAbilityToPlay label=": Add  or . Underground River deals 1 damage to you." aria="Tap: Add U or B. Underground River deals 1 damage to you. " pip=true
<no [river] line for the colour question — `measurePrompt` only looked inside `live-prompt`, and this bar is not that>
bareWords found: ["BUTTON.button confirm__button: \"Blue\"", "BUTTON.button confirm__button: \"Black\""]
```

The `getAbilityToPlay` list itself (the land's two abilities) was ALREADY correct (`pip=true` both rows, via `RulesText`) — every prior Z10/Y23/AD6 fix landed there. Nobody had ever touched `ConfirmPrompt.tsx`, because the w64 brief's own prior-art note explicitly carved it out of T1 ("NOT covered… stays its own thing") — correct for T1's fold, but it meant this specific bar never got the pip treatment at all.

**The fix** — one mana table, every text path reads it:
- `ConfirmPrompt.tsx`: `{b.label}` → `colorWordToken(b.label) === null ? b.label : <ManaPip token={colorWordToken(b.label)!} />`, with `aria-label={b.label}` added so the word still reaches the accessible name (matches the pattern already used in `ShowOptionDialogPrompt`).
- `DialogPrompts.tsx`'s `ConfirmAskPrompt` (the `confirm`-method ask, a DIFFERENT component from the one above, which I had already run through `OptionButton` for T1): gained the same `colorWordToken`/`ManaPip` check — it didn't carry the measured bug, but it was the one other bare-word-capable button left unfixed, and the brief asked for one table everywhere.
- `RulesText.tsx`: when the WHOLE text handed to it is one of Forge's colour words (`colorWordToken(src)`), draws the pip instead of the loop — this is what `ChoicePrompts.tsx`'s `GetChoicesPrompt` already falls through to for a non-card `getChoices` option (a 3+-colour choice, `chooseColorCommon`'s OTHER branch, `getGui().one()`), so that surface is now covered by the same table too, pre-emptively (not separately measured — no 3+-colour land in this cube's test fixtures that I found).
- `COLOUR_TOKENS` (the old `DialogPrompts.tsx` table) deleted — folded into `ManaPip.tsx`'s own, as T2 originally planned.

**Measured, after the fix** (`e2e/w64-river.spec.ts`, both tests green, three runs total including one green-on-first-try and one that needed a cast-gesture fix unrelated to the product bug — see below):

```
[river] where=direct-tap method=getAbilityToPlay label=": Add ." aria="Tap: Add C." pip=true
[river] where=direct-tap method=getAbilityToPlay label=": Add  or . Underground River deals 1 damage to you." aria="Tap: Add U or B. Underground River deals 1 damage to you. " pip=true
[river] where=direct-tap method=showConfirmDialog/bar message="Underground River\n\nSelect Mana to Produce" label="" aria="Blue" pip=true
[river] where=direct-tap method=showConfirmDialog/bar message="Underground River\n\nSelect Mana to Produce" label="" aria="Black" pip=true
```
`label=""` (no bare word in the VISIBLE text), `aria="Blue"`/`"Black"` (the word survives as the accessible name), `pip=true`. No leaf element anywhere on the page matched `/\b(black|blue)\b/i` in its visible text, both for the direct tap and for paying a {B} spell's cost (`Dark Ritual`, swapped in for `Duress` after measuring that `Duress`'s own target ask was an unrelated test-harness complication, not the product bug — see Honesty note).

**Every surface checked, with its measured verdict:**
| surface | component | verdict (before → after) |
| --- | --- | --- |
| the land's own ability list (`getAbilityToPlay`) | `ChoicePrompts.tsx` `GetAbilityToPlayPrompt` → `RulesText` | already pip (`pip=true` both runs) — not the bug |
| the colour bar (`InputConfirm`'s non-libgdx branch) | `ConfirmPrompt.tsx` | **the bug** — plain text → pip (fixed) |
| `confirm`-method asks (a different ask, unmeasured on this card, same table) | `DialogPrompts.tsx` `ConfirmAskPrompt` | plain text → pip (fixed pre-emptively, same table) |
| 3+-colour `getChoices` list (unmeasured — no fixture card) | `ChoicePrompts.tsx` `GetChoicesPrompt` → `RulesText` | plain text → pip (fixed pre-emptively, same table) |

Files: `apps/server/src/play/scenarios/underground-river.state` (new), `e2e/w64-river.spec.ts` (new), `apps/ui/src/play/prompts/ConfirmPrompt.tsx` (+test), `apps/ui/src/play/prompts/DialogPrompts.tsx`, `apps/ui/src/play/prompts/RulesText.tsx`, `apps/ui/src/components/ManaPip.tsx`.

## The video-recording acceptance gate (AE20)

Added behind `CARDTABLE_E2E_VIDEO=1`, off by default (checked: `grep` confirms the flag is read nowhere else, and every call site is `if (recording) …`):
- `e2e/play/browser.ts`'s `openFriend`: when the flag is on, `browser.newContext({ recordVideo: { dir: <RUN_DIR>/videos/<spec-title-slug>, size: {1280,720} } })`; the slug comes from `test.info().titlePath` (filesystem-safe), `RUN_DIR` is `e2e/.run` (already gitignored, already the directory the tracker's `forge.yml` `video` input uploads from — checked, it resolves under `e2e/.run` as required).
- `e2e/play/open-friends.ts`: tracks `{page, dir, name}` per context only while recording; on close, renames Playwright's own random `.webm` to `<name>.webm` (`alice.webm`/`bob.webm`) via `page.video().path()` → `renameSync`.
- `e2e/play/harness.ts`'s `PlayStack.stop()`: while recording, closes this stack's own friends (`closeStaleFriends()`) BEFORE tearing down the server, so the LAST test in a run also flushes its video (previously, friends were left for the NEXT stack's own `closeStaleFriends`, which never runs for the last test in a file). Absent entirely when the flag is unset — zero behaviour change, confirmed by every vitest/e2e run in this report running with the flag unset throughout except the explicit proof runs below.

**No context creation outside `e2e/play/*` was touched** (out of scope per the brief); found and reported, not edited:
- `e2e/draft.spec.ts:137,401,439`, `e2e/w48-format-tabs.spec.ts:38`, `e2e/w50-sound-builder.spec.ts:112`, `e2e/streamed-live.spec.ts:108,271`, `e2e/room-mode.spec.ts:74` — each calls `browser.newContext()` directly, independent of `openFriend`. None of these are mine to edit (only `draft.spec.ts` is in my row, and only for the T6 fold, not for video).

**Local proof** (claws unavailable to me; ran this myself since load allowed it, serialized under `w64-jvm.lock`): `npx playwright test w64-river.spec.ts` with `CARDTABLE_E2E_VIDEO=1` produced, for all three test runs:
```
e2e/.run/videos/<slug>/alice.webm   (176–911 KB, non-empty)
e2e/.run/videos/<slug>/bob.webm     (177–1012 KB, non-empty)
```
confirmed present and non-empty for every run via `find … -exec ls -la`.

## Mutation

- revert the suffix strip in `plainRulesText` → `lookup.test.ts`'s new "the card-id suffix (T4)" case FAILS.
- revert the `OptionButton` fold (restore two hand-rolled `<button>`s) → no dedicated mutation test, but `dialogs.test.ts`'s existing assertions on `data-default`/`data-answer`/button count still pin the exact markup those buttons must produce.
- the measured safety case: reverting T4's ChoicePrompts/OrderPrompt exception (i.e. routing their labels through the suffix-stripping `plainRulesText` instead of `translateTargetWords`) → `choices.test.ts`'s *"a label whose parenthesis is not this card's id is not guessed at: no art"* FAILS (confirmed — this is exactly how the exception was found: I made that mistake first, this test caught it).
- revert `ConfirmPrompt.tsx`'s `colorWordToken`/`ManaPip` fix → the new `ConfirmPrompt.test.ts` case *"draws a mana pip, not the bare word, when Forge's own label is a colour (Underground River)"* FAILS, and `e2e/w64-river.spec.ts` reds on a claw.
- revert `genuinelyAsked` (inline the old formula back) → no new FAIL by itself (it's a pure refactor), but `match.test.ts`'s new `describe('genuinelyAsked…')` would fail to compile (the export would not exist).

## Knip

Before (`docs/planning/wave64-evidence` baseline, captured before any edit): T's files carried 26 unused exports + 11 unused types (prompts/index.ts 11, LiveBoard.tsx 11 — matching the wave file's own inventory numbers exactly).

After: **unchanged** (26 exports + 11 types) — see Honesty note. Every NEW export this lane added (`OptionButton`, `cardOrWordsFace`, `dropBeforeIndex`, `colorWordToken`, `genuinelyAsked`, everything in `answer-table.ts`) has a non-test importer and knip does not flag any of them — confirmed by re-running knip and checking each by name.

## Honesty — what I could NOT do / did not finish

- **T6's `castUntilOnStack`/`grindPriority` were not built.** The coordinator's mid-task priorities (the video gate, then the Underground River bug, both ahead-of-queue) consumed the time budget I would have spent on them. `w51-control-box.spec.ts`/`w56-numbers.spec.ts`/`w33.spec.ts`'s own copies of the cast-wait loop, and `w35`/`w46-attack`/`w33`/`w32`/`w56-numbers`'s own grind loops, are UNCHANGED — still duplicated, exactly as the inventory found them.
- **T8 (knip's count going DOWN for `prompts/index.ts` and `LiveBoard.tsx` specifically) was not done.** I captured the before/after (both runs attached, byte-identical for T's files) but never did the "export only what a non-test importer uses, push the rest behind a `*.internal.ts` or through the public surface" pass the wave file asks for on those two files' own 11+11 pre-existing flags. These are not new drift — they pre-date this wave — but T8 asked me to clean them up and I did not reach it.
- **The second river measurement test (paying a cost) is a WEAKER proof than the first.** Forge auto-paid and fully resolved Dark Ritual before any prompt rendered (`next=none`, stack already empty by the time I polled), so it proves "no bare colour word after a successful auto-paid cast" rather than directly exercising the colour-choice UI mid-payment the way the direct-tap test does. The direct-tap test is the strong, repeatable proof; the pay-tap test is a secondary, weaker one. I did not find a scenario/card shape in the time available that forces a MANUAL (non-auto-pay) tap mid-payment for this specific ability.
- **T10 is deferred**, per the manager's relay — see above. Not a gap in my work, a sequencing decision.
- **Net lines are NOT negative for the lane as a whole.** The T1–T9 consolidation folds themselves are net-negative where pure (e.g. `e2e/w32/w33/w35/w59-stack.spec.ts` together: -115 lines; `DialogPrompts.tsx`/`OrderPrompt.tsx`/`ManipulateCardListPrompt.tsx`: net negative). But the lane's TOTAL diff is net-positive because of two coordinator-directed additions that are not consolidation: the video-recording infrastructure (~150 new lines across `browser.ts`/`open-friends.ts`/`harness.ts`) and the Underground River bug's measurement spec + scenario + fix (`e2e/w64-river.spec.ts` is 199 lines, new; the scenario is 23 lines, new). Both were explicitly ordered ahead of the rest of §T by the manager mid-task. I'm reporting this net number honestly rather than let the fold-only arithmetic imply the whole lane shrank.

## Decisions made because the brief was ambiguous

- **T9's file**: the brief says `genuinelyAsked` lives in `match.ts`. Its full derivation chain (as LiveBoard.tsx wrote it) depended on several LiveBoard-local helpers (`isSpectator`, `battlefieldCardIds`, `offersSecondButton`, and the whole `askOpen`/`paying`/`playOrDraw`/`confirmPrompt`/`selectionPopup`/`decision` chain) that are ALSO independently needed for LiveBoard's own JSX branching — moving all of them to `match.ts` to make a fully self-contained `genuinelyAsked(match, seat)` would have meant either duplicating that whole chain in `match.ts` (a second pathway — exactly what this wave forbids) or relocating LiveBoard's own render-branching logic wholesale (far outside my file row, high risk). I instead had `genuinelyAsked` take the two ALREADY-combined, ALREADY-necessary-elsewhere facts (`ownDecisionOpen`, `waitingForOpponent`) as parameters, and own only the actual COMBINING FORMULA (the thing that was F's seam filter) plus the one self-contained sub-fact it could own outright (`YIELDING`, moved in full). This is narrower than "one predicate takes just `(match, seat)`" but avoids a duplicate implementation; documented here as a deliberate scope reduction, not an oversight.
- **T9's file ownership**: my file row scopes `LiveBoard.tsx` to "the text paths and `useCrawlGuard`" — T9's seam-filter code is neither. I treated T9 as an explicit, named exception (it is in my own §T task list and the manager's rulings addressed it to me directly; neither J nor S owns that region), and kept the edit to the smallest possible hunk (one block replaced, one import list change, one doc-comment update) to minimize rebase risk.
- **`ConfirmPrompt.tsx`**: its own header says the `confirm`-method path ("outside this lane's files") was deliberately left uncovered by an EARLIER wave's T1-equivalent fold. I touched it anyway, because it is in my row (`apps/ui/src/play/prompts/*`) and it turned out to be the actual, measured location of the operator's repeated bug — leaving it alone because an old comment said "not this lane" would have meant shipping the fourth repeat of the same report.
