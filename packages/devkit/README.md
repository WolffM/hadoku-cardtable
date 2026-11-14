# @hadoku/devkit

A game repo's landing and release discipline, parameterised by app id: claims, land,
prove-and-land, run watching, release notes, the build version and the daily telemetry watch.
Every app-specific value comes from the repo's `devkit.config.json`; the app's own steps plug in
as hooks the config names. MIT. Private until it joins the publish list.

## What a repo provides

1. **`devkit.config.json`** at its root (schema: `src/config.ts`; check one with
   `node packages/devkit/src/config.ts check`). A bad field stops every tool with the field and
   what is wrong.
2. **Entry points** at fixed paths, each a one-line exec of the package's file with
   `DEVKIT_ROOT` set to the repo. `land-worktree.sh` runs the lane's own `scripts/land.sh`, so
   that one path is required; the rest are convention:

   | entry point | runs |
   | --- | --- |
   | `scripts/lanes/claim.sh` | `src/lanes/claim.sh` |
   | `scripts/lanes/watch-run.sh` | `src/lanes/watch-run.sh` |
   | `scripts/lanes/land-worktree.sh` | `src/lanes/land-worktree.sh` |
   | `scripts/lanes/prove-and-land.sh` | `src/lanes/prove-and-land.sh` |
   | `scripts/land.sh` | `src/lanes/land.sh` |
   | `scripts/telemetry/daily.sh` | `src/telemetry/daily.sh` |
   | `scripts/telemetry/watch.ts` | `main` of `src/telemetry/watch.ts` |
   | `scripts/release/collect.ts`, `credits.ts` | `main` of `src/release/*.ts` |

   ```sh
   #!/bin/bash
   exec env DEVKIT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)" bash "$(dirname "$0")/../../packages/devkit/src/lanes/claim.sh" "$@"
   ```
3. **Node 24** somewhere `src/lib.sh` finds it (`$DEVKIT_NODE`, `PATH`, or fnm), and `zod`.

## The config, and what each field replaced

Step 1 of wave 118d tabled every app-specific value the scripts hardcoded (lines as of
93413b1bc); each became a field. `scripts/devkit-config.test.ts` pins cardtable's config to them.

| field | cardtable's value | replaced |
| --- | --- | --- |
| `appId` | `cardtable` | `cardtable` in watch.ts's report title (:543), digest (:636), attachment name (:730) |
| `repo` | `WolffM/hadoku-cardtable` | watch-run.sh:20, prove-and-land.sh:20, land.sh:209; runner-name trim watch-run.sh:100 |
| `envPrefix` | `CARDTABLE` | `CARDTABLE_CLAIMS` claim.sh:21, `CARDTABLE_REPO` watch-run.sh:20 / prove-and-land.sh:20, `CARDTABLE_VERSION` build-version.ts:40, `CARDTABLE_TELEMETRY_KEY(_FILE)` watch.ts:694-708 / daily.sh:26-37 |
| `stateDir` | `~/.local/state/cardtable` | the root of claim.sh:21 and daily.sh:27 |
| `claimsFile` | `~/.local/state/cardtable/claims.tsv` | claim.sh:21 |
| `scratchDir` | `/tmp/claude-1000` | watch-run.sh:25, prove-and-land.sh:31, land.sh:48 |
| `nodeBin` | `~/.local/share/fnm/node-versions/v24.18.0/installation/bin` | land.sh:24, land-worktree.sh:25, daily.sh:28 |
| `trees.deploy`, `trees.ppe` | `~/srv/hadoku-cardtable`, `~/srv/hadoku-cardtable-ppe` | named for tools and docs; cardtable's link script still reads its own copy (`land.linkDeps`) |
| `ci.workflow`, `ci.name`, `ci.checkJob` | `ci.yml`, `CI`, `check` | land.sh:209's run-list hint |
| `proof.workflow` | `forge.yml` | prove-and-land.sh:49, :54, :58 |
| `proof.maxInFlight` | `3` | prove-and-land.sh:51 (three jdk21 claws) |
| `proof.select` | `scripts/ci/select-forge-tests.ts` | new: the hook `--plan` runs to show what the proof would pick |
| `releases.dir` | `docs/releases` | build-version.ts:42, credits.ts:16 |
| `ledger` | `docs/planning/playtest-ledger.md` | land.sh:64, collect.ts:20 |
| `land.lock` | `/tmp/claude-1000/land.lock` | land.sh:23 |
| `land.devVault` | `~/repos/hadoku_site/scripts/secrets/dev-vault.mjs` | land-worktree.sh:27 (`../hadoku_site/…` from the main checkout) |
| `land.linkDeps` | `scripts/link-worktree-node-modules.sh` | land.sh:121-123 |
| `land.unsetEnv` | `CARDTABLE_FORGE_JAR`, `CARDTABLE_FORGE_RES` | land.sh:197 |
| `land.botCommits` | `^chore: auto-update @wolffm/` | land.sh:213 |
| `land.tests.runAllList` | `scripts/ci/run-all.txt` | land.sh:161 |
| `land.tests.whole` | `^packages/`, `^games/[^/]+/packages/`, `^apps/ui/src/test-setup\.ts$` | land.sh:161 |
| `land.tests.relatedOnly` | `^packages/game-(server\|ui)/src/` | land.sh:161 |
| `land.hooks.beforeCheck` | `scripts/art/land-art-rows.sh` | land.sh:131-146, the Magic art rows, now cardtable's own script |
| `telemetry.service` | `cardtable` | watch.ts:753 |
| `telemetry.path` | `/cardtable` | watch.ts:752, the site split at :210 |
| `telemetry.keyFile` | `/home/hadoku/repos/hadoku-cardtable/.devvault.local.json` | daily.sh:26 |
| `telemetry.outDir` | `/home/hadoku/.local/state/cardtable/telemetry` | daily.sh:27 |
| `telemetry.backupJob` | `cardtable:state-backup` | watch.ts:53 |
| `telemetry.battletestJob` | `site:e2e-members` | watch.ts:54 |
| `telemetry.tourUserId` | `c8c59a87-…` | watch.ts:46 |
| `telemetry.discordWebhookSecret` | `DISCORD_CARDTABLE_DAILY_WEBHOOK` | watch.ts:719-725 |
| `health.prod`, `health.ppe` | `9008`, `9011` | the ports docs and skills curl (`node packages/devkit/src/config.ts get health.ppe`) |

Left in cardtable because they are Magic or Forge: `scripts/lanes/build-jar.sh` (the jar),
`scripts/art/land-art-rows.sh` (a land hook), `scripts/ci/select-forge-tests.ts` (the proof's
selection hook) and `scripts/link-worktree-node-modules.sh` (its deploy trees' node_modules).

## Leaving a block out

- no `proof`: prove-and-land rebases and lands with no proof run;
- no `ledger`: land numbers nothing and collect lists commits only;
- no `land.linkDeps`: land always runs a frozen install;
- no `telemetry`: daily.sh and watch.ts refuse, naming the missing block;
- no `telemetry.battletestJob` / `tourUserId` / `discordWebhookSecret`: no battletest set aside,
  no tour account, no `--post`.
