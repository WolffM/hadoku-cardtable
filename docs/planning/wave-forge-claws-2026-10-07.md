# Wave forge-claws — forge-e2e and forge-jvm run on the claws, off hokon

**Cut 2026-10-07 by the fleet tracker** (hadoku-fleet-manager session), at the
operator's request: _"the biggest problem in our system right now is how
cardtable runs are processed … hokon is the only runner … i dont think it
should be a problem for other runners to handle this as well."_ Named, not
numbered, so it cannot collide with cardtable's own wave sequence. Base
`68bb3d4`. Closes cardtable#5.

## Why

Both Forge jobs in `.github/workflows/forge.yml` run on `[self-hosted, pm2-host]`,
which only hokon (the operator's workstation) carries. Fleet job history, 14 days:

| job       | runs | succeeded | p50     | p90     |
| --------- | ---- | --------- | ------- | ------- |
| forge-e2e | 178  | 100       | 117 s   | 872 s   |
| forge-jvm | 45   | 28        | 1,182 s | 1,507 s |

Most of the misses are hokon itself: its own load, port fights with local wave
e2e runs, and `heavy.lock`, which makes CI queue behind the operator's own
agent waves. On top of that, `forge-jvm` is ordered after `forge-e2e`
(`needs: forge-e2e`) only because both share that one host, so a push's Forge
signal takes e2e + jvm end to end.

## What is actually needed, and what is not

Measured by the tracker before cutting. Do not re-derive.

**Already in place (fleet side, done):**

- **`jdk21` is earned on claw-3, claw-4, claw-5, claw-8 and claw-9.** Temurin
  21.0.12.1 + Maven 3.9, on the stock PATH, proved by compiling and running a
  class from a non-login shell. Recorded in the manifest (hadoku_site
  `0579ff62`); runners on those claws carry the label. **claw-5 never takes
  cardtable** (fleet-manager #82, slow tier), so the pool is claw-3/4/8/9, each
  16 GB.
- **Teardown of orphans is free on a claw.** Every claw job runs inside its own
  systemd unit with `KillMode=control-group` (verified on claw-4), so a server or
  JVM the job leaves behind dies when the job's unit ends. cardtable#5's
  "process-group teardown" item is NOT needed. Keep the existing cwd-scoped
  teardown step as is; it is harmless.
- **Ports are already overridable.** `e2e/identities.ts:46-47` and
  `e2e/play/harness.ts` read `CARDTABLE_E2E_*_PORT`. No harness change: the
  workflow only has to choose free ones.
- **TMPDIR on the claws is now dot-free.** Fleet wave 4b first put it at
  `~/.cache/runner-tmp`. express's `send` 404s any path with a dot segment, and
  both e2e harnesses copy the bundle into `tmpdir()`, so every claw e2e would
  have served 404s behind a green `/health`. That is why `f72a9ba` pinned
  `check`'s TMPDIR to `/tmp/cardtable-ci-tmp`. Fleet-manager 0.27.18 moves it to
  `~/runner-tmp`; the tracker rolls it out before this wave lands anything.

**What this wave builds:**

1. **The Forge bundle, cached per pin on each claw** (§A). This is the only
   real work: the jar and `forge-gui/res` exist only on hokon today
   (`~/.local/share/cardtable/jars/<pin>.jar`, and the HUMAN checkout's
   submodule). CI's checkout fetches no submodule. Pin churn is about 5 moves in
   30 days, so roughly 20 cold builds a month across four claws. Everything else
   is a cache hit.
2. **`forge.yml` on the claws** (§B): `runs-on`, paths from the bundle, per-run
   ports, no `heavy.lock`, and the two jobs in PARALLEL.
3. **`check` back off tmpfs** (§B): drop `f72a9ba`'s `TMPDIR: /tmp/cardtable-ci-tmp`
   once the fleet TMPDIR is confirmed dot-free. `/tmp` is a RAM disk on the
   claws, and #101 failed four jobs when it filled.

## Size — checked before dispatch

2 lanes, one interface between them (below). Target 3 h, hard stop 4 h. The long
pole is §A's first cold build on a claw, then §B's three proof runs.

## Settled — do not re-open

- **The interface between A and B.** `scripts/forge-bundle.sh` takes no
  arguments and runs from a checkout root. It resolves the pin with
  `git ls-tree HEAD forge | awk '{print $3}'`, ensures
  `${CARDTABLE_FORGE_CACHE:-$HOME/.cache/cardtable-forge}/<pin>/{forge.jar,res/}`
  exists, and prints exactly two lines on stdout, `CARDTABLE_FORGE_JAR=<abs>`
  and `CARDTABLE_FORGE_RES=<abs>`. Everything else goes to stderr. It exits
  non-zero, saying why, on any failure: a missing pin, a fetch failure, a build
  failure, a jar that fails the verifications, or a `res/` without
  `cardsfolder/`. B appends those two lines to `$GITHUB_ENV`.
- **Build exactly as `docs/FORGE_JAR.md` does**: a scratch clone of
  `WolffM/forge` at the pin (a shallow fetch of that one sha is fine), `mvn -q
-pl forge-gui-desktop -am clean package -DskipTests -Dmaven.test.skip=true`,
  the jar verifications FORGE_JAR.md lists, then copy the jar and
  `forge-gui/res`. Never build inside a checkout's `forge/`.
- **Atomic and locked.** Build into a temp dir beside the target, then `mv`
  into place, under `flock` on a per-pin lock file. Two jobs on one claw (or a
  job and a retry) can race. A half-written bundle must never be visible under
  the final name.
- **The guards stay.** "Forge is present, or fail" and "nothing skipped, or
  fail" are what turn a missing bundle into a red instead of a silent skip.
- **hokon's production jar is untouched.** `~/.local/share/cardtable/forge.jar`
  and `jars/` serve the pm2 `cardtable` warm spare; this wave is CI only.
- **No fixed ports, no host-wide locks on a claw.** Each claw runs 3–4 jobs at
  once, and different refs' Forge runs can land on the same claw.
- **`runs-on: [self-hosted, hadoku-builder, jdk21]`.** Never `ubuntu-latest`
  (the hosted runner has no bundle cache and no reason to).
- **Write scratch under `$RUNNER_TEMP` or `$TMPDIR`**, never a literal `/tmp`.

## Concurrent work — hands off

- **w53** is closed (closing notes `468ee19`); only its teardown is pending.
  Its E lane owned `ci.yml`'s jar resolution, which has since moved into
  `forge.yml` (`a7dd8b2`). Merge `origin/main` before landing.
- **The cardtable tracker session** is told about this wave by message. If it
  cuts a wave that touches `forge.yml`, `scripts/`, `docs/FORGE_JAR.md` or
  `docs/WAVE_WORKTREE.md`, the later wave rebases.

## Blast radius

| contract changed                                                     | lane | readers                                                                                           | who adapts each        |
| -------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------- | ---------------------- |
| where CI gets the Forge jar and res (`CARDTABLE_FORGE_JAR` / `_RES`) | A, B | `forge.yml` both jobs; `docs/FORGE_JAR.md` CI section; `docs/WAVE_WORKTREE.md` env block          | B (workflow), A (docs) |
| Forge jobs run on claws, in parallel                                 | B    | `forge.yml` only; `redeploy.yml` reads `ci.yml`, not `forge.yml` (`a7dd8b2`: Forge gates nothing) | B                      |
| `check`'s TMPDIR goes back to the runner's                           | B    | `ci.yml` `check` env and its "dot-free temp dir" step                                             | B                      |

## Lanes

| WS  | lane                                                 | owns (exact files)                                                                                                                                                                            | brief |
| --- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| A   | the Forge bundle, cached per pin                     | NEW `scripts/forge-bundle.sh`, NEW `scripts/forge-bundle.test.mjs` (or the repo's test idiom for shell), `docs/FORGE_JAR.md` (a new "CI on the claws" section; production sections untouched) | §A    |
| B   | forge.yml on the claws, in parallel; check off tmpfs | `.github/workflows/forge.yml`, `.github/workflows/ci.yml` (`check`'s TMPDIR env and step ONLY), `docs/WAVE_WORKTREE.md` (port and jar lines)                                                  | §B    |

**Ordering:** A lands first. B writes against the interface above and lands
after A, once its proof runs are green.

## §A — the Forge bundle, cached per pin

1. `scripts/forge-bundle.sh` per the interface. Log to stderr whether this run
   was a cache HIT or a BUILD, how long a build took, and the bundle size.
2. A cold build on a claw starts with an empty `~/.m2`. Maven downloads the
   dependencies on first use (hokon's `~/.m2` is 264 MB). That is expected;
   measure it.
3. Prune: keep the newest 3 pins' bundles under the cache root and remove older
   ones, but only ones this script wrote (a marker file inside each bundle) and
   never the pin it is serving. One res tree is 462 MB, 55k files.
4. Tests (each fails when reverted), with a FAKE `git`/`mvn` on PATH and a
   fixture cache root, never the real `~/.cache` or `~/.m2`:
   - a cache hit prints both lines and does not invoke mvn;
   - a miss builds, then a second call hits;
   - a build failure exits non-zero and leaves no bundle under the final name;
   - two concurrent calls build once;
   - a `res/` without `cardsfolder/` is refused;
   - prune keeps 3 and never the serving pin.
5. Live proof belongs to §B's runs (the script runs on a claw inside the
   workflow). Locally, run it once on hokon against a scratch
   `CARDTABLE_FORGE_CACHE` and compare the produced jar's sha256 to
   `~/.local/share/cardtable/jars/<pin>.jar`. The same pin built the same way
   should match. If it does not, report what differs; do not "fix" it by
   copying hokon's jar.

## §B — forge.yml on the claws

1. Both jobs: `runs-on: [self-hosted, hadoku-builder, jdk21]`. Replace "Resolve
   the Forge jar" and the hardcoded `CARDTABLE_FORGE_RES` with one step that
   runs `scripts/forge-bundle.sh >> "$GITHUB_ENV"`, keeping the presence guards.
2. **Per-run ports:** one step picks four free ports (bind port 0 and read it
   back, in node or python; say why the small race is acceptable or close it)
   and writes the four `CARDTABLE_E2E_*_PORT` variables to `$GITHUB_ENV`. Delete
   "the ports are free, or wait". The teardown step reads the chosen ports
   instead of the 29xxx literals.
3. **Drop `heavy.lock`** from both jobs (it is a hokon-workstation lock).
4. **Parallel:** `forge-jvm` loses `needs: forge-e2e`, keeping `needs: changes`
   and its `if:`. They were serialised only because they shared one host.
   `timeout-minutes` drops the "+30 for the heavy.lock wait".
5. **`check` back off tmpfs:** remove `TMPDIR: /tmp/cardtable-ci-tmp` and the
   "A dot-free temp dir exists" step from `ci.yml`, ONLY after the tracker
   confirms fleet-manager 0.27.18's TMPDIR rollout (`~/runner-tmp` on every
   claw). The three dot-directory suites (`base-path.test.ts`,
   `index.test.ts`, `mounted.test.ts`) must pass on a claw with the runner's own
   TMPDIR.
6. **Proof** (the done-when):
   - three `workflow_dispatch` runs of `forge.yml`, all green on claws, with at
     least one cold BUILD and one cache HIT in the logs, and at least two
     different claws;
   - `skipped == 0` in both reports;
   - each job's runtime and the run's end-to-end time against the baseline
     table above;
   - one `ci.yml` run green on a claw without the TMPDIR override.

   Record runner names, durations and HIT/BUILD in the closing note.

7. **Memory is the risk to watch.** hokon measured forge's runner at p50
   2.9 GB, p95 5.5 GB, max 10 GB. Each claw job runs in a memory-capped unit
   beside 2–3 other jobs. If a run is OOM-killed (exit 137, or `oom-kill` in
   the job log), STOP and report it with the numbers. Do not raise limits from
   this repo; that is the fleet tracker's call.

## Closing notes

One per lane, with mutation counts, in this file, before teardown.

Dispatched 2026-10-07 03:50Z (manager session on Fable 5.1; both lanes on Sonnet via `model: "sonnet"`, `subagent_type: "general-purpose"`).

### A landed — `scripts/forge-bundle.sh`: the Forge bundle built and cached per pin, atomic under a per-pin lock, pruned to 3

```
A landed — the per-pin Forge bundle script, its 7-case vitest suite, and FORGE_JAR.md "CI on the claws"
commits: 5813bdd on forge-claws → a9efa0b on main (cherry-picked by the land); 42f6b37 the wave file;
         9dbfe3a → 9265ced on main: the test fixture's fake mvn writes its jar in Node — CI's check on a9efa0b
         went RED on a claw (run 37571226973: `zip: command not found`, 3 of 7 cases) because the fixture
         shelled out to `zip`, which hokon has and the claws do not. Re-proven on a PATH with no zip, unzip or
         strings: 7 pass with a JDK on PATH, 6 pass + 1 skip without (the CI claw's case); CI on 9265ced: see below
deployed: both commits are in 9265ced, which mgmt-api deployed at 04:40:00Z ("Verifying cardtable is serving
          9265ced…", health OK after 3 s; pm2 uptime 04:40:00Z) once the live match that had deferred deploys since
          03:59Z ended. scripts/ and docs/ only — no app version moved for A.
verified: 7/7 vitest (`pnpm exec vitest run scripts/forge-bundle.test.ts`, Node 24, repo root) → re-ran: 7 passed
          `pnpm run lint` exit 0 → re-ran: exit 0;  `bash -n` → exit 0
          the real installed jar (sha256 984f247a…) passes `verify_jar` through the JDK `jar` route with
            `unzip` hidden from PATH (exit 0) and a jar without Main.class is refused (exit 1) → re-ran myself
          hokon live proof (lane, scratch cache ~/.cache/forge-claws-A, deleted after): BUILD exit 0, 68 s total
            (mvn 46 s with a primed 264 MB ~/.m2), bundle 499M; second call HIT in 0.009 s with identical stdout;
            production jar untouched (sha256 unchanged before/after; only read under ~/.local/share/cardtable)
          jar vs hokon's installed jar for the same pin: 24851 entries, same names and sizes; 3 of 24851 CRCs
            differ — META-INF/MANIFEST.MF, version.txt (…-10.07 vs …-10.06), build.txt — all build-date
            stamps; forge/view/Main.class byte-identical. Whole-archive sha256 differs for that reason only.
          cold build on a claw (empty ~/.m2), from lane B's proof logs: clone 16–36 s, mvn 141 s / 102 s /
            67 s / 44 s across four jobs on jit-claw-8, jit-claw-9, warm-claw-9 — far under the brief's
            10–20 min guess. The first claw attempt then died at verification: no `unzip` on a claw.
            Fixed in the same commit (unzip → JDK `jar` → python3 chain; `tr -c '[:print:]'` for `strings`).
mutation-tested (lane, 7 guards; manager re-ran the four marked ★):
          mvn-skip on HIT (`if false && is_complete`) → 4 tests fail / restored 7 pass
          atomic mv (bundle dir pre-created before a failing build) → 2 fail / 7 pass
        ★ lock (`flock 9` → no-op) → 1 fails (two concurrent calls build once) / 7 pass
        ★ cardsfolder check deleted → 1 fails / 7 pass
          prune's serving-pin backstop deleted → 1 fails / 7 pass
        ★ `die` exits 0 → 2 fail (build-failure, cardsfolder refusal) / 7 pass
        ★ JDK `jar` fallback unreachable → 1 fails (no-unzip build) / 7 pass
unverified: a cold-~/.m2 build on hokon (hokon's ~/.m2 was primed; the claw numbers above are the cold measurement)
          shellcheck (not installed on hokon; `bash -n` only)
          a full claw BUILD end to end (verify + 462 MB res copy + mv) — that is lane B's proof run, see B
decisions I made: `scripts/forge-bundle.test.ts` (vitest, the root config's `scripts/**/*.test.ts`) instead of the
          brief's `.test.mjs`; tool-presence checks are lazy (a HIT needs only git/awk/flock/mktemp); all six
          scenarios drive one fake `git` and one fake `mvn` by env vars — no test-only flag in the script;
          the landing: `scripts/land.sh` exited 5 because main had just taken an `@wolffm/*` auto-update
          (9c5ca5f) so it had to `pnpm install`, and GitHub Packages refused both host tokens (~/.npmrc 401,
          `gh auth token` 403 — scopes gist/read:org/repo, no read:packages). Landed with the same steps minus
          the install (detached worktree on origin/main, cherry-pick, `pnpm run check` against the deploy
          tree's node_modules — which lag the lockfile by the @wolffm/themes 5.8.8→5.8.9 bump — then
          `git push origin HEAD:main`, land.lock held throughout). Check: 4468 passed, 113 skipped. CI's
          `check` on a9efa0b is the gate of record.
out of lane / declined: none. Residual risk, not a bug in the brief's terms: prune runs on every call and the
          lock is per pin, so a HIT for pin Y can remove pin X's bundle while another job on the same claw is
          mid-run against X, if X has fallen outside the newest 3 (a HIT touches the marker, so a pin served
          recently is kept; pin churn is ~5/month). Worth a cache-root-wide lock or an in-use marker later.
sub-agents dispatched: 1 (three turns: build, the unzip fix, the zip-fixture fix), Sonnet (`model: "sonnet"`), owning
          scripts/forge-bundle.sh, scripts/forge-bundle.test.ts, docs/FORGE_JAR.md. Lane wall-clock 03:50Z → 04:19Z
          (29 min incl. the unzip fix); landed 04:23:31Z; the fixture fix landed 04:34:56Z.
```

### C landed — six jvm suites stop writing evidence to literal `/tmp/claude-1000/<lane>` directories (cut mid-wave by the manager)

```
C landed — the jvm suites' hidden hokon dependency: evidence writes to past lanes' scratch dirs
commits: 65a389c on forge-claws → d5e38df on main; a7e1e7a "server 0.32.15" (the land's bump)
deployed: server 0.32.15 — CI check green on a7e1e7a (run 37575745891), redeploy 37576114000 dispatched, mgmt-api
          deployed a7e1e7a (deploy tree at a7e1e7a; pm2 uptime 05:24:29Z; /health healthy, bundle ok at 05:25Z)
verified: why the lane exists: the first claw forge-jvm (run 37570892785, warm-claw-9) failed 7 tests with
            `ENOENT … /tmp/claude-1000/{S,w40-A,w33-S,w33-Q18}/…` — six suites wrote evidence files to lane
            scratch dirs that exist on hokon alone (manager read the job log; 4 of 7 shown in the wave file's
            evidence dir, docs/planning/wave-forge-claws-evidence/)
          `git grep -nE "['\"]/tmp/" -- 'apps/**/*.jvm.test.ts'` → exit 1 (no match) → re-ran in a detached worktree
          the six suites against real Forge (manager, detached worktree at 65a389c, deploy tree's res, per-pin jar,
            CARDTABLE_PLAY_WORK_DIR on disk, heavy.lock held, serial): blockers 2/2, cast-hidden 4/4, priority 2/2,
            scenario-glen 3/3, scenario-targets 2/2, scenario-thoughtseize 2/2 — 15 passed, 0 failed; the five kept
            dumps landed under $CARDTABLE_PLAY_WORK_DIR/evidence/ (tap1.json, summary.txt, firstnamed.txt,
            auto-target-stackitem.json, glint-hawk-stackitem.json)
          lint exit 0; typecheck: only the worktree's known e2e @hadoku resolution red (dangling links, below)
          the land's check: 4468 passed, 113 skipped
mutation-tested: n/a — no guard was added; the before/after is the claw itself: run 1 (without C) 7 ENOENT reds,
          run 2+ (with C) see lane B's table
unverified: the lane could not run its suites in the wave worktree: every `@hadoku/*` link under apps/*/node_modules
          there is dangling (`./packages/<name>` instead of an absolute path — the worktree was linked with a
          relative path argument, and scripts/link-worktree-node-modules.sh builds `$WT/$rel` from it). Its repair
          attempt (`ln -sfn` into node_modules) was denied by the permission classifier and it stopped, correctly;
          I did not repeat the denied action — I verified in a detached worktree the script linked from an absolute
          path. Tracker item: the script should `realpath` its argument, and the scaffold check should `find -xtype l`.
decisions I made: cutting the lane at all — the brief forbids widening a lane, and these six files were in no lane;
          without them forge-jvm can never be green on a claw and B's done-when is unreachable. Per site: delete a
          dump the test already console.logs or the next assertion prints; keep one that holds frames or a stack
          item nothing else shows, under the harness work dir (runner.temp in CI, which the evidence upload keeps).
          `docs/planning/wave35-evidence/s3-thoughtseize.md:201` still points at the deleted
          /tmp/claude-1000/w35-s/thoughtseize-folded-run.txt — the same text is in the suite's console.log; left
          for the tracker (docs/ not in the lane).
out of lane / declined: the 8th claw failure, prompts.jvm "combat and targets" (scenario did not finish in 150 s,
          stalled after t15 on warm-claw-9) is not this class; whether it repeats is in lane B's runs 2/3.
sub-agents dispatched: 1, Sonnet (`model: "sonnet"`), owning the six apps/server/src/play/*.jvm.test.ts files
          listed above. Lane wall-clock 04:52Z → 05:01Z (edits) + 05:04Z → 05:17Z (manager's real-Forge run, 838 s of
          it waiting for heavy.lock behind hokon's own CI); landed 05:19:33Z.
```

### B landed — forge.yml on the claws, in parallel; `check` back off tmpfs

```
B landed — both Forge jobs run on [self-hosted, hadoku-builder, jdk21] from the per-pin bundle, four free ports per
          run, no heavy.lock, forge-jvm beside forge-e2e; ci.yml's TMPDIR override and mkdir step are gone
commits: 28326e7 on forge-claws → b861155 on main (forge.yml, ci.yml, docs/WAVE_WORKTREE.md)
deployed: n/a — workflow files and a doc; no app version moves. CI check on b861155: run 37580418333 success (warm-claw-1, no TMPDIR override, 4467 passed / 114 skipped). The first
          push-triggered forge.yml run on main under the new file: 37580418316 (b861155) was superseded in its concurrency
          group by B2's push eight minutes later (cancelled, as the group is designed to); the first to run is
          37581135492 (33288d1), queued behind hokon's last old-file run 37578387180 — result under B2.
verified (manager, from the GitHub job logs, saved as text in docs/planning/wave-forge-claws-evidence/):
  the committed forge.yml differs from the proven proof commit 8cf04b0 in comments and ONE value: forge-jvm
    timeout 40→50 (from the measured worst case below). ci.yml: no `TMPDIR:` key, no mkdir step; yaml parses; lint 0.
  proof runs (workflow_dispatch = nightly mode: every job, every [nightly] test), pin e5db0510…:
  | run | ref | job | runner | result | wall | bundle | tally |
  | 37569234311 / 37569441429 | proof, proof-2 | both | jit-claw-8, jit-claw-9, warm-claw-9 | red | 2–3 min | BUILD mvn 44–141 s, then `unzip` missing | the lane-A bug; no tests ran |
  | 37570892785 (1) | proof | forge-e2e | jit-claw-8 | red | 18.0 min | BUILD 74 s (mvn 44 s), 504M | 87 passed, 2 failed: play.spec:659, table-fit:721 — main's own (hokon 37566400825: the same two, 87/2) |
  | 37570892785 (1) | proof | forge-jvm | warm-claw-9 | red | 28.2 min | BUILD 100 s (mvn 68 s), 504M | 92/9/7: 7 of 8 unpinned reds = literal /tmp/claude-1000 writes → lane C; 1 stall (prompts combat) never seen again |
  | 37574482895 (2) | proof | forge-e2e | jit-claw-8 | red | 16.4 min | HIT | 87 passed, 2 failed (the same two) |
  | 37574482895 (2) | proof | forge-jvm | warm-claw-9 | GREEN | 23.8 min | HIT | 107 passed, 1 failed (pinned [nightly] known_failing), 0 unpinned skips, judge true |
  | 37576542577 (3a) | proof | forge-jvm | jit-claw-8, alone | GREEN | 14.7 min | HIT | 106 passed, 2 failed (both pinned), judge true |
  | 37576542577 (3a) | proof | forge-e2e | warm-claw-9, 3 jobs on the host | red | 35.3 min | HIT | 80 passed, 3 failed (the two + w33 Q12), 6 skipped after them |
  | 37576544917 (3b) | proof-2 | forge-e2e | jit-claw-9, 3 on the host | red | 36.1 min | HIT | 86 passed, 3 failed (the two + w35 swallowed press) |
  | 37576544917 (3b) | proof-2 | forge-jvm | jit-claw-9, 3 on the host | red | 37.5 min | HIT | 105 passed, 3 failed: 2 pinned + target-players "Doom Blade names no player" (17.5 s timeout) |
  hokon, same day, old forge.yml, push mode: 37566400825 e2e 87/2 in 18.0 min test time, jvm red (R4 thoughtseize
    unpinned; load 21, 312 s lock wait); 37572150239 e2e 85/3 (the two + w32:106) 19.4 min test time after a 508 s
    lock wait at load 17, jvm 73/3/32 (two auto.jvm unpinned) 18.4 min at load 17–19, 289 s lock wait.
  against the wave file's baseline (p50 117 s / p90 872 s for e2e over 14 days — mostly skipped/short runs; p50
    1182 s / p90 1507 s for jvm): a claw alone runs e2e in 16–18 min and jvm in 15–24 min (nightly set) with no
    lock wait and load ~0–2; the two jobs overlap instead of e2e→jvm, so a push's Forge signal arrives in max(e2e,
    jvm) instead of the sum.
  ports: 36635/35017/34341/40301, 38033/44775/45663/37393, 41937/34175/44173/42969, 36585/40345/39169/39717 — four
    runs, never a collision, teardown read them. OOM: no `oom`, no exit 137 in any of the 8 claw job logs.
  parallel scheduling: run 1 jobs on jit-claw-8 + warm-claw-9 simultaneously; the pair put 3 jobs on claw-9 and 1
    on claw-8. Claws seen with jdk21: claw-8 (JIT), claw-9 (warm + JIT). The repo-level listing at 03:48Z showed
    the label only on warm-claw-9; JIT runners carry it on demand.
  ci.yml: run 37569624003 on warm-claw-1, check green with no override, `TMPDIR=/home/hadoku/runner-tmp`
    (RUNNER_TEMP still under .hadoku, which the suites do not read). The fleet tracker confirmed at ~05:35Z, read-only
    on all 8 claws, runner.env TMPDIR=/home/hadoku/runner-tmp (0700, on disk) on claw-1,2,3,4,5,6,8,9; hokon skipped
    as a guest. Caveat: the idle warm-claw-8 listener predates the rollout and has no TMPDIR → falls back to /tmp
    (dot-free, tmpfs) until its next job.
mutation-tested: n/a — no new test; the guards are the existing ones. Their bite was exercised for real: the two
          first proof runs went RED at "Resolve the Forge bundle" (unzip missing) instead of green-by-skipping.
unverified: "three runs all green" as literally written — forge-e2e cannot be green on any host today: play.spec:659
          and table-fit:721 are red on main on hokon too (presence__name overflow; board text after refresh). They
          are the ledger's, not this wave's. forge-jvm IS green on a claw (runs 2 and 3a). The nightly-mode
          timings above are not a push's: a push runs fewer jvm tests (32 [nightly] skips) — the first push-triggered
          run on main under the new file is the push-mode number (37581135492, under B2).
decisions I made: land B1 with ci.yml step 5 included (the tracker's confirmation arrived at ~05:35Z, before the
          land); forge-jvm timeout 50 not 40 (worst observed 37.5 min under 3-on-a-host contention); the fleet
          tracker's mid-wave scope addition (workflow_dispatch inputs) goes as a separate commit B2, after B1, on its
          own targeted proof — see B2 below.
out of lane / declined: the claw-9 stacking (3 heavy jobs on one 16 GB claw → e2e 2.2× slower, one extra flaky red
          per job, one jvm timeout) is a fleet-manager placement bug, diagnosed by the fleet tracker from this wave's
          numbers: warm affinity sorted ahead of load, `busy` counted repos not jobs, no in-tick re-rank. Fixed
          fleet-side; these numbers are its baseline. No host-wide lock added here (settled: none on a claw).
          Proof branches forge-claws-proof, forge-claws-proof-2, forge-claws-proof-ci: deleted at teardown.
sub-agents dispatched: 1, Sonnet (`model: "sonnet"`), owning .github/workflows/forge.yml, .github/workflows/ci.yml
          (TMPDIR env+step only), docs/WAVE_WORKTREE.md. Lane wall-clock 03:50Z → 06:14Z for B1 (of which ~1 h 15
          waiting on A's unzip fix, C, and the claws' runs); landed 06:14:14Z.
```

### B2 landed — forge.yml `workflow_dispatch` inputs: `specs`, `jvm`, `only` (the fleet tracker's mid-wave addition)

```
B2 landed — a session verifies one spec or one jvm suite on a claw in a minute or two: push verify/<task>, then
          `gh workflow run forge.yml --ref verify/<task> -f only=e2e -f specs='table-fit -g "a live match fits"'`
commits: c91d467 on forge-claws → 33288d1 on main (.github/workflows/forge.yml only)
deployed: n/a — a workflow file. CI check on 33288d1: run 37581135526 success. Its push-triggered Forge run 37581135492 was superseded in the concurrency group by 5c401c8 (another session, 06:33Z); the first on-main run under the new file is therefore 37582124478 — see the follow-up line below when it completes.
verified (manager, from the artifacts): the worktree file is byte-identical to the proven proof commit 5e09f5a;
          yaml parses (inputs specs/jvm/only); lint 0; actionlint is not installed on hokon.
          run 37580491608 (forge-claws-proof @ 5e09f5a, -f only=e2e -f specs='table-fit -g "a live match fits"'):
            warm-claw-9, bundle HIT, "spec override: table-fit -g …" logged, exactly one spec ran and failed with
            main's own presence__name overflow, forge-jvm `skipped` (only=e2e), forge-e2e-evidence-1 uploaded
            (88,822 bytes), job 06:15:15→06:16:43 = 88 s wall-clock (vs 16 min for the full list).
          run 37580697632 (-f only=jvm -f jvm=apps/server/src/play/priority.jvm.test.ts): warm-claw-9, HIT,
            "jvm override: apps/server/src/play/priority.jvm.test.ts", Tests 2 passed, FULL=false, judge `true`,
            forge-e2e `skipped`, 06:17:32→06:18:11 = 39 s.
          push-path reading (each new expression with inputs empty): forge-e2e `if` adds
            `(inputs.only == '' || … )` → true; forge-jvm `if` the same; `SPECS_OVERRIDE=''` → the `else` branch is
            today's derived list and its "no Forge-gated spec found" guard; `JVM_OVERRIDE=''` → today's group logic
            and the outside-apps guard; `FULL` adds `inputs.jvm == '' &&` → unchanged on push. Guards: "Resolve the
            Forge bundle" and both presence guards are steps BEFORE the Playwright/vitest step in both jobs on every
            path; the evidence upload steps are untouched. CI check on b861155 (B1) ran on warm-claw-1 with no
            TMPDIR override: 4467 passed / 114 skipped — identical tally to a7e1e7a's run before it.
mutation-tested: n/a (a dispatch convenience; the guards are B1's and A's, exercised above).
unverified: actionlint (not on this host). `specs` is passed through `eval` so a `-g "quoted filter"` splits as
          typed: acceptable because workflow_dispatch needs write access to this repo; noted, not a bug.
decisions I made: committed and landed on my own artifact verification rather than waiting for the lane's phase-2
          write-up (the clock: 2 h 32 at commit); landed as a separate commit after B1 so B1's proof stayed exact.
out of lane / declined: none.
sub-agents dispatched: the same lane-B Sonnet agent, continuing; B2 wall-clock 06:08Z → 06:18Z (edits + both
          dispatches), landed 06:22:18Z.
```

### Wave-wide, for the tracker (in addition to the lane notes, not instead of them)

- **Clock.** Dispatched 03:50Z. A landed 04:23Z (+fix 04:35Z), C 05:19Z, B1 06:14Z, B2 06:22Z; closing notes and
  teardown after the first on-main Forge run under the new file. Wall-clock to B2's land: 2 h 32. Sub-agents: 3
  (A, B, C), all Sonnet via `model: "sonnet"`; manager on Fable 5.1.
- **Where the time went.** A's two hidden host dependencies (no `unzip`, then no `zip`, on the claws) cost two
  proof rounds; hokon's own CI held `heavy.lock` for 14 min of C's verification; the claws' proof runs are 16–37
  min each. Lanes were idle waiting on each other for about 1 h 15 of B's 2 h 24.
- **Landing without `scripts/land.sh`.** It exits 5 on this host today: main had just taken an `@wolffm/*`
  auto-update, so the script must `pnpm install`, and GitHub Packages refuses both host tokens (`~/.npmrc` 401,
  `gh auth token` 403 — scopes gist/read:org/repo). Every land here ran the same steps minus the install
  (detached worktree on origin/main, cherry-pick, same bump rule, `pnpm run check` against the deploy tree's
  node_modules, push `HEAD:main`, land.lock held). CI's `check` was green on every landed sha except a9efa0b,
  whose red was A's own fixture (fixed in 9265ced, 11 min later). **Ask:** a current HADOKU_NPM_READ_TOKEN in
  `~/.npmrc` restores `scripts/land.sh`.
- **Ledger rows to open** (none are this wave's): forge-e2e `play.spec.ts:659` (board text after refresh differs
  by the `e2e-bob` presence line) and `table-fit.spec.ts:721` (`presence__name` / `presence__back` overflow the
  896 px shell by up to 53 px) — red on main on hokon and on every claw run; `scripts/link-worktree-node-modules.sh`
  must `realpath "$1"` (a relative argument writes dangling `./packages/<name>` links; this worktree had 17, and
  its e2e typecheck was red for that reason alone); `docs/planning/wave35-evidence/s3-thoughtseize.md:201` points
  at a deleted `/tmp` evidence file (the same text is in the suite's console.log).
- **Fleet-side, already with the fleet tracker:** the claw-9 stacking (placement bug, fixed there); the idle
  `warm-claw-8` listener without TMPDIR until its next job; `jdk21` appears on JIT runners for claw-8 and claw-9
  on demand — the repo-level runner listing shows it only on the warm claw-9 listener.
- **cardtable#5:** closed with this file's run ids once the on-main run is in (see the B2 note's last line).
- **Evidence:** `docs/planning/wave-forge-claws-evidence/` — text excerpts of every cited job log (runner names,
  HIT/BUILD lines, tallies, judge objects); no screenshots.

### Follow-up: the first on-main Forge run under the new workflow (closes cardtable#5)

Run 37582515279, push b79e398 (wave 54's landing: ui 0.32.40, server 0.32.16), 06:37Z → 06:57Z, push mode.
forge-e2e on jit-claw-8 (HIT, ports 46353/33961/42531/39875, load 0.16):  1 failed; 90 passed (17.6m); failed: w46-attack.spec.ts:165:1 .
forge-jvm on warm-claw-9 (HIT, load 1.09): 73 passed / 3 failed / 32 skipped ([nightly], expected on a push) in
968 s; two failures pinned flaky (board-play, the reveal label), one unpinned: socket-two-mana-pass "Goblin Piker
resolves over the real socket" — green on the claws in runs 37570892785 and 37574482895, so it is wave 54's
landing to read (the CI-gate rule: a red Forge run is the lander's work item; messaged w54-manager-c3). Both jobs
ran in parallel on two claws, 18 and 16 min, no lock wait, no OOM — against hokon's 28 + 18 min serial with 5–8
min of lock waits the same evening. Nothing of forge-e2e/forge-jvm runs on hokon any more; `changes` stays on
vars.CI_RUNNER. Evidence: wave-forge-claws-evidence/first-on-main-run.md. Noted 06:58Z; teardown follows.
