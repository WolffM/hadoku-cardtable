# U — `prompts.jvm.test.ts`: two pre-existing reds, not this lane's

`prompts.jvm.test.ts` is one of this lane's two jar suites required green (`confirm.jvm.test.ts` and
`prompts.jvm.test.ts` "pass alone with the jar env"). It does not. Three runs in a row, same env
(`w38run`, `--fileParallelism=false`, `CARDTABLE_PLAY_WORK_DIR=/tmp/claude-1000/w38-U/work`), same two
failures every time, same shape:

| run | when | HEAD at the time | result |
| --- | --- | --- | --- |
| 1 | before the CSS-family fix (step 2 unification was still using `prompts.css`'s own class names for all three shapes) | `436ef78` | `combat and targets…` FAILS (`no confirm button to click` — this lane's own bug, see below), `choices: confirm, order, …` FAILS, `a reveal: …` FAILS |
| 2 | after switching `ConfirmPrompt.tsx` to the `.confirm` family (`live.css`) | `436ef78` | `combat and targets…` **PASSES** (the lane's bug fixed), `choices: confirm, order, …` FAILS (same error, same text), `a reveal: …` FAILS (same error, same text) |
| 3 | after the `data-default` regression fix (the manager's report) | `436ef78` | identical to run 2: 1 passed, 2 failed, same two failures, same error text |

**The first failure (`combat and targets…`) was this lane's own bug** — `prompt-driver.ts` (unowned,
drives jar matches) selects `showConfirmDialog`'s default button by `.confirm__button[data-default]`;
the first pass of the unified `ConfirmPrompt.tsx` had switched that button's class away from
`confirm__button` to `prompt__submit`. Fixed by reusing the `.confirm` family `live.css` already carries
for `LiveBoard.tsx`'s Concede confirmation (see the report's step 2 section) — confirmed green in runs 2
and 3.

**The other two are not.** Across all three runs — spanning the CSS fix and the `data-default` fix, two
real behaviour changes to this lane's own files — both fail with byte-identical error text:

- `choices: confirm, order, tempShowZones, getChoices, showInputDialog, chooseSingleEntityForEffect`:
  `the scenario did not finish in 180000 ms`, always stopped right after seat 1 answers the FIRST ask in
  the chain (`confirm s1-1`, Serum Powder's "Use Serum Powder (116)'s ability?"), never reaching `order`,
  `tempShowZones`, `getChoices`, `showInputDialog` or `chooseSingleEntityForEffect`. The driver
  (`apps/ui/src/play/live/game-driver.ts`, not owned by this lane) just stops progressing; `drive`'s own
  180 s timeout is what throws.
- `a reveal: the label carries Forge's "(id)", and the card's own facts are in the browser anyway`:
  `expected 'Forest (N)' to contain 'card #N'` — `r.facts?.name` reads back `card #N` (the lookup's OWN
  fallback for "nothing found"), meaning `lookup.card(N)` missed for the id Forge's reveal named, in
  `apps/ui/src/play/prompts/lookup.ts` (not owned by this lane).

**Why this is not this lane's bug:**

1. Neither failing test exercises `ConfirmPrompt.tsx`, `DialogPrompts.tsx`, `wire.ts`, `jvm-harness.ts`
   or `match.ts`'s two touched comments — the only files this lane changed. The `choices` scenario's
   ONE step through this lane's code (`confirm` ask, i.e. `ConfirmAskPrompt`, renamed but not
   re-rendered) completes and is logged (`seat 1 answers confirm s1-1`); the stall is AFTER that, in
   `order`/`tempShowZones`/`getChoices`/`showInputDialog`/`chooseSingleEntityForEffect`, none of which
   this lane touches. The `reveal` test never reaches a `ConfirmPrompt`-family component at all —
   it is `getChoices`, resolved through `ChoicePrompts.tsx` and `lookup.ts`, both unowned.
2. `git log --oneline -8` at the time of run 3: HEAD is `436ef78` (lane H's `board.ts` helper
   consolidation, `e2e/**` only) on top of `ad3d84f` (wave 37's close) — no lane J or E commit has
   landed yet, and `git status --porcelain apps/server/` is clean. So the failure reproduces against
   essentially wave 38's STARTING POINT, before any other lane's work landed either.
3. Both failures are byte-identical across all three runs, including two runs that bracket a real
   behaviour change in this lane's own files (the CSS-family switch, the `data-default` fix) — if either
   fix had moved this failure at all, the error text or the stopping point would differ. It did not.

**What this looks like:** `game-driver.ts`'s own module header (this file, lines 56-84) already
documents a known race — `EVERY_PRIORITY_POLICY` pinning exists specifically because "a burst of phases
makes [a stale version-vs-message read] often instead of occasionally" — and separately, wave 38's own
plan names `auto.jvm.test.ts` as stale against a recent stop-policy/fork change (w35's land-actionable
fork change, or T3's `attackStopIsTheDeclaration`). This suite drives through the identical priority
machinery with the identical pin. A third jar suite silently red at HEAD, found only because this is the
first time anyone ran it this wave — the exact blind spot the code-quality retro and lane J's brief are
about (`docs/planning/retro-code-quality-2026-10-03.md`: "None of the 32 jar suites run in CI").

**Not fixed here.** A fix would mean editing `apps/ui/src/play/live/game-driver.ts` and/or
`apps/ui/src/play/prompts/lookup.ts` / `ChoicePrompts.tsx` — none owned by this lane
(`docs/planning/wave38-2026-10-03.md`'s §U row). Per the lane's own instructions: "if you believe you
need another [file], stop and report." Reported here; `confirm.jvm.test.ts` and the `combat and
targets…` case of `prompts.jvm.test.ts` (the one case this lane's files drive) are green. This is a
candidate for lane J's "jar suites, a real signal" scope or w39's engine wave, not U's.
