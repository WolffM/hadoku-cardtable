# A wave worktree that can run everything — what it needs, and what to fix

For the **tracker** who scaffolds a wave worktree, and the **manager** who runs in it.
Every item below cost a wave time. Each one says what bit, the setting that works
today, and the scaffolding change that would remove it. Fixing any of these is a
fair wave item; tick it off here when it lands.

## What a worktree is missing, and why

A worktree is a checkout of tracked files only. Everything the test suites need
from outside git is absent unless the scaffold puts it there:

| needed by | thing | where it really is | in a worktree |
| --- | --- | --- | --- |
| every `.ts` spawn | Node 24 | `~/.local/share/fnm/node-versions/v24.18.0/installation/bin` | host default `node` is **22**, so spawns break (memory `host-node-22-breaks-ts-spawns`) |
| jar suites, e2e | `CARDTABLE_FORGE_JAR` | `~/.local/share/cardtable/forge.jar` (`docs/FORGE_JAR.md`) | unset, so every jar spec **SKIPS and exits 0** |
| jar suites, e2e | `CARDTABLE_FORGE_RES` | **the main checkout's** `forge/forge-gui/res`, at the pin | unset; `forge/` is an uninitialised submodule here |
| reading Forge source | `forge/` at the pin | the main checkout's `forge/` (read-only) | empty dir |
| jar suites, e2e | `CARDTABLE_PLAY_WORK_DIR` | per lane, under `/tmp/claude-1000/` | defaults to **production's** `/tmp/cardtable-play`, which the pool boot-sweeps |
| everything | `node_modules` | main checkout's store | root symlink; per-package real dirs with `@hadoku/*` linked to the worktree |

## What bit in wave 33 (2026-10-01)

1. **The handoff pointed RES at the wrong Forge.** It said
   `~/.cache/cardtable-w8/forge-build/forge-gui/res`. That tree is at Forge
   `2ad70eb`; the pin, and the jar built from it, is `917bb193`. So every
   local jar and e2e run that wave used older card scripts than the jar, and
   every Forge line number a lane cited came from older source. CI and
   production read the main checkout's `forge/forge-gui/res` (`ci.yml`
   forge-e2e env; hadoku_site's wrapper), and CI was green, so nothing shipped
   wrong. But "verified locally" was against a different Forge.
   **Check:** `git -C <path> rev-parse HEAD` must equal
   `git -C ~/repos/hadoku-cardtable submodule status forge`.
2. **A run without the jar env looks like a pass.** The manager's first
   mutation run printed `9 skipped`, exit 0. Playwright treats a skip as
   success; only CI's `jq` gate (`skipped == 0`) refuses it.
3. **Five lanes, one host:** heavy runs needed one `flock`. `flock -x L -- cmd`
   runs nothing and exits 69 here, so drop the `--`.
4. **Stale JVMs from earlier waves.** 17 Forge JVMs from wave 31's lane F
   (cwd `/tmp/claude-1000/laneF/*`, a day old) plus one from a deleted w31
   worktree held the host at 46 GB of swap. That's plausibly behind several
   "flaky" timeouts this wave. Nobody's teardown swept them.
5. **e2e harness ports are shared** with CI's `forge-e2e` on hokon
   (19008/19028/19108/19128). A local run during a CI run fails on bind.

## The setting that works today (paste into every lane's commands)

```sh
export PATH="/home/hadoku/.local/share/fnm/node-versions/v24.18.0/installation/bin:$PATH"
export CARDTABLE_FORGE_JAR="$HOME/.local/share/cardtable/forge.jar"
export CARDTABLE_FORGE_RES="/home/hadoku/repos/hadoku-cardtable/forge/forge-gui/res"   # read-only use of the deploy tree
export CARDTABLE_PLAY_WORK_DIR="/tmp/claude-1000/w<N>-<lane>/work"
# Forge SOURCE to read: /home/hadoku/repos/hadoku-cardtable/forge/ (same pin). Never build or write there.
```

Run e2e from `e2e/` after `pnpm --filter @hadoku/ui --filter @hadoku/server build`.
Grep the output for `— SKIPPED:` before believing a green.

## Scaffolding to build (not done yet)

Ordered by how much each would have saved:

- [ ] **`scripts/wave-env.sh`**, committed and sourced by every lane. It exports the
  block above, derives RES from the main checkout's `forge/` and **fails** if
  that tree's HEAD isn't the pin, and fails if the jar is missing. One
  `source scripts/wave-env.sh <lane>` replaces five lines every brief has
  to carry, and the RES mistake becomes impossible. (Not `.env`: AGENTS.md bans
  `.env` files, and this holds no secrets, only paths.)
- [ ] **Link the main checkout's Forge into the worktree at scaffold time**: a
  gitignored link, e.g. `.claude/worktrees/w<N>-manager/.forge ->
  /home/hadoku/repos/hadoku-cardtable/forge`. Then lanes read the pinned source
  and res at a stable relative path. Do NOT symlink over the `forge/`
  submodule path itself: git sees a typechange, and initialising the
  submodule in a worktree breaks `git worktree remove` (memory
  `worktree-removal-with-forge-submodule`).
- [ ] **Make a jar-less e2e run loud, locally too.** `e2e/play/harness.ts`'s
  `forge.ok` skip is deliberate (a dev box without a jar), but a run where
  EVERY jar spec skipped could print one banner line, or `scripts/wave-env.sh`
  could set `CARDTABLE_E2E_REQUIRE_FORGE=1` and the harness could fail instead
  of skipping when it's set. CI already has the equivalent gate.
- [ ] **A teardown JVM sweep** in the manager protocol: SIGTERM every `java`
  whose `/proc/<pid>/cwd` is under `/tmp/claude-1000/w<N>-*`, the worktree, or
  a removed worktree path. Never `/tmp/cardtable-play` (production's spare)
  and never the actions-runner work dir (CI's).
- [ ] **A one-command scaffold check**, run by the tracker before handing out the
  manager command: Node 24 on PATH, jar present, RES at the pin,
  `realpath apps/ui/node_modules/@hadoku/carddata` inside the worktree, no
  stale JVMs, and one jar e2e spec actually RUN (not skipped).
