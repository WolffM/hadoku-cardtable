# Lane E — run evidence (wave 35)

FINAL pass, after S's (match.ts/auto.ts/visibility.ts) and B's (Board.tsx) fixes landed.
Env used for every run below:

```sh
export PATH="/home/hadoku/.local/share/fnm/node-versions/v24.18.0/installation/bin:$PATH"
export CARDTABLE_FORGE_JAR="$HOME/.local/share/cardtable/forge.jar"
export CARDTABLE_FORGE_RES="/home/hadoku/repos/hadoku-cardtable/forge/forge-gui/res"
export CARDTABLE_PLAY_WORK_DIR="/tmp/claude-1000/w35-e/work"
```

Every run: `pnpm --filter @hadoku/ui --filter @hadoku/server build` under the
shared `flock`, then `npx playwright test` from `e2e/`. tsc and eslint are
clean across every file this lane touched, every time they were run.

## This lane's own fix, applied after the manager's R4 routing

S confirmed (real socket.io + real jar harness, 4/4) the caster DOES get
exactly one `chooseSingleEntityForEffect` — the `notify:setSelectables` this
spec first caught was Thoughtseize's own TARGETING step (choose a player),
which it never answered. Two real bugs in the spec, not the product:

1. It never clicked the opponent to answer the target ask at all (fixed:
   added an `opponentTarget` click, same pattern as `w33.spec.ts`'s own
   `clickOfferedTarget`).
2. Even after (1), it still read false: `play/prompts.ts`'s own
   `answerPrompt` has a case for `chooseSingleEntityForEffect` and was
   answering Thoughtseize's discard choice itself, before this spec's own
   `choosable`/`greyed` read ever ran. Fixed by reading the open ask's
   `data-method` first and skipping the generic drain when it is
   `chooseSingleEntityForEffect`, leaving that one ask for this spec's own
   manual click.

**R4: 10/10 (run once), then 10/10 again (`--repeat-each=10`).**

## B's R9b fix (settle/release race) — confirmed

**R9b: 10/10** after B's fix (`2181aed`, `notePlayedTo` safe to call twice via
a `useSyncExternalStore`-backed version). Was ~25% pass / ~75% fail across 17
runs before. Comment in `w35.spec.ts` updated to record the fix, not left
describing a live bug.

## B's table-fit fixes — one confirmed, one still open

**Left-column spacing (this lane's own fix, from B's exact spec)**: applied
precisely as B wrote it in `b-screens.md` §(2) — a `manaPool` field on
`measureColumns()`, and the single "counts → graveyard" gap check split into
two (counts→manaPool, manaPool→graveyard, mirrored for `them`), same
`GAP_MAX` tolerance on each. **Confirmed passing** in both the full run and
isolation.

**Tapped-land arrange-drag ghost — STILL REPRODUCES after B's fix**: B's
`disabled`→`tabIndex` change (`2181aed`) is confirmed present and live in
this exact harness (`tabindex="-1"` read directly off the button, not
`disabled`) — the fix landed and is running. But the symptom is unchanged:
`{ghost:0, indicator:1, pickedUp:0}`, same as before, where B's own isolated
verification (a replay server through `live/harness.html`, a different path
than this e2e test) showed `{1,1,1}` for the same kind of card. Something
else in the real e2e path still suppresses the arrange-drag's press for a
non-selectable, tapped card — not `disabled` any more, so the `disabled`
theory was only part of the story. Comment in `table-fit.spec.ts` records
this exact delta (tabindex confirmed, symptom unchanged) for whoever picks
it up next.

## S's auto.ts fix (land-blind auto-pass) — STILL REPRODUCES

`apps/server/src/play/auto.ts`'s fix (`ad2d4b7`, `nonLandSources` excluding
`ownBattlefieldLandIds`) is confirmed present and compiled into the running
`dist/index.js` (`grep -c nonLandSources` finds it; the dist's mtime is after
the commit). `play.spec.ts`'s "a spell resolves unattended" check still fails
**identically**, twice in a row: same five casts, same order (fixed seed),
every one `left:true, arrived:false, pressed:[]`. Not re-diagnosed further
from here (server-side, S's file) — reported as-is: the land exclusion did
not change this test's outcome at all, so either a different actionable
source is still blocking auto-pass for this exact seed, or the fix isn't
reaching the code path this real game takes.

## S's Q17 fix (match.ts orderings) — confirmed, matches S's own number

**w33.spec.ts full-file run: 9/9 clean**, then a second full run hit the
known, unrelated host-load "sets up" precondition timeout on an UNRELATED
test (`own-spell`'s own 45s precondition, not Q17's race) — re-run clean,
9/9. A `--repeat-each=5` (45 total tests, 5× Q17): **45/45**, including Q17
every time. Consistent with S's own isolated measurement (61/66 ≈ 92%); this
lane's smaller sample (6 total runs of Q17 today, all passing) did not catch
the residual client-side timing case S already named, which is expected at
that rate over 6 trials.

## Full `forge-e2e` CI-set runs, timed — final

| Run | Elapsed | expected | skipped | unexpected | Notes |
| --- | --- | --- | --- | --- | --- |
| Before this round's fixes (yesterday's final) | 416s (6.9m) | 31 | 4 | 6 | R4, R9b, table-fit×2, w33 Q17, play.spec.ts. |
| **Final, after S/B/L's fixes + this lane's R4/table-fit-spacing fixes** | **475s (7.9m)** | **39** | **0** | **2** | |

**Final state, 2 `unexpected`, both precisely diagnosed and NOT this lane's
files to fix further**:

1. `play.spec.ts` — the "resolves unattended" check, despite S's confirmed,
   compiled `nonLandSources` fix, still fails identically (100% reproducible,
   2/2). Needs S's own further look — the fix did not change this test's
   outcome.
2. `table-fit.spec.ts` — the tapped-land ghost gap, despite B's confirmed,
   live `tabIndex` fix, still reproduces identically (100% reproducible,
   2/2). Needs B's own further look — `disabled` was not the whole story.

Zero `skipped` — the w33 serial-mode cascade from Q17 (the thing that
produced non-zero skips before) is gone now that Q17's own race is fixed.

## What is NOT a bug, corrected from an earlier misreading this session

- The webServer's `no Forge` console line — `e2e/harness.ts`'s own webServer
  deliberately never gets Forge env (draft matches don't touch it); the REAL
  play server (`startPlayStack`) gets it from this shell's `process.env`.
- `live-log-peek` assertions always reading count 0 (the element does not
  exist anywhere in `apps/ui/src` except as this test's own absence-check).

## Files changed (this lane's `e2e/**` + `.github/workflows/ci.yml` only)

`e2e/w35.spec.ts` (new), `e2e/w31.spec.ts`, `e2e/w33.spec.ts`,
`e2e/w34.spec.ts`, `e2e/table-fit.spec.ts`, `e2e/play.spec.ts`,
`e2e/play/hands.ts`, `e2e/play/scenario.ts`, `e2e/arrow.spec.ts`,
`e2e/w32.spec.ts`, `.github/workflows/ci.yml` (added `w35.spec.ts` to the
forge-e2e job). No file outside this lane's ownership was touched.
