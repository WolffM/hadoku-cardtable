# What the jar-gated suites cost to run

Wave 21 §B item 3. The jar-gated suites have never run in CI, and that is why
two defects in them aged for a wave each while passing. This is the **measured**
price of changing that, so the tracker can decide with numbers instead of a
guess. **Nothing here changes any CI config**; §B item 3 asked for the
measurement only.

Measured on **2026-09-26** on the pm2 host — 12 cores, 61 GB, the same
`[self-hosted, pm2-host]` runner the `forge-e2e` CI job already uses, with
production's `cardtable` live throughout and the operator's own desktop on it
(`firefox` and `invokeai-web` were each taking ~75% of a core for much of the
session, so the one-minute load average never sat below about 5). Node 24.18.0,
the major CI pins.

## How to reproduce any number here

```sh
export PATH="/home/hadoku/.local/share/fnm/node-versions/v24.18.0/installation/bin:$PATH"
export CARDTABLE_FORGE_JAR=$HOME/.local/share/cardtable/forge.jar
export CARDTABLE_FORGE_RES=/home/hadoku/repos/hadoku-cardtable/forge/forge-gui/res
export CARDTABLE_PLAY_WORK_DIR=<a scratch dir>      # NEVER the default: it is production's
s=$(date +%s.%N); pnpm exec vitest run <files>; e=$?; printf 'exit=%s wall=%.1fs\n' "$e" "$(echo "$(date +%s.%N)-$s" | bc)"
```

**Counting JVMs: do not use `pgrep -fc 'cardtable/forge.jar'`.** `pgrep -f`
matches the whole command line, so it counts the shell that is running the
command containing that string — it over-reports by up to 2 and every early
figure in this lane was inflated that way. Count `java` processes by their
`exe` link instead:

```sh
for p in /proc/[0-9]*; do
  case "$(readlink "$p/exe" 2>/dev/null)" in */bin/java) ;; *) continue;; esac
  tr '\0' ' ' < "$p/cmdline" | grep -q 'cardtable/forge' && echo "$p"
done | wc -l
```

**Baseline 2.** Production's own pool keeps warm spares up
(`cwd` = `/tmp/cardtable-play/spare-…`); there were 2 all session. Every peak
below is the raw count; subtract 2 for what a test run is responsible for.

## Per suite, one file per invocation

| suite | tests | wall | peak JVMs (ours) |
| --- | --- | --- | --- |
| `apps/server/src/http/gate.test.ts` | 8 (1 jar-gated) | 10.0 s | 1 |
| `apps/ui/src/play/live/board-play.jvm.test.ts` | 1 | 13.3 s | 1 |
| `apps/ui/src/play/live/combat-drag.jvm.test.ts` | 1 | 13.8 s | 1 |
| `apps/server/src/play/auto.jvm.test.ts` | 1 | 14.2 s | 1 |
| `apps/server/src/play/browser/browser-jvm.test.ts` | 1 | 14.5 s | 1 |
| `apps/ui/src/play/live/prompts.jvm.test.ts` | 2 | 33.7 s | 2 |
| `apps/server/src/play/jvm.test.ts` | 3 | 35.1 s | 2 |
| `apps/ui/src/play/live/flow.jvm.test.ts` | 7 | 27.0 s green / **204.6 s when it fails** | 2 |
| **total, one at a time** | **24** | **161.6 s** | **2 at any moment** |

`board-play.jvm.test.ts` was also run 30 times on its own across the session:
13.3-20.7 s, median about 15 s. A run of this suite that takes minutes is
telling you the machine is busy, not that the suite is slow.

## The whole test suite

| how | wall | result | peak JVMs (ours) |
| --- | --- | --- | --- |
| no Forge vars, default parallelism (**what CI does today**) | 19.6 s, 12.1 s | 83 files pass, 7 skip; 2190 pass, 17 skip | 0 |
| Forge vars, `--fileParallelism=false` (**truly serial**) | 278.3 s | 2200 pass, 7 skip — the 7 are `flow.jvm`, below | 2 |
| Forge vars, default parallelism | 58.3-87.7 s when green (5 of 13 runs) | 90 files, 2207 tests | **11-13** |

**`--poolOptions.threads.maxThreads=1` does NOT serialise the files.** Measured:
with that flag the suite still peaked at 8 of our JVMs and finished in 79-88 s.
`--fileParallelism=false` is the flag that serialises, and it is the row above
with 2 JVMs.

So the honest cost is a choice between two shapes, and they are very different:

- **Serial**, the shape the suites were written for: **278.3 s** for everything,
  2 JVMs at a time, all 24 jar-gated tests run. That is +259 s on today's 19.6 s
  vitest run.
- **Default parallelism**: 58-88 s when it works, but **11-13 `-Xmx1g` JVMs at
  once on a 12-core box**. The wave manager measured `/proc/loadavg` at **36.6**
  during one such run — three times oversubscribed. A red from that
  configuration is not diagnosable: a correct match misses a 120 s deadline on
  CPU starvation alone, which is indistinguishable from the bug this lane fixed.
  **Do not gate on that shape.**

## What CI costs today, for comparison

Run `36252759753` on `main`, 2026-09-26 (`gh run view 36252759753 --json jobs`):

| job | runner | the step that matters | whole job |
| --- | --- | --- | --- |
| `check` | `vars.CI_RUNNER` | `Test` (`pnpm run test`) **35 s** | 151 s |
| `forge-e2e` | `[self-hosted, pm2-host]` — this host | the Playwright step **197 s** | 208 s |

Note the 35 s: the same `vitest run` that takes 19.6 s here takes 35 s on the
`check` runner, so that runner is about **1.8× slower**. That runner also has
**no jar and no `forge/`**, so these suites would skip there and prove nothing.
There is exactly one machine in the fleet where they can run, and it is the one
already running `forge-e2e` — which is also the one serving production.

## Before gating on them: one suite is flaky whatever the load

This is the part that decides it, and it is measured, not feared.

**`apps/ui/src/play/live/flow.jvm.test.ts` failed 9 of 20 runs, including once
run entirely on its own with 1-2 JVMs up.** Its failures, all of them a wait
that expires:

- *"timed out waiting for seat 0's own main phase with a land in hand (Preordain
  run)"* — **solo**, peak 2 JVMs, load falling through 5.
- *"timed out waiting for the land to be on the battlefield, untapped"* (×3),
  once with the seat parked at a cleanup discard it never answers
  (`selectables {cards:[40,28,15,26,38,16,31,8], min:1}`, OK disabled).
- *"timed out waiting for seat 0's next own main phase, under full control"*,
  *"the one-ability offer to be DRAWN under full control"*.

Two things follow. First, it is **not a load artefact** — it failed serially and
solo, so the fix is in the suite, not in the scheduler. Second, every one of
those messages is the **same defect class wave 21 §B fixed in
`board-play.jvm.test.ts`**: a driver that latches a click or a window and cannot
recover when Forge does not act on it. `board-play` now expires every latch,
retries, and counts the retries; `flow.jvm` does not, and it is the only suite
left that behaves this way. Worth a lane of its own — the diagnosis is already
done and written down in `board-play.jvm.test.ts`'s header.

Its failure also happens **outside** its test cases, so all 7 of its tests are
SKIPPED when it goes red: a red that reports nothing about the product.

For completeness, the other suites' reds, all of them only ever under the
oversubscribed default parallelism and all of them fixed or explained in this
wave:

- `board-play.jvm.test.ts`: 1 of 13 whole-suite runs **before** §B's fixes,
  **0 of 9 after** (6 whole-suite, 3 solo, plus 4 single-suite greens at the
  end). Its two load failures were real defects, diagnosed from state and not
  from the clock — a card still sitting in the actor's hand and still in Forge's
  own actionable set at turn 5, and an OK button that never enabled at a 2-card
  discard.
- `auto.jvm.test.ts`: 2 of 13 before this wave's two fixes, 0 of 6 after.
- `prompts.jvm.test.ts`: 2 of 15 (*"the scenario did not finish in 150000 ms"*),
  never solo (0 of 3).
- `apps/server/src/play/browser/browser.test.ts` — **not a jar suite at all**,
  a pure RFC 6455 unit test — went red once under the oversubscribed run
  (`expected null to be 1002`). That is the clearest single argument against
  gating on that shape: it reddens tests that have nothing to do with Forge.

## The cheap half of the decision, available today

Running these locally before a push that touches `apps/server/src/play` or
`apps/ui/src/play` costs **278 s serially**, or **161.6 s** for the eight files
one at a time, and it would have caught both of this wave's defects. That needs
no workflow change and no second jar.

## What could not be measured

- **The cost on the `check` runner**: no jar, no `forge/`, so it cannot be run
  there at all. The 1.8× figure above is measured; applying it is arithmetic and
  is labelled as such.
- **The cost of a CI run with these suites enabled while `forge-e2e` also runs**
  — the two would share this host. Settling it means dispatching a real run:
  `gh workflow run ci.yml` after the workflow change, then
  `gh run view <id> --json jobs`. Nobody has done that, and this document does
  not guess at it.
- **A measurement on a genuinely idle box.** The operator's desktop was on this
  machine all session; the one-minute load average never went below about 5. The
  per-suite numbers are therefore an upper bound rather than a floor.
