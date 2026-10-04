# J — `ci.yml`: forge-e2e's derived list, and the `forge-jvm` job

## The full serial run (the measurement)

```sh
source /tmp/claude-1000/w38-J/env.sh   # Node 24, jar env, CARDTABLE_PLAY_WORK_DIR=/tmp/claude-1000/w38-J/work, w38run
w38run sh -c 'pnpm vitest run --fileParallelism=false --reporter=default --reporter=json \
  --outputFile=/tmp/claude-1000/w38-J/full-report.json $(git ls-files "*.jvm.test.ts")'
```

- **Wall-clock: 1140 s (19.0 min)**, 06:07:06 to 06:26:06 UTC 2026-10-04. It ran alone under the wave
  lock, after waiting for CI's forge-e2e to leave the ports. It falls entirely after the manager's
  accidental parallel jar run (≈05:52 to 06:05).
- **`timeout-minutes: 30`**: 19 min × 1.5 = 28.5 min, plus checkout and install.
- 32 files, 64 tests: **59 passed, 5 failed, 0 skipped, 0 todo.** w21's 7 skips in `flow.jvm` are gone.
  With the jar present no `describe.skipIf` fires, so `expected_skips` is empty.
- Log: `/tmp/claude-1000/w38-J/full-run.log`. Report: `/tmp/claude-1000/w38-J/full-report.json`.

The 5 reds and where each one is pinned:

| test (full name, abbreviated) | list | why | evidence |
| --- | --- | --- | --- |
| board-play: "a player plays a land and casts spells…" | `known_failing` | red on main without U too (manager's baseline), U's runs, this run | `U-board-play-jvm-red.md` |
| prompts: "choices: confirm, order, …" | `known_failing` | same: baseline, U ×3, this run | `U-prompts-jvm-red.md` |
| flow: "Forge offers the same one ability twice…" | `known_failing` | `repeatedOffers` 0 in U's run and this one. The server answers Forge's re-ask itself since `c75060d` (the `ask-auto-answered … forge re-asked` log line in my auto trace), so I expect it constant. **Two runs, not proven constant.** | `U-flow-jvm-red.md` |
| prompts: "a reveal: …" | `known_flaky` | the tracker saw it green on main at `ae1a236`, the manager's baseline red: a decode race | `U-prompts-jvm-red.md` |
| scenario-blockers Q12 | `known_flaky` | 3 of 4 runs red, 1 green | `J-blockers.md` |

`auto.jvm.test.ts` is **not** pinned. It is fixed (`J-auto.md`).

## The guard

The judging step reads the vitest JSON report and compares by **full test name** against three
heredoc lists in the step, each entry with a `#` reason line naming its evidence file. It exits 1 on:
an unpinned failure; a `known_failing` test that did not fail; an unpinned skip or todo; an
`expected_skips` entry that did not skip; a `known_flaky` entry absent from the report; a report with
no tests; and a missing or empty report. The run step no longer fails on vitest's own exit code,
because a pinned failure would otherwise red the job. The judging step is the gate.

**Bite, proven locally.** The step's exact `run:` script was extracted from `ci.yml` by
`/tmp/claude-1000/w38-J/extract-guard.py` and run with **`bash -eo pipefail`**, the shell the runner
uses. That flag mattered: the first draft's `grep` on an empty list exited 1 under pipefail and redded
a clean report, and it is fixed with a scoped `|| true`. Driver: `/tmp/claude-1000/w38-J/bite.sh`.

| report | exit |
| --- | --- |
| the real full-run report | **0** |
| + one passing test flipped to `failed` (unpinned failure) | **1**: `"failed, not pinned": ["a real match starts with one deck from each power-summer era …"]` |
| + one passing test flipped to `skipped` | **1**: `"skipped, not pinned": […]` |
| the `known_failing` board-play test flipped to `passed` | **1**: `"pinned as failing, did not fail": [board-play …]` |
| the `known_flaky` Q12 flipped to `passed` | **0** (accepted) |
| Q12 deleted from the report | **1**: `"pinned as flaky, not in the report"` |
| empty report file | **1** |

Outputs: `/tmp/claude-1000/w38-J/bite-*.out`.

## forge-e2e's derived spec list

`grep -lE 'forge\.ok|startPlayStack|startScenarioMatch' e2e/*.spec.ts` gives 9 files today: the old 8
plus `arrow.spec.ts`. It never matches `streamed-live.spec.ts` or `draft.spec.ts`/`room-mode.spec.ts`.
An `excluded` heredoc in the step takes `<file>  # <reason>` lines. **It is empty.** Each entry prints a
`::warning::` and is removed with `grep -vxF`. An empty derived list is an error. I tested it by
extracting the step with the pnpm call stubbed to `echo`: empty list → all 9 run; one `arrow.spec.ts`
entry → 8 run plus the warning (`/tmp/claude-1000/w38-J/e2e-step*.sh`).

One risk to watch: the grep keys on those three identifiers appearing **in the spec file**. If a later
helper consolidation moves every `forge.ok`/`startPlayStack` call out of a spec and into
`e2e/play/*.ts`, that spec silently leaves the list.

## Other edits to ci.yml

- The `:192-196` comment now says the jar suites run in `forge-jvm`.
- The w33-w36 "joins" history comments over the old hand-kept list are deleted, because the list
  they explained is gone.
- `forge-jvm` lists its files with `git ls-files '*.jvm.test.ts'` (lane J's draft used `find apps`),
  and writes both a default and a JSON reporter.
- Not touched: the concurrency group, the port wait, `redeploy.yml`.

## actionlint

`/tmp/claude-1000/w38-J/actionlint .github/workflows/ci.yml` exits 1, and its only findings are the two
`label "pm2-host" is unknown` lines (the existing forge-e2e job's, and `forge-jvm`'s identical
`runs-on`). Output: `/tmp/claude-1000/w38-J/actionlint.out`.

## Not verified

- The job has not run on CI. The `[self-hosted, pm2-host]` runner, `runner.temp`, and the jar paths are
  copied from forge-e2e, not observed in this job.
- 19 min is one local measurement. CI's host load can differ.
