# Retrospective — what waves 32–37 left in the code

**Operator, 2026-10-03:** concerned "about the code that landed and whether or not we've been
introducing duplicate code and legacy cruft". The wave-35 retro (`retro-wave35-2026-10-03.md`) was
about wall-clock time. This one is about the code. It was read from git (`4a56d60..ad3d84f`, about
3 days), by three read-only reviewers (UI, server and packages, tests and CI), each finding spot-checked
by the tracker. Wave 38 (`wave38-2026-10-03.md`) is the action.

## The shape of the churn

`git diff --numstat 4a56d60 HEAD`, excluding `forge/`:

| area | net lines |
| --- | --- |
| docs (planning, evidence, deck selection) | +26.6k, **0 deleted** |
| tests (e2e, `*.test.ts`, `*.jvm.test.ts`) | +13.9k |
| generated deck pools / JSON | +14.4k |
| product source (`apps/*/src`, `packages/*/src`) | **+6.6k** |

Of the source and test lines added, 7.9k are comments and 13.7k are code, so about 37% are comments.
Of those comment lines, 815 cite a wave, lane or ticket id (`R9`, `Q18`, `T4`, `lane F`,
`wave 35 §S`). In the hot files about half of all lines are comments: `Board.tsx` has 1523 of 3106,
`LiveBoard.tsx` 1065 of 1935, server `auto.ts` 856 of 1325.

## Duplicate paths (each one checked by the tracker)

**UI**
- **Two pointer-drag systems on the same cards.**
  - `useArrangeDrag` uses `SLOP = 4` (`Board.tsx:2605`, w32 `4744c57`).
  - The gesture layer uses `DRAG_SLOP_PX = 6` (`gestures/types.ts:34`).
  - Two unrelated types are both named `DropTarget` (`Board.tsx:891`, `gestures/types.ts:21`).
  - `draggable="true"` is kept as a marker only.
- **The yes/no question has four components.**
  - Two exports both named `ConfirmPrompt` (`prompts/DialogPrompts.tsx:98`, `prompts/ConfirmPrompt.tsx:110`).
  - `PlayOrDrawPrompt.tsx`, which w36 says it "generalised" but did not delete.
  - `live/ConfirmDialog.tsx` for `showConfirmDialog`, kept apart by an exported constant named for a
    lane (`LANE_B_METHOD`, `prompts/types.ts:33`).
- **T4 is half done.**
  - The operator asked: *"never put yes/no there, always the big pop-up"*.
  - The bar's OK still shows Forge's "Keep" while the pop-up is up, and `w36.spec.ts:171` pins it.
  - `questionOpen` (`LiveBoard.tsx:1423`) was not updated for the new pop-ups.
- **R9 placement is a patch on a patch.** A module-global version counter re-moves a card the first
  fix already placed.
- **Secluded Glen was fixed twice**, by `dd0547e` and `812dea1`, in two branches of
  `gestures/install.ts`.
- **"Is this card in my hand or named by the question" has 5+ predicates.**
- **The z-index scale (`d2fc75b`) was bypassed:** `live.css` has three bare `z-index: 6`, one of them
  added by w36.

**Server**
- **Ask shortcuts live in 4 places across 3 files.**
  - `onlyAnswer` and `repeatedAbilityToPlay` in `auto.ts`.
  - The Thoughtseize fold in `match.ts`, which rests on a **250 ms timer** (`match.ts:499`) and a 5 s TTL.
  - A yield decline matched on English labels (`match.ts:506-507`).
  - The browser's `autoAnswer`, with different `min` rules.
- **The "own lands don't count" filter runs on both sides.**
  - Server: `visibility.ts` `ownBattlefieldLandIds`.
  - Browser: `ui/play/live/match.ts:1262` `isOwnBattlefieldLand`.
  - Both compensate for one fork change (w35 `9729168`).
- **`StopPolicy` grows one boolean per complaint** (`skipEmptyBlockStop`, `attackStopIsTheDeclaration`,
  `passOwnSpell`, …), each nested into the last in `decideStop`.

**Tests**
- **Specs are organised by wave** (`w31`…`w36.spec.ts`, helper `e2e/play/w32.ts`). Each UI change
  rewrites old wave files: Arena casting touched 6 of them, the confirm pop-up 7.
- **16 helper names are defined in 2+ spec files, 44 copies in all** (`titled` and `offered` ×6).
- The cast-lift fix is reimplemented in 7 places.
- There are 20 hand-rolled `waitForTimeout` poll loops. w37's §E2 red is one of them answering an ask
  that opened mid-wait.

## Coverage that looks green and is not

- **None of the 32 `*.jvm.test.ts` jar suites run in CI.** `ci.yml:193-196` says it outright:
  "a separate decision nobody has made". w37 found `auto.jvm.test.ts` and `scenario-blockers` Q12
  red at HEAD as a result.
- **`arrow.spec.ts` skips in `check` and is not in forge-e2e's hand-kept file list,** so its match never
  runs in CI.
- **Redeploy runs on every push regardless of CI** (`redeploy.yml`), so red builds deploy.
- **A commit subject claimed an outcome CI then contradicted:** `1a693fe`, a docs-only plan, is titled
  "forge-e2e is green again".

## Why it happens

A lane is scoped as "make the operator's sentence true" and proves it with a new test. Nothing asks it
to **delete what its change replaced**, or to fix the thing where it lives (the fork, the shared helper)
rather than where the symptom showed. w35's blast-radius rule lists who *reads* a change, not what it
*makes dead*. History goes into comments because the commit and the wave file feel far away.

## What changes

1. **Wave 38 is consolidation plus the w37 carry-over.** No product features. Deleting is the
   deliverable, and the CI signal comes first because nothing can be safely deleted without it.
2. **Every lane's closing note gets a `made dead / deleted` line, with lines removed.** A change that
   replaces a path removes the old one in the same lane, or names it as left for a later wave.
3. **New source comments explain the code. Ticket ids, wave numbers and lane letters go in the commit
   message.** A comment a lane touches anyway is rewritten that way.
4. **A commit subject says what the commit contains,** never an outcome CI has not shown yet.
5. **Deferred to wave 39, an engine/server wave of its own (the w35 rule):**
   - the `auto.ts` shortcut pipeline and a stop rule table;
   - the land filter moved into the fork or bridge;
   - the drag unification and the R9 collapse;
   - the e2e regroup by feature;
   - the decode-race measurement for a freshly drawn card (`wave37-evidence/A-repro.md` §8).
6. **Operator decisions, not lane work:**
   - gate `redeploy.yml` on CI;
   - stop committing evidence PNGs (`!docs/**/*.png`, 60 files and 9.6 MB in history so far);
   - archive `workstreams.md`, a 238 KB chronological log.
