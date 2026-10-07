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
