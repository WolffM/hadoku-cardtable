# Wave 33 — the forge-e2e job's exact command, run by the manager

Command (`.github/workflows/ci.yml` forge-e2e step, run locally on this host with the w31 jar, after `pnpm --filter @hadoku/ui --filter @hadoku/server build`):

    pnpm --filter @hadoku/e2e test play.spec.ts table-fit.spec.ts w31.spec.ts w32.spec.ts w33.spec.ts
    jq -e '.stats.skipped == 0 and .stats.unexpected == 0 and .stats.expected > 0' report.json

Three consecutive runs, 2026-10-01, all on the landed tree (lanes S, B, G, L committed; E and the Q18 rework in the worktree):

```
run1 playwright=0 gate=0 secs=206 stats={"startTime":"2026-10-01T22:45:33.062Z","duration":205531.161,"expected":22,"skipped":0,"unexpected":0,"flaky":0}
run2 playwright=0 gate=0 secs=210 stats={"startTime":"2026-10-01T22:48:59.137Z","duration":209589.45299999998,"expected":22,"skipped":0,"unexpected":0,"flaky":0}
run3 playwright=0 gate=0 secs=216 stats={"startTime":"2026-10-01T22:52:29.304Z","duration":215622.395,"expected":22,"skipped":0,"unexpected":0,"flaky":0}
```

22 tests per run (play 2, table-fit 2, w31 7, w32 2, w33 9), 0 skipped. Local wall 206–216 s for the test step alone, against the 8-minute budget (D1); the CI runner's measured job time is in the closing note.

Manager's mutation re-runs (one per lane, e2e level, jar present):

- S: `refreshActionable` call commented out → Q17 fails 3/3 at its precondition ("alice is offered her free creature"); restored → Q17 green in the three runs above.
- G: `drawAutoTargetArrows` made a no-op → Doom Blade arrow spec fails 2/2 on the arrow assertion; restored → green.
- B: `&& !item.isAbility` removed → with the ORIGINAL glint-hawk (Prodigal Sorcerer, a tap ability) Q18 still PASSED 2/2 — vacuous. Reworked to Shivan Dragon (repeatable non-tap ability, source re-offered while its ability is on the stack): reverted fails 3/3 on the behaviour assertion, restored 10/10 (`q18-mutation.md`).
- L: `.live__step` back to `flex: 1 1 0` → the e2e rail test still PASSES 3/3. The e2e rail check does not catch L's change; the flake it showed was the test's own (bob's page never resized, 1280×720 vs 800). L's claim is held by LiveBoard.test.ts (reverted fails / restored passes) and the measured numbers in l1-rail-rows.md.
