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
| jar suites, e2e | `CARDTABLE_PLAY_WORK_DIR` | per lane, on disk under `~/.cache/cardtable-play-work/` | defaults to **production's** `/tmp/cardtable-play`, which the pool boot-sweeps |
| everything | `node_modules` | main checkout's store | root symlink; per-package real dirs with `@hadoku/*` linked to the worktree |

## What bit in wave 33 (2026-10-01)

1. **The handoff pointed RES at a different Forge checkout than the pin.** It said
   `~/.cache/cardtable-w8/forge-build/forge-gui/res`. That tree is at Forge
   `2ad70eb`; the pin, and the jar built from it, is `917bb193`. **Corrected by
   the tracker, 2026-10-02: the `res` directories are byte-identical** (`diff -rq`
   of the two trees prints nothing; the two fork commits differ only in
   `LondonMulligan.java` and `AvailableActions.java`, both Java), so the card
   scripts the runs used were the same as the jar's, and no local verification
   was invalidated (the tracker re-ran w33's suites on the pinned `res`: the same
   results). What WAS different is the Java *source* in the old tree: a Forge line
   number a lane cited from it can be stale. CI and production read the main
   checkout's `forge/forge-gui/res` (`ci.yml` forge-e2e env; hadoku_site's
   wrapper). The mismatch is still worth preventing, as hygiene.
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
export CARDTABLE_FORGE_JAR="$HOME/.local/share/cardtable/jars/$(git ls-tree HEAD forge | awk '{print $3}').jar"   # per-pin, from THIS worktree's own pin (docs/FORGE_JAR.md); `test -f` it before trusting it — a pin nobody has built yet leaves this pointing at nothing
export CARDTABLE_FORGE_RES="/home/hadoku/repos/hadoku-cardtable/forge/forge-gui/res"   # read-only use of the deploy tree
export CARDTABLE_PLAY_WORK_DIR="$HOME/.cache/cardtable-play-work/w<N>-<lane>"   # on DISK, never under /tmp: see below
# Forge SOURCE to read: /home/hadoku/repos/hadoku-cardtable/forge/ (same pin). Never build or write there.
```

Run e2e from `e2e/` after `pnpm --filter @hadoku/ui --filter @hadoku/server build`.
Grep the output for `— SKIPPED:` before believing a green.

**The work dir goes on disk, not under `/tmp`.** `/tmp` is tmpfs on this host and CI's
work dir (`runner.temp`) is on btrfs. Forge's per-match run directory lives there, and on
tmpfs a match starts fast enough that the scenario-start race (the first cast after a
scenario applies is dropped) fires most of the time. Measured 2026-10-06 on
`scenario-thoughtseize.jvm.test.ts`, same code, same host: 5 of 6 runs red with the work
dir under `/tmp/claude-1000`, 8 of 8 green under `~/.cache`. This block said
`/tmp/claude-1000/w<N>-<lane>/work` until that day, so a lane's "flaky" jar red from before
then may have been this. `rm -rf` the directory when the lane is done.

**A `[nightly]` test skips with that block, on purpose.** A jar-gated test too slow for
every push gates itself on `nightly` (`apps/server/src/play/scenario.ts`) and carries
`[nightly]` in its title; `export CARDTABLE_JVM_NIGHTLY=1` runs it. CI sets that on
every run that is not a push, and its judge accepts a `[nightly]` skip only on a push
(`ci.yml`, `forge-jvm`). So the block above runs what a push to main runs, which is the
set a landing has to keep green.

## Landing: the wave lands itself (2026-10-06)

No tracker hop. As soon as the manager has verified a lane and committed it on the wave branch, it runs
`scripts/land.sh` from the wave worktree. The script:
1. takes `/tmp/claude-1000/land.lock`;
2. cherry-picks every wave commit that main lacks onto a throwaway worktree at the latest `origin/main`;
3. bumps the app versions those commits touched;
4. runs `pnpm run check`;
5. pushes `HEAD:main`.

Lanes still working keep their uncommitted files, because the wave branch is never rebased. A later land skips
what an earlier one pushed.

**CI is the combined gate.** Each wave runs its own full gate once, before its last land; nobody re-runs it after
a merge. A red CI run belongs to the wave that pushed it, and that wave fixes it and lands the fix. Waves never edit
version fields by hand; the script does.

Why: w49 and w50 were READY at 00:30 and 00:50 on 2026-10-06 and reached main at 08:20, because they waited on the
tracker's merge plus a duplicate local gate.

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
