# Lane rules (cardtable)

Read all of this before you start. Your brief adds to it; where they differ, the brief wins.

## Verify after landing (operator, 2026-10-21 — overrides older proof rules)
- Lanes do NOT dispatch CI proofs. Prove locally: a failing test first (unit / component / server test from the
  repo root: `CI=1 node_modules/.bin/vitest run <paths>`, read the Tests line), then the fix; typecheck + eslint on
  what you touched. Report: the diff's reasoning, the local RED→GREEN evidence, and which Forge specs/suites main's
  post-land run should check. The manager reviews and lands; main's push run and the 2-hourly full run verify; a red
  there is fixed forward or reverted at once.
- Exception: ONE claw dispatch only when no local test can show the failure (a Forge engine/fork change, a bridge
  behaviour only real Forge produces). Say why. Wait for it with ONE background
  `bash scripts/lanes/watch-run.sh <run-id>` call — never sleep/until polling loops.
- Commit your ledger row(s) yourself as `| AF??? | …` INSIDE the table of docs/planning/playtest-ledger.md
  (land.sh numbers them). Only the operator writes ✅.

## Fix quality (operator)
- "build robust fixes (not bandaid fixes…)"; 2026-10-21: "evaluate whenever we find bugs like this whether it's
  something we can solve at a system level. i want to avoid hardcoded fixes as much as possible" and "we must avoid as
  much duplicate code paths as possible". Name the CLASS, fix the shared mechanism, survey the family with counts, never
  special-case one card/spec/screen. Before adding a helper, grep for an existing one and extend it. Delete what your
  change makes dead. Consolidation work lands net negative in non-test lines.
- Port existing designs; theme tokens only; no explanatory UI text (hover tips are fine). No ticket ids in comments.
- Confirm behaviour from telemetry/logs/real runs, not by deducing client state from code.

## You report; the manager lands
- Work only in your own worktree and branch (named in your brief). Never in the main checkout
  (`/home/hadoku/repos/hadoku-cardtable` is the production deploy tree). Never push to `main`; never run land.sh.
- Verify branches: `verify/<lane>*` only, explicit refspec; delete them when you finish.
- Never `git stash` (shared across worktrees); WIP-commit instead. `git -C <absolute path>` in chains; no `git add -A`
  in the deploy tree. No AI attribution in commits.
- Claim your areas first: `bash scripts/lanes/claim.sh claim <area> lane-<x> "<note>"`; if refused, coordinate or
  report; `release --all lane-<x>` when done.

## Safety on hokon (this host runs production)
- Never read files under `/tmp/cardtable-play` except the named regular files `stream.jsonl`, `bridge.stderr.txt`,
  `jvm.json` (fifos are live pipes).
- Never `pkill`/`kill` by pattern; kill only PIDs you printed yourself. Stop any dev server you start.
- Never build jars (mvn) or install a Forge jar on hokon. Engine changes: commit on a fork branch (push to WolffM/forge's
  `fork` remote, never `origin`), based on the current pin, and report the sha; the manager builds and switches.
- /tmp is a shared tmpfs with production and has been wiped/filled: keep scratch and TMPDIR under ~/.cache/lane-<x>
  and delete it when done. Use a private Chromium script for browser checks, not the shared Playwright MCP browser.

## Working cheaply
- Grep logs; never read whole logs or huge files (a tool result over ~10k chars is paid again every later turn).
- Rebase onto origin/main before reporting.

## Report
- Branch + commits (spec commit separate from fix), cause with evidence, local RED/GREEN, e2e specs/jvm suites for
  main's post-land run, files touched outside your brief, what you deleted, non-test line counts before/after for
  consolidation work. Do not land.
