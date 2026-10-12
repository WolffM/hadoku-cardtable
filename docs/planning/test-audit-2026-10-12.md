# Test audit, 2026-10-12 (lane A0: measure and inventory)

Read-only audit. No test or product code changed. The data covers **2026-10-09 12:00Z to 2026-10-12 16:33Z** and comes from:

- **forge.yml:** 739 completed runs, of which 177 were pushes, 12 schedules and 550 dispatches. I parsed 975 `forge-e2e`/`forge-jvm` job logs. That gives 27,480 e2e test results, 9,972 jvm per-test results and 5,189 jvm per-file results.
- **ci.yml:** 178 runs, of which 18 were red. I read the logs for 16 of them; the other 2 had expired.

The scripts and raw data are in the manager's scratchpad under `a0/`. They are `parse.py`, `analyze.py`, `results.jsonl` and `stats.json`, and they can be re-run.

**Definitions used throughout**

- A failure **did not reproduce** (non-repro) if either:
  - the same test passed at the **same sha** in some other run or repeat; or
  - on main it was an isolated red, with a pass in the main run before it and in the main run after it.
- **Flake %** = non-repro failures ÷ runs.
- **Caveat:** vitest prints per-test durations only for slow tests. Per-test jvm stats therefore cover slow tests only. Per-file jvm stats cover every file.

## 0. Headline numbers

| | |
|---|---|
| Main Forge runs (push + schedule) that completed | 112. 69 red, 43 green |
| Since 10-11 00:00Z | 63 completed. 26 red (41 %) |
| Main runs whose **only** reds were tests with a measured flake share ≥ 25 % | **30 of 70** red (by run id, e2e + jvm) |
| Biggest single sources of red on main | `prompts.jvm` "combat and targets" (41 failing results on main), `w67-shaman.spec` (40), `played-card.spec` (10), `phyrexian.jvm` (9), `table-fit.spec` (8) |
| Full e2e run (last schedule, run 38234802880) | 221 tests, **70 min serial**, 3 shards, each shard ~14–18 min wall clock |
| Full jvm run | 55 suites, median **19.9 min** (max 34.7) |
| Claw time, 3 days | e2e 158 job-hours (60 push, 8 schedule, 90 dispatch); jvm 42 job-hours |
| e2e setup floor | p10 test = 11.1 s. Every Forge test pays roughly 11 s of stack, browser and match start before it asserts anything. That is about **55 % of the 70 serial minutes** |
| `check` (the deploy gate) | 3,506 unit `it`/`test` in 153 files, plus 5 non-Forge e2e specs. 55 jvm suites skip there |

## 1. Inventory

### 1.1 Unit tests (vitest, run by `check`)

153 files and about 3,506 tests. vitest itself reports 6,356 once `each` is expanded.

| area | files | tests |
|---|---|---|
| apps/ui/src/play (live, prompts, gestures, inspect, tip, Board) | 48 | 1,449 |
| apps/server/src/play (+ bridge, browser) | 10 | 479 |
| apps/server/src/http | 6 | 172 |
| apps/ui/src/screens | 7 | 157 |
| apps/ui/src/draft | 9 | 149 |
| apps/server/src/room | 5 | 128 |
| apps/ui/src/{components,sound,rooms,room,stats,chrome,embed,deck,settings} | 23 | 242 |
| packages/carddata | 8 | 159 |
| packages/forge-wire | 6 | 119 |
| packages/deck | 5 | 100 |
| packages/shared | 4 | 81 |
| packages/room-store | 6 | 64 |
| packages/draft, room-ask | 4 | 59 |
| apps/server/src (other: busy, base-path, index, cover, stream, stats) | 6 | 92 |
| scripts (ci selector, art ids, forge-bundle), e2e/isolation.test.ts | 4 | 58 |

The root `vitest.config.ts` glob matches `*.test.ts` only. There are no `*.test.tsx` files today, but one added later would silently never run.

### 1.2 JVM suites (`*.jvm.test.ts`, forge.yml `forge-jvm` only)

There are 55 suites. Appendix B lists every suite with what it guards, its runtime and its 3-day counts. Three more jar-gated suites exist but are **not named `*.jvm.test.ts`, so they run in no CI job** (§3.2).

Slowest by median file time:

| suite | median s |
|---|---|
| library-match | 190 (nightly only) |
| prompts.jvm | 105 (one case p90 126 s, timeout 150 s) |
| scenario-start | 66 (×3 on push, ×10 nightly) |
| w70-clue | 53 |
| match-slots | 53 |
| flow | 50 |
| auto | 49 |
| combat-drag | 46 |
| ee-asks | 42 |
| sanctum-worldbreaker | 37 |
| cast-hidden | 37 |

All other suites take 9–28 s, because each starts its own JVM. The sum of file medians is about 24 min. Most files are 1–3 `it`s, each paying a JVM start of about 9 s.

### 1.3 E2E specs (`e2e/*.spec.ts`)

There are 112 specs:

- **107 Forge-gated.** They self-skip in `check` and run only in forge.yml. 86 use `startScenarioMatch`; 14 use the room flow with random library decks (`startPlayStack` + `enterMatch`).
- **5 not Forge-gated:** `draft`, `room-mode`, `w48-format-tabs`, `w50-sound-builder`, `streamed-live`. These run in `check`. `streamed-live` skips without docker, so it runs nowhere (§3.2).

Appendix A lists every spec: what it guards, its scenarios, its test count and seconds in the last full run, and its 3-day runs, failures and non-repro count.

Slowest in the last full run (seconds, share of 4,203 s):

| spec | s | % | why |
|---|---|---|---|
| w69-avatar | 378 | 9.0 | **One test**, `test.setTimeout(8 min)`. A full room-flow Forge match just to screenshot a CSS focus ring about 20 times, with a 300 ms settle per state and an in-page per-pixel JS loop. This is a static-UI check paying for a live match. |
| w35 | 229 | 5.4 | 12 tests on 9 scenarios. R5 (End Turn highlight) alone takes 42 s; R4 (Thoughtseize) 35 s |
| dead-bar | 174 | 4.1 | 6 tests at about 29 s each, including deploy/restart cases (server relaunch) |
| aa-polling | 167 | 4.0 | 3 room-flow tests, 8 `waitForTimeout` (it measures request volume over real time) |
| w33 | 143 | 3.4 | 9 scenario tests, all at the 14 s floor. The cost is setup, not the test bodies |
| presence | 138 | 3.3 | 8 tests |
| w69-rematch | 136 | 3.2 | 3 room-flow tests, each playing to a result screen; one is 59 s |
| table-fit | 117 | 2.8 | 2,595-line spec; "a live match fits…" takes 56 s median, 102 s p90 |

## 2. Flakiness

### 2.1 Ranked by flake rate (non-repro failures ÷ runs, all branches, 3 days)

| # | test | runs | fails | non-repro | flake % | main: runs / fails / isolated |
|---|---|---|---|---|---|---|
| 1 | jvm `prompts.jvm` › combat and targets | 129 | 24 | 17 | 13.2 | 79 / 19 / 14 |
| 2 | e2e `w69-chip` › other screen follows a dragged ability chip as smoothly as a card | 105 | 16 | 11 | 10.5 | 30 / 0 / 0 |
| 3 | e2e `w71-tap-reveal` › paced: land taps start with the reveal | 29 | 15 | 3 | 10.3 | 3 / 2 / 0 |
| 4 | e2e `w69-librarytop` › flashback card buried in a 60-card graveyard | 38 | 17 | 3 | 7.9 | 8 / 2 / 2 |
| 5 | jvm `yield.jvm` › hides alice's response window… | 116 | 10 | 9 | 7.8 | 75 / 6 / 6 |
| 6 | jvm `prompts.jvm` › a reveal: the label carries "(id)"… | 112 | 12 | 8 | 7.1 | 63 / 7 / 6 |
| 7 | jvm `combat-drag.jvm` › an attack and a block… | 119 | 10 | 8 | 6.7 | 79 / 6 / 6 |
| 8 | e2e `w32` › Q1 / End Turn passes skipped phases at once | 163 | 10 | 10 | 6.1 | 79 / 1 / 1 |
| 9 | e2e `prompts-offboard` › W18 "you may pay {X}" | 155 | 10 | 8 | 5.2 | 81 / 2 / 2 |
| 10 | e2e `w67-shaman` › bears / shaman / shaman-held / shaman-midglide (4 tests) | 299 each | 89 | 44 | 3–5 each | 73 / 40 / 13 |
| 11 | e2e `embed` › binds one room to one table… | 131 | 8 | 6 | 4.6 | 59 / 1 / 1 |
| 12 | e2e `w69-perf` › never lays the board out again | 68 | 6 | 3 | 4.4 | 14 / 1 / 1 |
| 13 | e2e `w62-condescend` › pay-or-decline and scry never draw at once | 137 | 7 | 6 | 4.4 | 79 / 6 / 5 |
| 14 | e2e `table-fit` › a live match fits 1280×800 and 1366×768 | 279 | 24 | 11 | 3.9 | 101 / 8 / 4 |
| 15 | e2e `w62-bounce` › other seat never told to "decide" | 158 | 10 | 6 | 3.8 | 79 / 4 / 4 |
| 16 | jvm `blockers.jvm` › Q12 summoning-sick creature offered the block | 110 | 4 | 4 | 3.6 | 75 / 2 / 2 |
| 17 | e2e `w69-facedown`, `w69-name-card`, `w35` R16, `scry-one-prompt` | | | | 2.8–3.3 | |
| 18 | jvm `scenario-combat.jvm` › Q14 click declares attacker | 109 | 3 | 3 | 2.8 | 75 / 2 / 2 |
| 19 | e2e `w33` Q17, `w69-rematch` ×2, `w63-flash`, `w67-card-size`, `stacking`, `w62-parked` AE18, `played-card` creature | | | | 1.2–2.2 | |

Reds that **do** reproduce (consistent, not flakes):

| test | record | what it is |
|---|---|---|
| `[nightly] choices` (prompts.jvm) | 53 / 53 | pinned `known_failing` |
| `w69-perf` 4 ms budget | 22 / 22 | branch-only |
| `w63-yield` | 17 / 78 | all on lane branches; 0 / 20 on main |
| `phyrexian.jvm` | 9 / 107 | `stale-reply` on getChoices; a contiguous block on main = a regression window, not flake |
| `lobby-fit`, `play.spec`, `land-abilities`, `xn-copies`, `lg-gamelog` | | lane work in progress |

### 2.2 Mechanisms (grouped where the fix belongs)

| Mechanism | Tests | Evidence | Shared code to fix |
|---|---|---|---|
| **M1. Fishing in a random game for an ask.** A seeded two-human game is driven until Forge *happens* to raise four ask methods. | prompts.jvm "combat and targets" (#1, timeout 150 s, median 75 s, p90 126 s); `[nightly] choices` (stalls every run, pinned); prompts.jvm reveal (#6); combat-drag.jvm (#7, "combat was never driven by drag: 5 attack drags, **0 block drags**") | prompts.jvm.test.ts:408-442, `drive(... every(m => answered(h,m).length > 0), 150_000)`. Stalls end on `[1,"openZones",…]` frames: the plan never reaches assignCombatDamage. | `apps/ui/src/play/live/` jvm driver (`createDriver`/`drive`). Replace the seeded-random games with scenarios (the `.state` mechanism already exists): one scenario per ask method. This removes the biggest red on main and the 180 s nightly pin. |
| **M2. Frame-sampled animation/position assertions with ms bounds.** These read every rAF and assert where a stand-in was, or how long it stood still. | w67-shaman (×4; "bob: the stack card stands where the card lands (x,y), not back at the release" ×51, "bob's card shown before its flight" ×24); w69-chip ("stands still longer than the card does (50–83 ms)"); w71-tap-reveal ("within 80 ms"); w69-librarytop ("opening the view takes no long task", "frames keep the display rate"); w69-perf (p95 main-thread work ≤ 4 ms); table-fit "every frame fits" (hand scrolls inside itself) | 18 specs use rAF recorders and 15+ specs assert numeric ms thresholds (table-fit 36 `toBeLessThan`). The failures cluster on loaded claws: claw-8/claw-9 in the shaman/chip examples. **w67-shaman's own header says "measurement, not a gate"**, yet it is the second-largest red on main. | (a) Separate *measurements* from *gates*. Measurement specs print evidence and run under a `@measure` tag that never reds main. (b) Gates assert **order and end state** from the server/handover telemetry (`handover-report.ts` `doubled`, landing order) instead of wall-clock ms on a shared claw. (c) The few true perf gates run on a pinned, idle runner or use relative budgets. The handover part of w67-shaman is a real race the operator hit (w67, 2026-10-10). It belongs in a deterministic placement test (socket hold as in run 4 of that spec), not in four frame samplers. |
| **M3. A drag that never arms.** | table-fit (16 of 24 fails), w69-blocks: "the drag never armed: pickedUp stayed 0 after mouse.down" at `e2e/play/w32.ts:135-141` (`pointerDrag`) | It is 5 of the 8 table-fit fails on main. The first press after a scenario start or a re-render is dropped. Compare the "scenario-start race" note in `w68-untap.spec.ts:69` ("The first click after a scenario applies can be dropped… repeated a second apart"). | `e2e/play/w32.ts` `pointerDrag` and `board.ts` click helpers: gate the press on a board-ready state (the card's `data-*` offered/arm-ready attribute, or the server's offer), not on visibility. Then delete the per-spec "click twice a second apart" workarounds (`w68-untap.spec.ts:69`). |
| **M4. Match creation times out under load.** | `apiRequestContext.post: Timeout` at `e2e/play/scenario.ts:303/309`. 14 fails across played-card, presence, stacking, w36, w49, w59, w62-parked, w67-trigger-ask, w55, w67-card-size; 9 non-repro, 5 on main | `POST /api/play/matches` spawns the JVM synchronously inside the request; Playwright's request timeout cuts it. | `startScenarioMatch` / server `matches` route: return 201 at once and wait for readiness on the socket. Or warm a JVM per stack (the play pool exists). This is also the M7 setup cost. |
| **M5. Sampling a short-lived state with a polling tick, or asserting that a transient never shows.** | w62-condescend ("bob's own payment window was observed at least once": 50 ms tick loop at :170-194); w63-flash ("server forwarded bob a real window at least once", 0 seen); w62-bounce (MutationObserver saw "Waiting for Alice to decide…"); w32 ("End Turn: no phase waits out Forge's own pause"); yield.jvm ("alice's own wire carried a bar for bob's spell"); blockers.jvm Q12 (`'Waiting for A...'` vs `/^Select creatures to block/`: read before the block ask arrived) | Half of these are probably **real intermittent product races**: a window sent and then auto-answered, or a waiting banner for a decision the server answers itself. The test cannot tell the two apart. | Read **server-log telemetry** (ask-answered / ask-auto-answered / withheld) as the oracle, as `w62-bounce` already half does. Use one shared `recordSurface(page, testid)` MutationObserver helper in `e2e/play/` for client surfaces, with no ad-hoc tick loops. In jvm, gate on the ask frame, not on prompt prose. |
| **M6. Infra.** | `enter.ts:48` format-fixed toHaveAttribute (21, branch-only); `embed` "no socket.io request after unmount" (7); `check` RoomShell.test "mounts once" (`expected +0 to be 1`, 4 isolated reds on main); constructed.test "drafted-none" (2 isolated reds, **already widened to 10 s** in 57da1e4d, still red, so not a budget problem); vitest-worker "Timeout calling onTaskUpdate" (1); port 19108 already in use (1) | RoomShell was fixed by c291112c after the last red, so it is unproven. constructed.test's comment says the view can fire before the screen listens. That is a subscribe-order race, and the timeout bump did not fix it. | Unit: constructed.test's `mountPod` must subscribe before firing (a shared test socket that buffers until the listener attaches). E2E: `harness.ts` should close the friends a test opens. Every log has `[play-stack] closed 2 browser context(s) left open by an earlier test`, 40 times per shard, so tests leak contexts into the next test's timing. |

### 2.3 Pins that no longer pin anything

- **forge.yml `known_flaky`: all three entries are stale.** Over 3 days:
  - board-play "plays a land and casts spells": 0 / 112;
  - scenario-blockers Q12 "defender with one creature is NOT auto-passed": 0 / 108;
  - auto-pass-land "§S follow-up: seat 1 holds only untapped lands": 0 / 114.

  A `known_flaky` entry can never red, so each one is a hole. Delete all three.
- **`known_failing` `[nightly] choices`** has failed 53 of 53 since 2026-10-03, at 180 s per nightly. It is M1: fix it with scenario-driven asks, or delete it. Its comment at prompts.jvm.test.ts:475 still says "pinned … in ci.yml".

## 3. Meaningfulness

### 3.1 Tests that pin implementation, not behaviour

| What | Where | Cost |
|---|---|---|
| CSS-value pins | `apps/ui/src/play/Board.test.ts`: about 118 `declarationIn(board.css…)` + 33 `declarationInCss(card.css…)`, e.g. :4258/:4326 `.toBe('calc(var(--credit-strip) + var(--pile-fan) - 3px)')`. `LiveBoard.test.ts`: 28 (`'padding: 4px 0 2px'`, `'--rail-rows: 13'`). `constructed.test.ts`: 11 (`grid-auto-rows: 190px`). Also choices.test 6, zone-box.test 5, CoinToss 1, layer.test 2 | 45 of the 66 commits touching card.css/board.css since 09-28 also touched Board.test. The badge offset was re-pinned twice in a row (d36d50c6, b04c53fa). |
| Hash baseline | `apps/ui/src/play/live/parity.test.ts:571-589`: `BASELINE_SHA256` + `BASELINE_LENGTH = 39378` over the whole board's static markup | About 28 re-pins since 09-17, 11 of them since 10-05 (e.g. 58886b00 "re-pin parity"). On a red it cannot say *what* changed. The socket-replay test at :605 is the behavioural one. |
| Source-text greps | `LiveBoard.test.ts:2085` pins the exact `installGestures({ canvas, match, motion: motionWanted, report: … })` call string (re-pinned in 3 commits); `Board.test.ts:4862`; `auto.test.ts:1525-1540` slices auto.ts between two **comment banners**; `draft/socket.test.ts:543`; `forge-wire/envelope.test.ts:269` | These are architecture rules written as text matching. They belong in eslint `no-restricted-imports` / `no-restricted-syntax`. |
| Exact prose | `LiveBoard.test.ts`: 13 full sentences (`'Seat 1, waiting for the state.'`, Forge's `'Return 1 card(s) to the bottom of your library'`). **Forge prose as e2e driver gate:** `/^Select creatures to attack/` in w46-attack:129, cr-combat-clip:159, w33:238/253, w51-control-box:205, ww-creature-state:110; w53-prompt-words:173 | 666bc0b2 (game-log rewrite) rewrote 216 lines of auto.test, 90 of LiveBoard.test and 37 of match.test. Drivers should press by state (memory: "e2e drivers press by state, not text"). |
| Constant restatements | socket.test:269 `MAX_CONCURRENT_MATCHES === 10`, prefs.test:65, tier-c.test:139, lobby.test:126, auto.test:65/:1636/:1657 (whole-policy deep-equal), sounds.test:183 | Each is cheap, but each is a pure change-detector. |
| Prop-spy coupling | `LiveBoard.test.ts:174-183` mocks `Board` to capture `interaction`; 21 assertions read it | This pins the LiveBoard→Board interface rather than what is rendered. |

### 3.2 Tests that can't fail, or never run

- **Three jar-gated suites run nowhere.** forge-jvm selects by `*.jvm.test.ts` (forge.yml `git ls-files`; `select-forge-tests.ts:441`) and `check` has no jar, so these always skip:
  - `apps/server/src/play/jvm.test.ts` (refresh, then crash: an ask parked in Forge survives);
  - `apps/server/src/play/browser/browser-jvm.test.ts` (two browsers over the WebSocket against real Forge);
  - `apps/server/src/http/gate.test.ts:178` (one `describe.skipIf`: "hands Forge the checked text and the match runs").
- **`streamed-live.spec.ts`:** both docker tests `test.skip` without docker, and the claws deny docker. It has no Forge marker either, so it runs nowhere *(the docker side is unverified on hokon)*.
- **`theme-agreement.test.ts:149,155`:** `ctx.skip` on the "no-chrome"/"no-theme" verdicts, so a regression that removes the chrome turns into a skip.
- **`scripts/forge-bundle.test.ts:456`:** `skipIf` on a hardcoded `/home/hadoku/.local/opt/jdk-21.0.12.1+1/bin` path.
- **Probes kept as specs or suites:** `w65-elves.jvm.test.ts:110,123` (no `expect`; only `waitUntil`); `w64-river.spec.ts` ("measuring: …"); `w67-shaman.spec.ts` (header says "measurement, not a gate").
- **83 unreachable guards:** `if (!available.ok) return;` sits inside `describe.skipIf(!available.ok)` across 47 files.

### 3.3 Duplicated coverage (merge candidates)

| Group | Specs / suites |
|---|---|
| Mana-source untap | **w68-untap** (table over Forest, Island, Tron, River, Signet, Elves, Adarkar; last-tapped and out of order) already covers **w65-elves**, **w58-river**, **w58-painland** and `w65-elves.jvm` |
| Mana tapping and payment | w52-mana, w53-type-pill, w68-pay, w64-river (probe), land-abilities, w69-offers |
| Scry | scry-one-prompt (scry 4), w62-scry (Preordain), w70-nissa t2 (scry 1) |
| Trigger chip on `w67-trigger` | w67-trigger, **w69-chip** (same "other screen follows" claim, #2 flake), w69-chip-text, w69-chip-shape, w69-mirror, w67-trigger-ask |
| Counterspell on `w49-a-counterspell-opponent` | w49-counterspell, w65-commit, w67-counter, played-card |
| Reveal | w67-reveal and w67-trigger-ask (same scenario, both Dark Confidant), w69-reveal, w71-tap-reveal |
| Blocks on `w54-b-two-blockers` | w54-blockers, w69-blocks, w71-drag-block, w56-numbers |
| Waiting banner | waiting, w60-waiting, w67-respond-wait |
| Yield / stops on `own-spell` | w63-yield, full-control-yield, phase-stop |
| Arrows | arrow, arrows, modal-arrows, w49 arc |
| Avatar | w69-avatar, yy-avatar |
| Piles on `w67-piles` | w67-piles, w67-click-art, w69-pile-inspect |
| jvm pairs | two-mana-pass vs socket-two-mana-pass (the same Goblin Piker cast over two harnesses); scenario-thoughtseize vs socket-thoughtseize, and priority vs scenario-priority *(by header only)* |

The omnibus `w31`–`w36` specs (7–12 tests each, room flow or 9 scenarios) predate most topic specs and overlap them.

### 3.4 Dead

- **Scenarios** referenced by nothing except planning docs: `w41-grasp.state`, `w46-a-permanent.state`, `w46-a-two-bolts.state`. The art invariant still forces art rows for their cards.
- **e2e helpers:** no dead functions, but 23 exports are used only in their own file (harness.ts 8, isolation.ts 3, w32.ts 2, …).

## 4. Gaps

### 4.1 Landed in the last 3 days without a behaviour-level guard

AF1–AF21 are well covered: each has a spec or jvm suite, and dead bars have the global `assertNoDeadBar` at `harness.ts:375`. The gaps:

| Commit / row | Feature | Guard today |
|---|---|---|
| 54d09326, c484e9da, 918dc988 | End Turn passes remaining phases at once; no per-phase sound on the other seat | unit (`pace.test`) only. No spec reads `kind:'sound'` telemetry |
| 922cd08e, 826021d8 | log line paced as its own class; the opponent never reads a cast before it is on their stack | unit. `lg-gamelog.spec` makes no ordering assertion against the stack |
| a77ebdce, 6df4897a | own priority flag / attack window closes on the press | `match.test` only. `assertNoDeadBar` covers the opposite failure only |
| AF14 (87b07078) | "Done Attacking/Done Blocking" labels | `LiveBoard.test` only |
| AF17 | inspector 25 % larger | unit only |
| edaee308 | press-drag lifts the prompt's row, not the board copy | unit |
| 4d818b19, d36d50c6, 97ab9efd, 87d349d5, 5f872697 | deck art choice, artist credit, decks by win rate, deck hover list, Free-pick label | unit only |
| 77380dd9, 507b6767, bb74ae4e | room mounts once (two sockets), feed socket close | `RoomShell.test` (itself flaky, §2.2 M6) |
| 02de24f9 | log redraw perf | none |

### 4.2 The CI selector (`scripts/ci/select-forge-tests.ts`)

1. **Logic modules with no testid collapse to smoke, even on a dispatch.** `pace.ts` maps through `MatchScreen`'s `match` testid, which is used by 107 specs. It is therefore "sampled" down to play + table-fit, so `w71-tap-reveal`, `w47-pace` and `dead-bar` never run for a pacing change.
2. **Push mode's "6 most specific" ranks by key rarity, not relevance.**
   - The fix's own spec was skipped for 0bc18c18 (`w70-tapped-drag`), e1e12ebd (`w70-nissa`/`scry-one-prompt`/`w62-scry`) and fa399cef (`w71-tap-reveal`).
   - Every server-runtime, bridge or pin change ran smoke only on push (826021d8, 3802057e, 1f49c91c, 112836fe). The Signet regression 44497be5 landed this way and was caught later by w68-untap in a full run.
   - The selector's own test has no case asserting that a fix's own spec gets picked.
3. **jvm suites never run on push** unless the suite itself or a scenario it names changed (`:722` defers all rank > 0 jvm picks).
4. **`art-ids.json` maps by testid to lobby specs** (embed, lobby-fit, aa-polling), which is meaningless. Measured: the push for 10854165 selected 9 specs, none relevant.
5. **Suites that read the tree from disk are invisible to `land.sh`'s `vitest related`.** Only `build-art-ids.test.ts` was special-cased (af12b7dd), and only after it reddened main twice (38189416671, 38190220805). Still invisible:
   - `http/tables.test.ts:472` (`decks/*.dck`);
   - `http/library-eras.test.ts:64`;
   - `carddata/resolve.test.ts:365` (`reports/cube-resolution.json`);
   - `play/auto.test.ts:53` (its fixture dir);
   - `screens/tokens.test.ts:12` (themes css).

   `check` runs everything, so each of these becomes a red-main gap rather than a land-time catch.
6. Scenario mapping is literal-name only.

### 4.3 Bug classes that keep recurring without one table-driven guard (since 10-05, subject-regex counts)

| Class | ~fix commits | One-by-one specs | The one guard |
|---|---|---|---|
| Placement / hand-over / mirror | ~35 | w67-shaman ×4, played-card, w70-tapped-drag, w71-tap-reveal… | `handover-report.ts:100` already records `doubled` for every hand-over and landing, but only w67-shaman reads it. **Assert `doubled === false` for every handover/landing row in every spec's server log at `stack.stop()`**, beside `assertNoDeadBar`. Every cast in 100+ specs then becomes a probe. |
| Asks / prompt shapes | ~30 | ee-thicket, scry-one-prompt, tt-cryptic, w70-valakut, unless-cost, w62-scry, w70-nissa | `ask-unparsed` / `trigger-decision-malformed` = 0 at `stop()`, plus one real-Forge corpus table (method, shape) → one prompt |
| Mana / untap / payment | ~24 | w68-untap, w68-breach, w68-pay, w65-elves, w52-s-signet, auto-pass-land.jvm, land-abilities, unless-cost, scenario-nykthos.jvm | One jvm table: source kind (basic, painland, Signet, dork, filter, Nykthos/Tron, man-land, Ghost Quarter) × action (tap at priority, tap in payment, second click in a later window, untap last / out of order, opponent's spell holds the window iff non-mana ability) |
| Stack / arrows | ~20 | modal-arrows, w69-chip-shape, w59-stack, stacking | One table over target shapes (single, modal chain, player, spell, trigger chip, face-down): one arrow per Forge target on both screens, driven from the bridge's target list |
| Bar / flag / "Waiting for…" | ~16 | dead-bar, w32, w55-withheld, w62-bounce, w60-waiting | The converse of `assertNoDeadBar` at `stop()`: per window, (server asked seat) ⇔ (bar live ∧ own flag lit ∧ other seat shows waiting). This also turns M5's transient asserts into one oracle. |
| Art rows | 8 data follow-ups | w69-backface, w67-click-art, cancel-home | Extend `build-art-ids.test.ts:86` from scenario-placed cards to tokens and created cards plus every `decks/` name. Add a client report of any face drawn without art, asserted at `stop()` |

## 5. Optimization

| Item | Today | Change | Est. saving per full e2e run (serial 70 min) |
|---|---|---|---|
| Per-test stack + JVM + 2 browsers + match start (setup floor about 11 s × ~210 Forge tests) | about 38 min of 70 | Worker-scoped stack fixture: one server per shard, a fresh match per test. Optionally a pre-warmed JVM from the play pool for the next match (M4 also goes away). Close leaked contexts. | 15–25 min serial (≈5–8 min wall per shard). *Estimate: the split between server boot, JVM boot and browser open is unmeasured; one ×1 timing dispatch with stack timestamps would settle it.* |
| w69-avatar | 378 s, 1 test | Move to a unit/visual test on the static board (no Forge): the bug is the focus outline CSS | about 6 min |
| Duplicate specs (§3.3): drop w65-elves, w58-river, w58-painland into w68-untap; w69-chip into w67-trigger; w67-trigger-ask into w67-reveal; jvm two-mana-pass pair | about 12 specs at ~17 s | Merge | about 3–4 min |
| w67-shaman (4 runs × 19–25 s) | 75 s, 2nd-largest red on main | Keep one deterministic hand-over test; move the measurement to a `@measure` project | about 1 min, and most of main's e2e red |
| prompts.jvm combat (75 s median, 150 s cap) + nightly choices (180 s) | about 105 s per push-scale run, +180 s nightly | Scenario per ask (M1) | about 1.5 min jvm, +3 min nightly |
| jvm: one JVM per `it` (about 9 s each) | 24 min sum of file medians | Group single-`it` suites that share a scenario family into one file with `beforeAll` match reuse where state allows *(needs care: the scenario-start race)* | maybe 3–5 min *(guess)* |
| Shard balance | shards 16.5 / 13.8 / 17.6 min median | `--shard` splits by file. Large files (w35, table-fit, dead-bar, w69-avatar) skew it. Splitting omnibus specs evens it out. | about 2 min wall |
| Push selection | 71 of 100 pushes in the window ran 3 full shards (pre-selector); since bb5bc9a1, 28 of 33 run 1 shard with 2–12 specs | Fix relevance (§4.2) rather than widen | n/a |

Video is off by default. `--repeat-each` defaults to 1 and only proof dispatches use 3, so neither is a cost today.

## 6. Recommended fix lanes (disjoint ownership, infra first)

**L1: e2e harness and drivers** (owns `e2e/play/*.ts`, `e2e/playwright.config.ts`, and the server `POST /api/play/matches` readiness path). Size: L.
1. Worker-scoped stack fixture: one server per shard, fresh match per test. Close contexts each test opens (fixes the "closed 2 browser contexts" leak).
2. M4: match creation returns without holding the request open for the JVM spawn, and the harness waits on readiness.
3. M3: `pointerDrag`/click helpers gate the press on an armed/offered state. Then delete the per-spec "repeat the first click" workarounds (`w68-untap.spec.ts:69` and similar).
4. M5: one `recordSurface()` MutationObserver helper plus server-log oracles; port w62-condescend, w63-flash, w62-bounce and w32 to it.
5. Cross-spec invariants at `stack.stop()`: `doubled === false` on handover/landing rows; `ask-unparsed`/`trigger-decision-malformed` = 0; the converse of `assertNoDeadBar`.

**L2: timing, animation and perf specs** (owns `w67-shaman`, `w69-chip`, `w71-tap-reveal`, `w69-librarytop` perf half, `w69-perf`, `table-fit`, `w63-flash`, `w69-avatar`). Size: M. Depends on L1's invariants.
1. Split measurement from gate. Add a `@measure` tag/project that prints evidence and never reds main.
2. Rewrite each gate to assert order and end state from telemetry instead of ms on a loaded claw. Keep one deterministic hand-over test (the socket-hold run).
3. Move w69-avatar to a static, Forge-free test.
4. Merge w69-chip into w67-trigger.

**L3: jvm driver and suites** (owns `apps/ui/src/play/live/*.jvm.test.ts` + driver, `apps/server/src/play/*.jvm.test.ts`, the forge.yml jvm pin lists). Size: L.
1. M1: replace the seeded random "fish for an ask" games (prompts.jvm combat, reveal, `[nightly] choices`, combat-drag) with one scenario per ask method. Delete the `known_failing` pin.
2. Delete the three stale `known_flaky` pins (0 fails in 108–114 runs each).
3. Rename or move `play/jvm.test.ts`, `browser/browser-jvm.test.ts` and `gate.test.ts`'s jar block to `*.jvm.test.ts` so they run.
4. Gate drivers on ask frames, not prose (blockers Q12, yield).
5. Build the mana-source × action table suite and fold `w65-elves.jvm`, `w52-s-signet` and `two-mana-pass` into it.

**L4: unit-test meaningfulness** (owns `apps/ui/src/play/Board.test.ts`, `live/LiveBoard.test.ts`, `live/parity.test.ts`, `screens/constructed.test.ts`, `room/RoomShell.test.ts`, `server/src/play/auto.test.ts` banner slice, eslint config). Size: M. The net diff should be negative.
1. Replace CSS-value pins with behaviour: computed layout in jsdom where it matters, else delete.
2. Drop the parity hash and keep the replay test.
3. Turn source greps into eslint `no-restricted-*` rules.
4. Replace prose pins with testid/state.
5. Fix the constructed.test subscribe-order race (a buffering test socket) and verify RoomShell.

**L5: CI selection and invariants** (owns `scripts/ci/select-forge-tests.ts` + test, `scripts/land.sh`, `.github/workflows/forge.yml` except the jvm pin lists, `scripts/art/build-art-ids.test.ts`). Size: M.
1. Rank push picks by relevance: changed module → specs that import or exercise it, plus the spec added in the same commit range.
2. Logic modules (pace, match, bridge) map to a curated spec family, not smoke.
3. Run rank-1 jvm picks on push.
4. Treat disk-reading unit suites as dependents of their data dirs in `land.sh`.
5. Extend the art invariant to tokens, created cards and `decks/`.
6. Delete the 3 dead scenarios.
7. Add selector test cases: "the fix's own spec is picked".

**L6: dedupe e2e** (owns the duplicate-group spec files in §3.3 not owned by L2: w65-elves, w58-river, w58-painland, w62-scry/scry-one-prompt/w70-nissa scry case, w67-trigger-ask/w67-reveal, w49/w65-commit/w67-counter, w54/w69-blocks/w71-drag-block, waiting/w60-waiting/w67-respond-wait, yy-avatar, w67-click-art/w69-pile-inspect). Size: S–M. Merge into table-driven specs, then delete. Do this after L1 so the merged specs use the shared fixture.

Not assigned (G2's area): `w50-sound-builder.spec.ts:122` is red on main heads 80394f32 and 5b386ac5 in `check`.

## Appendix A: e2e specs

"guards" is the first sentence of each spec's header. "tests" and "full-run s" come from scheduled run 38234802880. The 3-day counts cover every test title the spec carried in the window, all branches.

| spec | guards | scenario(s) | tests | full-run s | 3-day runs / fails / non-repro |
|---|---|---|---|---|---|
| aa-polling | Request volume — hadoku_site's request log, 6 h to 2026-10-10 23:28Z: | (room flow, random decks) | 3 | 167 | 174 / 12 / 0 |
| arrow | The targeter arrow, measured in a browser that has boxes. | auto-target | 1 | 17 | 131 / 0 / 0 |
| arrows | Wave 41 — the arrow only goes where Forge allows. | own-spell,w41-worldbreaker | 2 | 32 | 287 / 1 / 1 |
| cancel-home | A cast cancelled mid-aim goes home on BOTH screens (playtest 15, 2026-10-09): | cancel-hammer | 2 | 40 | 338 / 6 / 0 |
| cr-combat-clip | The operator: *"cards get a bit bigger when they are ready to attack, which is good but it's a little awkward when they get clipped by the f | (variable) | 1 | 18 | 12 / 5 / 0 |
| dead-bar | A dead control bar (prod match m-3bc0ad1f5ac1, 2026-10-11): | dead-bar,dead-bar-picker | 6 | 174 | 216 / 7 / 1 |
| draft | Two humans, one draft, end to end — through the ONE front door. | (no Forge) | - | - | 22 / 0 / 0 |
| drag | One test per case of the operator-approved drag-and-cast demo (https://claude.ai/artifact/3Y1E4pvAnWj1NgKbE5Hrx7), against a real Forge matc | auto-target,bolt-player,land-into-middle,thoughtseize,w60-thirst | 7 | 115 | 1267 / 0 / 0 |
| ee-thicket | A filter land's mana combination reaches the seat that asked for it. | ee-thicket | 1 | 19 | 51 / 2 / 0 |
| embed | Counts what a mount could leave behind. | (room flow, random decks) | 2 | 18 | 262 / 8 / 6 |
| full-control-yield | The operator, 2026-10-11: | own-spell | 1 | 20 | 65 / 1 / 0 |
| kw-granted-tags | Two of the operator's reports, in the window the second one came from — declaring blockers: | (variable) | 1 | 17 | 13 / 2 / 0 |
| land-abilities | The operator, 2026-10-11 (match m-d87aabc2c3e2): | land-abilities-gq,land-only-pass | 2 | 34 | 70 / 8 / 0 |
| lg-gamelog | The log is Forge's own game log, on both screens. | lg-gamelog | 1 | 20 | 12 / 7 / 0 |
| lobby-fit | More than one column of rows holds at 1024×700. | (room flow, random decks) | 1 | 6 | 152 / 14 / 0 |
| modal-arrows | A modal spell on the stack draws its arrows on both screens (the operator, 2026-10-11, with a screenshot: | modal-charm,modal-command | 2 | 35 | 48 / 2 / 0 |
| phase-stop | The operator: *"build a 'stop at' mechanic that essentially works like full control but just for one phase. | own-spell | 1 | 18 | 13 / 1 / 0 |
| play | Two humans, one Forge match, end to end. | (room flow, random decks) | 2 | 42 | 352 / 9 / 0 |
| played-card | A card played to the battlefield waits where it was let go, against a real Forge match, measured in every frame the browser draws. | land-only-pass,shockland,w49-a-counterspell-opponent | 5 | 90 | 1610 / 35 / 5 |
| presence | Presence (ledger Z5), against real Forge and two real browsers: | ai-seven-card-hand,bolt-player,land-into-middle,own-spell,w60-thirst | 8 | 138 | 2000 / 19 / 5 |
| prompt-bar | Against real Forge. The operator, on Scapeshift's "Select up to 6 land(s) to sacrifice" sheet: | scapeshift-ten | 1 | 17 | 23 / 5 / 0 |
| prompts-offboard | Wave 42 §P — W18 (the soft-lock) and W16 (World Breaker's never-explained choice), in a real browser. | w42-relentless-dead,w42-worldbreaker | 4 | 69 | 610 / 10 / 8 |
| room-mode | The room's client mode, end to end, against the REAL built server. | (no Forge) | - | - | 13 / 0 / 0 |
| scry-one-prompt | Against real Forge. The operator: | scry-one-prompt | 1 | 18 | 36 / 3 / 1 |
| stacking | Stacking cards, against real Forge: | w43-stack-lands | 6 | 107 | 846 / 3 / 3 |
| start-race | Every error text this friend's screen ever draws, across reloads. | (room flow, random decks) | 3 | 37 | 384 / 13 / 1 |
| streamed-live | A streamed room with REAL containers behind it, driven by two real browsers. | (no Forge) | - | - | 0 / 0 / 0 |
| table-fit | The table never scrolls — measured on a LIVE match, in every frame. | w43-planeswalker,w43-stack-lands | 5 | 117 | 1395 / 25 / 12 |
| tp-tooltips | The operator, 2026-10-12: | (variable) | 2 | 35 | 12 / 2 / 0 |
| tt-cryptic | Against real Forge. The operator, 2026-10-11, on Cryptic Command: | tt-cryptic | 1 | 25 | 12 / 1 / 0 |
| unless-cost | A cost another player's spell puts on yours is yours to pay or decline. | unless-cost | 2 | 34 | 42 / 2 / 0 |
| w31 | Wave 31: what the second play test found, in a real browser against a real Forge. | (room flow, random decks) | 7 | 100 | 952 / 0 / 0 |
| w32 | Wave 32: what the third play test found, in a real browser against a real Forge. | (room flow, random decks) | 2 | 31 | 316 / 10 / 10 |
| w33 | Wave 33: a game a test can SET UP, so these claims are proven rather than hoped for — every match here is seeded by a scripted Forge opening | attackers-declared,auto-target,glint-hawk,lone-spell,no-creatures,one-creature,own-spell,ponder | 9 | 143 | 1494 / 7 / 4 |
| w34 | Wave 34: the Full Control wall, Ponder's silent resolution, and the four untested shipped items — each against real Forge, each asserting it | choose-x,lone-spell,poison,ponder,two-triggers | 6 | 113 | 768 / 0 / 0 |
| w35 | Wave 35: alpha polish, each item from playtest 4 against real Forge, each asserting its own precondition first ("a spec that cannot fail is  | attackers-declared,bolt-player,glint-hawk,land-into-middle,nothing-left,ponder,raise-the-alarm,secluded-glen,thoughtseize | 12 | 229 | 2277 / 9 / 6 |
| w36 | Wave 36: the table tells you what is happening — each item asserts the operator's own situation first, against real Forge, on `docs/planning | attackers-declared,cavern,lone-spell,shockland | 6 | 108 | 840 / 2 / 2 |
| w46-attack | X1/W14 — attacking a planeswalker by drag, against a real Forge match, and the lasting attack arrow (wave 46 §B item 2) that joins attacker  | w46-b-planeswalker,w54-c-vigilant | 2 | 32 | 260 / 0 / 0 |
| w47-pace | Wave 47 §P, done-when item 5/6: | w47-pace | 1 | 17 | 162 / 2 / 1 |
| w48-format-tabs | The format tab selector, end to end, against the REAL built server and the real deck library. | (no Forge) | - | - | 46 / 3 / 0 |
| w49-counterspell | Wave 49 §A — the counterspell arc, both directions, against a real Forge match. | w46-b-counterspell,w49-a-counterspell-opponent | 2 | 33 | 334 / 1 / 1 |
| w50-sound-builder | The sound builder, end to end, against the REAL built server — admin can place a take and have it survive a reload; | (no Forge) | - | - | 0 / 0 / 0 |
| w51-control-box | Wave 51 — the control box is fixed furniture, and every other answer to Forge's bar is a decision pop-up. | attackers-declared,bolt-player | 2 | 33 | 246 / 0 / 0 |
| w52-mana | Wave 52 §E — mana you can tap is mana you can click, against a real Forge match. | w52-e-island,w52-e-signet | 3 | 46 | 345 / 0 / 0 |
| w53-prompt-words | Wave 53 §P — Y18, against a real Forge match. | (variable) | 1 | 17 | 113 / 0 / 0 |
| w53-type-pill | Wave 53 §T — the operator, Playtest 9: | w53-t-magus,w53-t-signet-only,w53-t-urborg | 3 | 46 | 339 / 0 / 0 |
| w54-blockers | Undoing a block, and the lasting arrow to what it blocks — against a real Forge match. | w54-b-two-blockers | 1 | 17 | 127 / 1 / 0 |
| w55-withheld | Pressing End Turn with a creature already untapped on the active seat's own battlefield, nothing on the stack and nothing contested, skips t | attackers-declared | 1 | 16 | 125 / 1 / 1 |
| w56-exile | The operator: *"ancestral visions is a card placed into exile with suspend counters. | w56-x-suspend | 1 | 18 | 120 / 0 / 0 |
| w56-numbers | Floating combat numbers, against real Forge. | bolt-player,w54-b-two-blockers | 2 | 33 | 256 / 0 / 0 |
| w58-painland | Answer whatever choice pop-up is open: | yavimaya-coast | 1 | 16 | 124 / 0 / 0 |
| w58-river | The hand card named `name`, Forge-offered or not — by its own `.card__name` text. | river-of-tears | 2 | 32 | 230 / 0 / 0 |
| w59-stack | Wave 59 §P item 3 — the operator's own situation (AD4's design boards, https://claude.ai/artifact/DBNEciEeHeFXwsChCGx3C5), against real Forg | w59-keiga | 2 | 42 | 468 / 6 / 2 |
| w60-relations | Relations, generically. | w60-haunt | 1 | 16 | 122 / 0 / 0 |
| w60-waiting | The T2 banner's own sentence, against a real Forge match. | w60-thirst | 1 | 16 | 158 / 0 / 0 |
| w62-adjacent | The operator, 2026-10-08: | w43-stack-lands,w65-lone | 3 | 50 | 432 / 0 / 0 |
| w62-bounce | Playtest 15, AE13 — the operator, 2026-10-08: | w62-bounce | 1 | 17 | 158 / 10 / 6 |
| w62-cointoss |  | (room flow, random decks) | 1 | 15 | 130 / 1 / 0 |
| w62-condescend | The operator, on Condescend: | w62-condescend | 1 | 42 | 137 / 7 / 6 |
| w62-discard | The cleanup discard draws no targeter arrow. | w62-discard | 1 | 13 | 120 / 0 / 0 |
| w62-parked | The phantom stands still (ledger AE12 — the fourth report, 2026-10-08): | land-into-middle,w62-parked | 3 | 41 | 687 / 5 / 4 |
| w62-scry | Against real Forge. The operator, 2026-10-08: | w62-scry | 1 | 11 | 132 / 2 / 1 |
| w63-flash | The operator: *"i notice priority flashing back and forth in untap/upkeep/draw. | w66-flag | 1 | 16 | 134 / 19 / 2 |
| w63-yield | The operator: *"when it's the opponents turn the 'End turn' button should turn to 'Auto Yield' meaning that we auto-pass on whatever the opp | w63-yield | 1 | 11 | 78 / 17 / 0 |
| w64-river | Underground River — the operator's repeated report (Z10, Y23, AD6, 2026-10-08, the fourth time): | underground-river | 2 | 42 | 278 / 7 / 1 |
| w65-commit | a spell of the opponent's, committed to the stack while this seat holds priority ("Resolve Viridian Zealot?"), is ONE object on this screen: | w49-a-counterspell-opponent | 1 | 15 | 199 / 13 / 1 |
| w65-elves | The viewer's own battlefield cards named `name`, in DOM order. | w65-elves | 1 | 11 | 118 / 0 / 0 |
| w67-card-size | One source of truth for a card's size (the operator, 2026-10-09): | bolt-player | 1 | 12 | 139 / 7 / 2 |
| w67-click-art | The operator, 2026-10-09: | w67-piles | 1 | 13 | 131 / 1 / 0 |
| w67-counter | A counter resolves in three steps, not one (ledger AE27, the operator, 2026-10-09): | w49-a-counterspell-opponent | 1 | 12 | 131 / 2 / 0 |
| w67-outlines | Placement outlines (the operator, 2026-10-09): | w67-outlines | 1 | 12 | 139 / 2 / 0 |
| w67-piles | The operator, 2026-10-09: | w67-piles | 1 | 11 | 155 / 6 / 0 |
| w67-respond-wait | The operator, 2026-10-09: | own-spell | 1 | 10 | 121 / 1 / 0 |
| w67-reveal | The operator, 2026-10-09: | w67-reveal | 1 | 10 | 118 / 1 / 0 |
| w67-shaman | measurement, not a gate (playtest report, 2026-10-09): | (variable) | 4 | 75 | 1063 / 91 / 44 |
| w67-shimmer | An ability nobody stopped is never drawn on the stack — its card shimmers instead (the operator, 2026-10-09): | w67-shimmer | 2 | 24 | 278 / 3 / 0 |
| w67-trigger-ask | A trigger's one ability is not a question. | w67-reveal | 1 | 11 | 169 / 5 / 1 |
| w67-trigger | AE28 + AE29 (playtest 15, 2026-10-09): | w67-trigger | 1 | 11 | 161 / 1 / 0 |
| w68-breach |  | w68-breach | 1 | 10 | 109 / 1 / 0 |
| w68-pay |  | w68-pay | 1 | 11 | 106 / 1 / 0 |
| w68-untap | The viewer's own battlefield, id → name and tapped. | w68-untap | 1 | 18 | 125 / 11 / 1 |
| w69-always | The operator, 2026-10-10: | w69-always | 1 | 11 | 91 / 1 / 0 |
| w69-attack-flash | The operator, 2026-10-10: | attackers-declared | 1 | 13 | 79 / 2 / 0 |
| w69-avatar | Your own face stays a circle while it is the way into the settings — the operator, 2026-10-10: | (room flow, random decks) | 1 | 378 | 67 / 4 / 0 |
| w69-backface | The operator, 2026-10-11: | w69-backface | 1 | 14 | 54 / 1 / 0 |
| w69-blocks | The attacker watches the blocks being made — against a real Forge match. | w54-b-two-blockers | 1 | 11 | 72 / 6 / 0 |
| w69-chip-shape | The operator, 2026-10-10: | (variable) | 2 | 24 | 149 / 8 / 0 |
| w69-chip-text | An ability chip reads the ability's own text, not Forge's stack-instance notes. | (variable) | 2 | 22 | 102 / 2 / 0 |
| w69-chip | The operator, 2026-10-10: | w67-trigger | 1 | 15 | 105 / 16 / 11 |
| w69-cursor | The operator, 2026-10-10: | land-into-middle | 1 | 11 | 110 / 1 / 0 |
| w69-facedown | A face-down spell on the stack is a card back on the screen that may not see it. | w69-facedown | 1 | 12 | 61 / 5 / 2 |
| w69-flashback | The operator, 2026-10-11, on Cabal Therapy: | w69-flashback | 1 | 12 | 59 / 4 / 0 |
| w69-hidden | The operator, 2026-10-10: | w69-hidden | 1 | 12 | 108 / 2 / 0 |
| w69-librarytop | The operator, 2026-10-11: | w69-librarytop,w69-snapcaster,w69-snapcaster-deep | 3 | 36 | 123 / 29 / 3 |
| w69-mirror | The other seat's rearranged card, mirrored (`presence.ts`'s `drawArranging`, anchored to the battlefield card itself by id since 2c9d16c): | w67-trigger | 1 | 22 | 72 / 0 / 0 |
| w69-name-card | The operator, 2026-10-11, Cabal Therapy: | w69-name-card | 1 | 11 | 63 / 8 / 2 |
| w69-offers | The open "which ability?" pop-up's options, by their plain words; | w69-port-alone,w69-port-forest,w69-serra | 3 | 37 | 267 / 2 / 0 |
| w69-perf | The operator, 2026-10-10: | w69-perf | 1 | 47 | 90 / 28 / 3 |
| w69-pile-inspect | The operator, 2026-10-10: | w67-piles | 1 | 11 | 72 / 2 / 0 |
| w69-rematch | Rematch is a mutual agreement — the operator, 2026-10-10: | (room flow, random decks) | 3 | 136 | 282 / 14 / 4 |
| w69-reveal | The operator, 2026-10-10: | w69-reveal | 1 | 17 | 84 / 2 / 0 |
| w70-clue |  | w70-clue | 1 | 10 | 11 / 0 / 0 |
| w70-damage-pt | The operator, 2026-10-11: | w70-damage-pt | 1 | 12 | 59 / 1 / 0 |
| w70-nissa | The operator, 2026-10-11, casting Nissa, Vastwood Seer (when she enters, search your library for a basic Forest card, reveal it, put it into | w70-nissa,w70-scry-one | 2 | 31 | 13 / 3 / 0 |
| w70-tapped-drag | The operator, 2026-10-11: | w70-tapped-drag | 2 | 25 | 28 / 2 / 0 |
| w70-valakut | The operator, 2026-10-11, with a screenshot of eight Valakut, the Molten Pinnacle triggers: | w70-valakut | 1 | 12 | 22 / 5 / 0 |
| w71-drag-block | Blocking is a drag, a drag moves a block, and a block arrow is not an attack arrow — against a real Forge match. | w54-b-two-blockers | 1 | 14 | 9 / 1 / 0 |
| w71-tap-reveal | A cast paid by lands: | w67-bears | 2 | 27 | 58 / 21 / 3 |
| waiting | Wave 42 §L, W1. Playtest 7, the operator's own words: | (room flow, random decks) | 1 | 12 | 150 / 0 / 0 |
| ww-creature-state | Three of the operator's playtest items, on one real-Forge board (`ww-creature-state.state`): | (variable) | 3 | 31 | 72 / 3 / 0 |
| xn-copies | The operator, 2026-10-12: | xn-copies | 1 | 12 | 15 / 7 / 0 |
| yy-avatar | A player who never picked a character still has one — the operator, 2026-10-11: | (room flow, random decks) | 1 | 7 | 12 / 1 / 0 |

## Appendix B: jvm suites

"median s" is the median file time over passing runs. "failing tests" counts failed test results; only slow tests print per-test lines, so these are lower bounds.

| suite | guards | its | median s | 3-day file runs / failing tests / non-repro |
|---|---|---|---|---|
| server/src/http/library-match | Wave 34 §D, "done when": | 1 | 190.4 | 1085 / 0 / 0 |
| server/src/http/library-resolve | Wave 34 §D, item 3 (the second half): | 1 | 3.6 | 106 / 0 / 0 |
| server/src/play/auto-pass-land | Wave 35 §S follow-up, item 1 — the regression lane E found running the real `forge-e2e` suite (`docs/planning/wave35-evi | 1 | 9.2 | 114 / 0 / 0 |
| server/src/play/auto | Wave 19, lane C, against a REAL Forge match in a child JVM. | 4 | 48.9 | 454 / 4 / 0 |
| server/src/play/blockers | Wave 32, Q12 and Q10 — what a seat is offered at Declare Blockers, against a REAL Forge match. | 2 | 20.4 | 220 / 4 / 4 |
| server/src/play/cast-hidden | "it shouldn't be revealed to the opponent yet when we do this. | 4 | 36.8 | 443 / 4 / 0 |
| server/src/play/concurrent-select | Two clicks that reach Forge at once must not run side by side, against real Forge. | 1 | 11.6 | 99 / 1 / 0 |
| server/src/play/ee-asks | Two production softlocks of one family (2026-10-10): | 4 | 42.1 | 170 / 8 / 0 |
| server/src/play/endturn | Wave 32, Q5 — the crawl after End Turn, against a REAL Forge match. | 1 | 9.1 | 108 / 0 / 0 |
| server/src/play/lands | Wave 35, §F / R15 — "lands are tappable", against a REAL Forge match. | 1 | 9.1 | 106 / 0 / 0 |
| server/src/play/match-frames | The `match-frames` ring against a real 20-turn match: | 1 | 14.6 | 106 / 0 / 0 |
| server/src/play/match-slots | The server's match slots, against REAL Forge (2026-10-11): | 2 | 53.3 | 94 / 3 / 0 |
| server/src/play/modal-targets | A modal spell's targets, on the wire, against real Forge. | 2 | 18.6 | 32 / 1 / 0 |
| server/src/play/mulligan | Item 1 — the mulligan's dead hand, driven against a REAL Forge match. | 2 | 20.8 | 222 / 0 / 0 |
| server/src/play/offer-telemetry | The match log answers "X wasn't clickable", against real Forge: | 1 | 9.1 | 10 / 0 / 0 |
| server/src/play/phyrexian | Gitaxian Probe with no untapped land, against a REAL Forge match. | 1 | 12.5 | 107 / 9 / 0 |
| server/src/play/priority | Wave 32, Q17 — "holding priority on my own spells is weird" (carried from the first list's item 12), against a REAL Forg | 2 | 25.1 | 212 / 0 / 0 |
| server/src/play/reload | Wave 31 §S, P10 — a reload with a SELECTION open is no longer a soft-lock, proved over REAL sockets against a REAL Forge | 1 | 15.9 | 108 / 0 / 0 |
| server/src/play/scenario-ability-repeat | Wave 34 §S4 — the repeated `getAbilityToPlay` ask, chased to its cause and pinned here. | 2 | 18.6 | 212 / 0 / 0 |
| server/src/play/scenario-blockers | Wave 33 §S, item 3 — Q10 and Q12, against a REAL Forge match, set up by a scenario instead of played through two seats'  | 2 | 17.9 | 216 / 0 / 0 |
| server/src/play/scenario-combat | Wave 33 §S, item 3 — Q14, against a REAL Forge match: | 2 | 18.3 | 218 / 3 / 3 |
| server/src/play/scenario-glen | Wave 35 §S item 1 — R13, "Secluded Glen's 'you may reveal a Faerie' was decided for me." The playtest log shows no auto- | 3 | 27.3 | 318 / 0 / 0 |
| server/src/play/scenario-harness | Wave 33 §S, shape 1 and item 1 — the scenario harness itself, against a REAL Forge match: | 2 | 8.9 | 107 / 0 / 0 |
| server/src/play/scenario-nykthos | The operator's frozen match, 2026-10-11 (m-34ad8755db4d): | 2 | 18.3 | 20 / 0 / 0 |
| server/src/play/scenario-order | Wave 34 §S, item 3 — Q8, exercised against a REAL Forge match for the first time. | 3 | 27.0 | 333 / 0 / 0 |
| server/src/play/scenario-priority | Wave 33 §S, item 3 — Q17 and Q7, against a REAL Forge match, set up by a scenario instead of played through three turns  | 2 | 18.3 | 212 / 0 / 0 |
| server/src/play/scenario-start | Wave 37 §A — a scenario starts the same way every time. | 1 | 66.2 | 216 / 0 / 0 |
| server/src/play/scenario-targets | Wave 33 §S, item 3 — the auto-target arrow (first list's item 8) and Q18's evidence, against a REAL Forge match, each se | 2 | 18.3 | 214 / 0 / 0 |
| server/src/play/scenario-thoughtseize | Wave 35 §S item 3 — R4, "Thoughtseize: | 2 | 19.6 | 214 / 0 / 0 |
| server/src/play/scenario-w46-b-counterspell | Wave 46 §B item 3 — what the wire says when a spell targets ANOTHER SPELL on the stack (Counterspell on Memnite), agains | 1 | 9.4 | 107 / 0 / 0 |
| server/src/play/seed | One seed, one deal — against a real Forge, twice. | 1 | 17.5 | 106 / 0 / 0 |
| server/src/play/socket-thoughtseize | Wave 35 §S follow-up, item 2 — R4 over the REAL socket path, against a real Forge JVM (not the replayed fixture `socket. | 1 | 10.0 | 108 / 0 / 0 |
| server/src/play/socket-two-mana-pass | Wave 35 §S follow-up, item 1 regression chase, continued — `two-mana-pass.jvm.test.ts` proves a 2-mana Auto-payment wind | 1 | 9.6 | 106 / 0 / 0 |
| server/src/play/target-players | Which players a target selection accepts, sent with `setSelectables`, against real Forge. | 2 | 18.1 | 214 / 0 / 0 |
| server/src/play/two-mana-pass | Wave 35 §S follow-up, item 1 regression chase — the manager found `play.spec.ts`'s "a spell resolves unattended" STILL f | 1 | 9.3 | 106 / 0 / 0 |
| server/src/play/w46-block-stop | Wave 46 §C (playtest 8) — *"had to click twice for declaring blockers? probably not a bug but just make sure." Verdict: | 2 | 18.7 | 214 / 0 / 0 |
| server/src/play/w52-s-augur | Wave 52 §S (A, B) against real Forge — the operator's Augur of Skulls, match m-6ce49e226aef, 2026-10-06: | 2 | 18.1 | 216 / 0 / 0 |
| server/src/play/w52-s-signet | Wave 52 §S, item 2 — a seat holding a Signet and nothing castable is auto-passed exactly where a land-only seat is (`aut | 1 | 9.2 | 118 / 1 / 1 |
| server/src/play/w62-bounce | Playtest 15, AE13 — the operator, 2026-10-08: | 1 | 10.7 | 108 / 0 / 0 |
| server/src/play/w62-condescend | The operator, on Condescend: | 1 | 9.6 | 107 / 0 / 0 |
| server/src/play/w65-elves | The untap of a mana source whose mana is still unspent, measured against real Forge — the operator's ask (ledger AE21; | 3 | 27.3 | 336 / 2 / 1 |
| server/src/play/w65-yield-wire | auto-yield, measured on the wire the board reads (w63-yield’s reds) | 1 | 10.0 | 108 / 0 / 0 |
| server/src/play/w69-offers | What Forge offers is what Forge takes, against real Forge: | 3 | 26.2 | 120 / 0 / 0 |
| server/src/play/w70-clue | A Clue ({2}, Sacrifice: | 1 | 53.4 | 60 / 0 / 0 |
| server/src/play/yield | The operator: *"when it's the opponents turn the 'End turn' button should turn to 'Auto Yield' meaning that we auto-pass | 3 | 28.2 | 348 / 10 / 9 |
| ui/src/play/live/board-play | A land played and spells cast by CLICKING THE BOARD, against a real Forge match in a real child JVM. | 1 | 21.9 | 112 / 0 / 0 |
| ui/src/play/live/combat-drag | Combat, driven by DRAG, against a REAL Forge match (§C.3). | 1 | 46.2 | 119 / 10 / 8 |
| ui/src/play/live/flow | Wave 20 lane B — turns that flow, against a REAL Forge match. | 7 | 50.1 | 0 / 0 / 0 |
| ui/src/play/live/prompts | Every prompt this client can be asked, against a REAL Forge match. | 3 | 105.4 | 311 / 105 / 25 |
| ui/src/play/prompts/choose-x | Wave 34 §G item 1 — the Choose X slider, against a REAL Forge match. | 1 | 9.1 | 111 / 0 / 0 |
| ui/src/play/prompts/confirm | Wave 36 T4 — `isConfirmPrompt` against a REAL Forge match, real engine proof as the brief requires: | 1 | 9.1 | 110 / 0 / 0 |
| ui/src/play/prompts/offboard | Wave 42 §P item 1 — the W18 soft-lock, against a REAL Forge match. | 3 | 27.7 | 345 / 3 / 1 |
| ui/src/play/prompts/sanctum-worldbreaker | Wave 42 §P, manager send-back — W18 (Sanctum of Ugin) and W16 (World Breaker) are ONE event, against a REAL Forge match. | 4 | 37.1 | 444 / 0 / 0 |
| ui/src/play/prompts/search | A library SEARCH, against a real Forge match — wave 24 §D items 2 and 3. | 1 | 21.3 | 112 / 0 / 0 |
| ui/src/play/prompts/worldbreaker | Wave 42 §P item 3 — W16, against a REAL Forge match. | 2 | 18.5 | 220 / 0 / 0 |
