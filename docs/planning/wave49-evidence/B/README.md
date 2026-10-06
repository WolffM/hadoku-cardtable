# Lane B — jvm test debt (wave 49)

Rebuilt from `/tmp/claude-1000/w49-B/*.log` after a session interruption around 05:17 UTC wiped
this directory's first draft. All counts below are read back from the surviving log files listed
next to each claim; nothing here is from memory alone.

## 1. `board-play.jvm.test.ts:663`

**Diagnosis.** The pinned failure was real but the assertion was stale. `Board.tsx` (R10, wave 35,
lines ~1780-1818) made the card face **always** a `<button>` — even when Forge does not offer the
card — specifically so a creature tapping to attack doesn't unmount the subtree (that used to flip
`button` → `div` → `button` and caused a visible flicker). `cardButton()` in the test (`root.querySelector('[data-board-card] button')`)
therefore always finds an element now, so `expect(cardButton(...)).toBeNull()` at the old line 663
can never pass — the "cannot be played by clicking" claim needs a different signal: whether the
card is drawn with `data-selectable` (Board's own offered-affordance attribute), not whether a
`<button>` element exists at all.

**Fix** (`apps/ui/src/play/live/board-play.jvm.test.ts`):
- Added `isOffered(root, id)` (checks `data-selectable` on `[data-board-card]`), kept `cardButton`
  but re-documented it as "the face, whether or not it's offered."
- The turn-1 "second Mountain" check now asserts: not in Forge's actionable set, not drawn with
  `data-selectable`, AND a `fireEvent.click` on its (still-existing) button face sends nothing
  (`stats.replies` unchanged) — the actual "cannot be played by clicking" claim, from the board as
  it renders today.
- The whole-run "card-for-card parity" check (`sampleParity`, originally ~line 393) was ALSO using
  `cardButton(...) !== null` as "is this card clickable" — same stale assumption, now vacuously true
  for every card on the board. Switched it to `isOffered(...)` too (renamed `hasButton` → `offered`,
  `inertLand.hadButton` → `inertLand.offered`). Without this second fix the suite still fails, now at
  the parity assertion instead of :663 — confirmed by running the file right after the first fix (see
  "first attempt" below).

**Counts:**
- **Unfixed baseline, 1 run** (reconfirmed after the interruption, `/tmp/claude-1000/w49-B/mutation-reverted.log`):
  1 failed / 1 test — `AssertionError: expected <button type="button" …> to be null`, the original
  :663 line.
- **First fix attempt (only :663's own assertion changed, parity check untouched), 1 run**: still 1
  failed / 1 test, now at the parity `mismatches` assertion (not saved to a named log file — caught
  live, fixed immediately by also changing `sampleParity`/`inertLand` to `isOffered`).
- **Both fixes together:**
  - 1 verification run: 1 passed / 1 test.
  - **10/10 clean under ordinary load** (`board-play-noload-{1..10}.log`, `board-play-noload-summary.log`)
    — shared `heavy.lock` contention only, no CPU pin, matching how CI actually runs (`--fileParallelism=false`,
    not core-pinned). All 10 `Tests 1 passed (1)`.
  - **Mutation test, redone after the interruption** (`mutation-reverted.log` / `mutation-restored.log`):
    revert the fix (restore `git show HEAD:...`) → 1/1 **fails** at the original :663 assertion;
    restore the fixed file (byte-for-byte, `diff -q` confirmed identical before running) → 1/1
    **passes**. File content verified back to the fixed state after the test (`git diff --stat` still
    shows the full fix: 37 insertions / 15 deletions).

**A separate, pre-existing flake found, NOT fixed (out of scope for :663):** under `taskset -c 0`
(single-core pin — a deliberately extreme stress technique this codebase uses elsewhere, e.g.
wave40's thoughtseize diagnosis), the suite's own `DECLINED_CLICK_BOUND = 2` is exceeded in
roughly a third of runs once execution gets far enough to reach that assertion (`board-play-batch1.log`
run 8, `board-play-extra-1.log`, `board-play-extra-3.log` — all three fail with
`declined clicks: [...]: expected N to be less than or equal to 2`, N = 3 or 4). This bound predates
this lane (calibrated in wave 20/21 against `flow.jvm.test.ts`'s own bound) and was previously
unreachable because the test always failed earlier, at :663, on every run (100%) — fixing :663
exposed it. It does **not** reproduce under ordinary host contention (10/10 clean above, no pin) —
only under single-core pinning, which CI does not do. Left unpinned and unfixed: it's a pre-existing
calibration question (is 2 the right bound under the harshest possible contention?), not something
introduced by this lane's fix, and not reproducible under CI's actual execution model. Flagging for
the tracker rather than guessing at a new bound.

## 2. The Thoughtseize "fold" flake — NOT reproduced

**Attempted repro, 3 methods, 17 runs total, 0 failures** (unmodified `scenario-thoughtseize.jvm.test.ts`,
both `it()` blocks — "the fold" and "the land is never a legal choice" — run together every time):

| method | runs | result | log |
| --- | --- | --- | --- |
| `taskset -c 0`, serial, alone | 6 | 6/6 clean (2/2 tests each) | `ts-baseline-{1..6}.log`, `ts-baseline-summary.log` |
| beside `blockers.jvm.test.ts` + `auto.jvm.test.ts`, 2 cores (`taskset -c 0,1`), vitest's own file parallelism (concurrent JVMs) | 6 | 6/6 clean on thoughtseize (run 2 failed, but all 3 failures were in `auto.jvm.test.ts`, confirmed by `grep -n thoughtseize ts-load-2.log` showing both thoughtseize tests passed at 34302ms) | `ts-load-{1..6}.log`, `ts-load-summary.log` |
| `taskset -c 0` (single core) **and** concurrent with `auto.jvm.test.ts` — the harshest combination tried | 5 | 5/5 clean | `ts-squeeze-{1..5}.log`, `ts-squeeze-summary.log` |

No dump excerpt exists for the fold race because nothing ever failed or timed out against the
unmodified suite — `scenario.ts`'s own `waitUntil` only writes a dump on a timeout, and none
occurred. (`/tmp/claude-1000/w49-B/dump/` holds only `auto.jvm.test.ts`'s own unrelated diagnostic
dumps, `w24-e-windows-*.json` / `w25-d-item6-*.json`, from the concurrent-load runs — nothing
thoughtseize-specific.)

**What I did anyway, and why.** `castThoughtseize` (the helper both `it()`s share) calls
`finishMulligan(s)`, waits only for the hand's *contents* to reflect Thoughtseize, then immediately
calls `s.select(0, seize.id)` with no check that seat 0 actually holds priority at its own turn-1
main phase yet. `s.select` (`scenario.ts`) sends a raw `selectCard` act with no precondition of its
own — Forge drops it silently if the real cast window isn't current yet. This is exactly the
documented pattern in memory "jar casts wait for priority" (a select right after `finishMulligan` is
dropped under load) and matches how every OTHER scenario file in this suite gates its first act
(`inOwnMain(s, seat, 1)` — see `lands.jvm.test.ts`, `scenario-start.jvm.test.ts`, `cast-hidden.jvm.test.ts`).
Added the same gate here (`apps/server/src/play/scenario-thoughtseize.jvm.test.ts`, before `s.select(0, seize.id)`):

```ts
await waitUntil(() => { s.answerAsks(); return inOwnMain(s, 0, 1); }, "seat 0 to hold priority at its own turn-1 main phase", 20_000, s);
```

This is a **defensive hardening, not a confirmed fix** — I never observed the fold flake fail, so I
cannot claim causation. It's included because: (a) it's strictly more correct regardless (the test
now proves what it claims to test off a well-defined window, not luck), (b) it's zero-risk — scoped
entirely to this one file I own, unlike `finishMulligan` itself in `scenario.ts` (shared by 12 other
jvm test files; wave 40 tried and reverted a fix there for exactly that reason, `wave40-evidence/B-thoughtseize.md`),
and (c) it did not slow the suite down — if anything runs got faster (~24s vs ~35-39s before, likely
because the gate avoids a dropped-and-silently-ignored first act that Forge would otherwise need a
retry/timeout cycle to recover from).

**Counts after the fix:**
- 1 verification run: 2/2 passed.
- **9/9 clean under `taskset -c 0`** (`ts-final-{1..9}.log`, `ts-final-summary.log`), plus the 1
  verification run above = **10/10**.
- 1 more verification run after the session interruption (`post-resume-ts.log`): 2/2 passed.
- **Total, with the fix: 11/11 clean.**
- **Combined with the 17 pre-fix clean runs: 28/28 clean across this file's lifetime in this lane,
  0 reproductions of either the fold flake or the pinned land-choice flake.**

## 3. `R4: casting Thoughtseize, against real Forge the land is never a legal choice: picking the land is refused by Forge itself`

Pinned `known_flaky` before this lane (wave 35/wave 40, tied to the SAME `castThoughtseize` helper
and the same undiagnosed-at-the-time race). Brief: "unpin it if 10/10 under load." Measured
**28/28 clean** (17 before the hardening fix, 11 after, across three load-generation methods — see
above). Far past the bar. **Unpinned** in `.github/workflows/ci.yml`'s `known_flaky` list.

## 4. `ci.yml` edits

Two removals, both reflected in `git diff .github/workflows/ci.yml`:
- `known_failing`: removed the `board-play` entry ("playing by clicking the board, against a real
  Forge match a player plays a land and casts spells — one targeted — by clicking their own board").
  Left the unrelated "fifteen prompts" `known_failing` entry untouched (not this lane's).
- `known_flaky`: removed the Thoughtseize "the land is never a legal choice" entry. Left the other
  three `known_flaky` entries (fifteen-prompts reveal race, Declare-Blockers J-blockers, wave-35-§S
  auto-pass) untouched — none of them are this lane's tests.

## 5. Judge-jq, run against a real report

```
pnpm exec vitest run --fileParallelism=false --reporter=default --reporter=json \
  --outputFile=/tmp/claude-1000/w49-B/mini-report.json \
  apps/ui/src/play/live/board-play.jvm.test.ts apps/server/src/play/scenario-thoughtseize.jvm.test.ts
```
→ exit 0, `Test Files 2 passed (2)`, `Tests 3 passed (3)`, report written (2180 bytes, non-empty).

Ran `ci.yml`'s own judge `jq` (copied verbatim from the "Every jvm suite ran..." step, `FULL=false`
since this is a partial 2-file run) against that report with my two edited lists (board-play dropped
from `known_failing`, the land-choice test dropped from `known_flaky`): **result `true`, exit 0** —
no "failed, not pinned", no "pinned as failing, did not fail", no mismatch of any kind. Re-run after
the session interruption against the same (surviving) report file: same result.

## 6. The full forge-jvm gate — attempted, interrupted, not completed

Ran all 39 tracked `*.jvm.test.ts` files (`apps/ui` + `apps/server`) serially with CI's exact
invocation (`--fileParallelism=false`, CI's three env vars only) to validate the edited lists
against the WHOLE suite, not just my two files. It progressed cleanly through roughly 30+ files
(`full-gate.log`, 41 KB) — the last few lines before the interruption's cleanup killed it show
`socket-thoughtseize.jvm.test.ts` failing with `"the JVM exited (code 143, signal null)"` and the
run ending with `exit 143` (SIGTERM). **This is collateral damage from the session interruption's
own JVM cleanup** ("any jvm runs in flight were killed," per the resume instruction), not a real
failure — code 143 is SIGTERM, not a product or test defect, and nothing in that file is owned by
this lane. The `--outputFile` JSON was never written (vitest only writes it on a completed run), so
I cannot produce a judge-jq result for the complete 39-file set.

**Could not verify:** the full forge-jvm gate across all 39 suites, end to end, in one run. Verified
instead: (a) my two owned suites directly, repeatedly, under three load conditions each (above),
and (b) the judge-jq logic against a real (partial) report containing both. Did not re-attempt the
full 39-file run before the 07:30 UTC deadline — it takes ~25-30 minutes serially, and wave 50 now
shares this host and `/tmp/claude-1000/heavy.lock`; re-running it risked not finishing in time and
contending with w50's own lane work for no new information about MY two files.

## Files changed by this lane

- `apps/ui/src/play/live/board-play.jvm.test.ts` — the :663 fix + the parity-check follow-on fix (both above).
- `apps/server/src/play/scenario-thoughtseize.jvm.test.ts` — the `inOwnMain` gate (defensive, unconfirmed-causation).
- `.github/workflows/ci.yml` — two list removals (above). Pinned-list lines only; no other changes.
- `docs/planning/wave49-evidence/B/README.md` — this file.
- No new `scenarios/w49-b-*.state` files were needed — both fixes stayed within test-driver logic,
  no new Forge puzzle state required.

## Not done / left for the tracker

- The full 39-suite forge-jvm gate end to end (see §6).
- `forge-e2e` — not run by this lane. Nothing in this lane's changes touches UI runtime code, e2e
  specs, or anything `forge-e2e` exercises (only two `*.jvm.test.ts` files and `ci.yml`'s pinned
  lists changed); e2e behaviour is unaffected. Lane A's concurrent changes are the ones that touch
  e2e-relevant files.
- The `DECLINED_CLICK_BOUND` question under extreme single-core contention (§1) — flagged, not
  fixed, pre-existing.
