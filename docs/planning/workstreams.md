# Workstreams — hadoku-cardtable

> The `.png` screenshots this file names were removed from the repository on
> 2026-10-11; the written descriptions stand on their own.

**The tracker owns this file.** Managers and sub-agents report; the tracker
records. Every row carries the evidence it was checked against, not the doc that
claimed it.

**2026-10-03 (late) — code-quality retrospective; wave 38 is consolidation plus w37's carry-over.**
The operator asked whether waves 32–37 have been adding duplicate code and cruft. **Yes:**
`docs/planning/retro-code-quality-2026-10-03.md` has the evidence, every item spot-checked by the
tracker. In three days the repo added 92k lines and deleted 28k. Product source grew +6.6k against docs
+26.6k (0 deleted). Duplicates include:
- the yes/no question (4 components, two of them exported as `ConfirmPrompt`);
- two drag systems with different slop values;
- the own-lands filter on both server and browser;
- ask shortcuts in 4 places;
- 16 e2e helper names copied 44 times.

Separately, none of the 32 jar suites run in CI.
**w37 verified from its closing note** (`ad3d84f`):
- E `aa0c340` and A `ceeffab` are on main; server 0.32.2 is deployed.
- forge-e2e on `ad3d84f`: `check` green, forge-e2e red. The reds are the three flakes w37 routed to w38,
  not the scenario race.

**Wave 38 (`docs/planning/wave38-2026-10-03.md`):** 8 items, 4 lanes.
- **E** fixes the e2e flakes: §E2, Choose X, the R4Qi59 mulligan stall, table-fit.
- **H** leaves one copy of each e2e helper.
- **J** makes the jar suites a real signal: `auto.jvm` and Q12 green, the suites in CI, `arrow.spec`
  in the forge-e2e list.
- **U** builds one yes/no pop-up and finishes T4 (the bar's OK no longer reads `Keep`).

No engine change. The decode-race measurement, the auto-pass consolidation and the land filter go to
w39 (engine, its own wave); the drag unification and the e2e regroup go to w40.
**Operator decisions, 2026-10-03:**
- **Redeploy is gated on CI** (`5cd53a4`). It runs on CI completing on main, and deploys only if the
  run is green, its sha is still main's head (mgmt-api deploys main's head, not the dispatched sha), and
  a non-docs path changed since the last dispatch. `workflow_dispatch` is the operator's ungated
  override. Verified by running the `decide` script against the live API in three cases: docs-only →
  skip; stale sha → skip; servable changes → deploy. actionlint is clean on the file. The first real
  gated dispatch is still unobserved.
- **Evidence PNGs are no longer committed** (`5cd53a4`, the `!docs/**/*.png` exception removed). The 60
  already tracked stay.
- The w38 manager was told both by message after dispatch.
- Still open: archive this file.

**2026-10-03 — tracker's own fixes after w36 (Fable session), newest first.**
The operator handed the three open play-test items to the tracker directly;
`docs/planning/playtest-ledger.md` has the rows.

- **T12 shipped `812dea1`** (UI 0.32.1, deployed 20:23 UTC): Secluded Glen's reveal
  no longer cancelled by w36's click-armed cast. R13 e2e 10/10 locally after.
- **T3 shipped `f7ad0b8`** (server 0.32.1, pm2 restart 20:39:11 UTC): the Declare
  Attackers stop is the declaration; the empty priority window after it auto-passes
  (`StopPolicy.attackStopIsTheDeclaration`). Real-Forge case in
  `scenario-combat.jvm.test.ts`; mutation-tested both ways.
- **T11 measured, no change**: the board fits beside the chat at its 640 px max
  (table 576 px at 1280×800; 6 cards a row). Numbers in the ledger row.
- **CI `forge-e2e` is red on every push today and the cause is NOT reproducible
  locally**: `32ed75b` R13+§E1, `812dea1` R13+T1, `f7ad0b8` Q7, `bac5e97` R4+T8 (+Q10,
  a real T3 fallout: its helper waited for the very stop T3 removes — re-aimed).
  Each red is a scenario spec failing its first "the seat is offered its card"
  precondition. The page's `unknown-match` text in the snapshots is NOT the cause:
  it is taken after `stack.stop()` runs in the test's own `finally`. From the
  per-stack logs pulled off the runner by hand (`bac5e97`'s run): the match is
  normal — Forge ready, two seats claimed, no JVM exit — then Forge raises the
  first priority prompt of turn 1 about a second after the seat's socket handover
  (`left` → `spectator-promoted`; every page connects twice) and the server never
  answers it: no `auto-passed`, no relay, for the whole timeout. A passing stack
  answers the same prompt within milliseconds. Correlation, not proof: the failing
  test is the one with the most leaked browser contexts in its stretch (26 and 20
  stale pages reconnecting to the new stack); a synthetic repro with 24 stale
  pages passed 6/6 locally, so that is hygiene, not the fix. Locally the same
  start passes 12/12 (~7.3 s). **Shipped:** per-stack server logs
  (`play-server-<stack>.jsonl`), the failing JVM's run dir kept in CI
  (`CARDTABLE_E2E_WORK_DIRS_KEPT=96`), an on-failure artifact
  (`forge-e2e-evidence-<attempt>`, `include-hidden-files` — the first one
  carried only the report), a host-load line, a wait for the fixed e2e ports,
  `startPlayStack` closing every context an earlier test left open, and a
  `stop-decided` trace of EVERY stop decision with its facts, probe mode only
  (the harness's servers) — a kept stop used to leave no line. **Read from `fba269b`'s
  artifact (4 reds: table-fit, R7, T8, T1; host load 12.8 — a game was running on
  the CI host):** the two 159 s lone-spell stacks each park on **seat 1's own
  scripted MAIN1 priority with an EMPTY actionable set** (`stop-decided seat 1
  priority MAIN1 myTurn sources 0 → kept`, Forge `Turn 1, MAIN1, Active=Bob`,
  then no frame for 150 s); the passing neighbour's first priority is seat 0's
  MAIN1 (`Active=Alice`) and Memnite is offered. R7's 53 s stack: seat 0's MAIN1
  with `sources 0` and Lightning Bolt in the scripted hand. That is the
  scenario-start race `PlayBridge.java`'s own `refreshActionable` comment calls
  intermittent — Forge's `cachedActionableCards`, computed before the start-game
  hook replaces the hand, reaching the first priority window. (An earlier line
  here said the active seat differed between a passing and a failing run; that
  compared different specs and is retracted: passing `lone-spell` stacks `eQkqXQ`
  and `YsVAFC` have the same `Active=Bob`, with sources 1.) Not a product bug a player meets (scenarios are
  e2e-only); every red today was a scenario precondition. **Wave 37 (`docs/planning/wave37-2026-10-03.md`, scaffolded 2026-10-03):** make scenario application deterministic in the bridge (apply, then
  force a fresh priority input rather than a cache null), and have
  `startScenarioMatch` assert the applied state (`activeplayer`, the scripted
  hand on the board) before any spec polls `offered` — a precondition that fails
  by name, not a 150 s timeout. `check` is red only for
  watchparty-ui 0.40.5's unguarded `ResizeObserver` (watchparty #148, theirs).

Last swept: 2026-09-16. **Wave 5 LANDED — all four lanes, one push, deployed.**
`20346e1`+`2e88af1`+`9a99fa3` H · `a530349` F · `0465c08` G · `fcf8c13` E, plus
the manager's lockfile commit `5cc9773`. CI green on `5cc9773`; the redeploy
dispatched and `hadoku_site`'s receiving run succeeded 7 s later. Branch `w5`
and its worktree are gone.

**The room layer exists.** PR-3's P3–P6 are implemented, not just specified: a
socket server with per-seat emit behind the friend gate, an MIT clean-room ask
registry, room persistence with a service participant, and a client socket
driver that is a **third** source beside the in-process engine and the fixtures.
`pnpm check` on `main`: **28 files, 473 tests, exit 0** (Wave 3 closed at 15/242).

**What is NOT proven: two browsers drafting one pod.** Every lane says so and
none of them claimed it. It is the one thing PR-2 exists for, it needs two
friend-authenticated browser sessions, and it is now the top of the queue.

**Wave 4 also landed** — `b4a024b` A · `e0ccd0e` C · `541d2a9` B · `b2917ac` D,
CI green — and **its closing notes were never recorded here.** The rows below
are Wave 5's. What is verifiable about W4 from artifacts is in this pass's
ledger; the rest needs its own closeout.

**This header had not moved since Wave 2** even though Wave 3's closing ledger
was already in the file, and a 39-line block appeared twice. Both corrected in
this pass.

Previously: 2026-09-14. **Wave 2 LANDED — four lanes of five.** `df716ef` D ·
`e5102de`+`62b1e64`+`169cb9c` E · `ae5a076` A · `1a7a2f4` C, each pushed
separately with **CI green on every one**. Branch `w2` and its worktree are
gone; `forge/` verified pristine at `2cd497c` throughout.

**Lane B was never dispatched.** *(Historical — superseded. P1 is closed, the
engine shipped in Wave 3 and `packages/shared` now carries both the draft
envelope and the wire envelope. Kept for the record of what Wave 2 cost.)*
Operator item **P1** (`NODE_AUTH_TOKEN`
unset → `E401`) is its gate and is still open, so the pure draft engine and the
Zod wire schema — the heart of PR-2 — did not get built. `packages/shared` is
still empty. **This is the single thing standing between here and a playable
draft**, and it is a one-line shell fix.

The wave's other headline: **the board's own numbers were wrong in five places**
and the lanes caught them. `ProtocolMethod` is **60**, not 62. `15 Any` is
**91** recipes, not 92. The cube corpus is **49,345** lines over **388** set
codes, not 47,315 over 375 — and the tracker reproduced *why* the old number
was wrong (below). All corrected in place, with the evidence in "Verified this
pass".

Previously: 2026-09-12. **Wave 1 LANDED** — all five lanes verified and merged
to `main` (`e359649` E, `5b41cc1` A, `81583ae` D, `7db43ca` C, `9f6f953` B, plus
the tracker commit). Branch `w1` and its worktree are gone. The wave's headline:
**D7 is settled NO-GO** — Forge does not compile to WASM GC, so P4 is a React
client and D6's iframe payload has to be built.

**SHA note:** the tracker rewrote history after the wave (to strip AI-attribution
trailers and swap a real email for the noreply address, both required by
`~/.claude/AGENTS.md`; nothing had been pushed). Every SHA below is the
**post-rewrite** one and resolves in `main`. The manager's own closing note cites
pre-rewrite SHAs that no longer exist.

Rows below carry Wave 1 evidence, plus the 2026-09-14 re-verification.

## What this project is for

Friends draft a cube in a browser and play the decks, behind the friend gate at
`hadoku.me/cardtable/`. Forge supplies the rules engine; the watchparty room
layer supplies everything above a match; **Forge's UI renders inside the room's
central canvas slot** (D6).

## Programmes, in dependency order

**The product goal, in the operator's words (2026-09-16):** *"i also want to
allow playing constructed with prebuilt decks — the goal here is to recreate
standard formats from years past."* That reframes the roadmap: **PR-4, the rules
engine, is now critical path**, because constructed play is not possible without
it. PR-5 is new and exists to serve it.

| # | Programme | State |
| --- | --- | --- |
| **PR-8** | **Presentation** — sound, motion, board and UI art. The operator, 2026-09-27: *"one of the most important parts of this project is getting the graphics/audio to be upgraded. thats a huge part of the appeal, otherwise all we've done is create magic online with slight improvements"* | **NEW, and the operator's stated priority after w25**: *"i would prefer to not be debugging the game functionality for much longer."* See the presentation section below for what exists, what does not, and the three decisions that gate it |
| **PR-7** | **The outer shell** — adopt hadoku_site's `templates/game` and delete our hand-written wrapper in favour of it | **SCHEDULED: the wave immediately after the game client.** Operator, 2026-09-20. Not before — the shell wraps the client, and the client is the unproven half |
| **PR-6** | **The game client** — a real Forge UI in the browser, speaking through our bridge | **IN PROGRESS. W19 landed the QOL wave**: static canvas with player faces, only-Forge-offered clickability + drag + targeter, stops only where a legal action exists with payment said out loud, art ids for every card and stack item. The operator's bar — *"i would not even call this alpha playable yet"* — was the brief; their re-test is the remaining proof |
| **PR-5** | **Constructed** — historical Standard pools, prebuilt decks, format validation. The operator's stated goal. | **Wave 6 lanes C/D** lay the data track; play needs PR-4 |
| **PR-1** | **Ground truth** — toolchain, card data, and the WASM go/no-go that decides the UI strategy | **done** (Wave 1) |
| **PR-2** | **Draft** — pure draft engine, cube import, draft UI. Playable with friends. | **built end to end, unproven with two people.** Engine (W3), card art (W4) and a live socket (W5) all land; `DraftScreen` renders from fixtures, the in-process engine, or a server. **"Playable with friends" is not ticked** until two browsers draft one pod — see the queue |
| **PR-3** | **Room module** — our P3–P6 contributions to `@wolffm/rooms-protocol` / `-server` (**renamed**: `@wolffm/rooms` never shipped) | **implemented Wave 5, locally.** Designs W1, delivered to watchparty W2/W3, built here W5. Upstream still ships **none** of P4–P6, so ours are our own packages consuming their primitives — `@wolffm/rooms-server@0.38.111` is `RoomRegistry` + seating + emit + rate limiting + `collectGC` and nothing else. The socket wiring is ours |
| **PR-4** | **Play** — WS/JSON bridge at `IToClient`, headless Forge, the embedded client | **spiked and de-risked** (D). Forge runs headless; 38 of 60 protocol methods required; jUPnP is a config flag. Not greenfield — a 3,919-line headless net harness already exists in-tree |

## Wave 81 (replays rebuilt) dispatched as one single session (2026-10-28)

`docs/planning/wave81-2026-10-28.md`. Operator: "the replay feature just doesn't really work at all". Cause read from code: the player fakes a socket and seeks by forcing resyncs (`replayTransport.ts:217`); the only e2e replays a turn-1 concede.

| lane | worktree / branch | status | evidence |
| --- | --- | --- | --- |
| replays: fold-based player, both hands, preload + cache, real e2e | `.claude/worktrees/w81` / `w81` | dispatched; artifact gate | — |

## Wave 80 (steady glow) dispatched as three single sessions (2026-10-28)

`docs/planning/wave80-2026-10-28.md`. Operator, 2026-10-28: cards flash not-clickable between phases. AF101's `offer-hold.ts` holds only after a card click and ends on a phase move; measure a normal game first.

| lane | worktree / branch | status | evidence |
| --- | --- | --- | --- |
| steady glow through phases | `.claude/worktrees/w80a` / `w80a` | dispatched; artifact gate before land | — |
| Frontline Medic's orange glow (which mark, then the class) | removed | **landed** `00934b030` (AF439), PPE `ba47b15d` restarted 06:53Z; awaiting operator ✅ | the condition rim, not can-act: prod `m-b7b9edfcefd6` frames 36–44 lit Sage's Medic while Hadoku attacked; `condition-met.jvm` red on unchanged code → green; claw 40829096583 ✓, CI 40830865443 ✓ (tracker re-read both); mutation 1/1 reverted-fails 1/1 restored-passes; unverified in a browser; 35 other Attack/Block presence scripts darkened by grep, not played (closing note `~/.cache/cardtable-manager/w80b-closing.md`) |
| unlock on an animation's last 10% | `.claude/worktrees/w80c` / `w80c` | built + proven on head 30f8397e4, **awaiting operator approval** https://claude.ai/artifact/HZHgXzyxivyknijPtcBfgC | red on main 40835149779, green ×3 40841046825, timing set 40841050123 (tracker re-read all three); UNLOCK_AT→1 mutation 8 red |
| spellsHeld has no bound: a view that jumps past a resolving spell's beat holds it out of its graveyard forever (found by w81, in `placed.ts`/`Board.tsx`) | — | queued: after w79b + w79c land | w81 works around it by remounting per seek |
| w67-counter's "face where the back stood" check compares against the last SAMPLED back frame: dropped frames on a loaded claw read 4.12 px > 4 px (40837318083); compare to the glide's target (found by w79b, a test change) | — | queued | w79b frame records: face at the back's rest point 916,468 in both runs |
| departure copies and floating numbers are removed by timers that run up to a long frame ahead of their CSS animation (a number 117 ms early, a death copy 254 ms early on a loaded runner; on main too — found by w80c) | — | queued: after w80c lands | `numbers.ts` `letGo`, the departure copy's timer |
| release a permanent anywhere → next board space | `.claude/worktrees/w80d` / `w80d` | dispatched 2026-10-29 ~01:10 after w79a landed | — |

## Wave 79 (trailer cut 1 feedback) dispatched as four single sessions (2026-10-28)

`docs/planning/wave79-2026-10-28.md`. Operator review of promo cut 1 (session hadoku-cardtable-e1).

| lane | worktree / branch | status | evidence |
| --- | --- | --- | --- |
| A one arrival path (2a–c) | `.claude/worktrees/w79a` / `w79a` | dispatched | — |
| B the stack (1, 8, face-down spell) | `.claude/worktrees/w79b` / `w79b` | dispatched; 8 gated on artifact | — |
| C deaths (11a–c) | `.claude/worktrees/w79c` (closing) | **landed + verified** `45b6606b4` spec, `03c17e162` fix (AF444), PPE `18960210` restarted 08:02Z; awaiting operator ✅ | cause measured, not the flying: Forge sends the wipe as two views ~50 ms apart; the second view's places indexed against an already-shrunk row (11a), got no hits so died at once (11b), uncovered the angels' stand-ins (11c). Claw 40837099724 ×3 with video ✓, CI 40838688326 ✓ (tracker re-read); 6 unit mutations each fail; unverified: Board `holds` past DEPARTURE_MAX_MS has no unit test; edited `numbers.ts` with w79b's written consent. Note `~/.cache/cardtable-manager/w79c-closing.md` |
| D room → table → match (5, 12, 12a, 12b) | removed | **landed + verified** `1131c3643`..`17653537f` (AF440–443), PPE `5b688f38` restarted 07:17Z; awaiting operator ✅ | claw 40832236897 ✓ with video (tracker re-read); boot spec red on base `[-]`→`(connecting)` 170 ms–1.1 s, green after; mutation 1/1; 12 = e2e edge sprites, not product; unverified: prod latency (settle from the match log after a real Ready); closing note in `wave79-2026-10-28.md` |
| E draft visuals (13, 13b) | — | queued: 13b artifact first | — |
| F front-page replay, omniscient (3) | — | superseded by wave 81 | — |
| trailer v2 re-shoot | `promo-clips` (e1) | waits on A–F | cut 1 https://claude.ai/artifact/RTwUZ5jEHvJRnHXoZ7r6bF |

Main red at dispatch: `aa-polling.spec.ts` since `7c101ad42` (front wildcard), owner the `apps/ui/src/front/` claim holder.

## Waves 70, 71 and 72 (draft pods) landed and were re-verified by the tracker (2026-10-17)

The operator's plan and rulings: `docs/planning/draft-pods-plan.md`. Each wave's per-lane notes are in its wave file.

| wave | wall clock | lanes | tracker re-ran | mutation (tracker's own) |
| --- | --- | --- | --- | --- |
| w71 room core | 1 h 55 m | D tables+series, E chooser, F pairing, G strip+chat | 379/379 across the lanes' suites | recordGameResult → always `done`: 2/189 fail, restored 189/189 |
| w70 draft glue | 3 h 06 m | A editor, B draft screens, C pod store | 319/319 | `?? completedSeatOf(...)` removed: 1/41 fail, restored 41/41 |
| w72 pods on screen | 3 h 32 m | P pod rounds + eager series, Q 1v1 series + sideboard step, R pod screens + G's regressions | 764/764 (including R16 on hokon, red there before Q §0) | round advance → return: 1/206 fail, restored 206/206 |

Deployed: ui 0.32.314 / server 0.32.209 (deploy tree `aefb4c0f`, restarted 16:12:55Z, `/health` healthy). Ledger rows
AF136–AF138 carry the acceptance videos; only the operator writes ✅.

**Reds found and named during the programme:**
- **w71 G, two regressions** (fixed in w72 R `3b331877`): the strip sat under the watcher's line (w71-boards on run
  39027167776), and the chat chrome mounted after the board's first layout. The board measured 1216 → 896 px in 15–60 ms.
  bs-batterskull was bisected on claw-9: green at D (39031259828), red at G (39031261626). Its placement half was another
  session's fix (`56b046cb`, AF134).
- **R16 result-screen tests** were red on hokon, green on CI, from `e9b3649d` (another session). test-setup's
  `asyncUtilTimeout` is 1 s off CI and 5 s on CI, against `END_UNSHOWN_MS` = 2 s. The tests now advance fake timers
  (w72 Q `43ed9273`); no timeout was raised.
- **w72-sideboard red on main 7582f2b2** ("a fresh Forge match, not game 1 again"): the spec waited for any match url.
  Fixed in `cffa7c77`; proof run 39047373363 is green.
- **af69-searing-blaze** (w72 notes, AF135): another session's path; ×3 green on 8d225b54.

**Left over, next draft wave:**
- the `cardRequestOf` dedupe (`apps/server/src/http/draftPool.ts` vs `apps/ui/src/draft/deckFromPool.ts` → `@hadoku/deck`);
- `screens/pod/wire.ts` folds into its two callers;
- draftRooms' synchronous file store wants a sync API in `@hadoku/room-store`;
- the AI opponent for a bye (operator ruling 3: "keep the option open");
- a cube picker (one hard-coded cube).

**Unverified, needs the operator:**
- a real chat message across boards (the e2e harness has no watchparty backend);
- a production restart with a live pod (`ls apps/server/data/drafts`, deploy, `GET /api/drafts/<pod>/mine`).

## 2026-09-30 — deck screen feedback shipped direct; main was red after w30, now green

**Shipped direct, no wave** (operator feedback on the deck picker): Ready and
Random moved to a bar above the deck list; the chosen deck's duplicate colour
row, the "source" link and the era note (*"deck … is built for Standard (AVR) …
but the pool supplied is Standard (M13)"*) are gone. `7bba643`, `@hadoku/ui`
0.26.1. Attribution for each list stays in its `.dck` (`Source URL`) and
`decks/README.md`. Guards in `apps/ui/src/screens/constructed.test.ts`; reverted,
2 of 72 fail, restored, 72 pass.

**Main was red after w30 and after my push, for two separate reasons**, both
fixed. CI run `36757749433` on `eaa3898`: `check` success, `forge-e2e` success;
the deploy tree is at `eaa3898`.

- **`forge-e2e` was already red on w30's own head `517185d`.** W30 made the single
  board the default, and that board has no `[data-board-row]`. `e2e/table-fit.spec.ts`
  reads those rows (the drag-between-rows check and the crowd probe), and nobody
  owned it this wave. **This was my wave file's fault**: my pin check grepped
  `*.test.ts` and never `e2e/*.spec.ts`. The w30 manager's "CI passed" claim was
  wrong. Fix `eaa3898`: both tests switch to the four lanes through the settings
  panel, the way a player does. The live game is played on the default single
  board up to mid-game first, so the frame sampler still covers the default
  (13 turns, about 900 frames per player, no breaches, locally with the jar).
  **Not covered:** the crowd probe still measures only the four-lane layout. A
  crowded *single* board has no e2e fit check. That is w31 work.
- **`check` went red on my `7bba643`.** `e2e/room-mode.spec.ts` asserted zero
  off-host requests. With Random out of the list, the deck rows render in time,
  and their card art requests `cdn.hadoku.me` / `cards.scryfall.io` before the
  test ends. A/B: `517185d` passes, `7bba643` fails, and the same 19 URLs appear
  on the old layout given 1.5 s. Fix `9404976`: card-art hosts are excused, the
  same way `draft.spec` has always done it. Mutation: an injected fetch to
  `example.invalid` still fails the test.

**W30's closing note is still unverified lane by lane.** Only the CI claim was
checked, and it was false. Worktree `.claude/worktrees/w30-manager` still exists
and is left alone.

## 2026-09-30 — "a second browser saw me as a new user": watchparty's, with two cardtable halves

**Identity is correct end to end.** In watchparty's log both of the operator's
browsers resolve to `fk:6c0ce5…` at `account` tier. Cardtable's two seats in
`m-4c9483b3ec01` are the operator (admin, `de5c2a05…`) and a friend (Heiter,
friend tier, `8b45ae86…`). The "3 online" was the operator counted twice, and
one of the two rows had been renamed **Himmel** (herald's default name).
Watchparty's defect is filed as a handoff:
`docs/requests/WATCHPARTY_SAME_ACCOUNT_TWO_CONNECTIONS.md`. The `sprite_taken`
retry replaces a custom name with a character default and saves it to the
account's prefs at `user` scope. **Revised after the operator ruled** that two
browsers ARE two roster entries (*"it does make sense that multiple browsers
would be treated as separate entities"*), so the "one row per person" and
"share the sprite" asks were dropped.

**Cardtable's half, for w31. Found in the same investigation; neither is filed
upstream:**

- **`POST /<matchId>/identity` 404s for every player at match start** (prod log,
  18:23:21 and 18:23:45, both players). The avatar assert is sent with the
  match id where the room id belongs (`r-c09f459cf6a3`), so a match URL never
  sets an avatar.
- **`apps/ui/src/room/avatar.ts` reads the chosen avatar only from this
  browser's prefs cache** (`selectedAvatarId`). A browser that has never opened
  the watchparty chrome shows no avatar. It should read the account's prefs.
- **Bump `@wolffm/watchparty-ui` past 0.39.8** once watchparty publishes the fix.

### A second browser on a held seat is a spectator (w31, top of the play lane)

Operator, 2026-09-30: *"it would be really messy if two clients were capable
of performing game actions. if i join on a new browser it shouldn't let me
participate in game actions and just have it joined as a spectator."*

**Today it can act.** `m-4c9483b3ec01`, prod log: seat 0 `joined` at 19:41:25
from the operator's second browser (`fresh: false`) while the first was still
connected. Every seat action in `apps/server/src/play/socket.ts` is gated only on
`joined.get(match.id)` (`clientToServer`, `fullControl`, `stopPreference`), and
`match.claim` hands a returning participant its seat. So each connection is a
full controller.

**The design, checked against the code:**

- **Viewing needs no change.** Frames already reach every socket in the seat's
  room, so a second browser gets the seat's own view. It is the same person,
  so showing their own hand is not a leak.
- **One controlling socket per seat.** The first connection to claim a seat
  controls it. A later connection for the same seat, while the controller is
  still connected, joins as a **spectator**. The server refuses its
  `clientToServer`, `fullControl` and `stopPreference`, and logs
  `c2s-spectator`. The server is the enforcement; the UI only explains it.
- **Promotion on disconnect.** When the controlling socket disconnects, the
  longest-connected spectator socket for that seat becomes the controller. The
  seat's asks are re-sent to it (`resendAfterSnapshot`), and it is told on a
  new event.

  This is **also the refresh path**, and it has to be tested as such. A refresh
  can open the new socket before the old one's `disconnect` lands (the reason
  `disconnectGraceMs` exists), so the refreshed tab spectates for a moment and
  is then promoted. A refresh must never leave a player locked out of their
  own seat.
- **The UI:**
  - a spectator banner ("Watching: this seat is being played in another
    window");
  - no prompt, action bar, drag or concede is actionable;
  - hover and zoom still work.

  The mode must lift on promotion without a reload.
- **Done-when:**
  - server tests for: refused actions; promotion; the refresh race (new socket
    joins before the old one leaves); a spectator whose controller never
    leaves stays refused;
  - an e2e with two contexts on one key: the second one's controls are inert,
    and closing the first promotes it;
  - mutation counts for each guard.
- **Out of scope unless asked:** the draft. Two browsers can both pick for one
  drafter today: `pick` is gated on `seatOf(room.seats, participantId)`
  (`apps/server/src/room/socket.ts:388`), the person and not the connection.
  The same bug, in the room layer. Ask the operator before
  widening the rule to it.

## 2026-09-30 — every deploy kills every live match; the hand-over has never worked in prod

Operator: *"why can I still join `#/match/m-c6f0bd09c188` if the match is
gone?"* and *"why are 'hi there' and 'hi there2' still showing up?"*

**Root cause, reproduced in isolation.** pm2 runs cardtable with `treekill: true`,
so on every restart it signals the whole parent-pid tree, and the match JVM,
though `detached` + `unref()`'d, is still a child of the server until it exits.
Wave 22's hand-over (`host.ts:120-200`) is sound and its half works
(`match-handed-over` logged), but the new process finds no live JVM. Six
hand-overs since 2026-09-27, **zero** adoptions. Experiment: same process shape
under a private `PM2_HOME`; the stand-in child dies with `treekill: true` and
survives with `false`. Filed as
`docs/requests/HADOKU_SITE_CARDTABLE_TREEKILL.md` (one line in hadoku_site's
`ecosystem.config.cjs`). **Open until hadoku_site deploys it and a match is
shown surviving a restart.**

**My push caused the match the operator was in to die.** The `0553bb8` dependency
bump changed `package.json`, so it redeployed, and the restart killed the live
match `m-c6f0bd09c188` at 21:06:09 (created 21:04:49). Until the fix above
lands, **a push that redeploys cardtable ends every game in progress**.
Check `pm2` / the match log before pushing anything outside `docs/**` and
`*.md`, and ask when someone is playing.

**Two cardtable-side findings, for w31:**

- **"Can still join a gone match."** The URL's hash route attempts the join,
  the server answers `match-gone`, and the UI still leaves the person on a
  match page. Needs its own look at what `LiveBoard` renders for `match-gone`
  (`LiveBoard.tsx:345,380`) and whether the route should bounce to the room.
- **Stale rooms with stored members.** `lobby.ts` restores rooms on boot with
  `matchId: null` (correct) and forgets them after `ROOM_IDLE_MS` = 12 h. The
  list shows a room's **stored** members ("Hadoku, Bella"), not who is connected,
  so a dead table looks alive with an **Enter** button for half a day. Options
  to put to the operator: show presence, not membership; or drop a room whose
  members have all been absent for N minutes.

## 2026-09-30 — main's `check` is red on one slow runner, not on code

`check` failed on `ded7f8d` and `dd0c2a9` (the latter carries the 0.39.20
dependency bump) and passed on `97628be` and `eaa3898`, with identical code
between them. **Both failures, and three re-runs of `dd0c2a9`, ran on
`warm-claw-5-hadoku-cardtable` and took 311 to 334 s; every job on `warm-claw-8` or
the JIT claw took about 143 s and passed.** On claw-5 the same five or six
tests in `constructed.test.ts` (and one in `LiveBoard.test.ts`) hit vitest's 5 s
timeout. Locally the slowest test in that file takes 176 ms and all 72 pass.

- **Not proven:** that the bump is clean on CI. Locally it is: `pnpm check`
  green (2805 passed) and `room-mode` and `draft` e2e green on the new bundle.
  `dd0c2a9`'s `forge-e2e` passed. Settle it by a green `check` on a healthy claw.
- **One forge-e2e failure is unexplained.** `97628be`'s `forge-e2e` failed at
  `twoLegalDecks` (`table-fit.spec.ts:454`) parsing a body of `not found`, and
  passed on every neighbour. No cause found in the log; do not close it as a flake.
- **For the fleet owner:** claw-5 is running at under half speed. Nothing in
  this repo should be loosened to fit it. A 5 s cliff is still worth a look in
  its own right if the runner turns out to be fine.

**Every reported item is also tracked in `docs/planning/playtest-ledger.md`**,
with how many times it
has been asked, what shipped, and a column for the operator's own ✅/❌ after a real
game. Only the operator marks an item verified.

## Wave 34 landed and was re-verified by the tracker (2026-10-02)

`0.30.0`, `f62ee46..0af9761`, deployed 04:54 UTC (restart after the build), CI green on both jobs. The
tracker's bot commit (`f62ee46`, Play vs Forge AI) landed under it and survived the rebase.

**Re-run by the tracker on the deployed commit:** `pnpm check` 3194 passed; `library-resolve.jvm` 1/1;
`library-match.jvm` 9/9 (a real match per era); `scenario-order.jvm` (Q8) 2/2; `choose-x.jvm` 1/1;
D's loader mutated back to a directory scan fails 2 of 3, restored 3/3; per-era deck counts
12/4/8/12/12/12/12/12/12.

**What the notes did not catch:**

- **`scenario-ability-repeat.jvm` (the Full Control fix's own test) fails intermittently: 2 of 4,
  then 3 of 6 in the tracker's runs.** Not the fix: Ponder is asked once (`stackAsks=1`) every time.
  The failing runs show the test pressed OK once and the seat still sits at "Stack: 1 to Resolve",
  OK enabled. A local retry of the press after 3 s passed 6/6, one run needing the retry. **A first
  OK press after casting can be swallowed** (seen in 4 of 12 runs), the same shape as Q12's root
  cause (Forge's buttons arrive before its input is live). Proven at the server level only; a person
  in a browser may or may not hit it. Wave 35.
- **The combat-rail e2e failed once in three full CI-set runs** (rail grew 18.7 px against a
  required 20; 5 of 5 alone). Flaky in the full run, not a lane regression.
- **L13's "max = mana available" is not met** (the manager said so): Forge offers 0-9 + Other for a
  mana X and sends no mana figure. Needs a bridge field or the operator's ruling.
- **The library swapped three decks for their alternates** (mtgtop8 "Unknown Card" exports), and
  **2014 now has no combo deck.**

## Wave 33 landed and was re-verified by the tracker (2026-10-02)

`0.29.0`, pushed as `48481dc..24d0cc9`; redeploy 22:59:08-22:59:44 UTC, bundles built 22:59:46-48, pm2
restarted 22:59:48 (after the build); `CARDTABLE_PLAY_PROBE` is **unset** in every server process and the
served bundle carries the `scenario-needs-probe` refusal. CI green on `24d0cc9` and, after a re-run, on
`491743d`. **Re-run by the tracker on the pinned Forge `res`:** `pnpm check` (2998 passed); eight real-Forge
suites (blockers, endturn, priority, five `scenario-*`) all pass; **CI's exact spec set (`play`, `table-fit`,
`w31`, `w32`, `w33`) three times, 22 of 22 each, 3.7-3.9 min, no skipped titles.** The two tests that failed
3 of 5 in w32 are stable.

- **Two reds on later docs commits were not product failures.** `2857942`: `check` timed out on `jit-claw-5`
  (the slow claw). `491743d`: `forge-e2e` was refused by the CI throttle (host free memory 1.8 GB against the
  8 GB limit, from leftover wave JVMs); re-run green once memory was free. Four more leaked CI spare JVMs
  (cwd deleted) were cleared.
- **The manager's "older card scripts" claim is wrong, and the stale path was the tracker's instruction.**
  The `res` directories are byte-identical (zero differing paths); the fork commits differ only in two Java
  files. No local verification was invalidated. `docs/WAVE_WORKTREE.md` is corrected.
- **Not exercised by any test:** Q8 (the ordering ask); the Choose X slider; poison counters beyond a
  screenshot; L's rail fix (no e2e fails when it is reverted).
- **A real bug found by E, for wave 34:** with **Full Control on** and an opponent's spell on the stack,
  clicking your own instant to respond does nothing (`e-findings.md` §E1). Also Ponder's follow-up asks are
  sometimes auto-answered (§E2), and the energy line clips at 1280x800.

## Wave 33 planned (2026-10-01): a game a test can set up

`docs/planning/wave33-2026-10-01.md`, not yet dispatched. Operator rulings 2026-10-01 on w32's
two behaviour changes: *"i'm fine with those changes"* (own spells no longer hold priority; the
single layout is always two tiers). Lanes: S (a probe-gated scenario harness over Forge's own
`GameState`, plus real-Forge scenario tests), B (Q18, the ring hook, poison counters), G (the
picker's OK, the Choose X slider, the auto-target arrow), L (the rail's row heights), E (scenario
specs that cannot pass vacuously, the two flaky tests made deterministic, and w31/w32/w33 specs
added to CI's `forge-e2e`). Deck-library integration is wave 34, after the operator reviews the
selection.

## Wave 32 landed and was re-verified by the tracker (2026-10-01)

`0.28.0`, `c185cd8`; CI green on both jobs. **Re-run by the tracker** on the deployed commit: `pnpm check`
(2951 passed); `endturn`, `blockers`, `priority` real-Forge suites 3 of 3 each; the Q12 fix reverted fails
`blockers.jvm` on the missing "Select creatures to block" prompt and restored passes; `table-fit`, `play`,
`arrow`, `w32` specs pass with the jar, no skipped titles.

**What the manager's note understated or left out:**

- **Two e2e tests are flaky, and neither runs in CI.** `w31.spec.ts` "combat is one rail step…" failed **3 of 5**
  runs (out-of-combat rail rows measured 17.5 px against 15.4 px in combat, tolerance 2) and "concede ends the
  game" failed **3 of 5** (it waits for a `concede-refused` log line; the server's guard is in the right order, so
  the race is in what the test observes). The manager called the concede one "failed once". `forge-e2e` runs only
  `play.spec` and `table-fit.spec`, so neither `w31.spec` nor `w32.spec` is a gate.
- **Q7 and Q10 passed vacuously** (the e2e monitor never met a stack ask or a blockers window), **Q14 and Q8 were
  never driven against real Forge**, and no test asserts the active-avatar ring (Q1).
- **Behaviour changes decided inside lanes, not by the operator:** your own spell no longer holds priority (Q17);
  the single layout is now always two tiers, so boards of six or fewer permanents have smaller cards (Q4).
- **`@wolffm/watchparty-ui` and `rooms-*` moved to 0.40.0 in production** via the bot's auto-update (`2b0534d`),
  after w32. The prefs-cache key lane R's avatar read depends on is unchanged in 0.40.0 (checked).

**What makes a scripted scenario possible:** the bridge is a single-file Java program we own
(`PlayBridge.java`, run by the source launcher, no build step) and Forge's own `GameState` loader (the one its
puzzle mode uses) takes a text file of life totals, hands and battlefields. The bridge returns `null` for
`getGamestate()` today. Applying a state at match start, behind the probe flag, would let e2e drive Q7, Q10, Q14,
Q8, Q18 and a Ponder resolution deterministically instead of hoping a random game reaches them.

## Operator play test C, 2026-10-01 — seventeen items (Q1–Q17), on the w31 build

Played on `0.27.0` (match `m-96b0a5e2f90d`, created 04:46 UTC, after the 03:17
deploy). **w31 landed** (`4a56d60`, CI green on both jobs; the jar installed by the
operator; `3e7e2856…`). Planned as **wave 32** (`docs/planning/wave32-2026-10-01.md`,
not yet dispatched). The operator asked whether any of this was already queued: the
column says.

| Q | item | was it queued? | found |
| --- | --- | --- | --- |
| 1 | drop "0 Nobody"; show "Start"; ring the active player's avatar | **new** (a follow-up to w31 P1) | `whoseTurn` returns `nobody` at turn 0 (`LiveBoard.tsx:764`) |
| 2 | opponent's hand the same card size, mirrored | **new** | |
| 3 | phase names centred, not bulleted; rail grows in combat | **follow-up on w31 P1** | w31 collapsed the six steps but left the rail's height at the six-step size |
| 4 | default placement (lands back row, rest front); free drag; our own ghost and snap indicator | **queued** (P11, "leads w32"); second ask | placement is new; the HTML5 drag is `draggable`/`dataTransfer` in `Board.tsx`. Third ask. |
| 5 | skipped phases should not crawl | **new** | **root cause:** the log shows each skipped step passed ~205 ms apart; Forge's own `PlayerControllerHuman` sleeps `phasesDelay` unless `YIELD_SKIP_PHASE_DELAY` is true. One preference in `host.ts`. |
| 6 | an avatar change does not reach the game | **new, related to P3b** | the avatar is told to the match once, at its start |
| 7 | Mana Leak: arrow to a stack item; shortcut when one target | **new** (related to the first list's item 8) | |
| 8 | "Select order for simultaneous abilities" only in full control | **new** | `getGui().order(...)`; `rules.ts`'s `autoAnswer` has no rule for it |
| 9 | one column: avatar, counts, graveyard the rest; opponent mirrored | **follow-up on w31 P2, and a REVERSAL of w26 §A.2** | w26 put the piles level with the hand on the operator's own drawing; the column is two cells (`board.css:470`, `:730`) |
| 10 | no Declare Blockers stop if the defender has no creatures | **new** | default `stopOnTheirTurn` is `['COMBAT_DECLARE_BLOCKERS']` unconditionally; w28 refused condition-driven stops, see D1 |
| 11 | arrow snaps to 8 points on the card edge | **new** | |
| 12 | could not assign blockers at all | **queued** (the first list's 15: blocker arrows and highlight) | **not diagnosed:** the log shows four `auto-passed Declare Blockers Step` for seat 0 and no blocker prompt. Summoning sickness does not stop a block. Reproduce first. |
| 13 | P/T bottom-right | **queued** (the first list's 14); **second ask** | |
| 14 | click or box-select attackers to pull them back | **new** | |
| 15 | settings into the header menu; explain Cancel; layout is mine only | **new** | **my wave-30 claim was wrong:** `ConnectedSettings@4.8.4` has a `children` slot and `AppHeader` forwards it |
| 16 | card labels under popovers | **queued** (the first list's 10, z-order); **second ask** | |
| 17 | holding priority on my own spells | **queued** (the first list's 12, second half) | `passStackWindows` is true (`auto.ts:328`), so not that |

**Operator rulings, 2026-10-01** (answers to the tracker's three defaults): **Q10**
confirmed, *"no creatures, no block"*. **Q5** is scoped: the skip is *"only when 'end
turn' is clicked"* and the resolve pause stays (so not the global Forge preference the
tracker first proposed). **Q9**: *"honestly it's just a guess. take whatever space the
avatar and the hand/deck counts need, and give the rest to the graveyard"*, so the
80% figure is dropped.

**Q18, reported 2026-10-01 while w32 was running:** a stack *ability* (Glint Hawk Idol's
trigger) draws as clickable. Root cause: `StackItem` (`Board.tsx:1858`) treats an entry as
selectable when `selectable.has(item.sourceCardId)`, and an ability's `sourceCardId` is the
permanent on the board, which Forge offers for its own activation; the click is
`onSelectCard(sourceId)`, so clicking the stack entry does what clicking the card does.
Queued for w33 (lane B's file; a dispatched wave is not edited). The w32 manager was sent an
information-only note because lane G's Q7 (stack items as arrow targets) hits the same
collision.

**Also found this pass:** `treekill` is still `true` (a redeploy still ends live
games; `/health/busy` now exists to check first). CI's `check` fails on
`warm-claw-5` only; `317bd92` (`/health/busy`, not ours) failed there too.

## Operator play test B, 2026-09-30 — twelve items (P1–P12), each checked against the code

Planned as **wave 31** (`docs/planning/wave31-2026-09-30.md`, not yet dispatched).
Verified before planning; the "found" column is what the check turned up.

| P | item | status | found |
| --- | --- | --- | --- |
| 1 | collapse combat phases outside combat (asked twice) | **open** → w31 L | `PHASE_ORDER` already groups the six steps as `combat`; the rail just never collapses them. The first ask is on no board or wave file. |
| 2 | card/deck count layout; graveyard ≥ 75% of the left column | **open** → w31 A | w30 made the piles 1.5 : 1 (60%), which still bisects the column |
| 3 | life under the avatar; names not `Seat N`; drop `(you)` | **open** → w31 A + S | `Seat 1`/`Seat 2` are hardcoded as the Forge player names (`socket.ts:295,300`) and the room's names never reach the match |
| 3b | only one avatar shows in game | **open** → w31 R, partly blocked on watchparty | the avatar assert **404s for every player** (the match route passes the match id where the lobby room id belongs), and the avatar is read only from this browser's prefs cache. An unset avatar's auto-assigned sprite is on nothing cardtable can read. |
| 4 | game colours don't follow the theme | **open** → w31 R | root cause: `styles.css` defines `--bg/--ink/--line/--accent` with fixed dark values while `@wolffm/themes` publishes `--color-*`. Only ~18 literals exist in the play CSS. |
| 5 | delete Regroup | **open** → w31 A | still at `Board.tsx:1830` |
| 6 | page boundary; outer black border | **open** → w31 L + A | border confirmed at `board.css:874-875`; frame rules are in `live.css:94-185`. The chat aside's edge may not be ours to move. |
| 7 | mulligan asks keep again after putting a card back | **found, Forge's order** → w31 F | w30 fixed why the hand was dead; it did not touch the order. `LondonMulligan.mulliganDraw()` tucks before the next keep prompt. The rules order is decide, then bottom. |
| 8 | Gitaxian Probe unplayable at zero mana | **open, probable cause** → w31 F | clickability is `AvailableActions.canAfford` using the AI's `canPayManaCost`; whether it counts Phyrexian life payment is **unverified** (lane reproduces first) |
| 9 | stack height; Ponder text unreadable | **open** → w31 A | `.stack__what` is 12px in an `overflow-y: auto` box inside a fixed `--mid-h` band; the canvas-static rule constrains the fix |
| 10 | reload with a decision open soft-locks | **open, cause found** → w31 S | an open *ask* survives a reload and is covered by e2e; a *selection* does not: `resendAfterSnapshot` never re-sends it and the client nulls it. |
| 11 | drag is too hard, doesn't animate | **open, deferred to w32 (default D1)** | HTML5 DnD in `Board.tsx`'s arranging plus `gestures/`; `Board.tsx` is lane A's file this wave |
| 12 | the log has its own hover display | **open** → w31 L | `live__log-peek` at `LiveBoard.tsx:665-676` beside the document-level inspector |

Also in w31: the **spectator rule** (a second browser on a held seat watches) and the
carried **P18** (concede after game over), **P20** (sound icon) and **stale rooms**.

## Operator play test, 2026-09-30 — eighteen items, three already in flight

Recorded the moment they arrived, because w29 is RUNNING and a wave in flight is
not mine to edit ([[dispatched-wave-is-not-mine-to-edit]]). Nothing here goes
into w29; it is w30's queue and beyond.

### Already being fixed in w29 — do not re-queue

- **6 (partly) and 17 — the arrow.** *"arrow snapping is getting better, but it's
  still not working correctly"*, and *"kessig wolf-run arrow is default pointing
  at my character portrait? that doesn't even make any sense it's not a valid
  target."* w29 §A item 17 is exactly this: an arrow must not default to a player
  portrait, and a card being played moves to a staging area with the arrow
  starting there. Item 6's *"the effect didn't even pop up at all on the screen,
  just the arrow… i can't even see what i'm doing"* is the same staging-area
  change seen from the other side.
- **7 — avatars.** *"avatars are still not showing? i guess thats part of w29."*
  Correct: w29 §B carries the field the last three hops and §A draws it.

### 2 and 12 are not bugs. They are a trade wave 28 made on purpose.

*"i played a land and clicked 'end turn' and the phase counter stopped at endstep…
it always waits on opponent at endstep now, that wasn't happening before and it's
not a desired behavior"*, and *"whenever i play any card it seems to put it on the
stack and i hold priority?"*

`DEFAULT_STOP_POLICY.stopOnTheirTurn` is now `['COMBAT_DECLARE_BLOCKERS',
'END_OF_TURN']` (`auto.ts:305`), and the lane wrote down why: with
`skipNonStopPhases: 'always'` — which is what item 5 asked for — **an empty
`stopOnTheirTurn` gives the seat no window on the opponent's turn at all, so a
held instant could never be cast.** Declare-blockers and the end step were chosen
as those windows.

So items 5 and 2 pull in opposite directions and the tension is real:

| | wants |
| --- | --- |
| item 5 (2026-09-28) | stop stopping everywhere; a stop that fires *because* something is castable leaks what is in my hand |
| item 2 (2026-09-30) | do not wait on the opponent at end step |

Satisfying both means stops are neither automatic nor condition-driven, which
leaves one shape: **the player arms priority deliberately.** Forge already models
it (`setAutoPassUntilEndOfTurn`, and `YieldController` is what `toYieldUpdates`
already speaks). No leak, because arming it is a choice; no nagging, because it
is off by default. **DECIDED, 2026-09-30, by the operator:** *"i see, you leave room at the endstep
to avoid giving information but also give someone a chance to play cards. i think
by default this should be off, but can be turned on in settings (always stop at
endstep). same place that we should allow the board config to show differently.
full control mode lets you get this anyway."*

So:

1. **`END_OF_TURN` leaves the default `stopOnTheirTurn`.** The opponent's turn
   passes unless the player asks otherwise. The operator accepts the consequence
   and named the existing escape: full control already gives you every stop.
2. **A SETTINGS SURFACE, holding at least two preferences**, and this is the
   larger half of the decision — the operator has now asked for the thing the
   tracker proposed when waves started feeling endless: *a preference you flip
   instead of a wave the tracker runs.*
   - *Always stop at end step* — default **off**.
   - *Board layout* — single undivided board (the new default, item 11) vs the
     type-separated rows (demoted to the alternate).
3. The mechanism under both already exists and must not be rebuilt: wave 28 §E
   built the **per-seat `StopPolicy`**, and wave 27 §C built the hatch that
   selects one from outside the process. What is missing is a player-facing
   control and somewhere to persist it. `@wolffm/prefs-client` is already an
   `apps/ui` dependency and is the fleet's preference service — prefer it over
   `localStorage`, which does not survive a different browser.

**This makes wave 30 a coherent wave rather than a pile**: the board rework (item
11), the stop default (item 2), and the settings surface that owns both.

`passStackWindows` is still `true` (`auto.ts:313`), so item 12's "I hold
priority" is NOT that field. Candidates for whoever takes it: the stop at your own
MAIN phase firing again after a cast resolves, or the staging/stack UI making a
passed window look held. Diagnose before fixing.

### 11 — the board separators. Asked at least three times; already committed to w30.

*"i asked for a different board ui several times already. it's still the weird
'type-seperated' board that you built many waves ago. i said this should be an
alternate ui and the real ui should just be a single board, no seperators."*

This is the same item as 2026-09-28's item 3 (*"we need a front and back layout…
selectable from the menu, in case users want to switch to the alternate view
(which is the current view)"*). The board groups permanents into `BOARD_ROWS`
(`lands`, `artifacts`, `creatures`, `other`) and the operator wants **one
undivided surface as the default, with the type-separated view demoted to an
option.** The tracker deferred it twice, each time with a file-ownership reason,
and w29's file already commits it: *"it is wave 30's play lane, alone."* That
commitment stands and this is now the third ask on the record.

### The rest — play-surface polish, for w30 and beyond

| # | item | note |
| --- | --- | --- |
| 1 | mulligan is broken: after clicking mulligan the only live button is `Auto`; the hand should light up to pick a card to bottom | **Functional, not polish** — a London mulligan the player cannot complete. Wave 22 §L already fixed a version of this (`mulliganHand` in `match.ts`); check whether it regressed |
| 3 | a picker's `OK` / `Clear choice` should sit BELOW the selector panel, not at the bottom of a scroll | *"i have to scroll all the way to the bottom to click 'ok'"*. Applies to every selector, not just Rampant Growth |
| 4 | poison/infect counters are shown nowhere (the portrait did read 11 at game end) | Player counters, not card counters — a different place from wave 28's state layer |
| 5 | delete the `Leave` button; `Concede` is enough | |
| 8 | an auto-targeted effect still needs its arrow while it is on the stack | Fiend Hunter auto-targeted the only legal target and drew nothing |
| 9 | the graveyard is still double-stacked; make it single | `.seat__piles` splits `2fr / 1fr` |
| 10 | z-order: cards on board → effects on cards → popup modals | A `2 charges` marker drew over an open card selector |
| 13 | `Choose X` is a radio list; make it a drag left/right, **capped at the mana actually available** | The cap is the interesting half — it is a number only Forge can answer |
| 14 | draw changed power/toughness bottom-right, over where it normally sits | |
| 15 | in declare-blockers, draw an arrow from each attacker; blockers did not highlight blue | |
| 16 | delete the `Call Back` button | It is Forge's own `lblCallBack` / `InputAttack.canCallBackAttackers()` — it un-declares attackers. Removing it removes that ability; the operator has asked for it anyway |
| 18 | conceding was possible after the game had already ended | |
| 20 | the `sound on` control should be an icon, not the words | Wave 27 §F's mute. It is in `apps/ui/src/rooms/`, **not** the play surface, so it is not capped by the play lane and can ride any wave |

*(No item 19 was sent; the numbering is the operator's.)*

## Verified this pass (2026-09-29 — tracker, closing Wave 28)

Four lanes landed, **0.24.0**, CI `check` ✓ and `forge-e2e` ✓ on main's head.
Deploy real: the redeploy for `db2966e` finished 06:40:54Z and the bundle was
built eight seconds later, `/health` reports `bundle: ok`, and the process
restarted after it. Worktree and branch gone; the only live JVM is production's
warm spare. **Tracker's own `pnpm check`: 2759 passed / 22 skipped.**

- **Item 15 shipped, and the tracker's expectation was wrong.** The amendment
  (`fa963e2`) was written after the operator started the manager, and both the
  operator and the tracker assumed it would not be read. It was: it is on main as
  `8337bfe`, lane A's commit is titled *"a card's state is drawn…"*, and the seven
  `chips.push(...)` strings are gone from `Board.tsx`, replaced by a drawn state
  layer in `card.css` with `data-tapped` on the card. The rule
  ([[dispatched-wave-is-not-mine-to-edit]]) stands — it was luck, not method.
- **The manager caught a regression all four lanes missed.** Item 10 turned the
  seat counts into symbols, moving the digits into an `aria-hidden` span, and two
  places still scraped them as page text — one reported *"the opening hand was
  never dealt"* for a board that had dealt it. Verified fixed and pinned:
  `play.spec.ts:986` reads the `aria-label`, and `Board.test.ts:146` asserts it is
  `library 46`, so it cannot drift silently again.
- **The manager also got a diagnosis wrong and §A corrected it**, which is the
  behaviour the protocol wants: `retryLand` already guarded the phase at `:177`;
  the real defect was `atOwnMain` parsing Forge's prompt message, which can lag
  its own buttons.

### Item 4 is not done, and the wave file is why

The avatar reaches the table view and the room roster and stops there.
`adapter.ts:320` carries `avatarId?: string` and `apps/ui/src/room/avatar.ts`
resolves it, but `PlayerFace` still draws its generated bust. The manager traced
the remaining hop and §D confirmed it independently: `routes.ts` (§D) →
`play/socket.ts` (§B) → `play/match.ts` (§B) → `adapter.ts` (§A) — **three of
those four files were not §A's**, so the hand-off this wave file ordered lanes
around could never have happened inside it. Carried to w29 with the join key in
`docs/planning/wave28-evidence/D-avatar-field.md` §2.

### The planner note: waves are slow because of how the TRACKER cuts them

The manager measured its own clock at the operator's request — *"this process is
way too slow… i've had that issue several times already"* — and wrote
`docs/planning/wave28-evidence/manager-why-waves-run-long.md`. The findings are
about wave PLANNING, not tests, and they are recorded here because they are the
tracker's to fix:

- **Test execution was 10–20 minutes of a ~110-minute wave**; roughly 80% was
  agents reading, reasoning and editing. Making tests faster buys a rounding
  error. The instinct goes to the wrong lever.
- **§A took 42 minutes and started at minute 55.** Dispatched at t=0 beside the
  others it would have committed before §B did — **~55 minutes instead of 110+,
  for identical work and identical verification.**
- **"B before A" gated 100% of §A to protect ~10% of it** (four jvm test files).
  Order the TASK, not the LANE: *"§A does its jvm re-aim after §B reports;
  everything else starts now."*
- **"D before A" bought nothing**, because the dependency did not exist — see
  item 4 above. A dependency asserted in a wave file is a claim, and the tracker
  did not grep it.
- **Lane sizing was argued correctly and concluded backwards.** "The play UI
  cannot be split across lanes" is true; "therefore put eleven items in it" does
  not follow. If a surface can only be one lane, that lane IS the wave — so cap
  its item count. Three items per wave, more often, beats eleven in one.
- **Every "prove it by re-running" needs its own run budget in the same
  sentence.** The brief capped flake reproduction at three runs and said nothing
  about attribution runs, which then cost ~15 minutes of JVM clock — for the
  wave's single most valuable artifact (§B re-running each moved suite with its
  change reverted in place, to prove causation rather than assume it).

All six are now a tracker memory, and **w29 is cut to them**: every lane
dispatched at t=0, dependencies written as tasks, and the play surface capped.

## Queued for Wave 29 — three items that arrived after w28 was dispatched

**Recorded here because a visual instruction that stays in conversation gets
lost.** The "tab system" was said three times and never became a board row; that
is not happening again. All three land in `apps/ui/src/play/`, which w28's §A
owns, so none of them could have been added safely once that wave was running.

**15. A card's state is drawn, not written.** Operator, 2026-09-28: *"+1/+1 looks
really ugly, we need a better way to show that. actually all the text you
have written on the card looks ugly, we need to find a way to handle all of that
with effects."*

It is one function — `Board.tsx:889-897` turns seven states into STRINGS and
drops them on a ~70px tile, over real art:

```
if (entry.tapped) chips.push('tapped');
if (entry.summoningSick) chips.push('summoning sick');
if (entry.attacking) chips.push('attacking');
if (entry.blocking) chips.push('blocking');
if (entry.damage > 0 && boardPT(entry) === null) chips.push(`${entry.damage} damage`);
if (entry.token) chips.push('token');
for (const c of entry.counters) chips.push(`${c.count} ${c.name}`);
```

Three have conventional answers and are not open questions: **tapped rotates the
card** (which merges with w28's item 6, "creatures should tap when they are
attacking"), **damage is red on the P/T badge** (`boardPT` already half does it),
and **counters are a badge with a number** rather than `1 +1/+1`. Summoning sick,
blocking and token are a design job with real constraints: legible at ~70px, and
distinguishable from the SELECTION and ATTACK-INTENT outlines the gesture layer
already draws — so not a fourth outline colour, and preferably a different
channel (fill, tilt, desaturation, corner mark) so no viewer is told two things
in one hue.

**Art is not the problem, and this must not break it.** Card art DOES render in
the deployed app: the CSP allows `https://cards.scryfall.io`, `art-ids.json`
covers these cards (`Celestial Colonnade|WWK`, `Jace, the Mind Sculptor|WWK`,
`Slagstorm|MBS`, `Tragic Slip|DKA` all resolve), and `CardTile` falls back to the
text tile only when an image FAILS. The wave-27 evidence screenshot looks artless
because `e2e/play/browser.ts:43` aborts every off-loopback request on purpose —
**the tracker read that screenshot as evidence about the product and it was
evidence about the harness.** Any evidence screenshot for this item must be taken
with art loading or it proves nothing.

**16. An active conditional ability should show it.** Operator: *"things like
morbid should be visible when they are active. the 'orange glow' from hearthstone
was always nice for when cards special effects were active."*

**Two different things wear this coat, and only one is buildable today.**

- *"This card can do something right now"* — buildable. The wire carries
  `HasAvailableActions` and `CanPlay` (both `BooleanType`, `tier-c.ts:483,486`),
  and Forge's actionable set already reaches us as `setWeaklySelectable`. A glow
  driven by those is most of the visual effect the operator is describing.
- *"Morbid's condition is currently met"* — **not established, and the lane must
  check before promising it.** Nothing obviously on the wire says a specific
  conditional ability's condition is satisfied; the nearest candidates are
  `OverlayText` and `MarkerText` (`tier-c.ts:373-374`, real `CardView` getters).
  If Forge does not tell us, **computing it ourselves is implementing rules**,
  which this repo does not do — the answer would then be a bridge change, not a
  UI one. Ship the achievable glow; report on the other with evidence.

**17. The targeting arrow starts in the wrong place.** Operator: *"the arrow
drawing is very wonky, by default it points at player portraits which doesnt make
sense at all. when playing a card, it should get put in the 'decision area' and
the arrow should draw from there, at least thats whenever i'm playing a card that
has an arrow that needs drawing."*

Two changes: an arrow must not default to a player portrait as its target, and a
card being played should move to a staging area with the arrow originating there.
The staging area is close to the question panel w27 §B gave a fixed home, so
these want designing together rather than as two independent tweaks.
`gestures/arrow.ts` draws it; `e2e/arrow.spec.ts` measures its endpoints against
both cards' boxes and will need re-aiming.

### Tracker process note: do not edit a dispatched wave

Item 15 was written into `w28`'s wave file **after the operator had already
started the manager**, so it is in that branch's history (`fa963e2`) and almost
certainly was not read. Nothing was unpicked — rewriting history under a live
agent is worse than a stale docs commit riding along — but the rule is now
explicit: **once handed over, the worktree is the manager's.** New items go to
the next wave's file, which is what this section is.

## Verified this pass (2026-09-28 — tracker, closing Wave 27)

Six lanes, all landed, one push, **0.23.0**. CI on main's head: `check` ✓ and
`forge-e2e` ✓. Deploy real — bundle built 13:49:06.138, process started 13:49:08,
two seconds later. Worktree and branch gone. **Tracker's own `pnpm check` on
main: 2692 passed / 22 skipped**, run in a worktree with the corrected
`node_modules` layout, so it is a real check of `packages/**` too.

### Lane E is the wave's best work: there was no probe race

Wave 26 handed over *"the `play.spec.ts` probe race, undiagnosed"* and the
tracker carried it as a defect. It is not a race, and E proved it with counts
rather than argument (`docs/planning/wave27-probe-race.md`): **20 runs on an idle
host, 0 red; 15 runs beside 16 CPU burners, 10 red, always the same line**
(`expect(boardAfter).toBe(boardBefore)`). The probe never lost a race in 26
measured matches with 26 distinct match ids. What was actually there: two spec
defects, a floating promise that ate the error so the reported line was not the
line that failed, and a board equality that was comparing the MOUSE. Both fixed.

This is the third time on this host that contention has been reported as a
product bug — the tracker did it twice at wave 25's close. **Under load, suspect
the host before the code**, and say how many runs and under what condition.

### Five defects in MY wave file — four the manager found, one it did not

1. **`parity.test.ts` was in no lane's row** though §A necessarily moves the
   markup it pins, so the manager re-recorded it (`f724fea`).
2. **§B.4 demanded a screenshot with no path**, and
3. **§E demanded written evidence with no path** — so both landed in tmpfs and
   the manager had to rescue them into `docs/planning/wave27-evidence/`
   (`bffbdb4`). My own skill says a handoff pointing at a scratchpad has not
   handed off; I wrote two of them.
4. **§D.2 asserted that the vendored font CSS also claims `.pip`. It does not** —
   both files are `.ms`/`.ss` with zero `.pip`. A lane was told a false premise
   about its own subject.
5. **§A specified work wave 24 had already shipped.** The operator's placement
   model — snap to the next free slot, stack with an offset on a drop onto a card
   — is `dropOnCard` and `withMove` in `Board.tsx`, landed in `3db801c` and in
   the tree before wave 27 began: a drop on a card's top or bottom third stacks
   it, the middle reorders, a new permanent joins the end of its row, and
   attachments survive the move. Lane A was right to ship only the fit, and
   nobody recorded that the rest was already done. **The operator asked three
   times because they could not USE it** — cards were crushed unreadable at the
   real table width — which is exactly what §A did fix.

Four commands would have caught all of these and they are now a tracker memory:
what else pins each owned file, what generates each generated file, grep every
factual claim before asserting it, and name a repo path for every artifact a
done-when demands. Plus the habit none of them covers: confirm the work is not
already done.

### The manager's own finding, recorded because the next wave inherits it

It put `pnpm check` behind `build.lock` — the same lock as builds and the 40–57 s
e2e runs — though a check writes no shared artifact. Eleven full checks queued
behind one another for nothing, and every one came back red from other lanes'
mid-edits anyway. Its own prescription, which the next wave file should carry: a
separate `check.lock`, scoped suites per lane, **one** authoritative full check by
the manager, and an explicit run budget on any lane told to chase a flake.

### Leftovers

- `styles.css`'s `.pip--unknown` comment pointed at `/tmp/claude-1000/w27/D-pip`;
  re-pointed at the committed probe in this commit. `.pip--unknown` itself stays
  on purpose — it is the fallback for a token no font has a glyph for, and D kept
  it after measuring computed-style equivalence in a browser.
- `docs/planning/wave27-probe-race.md` §0 still cites `/tmp` lock paths in its
  reproduction commands. Harmless (they are lock files, recreated on use), noted
  so nobody reads it as a dead artifact path.

## Verified this pass (2026-09-28 — tracker, closing Wave 26)

Six lanes, all landed, one push, **0.22.0**. Deploy tree at `f544238`, bundle
built 08:49:40Z and pm2 restarted 08:49:42Z (restarts 2→3 — the restart followed
the install); CI on main's head: `check` ✓ and `forge-e2e` ✓; worktree and branch
gone. The wave also cleared a red already sitting on main (`LiveBoard.test.ts`,
`'Turn 11'` vs `'Turn 14'`).

- **`pnpm check` re-run by the tracker: 2638 passed / 22 skipped**, matching the
  manager exactly — and run against a **corrected** worktree (see the scaffolding
  finding below), so it is the first wave whose check the tracker can actually
  vouch for.
- **Lane E's jar-gated claims re-run one file at a time**: `board-play.jvm.test.ts`
  1/1 and `flow.jvm.test.ts` 7/7. CI never runs these, so this is the only
  independent check they get. **The click-a-land proof is back** — E built the
  per-seat `StopPolicy` `auto.ts` had listed as missing rather than deleting or
  weakening the test, which is what the lane was asked for.
- **Per-lane headlines re-checked in source**: A — `adapter.ts` reads `'Mana'`;
  B — `.board__bar` is gone from `Board.tsx` and `live-status` renders only in
  the five no-board states (`statusText` returns null for a live match, so a live
  board says nothing — the instruction honoured, with the degraded-state
  messaging kept); C — 14 `ms-` class sites in `ManaPip.tsx`; D — the nine pools
  now carry `colors` (1319 entries) and `manaCost` (1581) as maps beside an
  unchanged `cards` list; F — the room layer knows about drafted pools.
- **The committed screenshot is clean.** `docs/planning/wave26-question-panel-1280x800.png`
  is the repo's first PNG; `.gitignore:41`'s `!docs/**/*.png` has always allowed
  it and `*.png` still refuses one anywhere else (tested). Viewed it: the board
  draws cards as TEXT TILES, so it carries no card art, and the image-boundary
  gate runs against `apps/ui/dist` which a docs file never reaches.

### Two tracker errors this wave, both mine

**1. The wave file named the wrong generator, and that caused the only protocol
violation.** §D's row gave lane D `packages/carddata/src/cli/build-pool.ts`. The
pools are generated by `packages/deck/src/library/build-pool-fixture.ts` — which
each fixture says in its own `$comment` and `command` fields. D needed
`packages/deck/src/library/pool-fixture.ts` and did not own it. **This is the
wave-16 lesson exactly** — "intersect every lane's file list AND check each lane
has the files it NEEDS" — and I did the intersection but spot-checked only the
lanes I guessed were risky. The check to add: for every file a lane is told to
CHANGE, confirm from the artifact itself what produces it.

**2. Worktree `node_modules` symlinks made every lane's check vacuous for
`packages/**`, and I have been scaffolding it that way since wave 18.** pnpm's
workspace links are relative (`@hadoku/carddata -> ../../../../packages/carddata`),
so symlinking `apps/ui/node_modules` to the main checkout resolves them from the
MAIN CHECKOUT — the deploy tree. Measured: an edit to a worktree's
`packages/carddata/src/index.ts` is invisible through
`apps/ui/node_modules/@hadoku/carddata`, whose realpath is the deploy tree. So a
green worktree check proved nothing about a `packages/**` change, and silently
tested against whatever the deploy tree held. Fixed scaffold and the one-line
verification (`realpath` must land inside the worktree) are in the tracker's
memory; no wave shipped a defect through it, but nine waves could have.

### A third error, in the layout spec rather than the wave file

`board-layout-2026-09-27.md` was drawn on a 1280×800 canvas as if the whole width
were the table. It is not: the app's room chrome takes a ~320px chat column, so
the table gets ~960 at that viewport. The lanes applied the operator's
percentages to the table, which is the sensible reading, but the drawing implied
more room than exists and the result is cramped. Visible in the committed
screenshot at 1280×800: the control labels truncate to **"Full c…"** and
**"Conc…"** at the 112px width the operator drew, and at least one battlefield
row compresses its cards until their names overlap and are unreadable. **The
blocking wants re-drawing against the real table width**, not against the page.

### Found while closing: a cancelled CI run leaks Forge JVMs

Two orphaned bridge JVMs were alive on the host at close, 11h34m old, holding
380 MB, reparented to systemd, with their run directories already deleted —
`…/actions-runner-hadoku-cardtable/_work/…/e2e/.run/play-work/stack-RWQANz/spare-*`.
One stack directory, two spares, so this is one run that died rather than every
run leaking: the harness reaps in `afterAll`, which does not run when the job is
killed, and the runner then wipes the workspace out from under live processes.
Killed by the tracker. **Worth checking after any cancelled `forge-e2e` run**, and
worth a boot sweep on the runner if it happens twice — the pool already has one
(`sweepOrphans`), it simply never runs there.

### Hand-backs, carried forward

- `styles.css` still holds the pre-D20 `.pip` section (16 rules) that C's shim
  now duplicates — delete it and the shim collapses.
- `Board.tsx:756` still rewrites `{T}` to the literal word `TAP` in rules text,
  while `ManaPip` now knows `T: 'tap'` and `CardTile` renders `ms-tap`. One
  replace to remove.
- The cost map wants serialising so the room screen's deck dropdown can show
  colours (D shipped it for `DeckView` and `DeckBuilder` only).
- The `play.spec.ts` probe race is undiagnosed.
- **Nothing can set a seat strict from outside**, which is why §B could not
  screenshot a live payment. E built the per-seat policy; a route or env to
  select it is the missing half.

## Verified this pass (2026-09-27 — tracker, closing Wave 25)

Six lanes, all landed, `f83b300..82ceea1`, one push. **Verified from artifacts.**

- **Deploy is real, not merely published.** The redeploy for `82ceea1` finished
  `2026-09-28T04:00:36Z` and the process restarted 13 s later at 21:00:49; the
  deploy tree carries `82ceea1` and both apps at **0.21.0**.
- **CI run 36375912499** on main's own head: `check` success, `forge-e2e` success.
- **`pnpm check` re-run by the tracker: 2577 passed / 22 skipped**, matching the
  manager's number exactly (baseline 2496/20).
- **Teardown confirmed**: w25 worktree gone, branch `w25` deleted, `forge/` still
  registered in the deploy tree, no leaked JVMs (the one live bridge is
  production's own warm spare).
- **Every lane's headline re-checked in source by the tracker**: A — `PUT …/deck`
  400s a body carrying `rules` with a message naming who owns the format, and
  `you.leader` is per-caller; B — `constructed.test.ts` has both "gives the
  LEADER a control that moves it" and "gives a NON-leader no pool control at
  all"; C — the cluster is 288×**102** (was ×153) with grid areas
  `ok/cancel` + `leave/full/conc` and no says or log row, the rail is
  `right: 2px` and the step name flipped to `right: calc(100% + 4px)`; D — see
  below; E — the hand takes `arranging.dropInto(e, 'hand')`; F —
  `promptCardTile(forgeId, name, setCode, label?)` separates identity from
  display, documented against the `Mox Opal (130)` case.

### The mutation counts the note did not carry — one held, one did not

The wave file required "reverted: N of M fail; restored: M pass" with real counts
for §D. The closing note carried none, so the tracker ran them:

- **The unpayable-cost cancel arm is guarded.** `decideCancel` forced to
  `return null` → **4 of 131 fail** in `auto.test.ts`; restored → **131 pass**.
- **Item 3's silence is guarded — my first answer here was wrong.** I mutated
  `match.ts` to re-add `this.say(s, \`auto-passed ${phase}\`)` and ran
  `match.test.ts`: 60 passed, so I recorded the guard as missing. It is not.
  The guard lives in `auto.test.ts` — *"passes a stop with nothing to do, presses
  OK exactly once, and says NOTHING (item 3)"* asserts `says(h, 0)` is empty —
  and against THAT suite the same mutant gives **1 of 133 fail; restored, 133
  pass**. The lesson is mine: a mutation test proves nothing about the suite you
  did not run, and "which suite owns this behaviour" is a question to answer
  before mutating, not after.

### Two claimed reds that were the tracker's own contention

Running all seven `*.jvm.test.ts` in one `vitest run` starts a Forge JVM per file
in parallel. `flow.jvm.test.ts` came back 7-skipped with a setup timeout and
`prompts.jvm.test.ts` failed its LEAK CHECK. Re-run one at a time: **flow 7/7
passed, prompts 3/3 passed.** Both reds were contention. The two most alarming
signatures in this repo are a leak failure and an `until` timeout, and both were
mine — the durable lesson is saved, and the manager's jar-gated claim stands.

### Accepted deviation: §C kept `live-says`

The wave file said `live-says` goes. C **moved** it into the collapsed log panel
and kept the test id, because it is the only place Forge's own message text is
readable and `e2e/play.spec.ts` — another lane's file — finds it by that name.
The element is always in the DOM and merely `hidden`, so the corner no longer
shows prose and a cross-lane spec still works. Better than the brief; recorded
rather than counted as a miss.

### Left over, and why each is not a failure

- **Item 6 (Galvanic Blast) ships unclosed, correctly.** D measured it against a
  real Forge instead of guessing: `readPromptFacts` read the `{R}` window as
  `sources: [16, 57]` resolving to `["Island", "Mountain"]`, so the guard that
  returned null is the SOURCE COUNT. Forge's payment-mode actionable set is every
  card in five zones with ANY playable mana ability
  (`PlayerControllerHuman.java:1533-1535`), so an Island is offered while `{R}`
  is being paid — and **nothing on this wire tells "one Mountain and one Island
  for {R}" apart from "two Mountains for {R}"**. Deciding an Island cannot pay red
  is a rule, and this file implements none. D added the policy value that would
  close it (`PaymentPreference: 'forgeAuto'`, press Auto whenever Forge's Auto is
  live) and deliberately did not default it. **That default is an operator
  decision**, and it is the difference between item 6 closing on a one-line flip
  and waiting for the bridge work.
- **Draft-then-play-a-human has no path at all.** Confirmed: a room's pool is a
  `FormatId`, a human match must start from a room (`routes.ts:731`), and a
  drafted pool cannot be named as a room's format. A's change — mandated by the
  wave file — removed the server affordance that could have carried it. **It cost
  no working feature** (the UI only ever posted `{ room }`, and the deck dropdown
  only ever offered library decks), but for a project whose first line is *"cube
  drafting + Magic play for a private friend group"* this is the headline gap.
  It wants a room pool that can name a drafted pool.
- **The turn bar and the `Seat 1, live.` status line are still there.** Not a
  wave-25 miss — the wave file never mandated their removal; the operator's
  blocking (`board-layout-2026-09-27.md`) did, and that is the next wave.

## The board's blocking, and the lesson about visual instructions

**`docs/planning/board-layout-2026-09-27.md` is the operator's own layout**, made
by dragging the real regions on a 1280×800 canvas
(https://claude.ai/artifact/YVxEMT7bfxyK6zcgdcivDN, saved in that artifact's
store at `layout/current`). It is a spec to implement: a left column per seat
with the portrait above the graveyard, four rows with the hands outermost, and
the stack, the question panel, the phase rail and the controls as overlays over
the right end of the board. The turn bar and the `Seat 1, live.` status line are
deleted. Cards snap to the next free slot and stack with an offset when dropped
on each other. **Ordering: wave 25 lands first; this is the wave after**, and
that file lists which of wave 25's lanes are steps toward it and which two of its
decisions it supersedes.

**The lesson, recorded because it cost four rounds.** The operator asked three
separate times for the board's card layout not to be *"this sort of tab system"*,
and it never became a board row — so it was never in a wave, and each time it was
answered with a guess in prose. A visual instruction is not a remark; it is an
item, and it goes on the board the first time it is said. The fix that finally
worked was to stop describing and hand over a canvas, which settled in one round
what four rounds of words had not: the tab system is `ZoneShell`'s labelled
panel.

## Presentation (PR-8) — what exists, what doesn't, what gates it

**D20, 2026-09-27: the symbols are not ours.** Operator: *"naw we're not drawing
our own"*, supplying `keyrune-master.zip` and `mana-master.zip`. Recorded in
`docs/LICENSING.md` §3.2 with what each licence actually says — the two packs are
NOT the same position, and the difference is worth knowing:

| pack | covers | licence | position |
| --- | --- | --- | --- |
| **Keyrune** 434 glyphs, `keyrune.woff2` 144 KB | set symbols; all **12** codes our nine eras need (`AVR DKA ISD M11 M12 M13 MBS NPH ROE SOM WWK ZEN`) | glyphs **GPL 3.0**, font **OFL 1.1**, © Andrew Gioia | **strong** — glyphs *redrawn by hand*, distributed under a stated nominative-use rationale citing WotC's own WPN policy, and GPL-3.0 matches this repo's own licence |
| **Mana** 308 glyphs, `mana.woff2` 187 KB | every token `ManaPip` parses: `W U B R G C S X`, 0–20, tap, hybrid `ms-wu`, twobrid `ms-2w`, Phyrexian `ms-bp`/`ms-wup` | font **OFL 1.1**, CSS **MIT** | **weaker** — its README says *"all mana, tap, and card type symbol images are copyright Wizards of the Coast"*. The OFL covers the wrapper; the artwork is attributed upstream |

Better than the route it replaced either way: the alternative was
`svgs.scryfall.io`, which is WotC's own files with no grant to us at all.

Three things checked so the build has no surprises:

- **The image gate needs no change.** `scripts/d13-gate.sh` matches
  `(jpe?g|png|webp|gif|avif)`; a `woff2` is neither an image file nor a
  `data:image/…` URI. Both fonts pass as they stand.
- **`.gitignore` does not block fonts** (`*.jpg`, `*.png`, `cards/` only), so
  the two `woff2` can be committed. 331 KB for both, whole. Only 12 of
  Keyrune's 434 glyphs are ever used, so **subsetting is an obvious follow-up**
  — not a blocker, and it costs a `fonttools` build step.
- **Do not ship `mplantin`.** The Mana pack bundles a Plantin-alike text face;
  Plantin is Monotype's, it is a separate and worse question, and we need none
  of it.

`ManaPip.tsx` keeps its token parser — `W/U` → hybrid, `2/W` → twobrid, `B/P` →
Phyrexian — which maps 1:1 onto the font's `ms-` classes. Only what it RENDERS
changes: a class instead of a letter. The seam that made this a small job is the
one the file already had.

**Still open, and still the operator's:** the two zips sit untracked at
`temp/` (8 MB). The tracker did not delete them; the build lane extracts the two
`woff2` it needs and `temp/` is the operator's to clear.

Measured 2026-09-27, not assumed:

- **Sound: nothing exists.** `Audio`, `AudioContext`, `playSound`, `.mp3`, `.ogg`
  return zero hits across `apps/ui/src` and `packages`. Greenfield, which is the
  good news — there is no legacy audio layer to unpick. The operator's list: UI
  sounds for hover, drag and button select, and by implication the game's own
  events.
- **Arrows: half exist.** `gestures/arrow.ts` draws the targeter while a pointer
  drags, and `e2e/arrow.spec.ts` measures its endpoints against both cards'
  boxes. What does not exist is an arrow driven by a GAME EVENT — a spell
  resolving onto its target, damage — which reads off the wire rather than the
  pointer. That is an extension, not a new capability.
- **Card effects: nothing exists.** No distortion, no transform on a card when
  something happens to it. `card.css` is a static face.
- **Board and UI art: nothing exists**, and `ManaPip` is a CSS gradient standing
  where a drawn symbol goes (`styles.css:572-577`).

Three decisions gate the programme, and none is a code question:

1. **Where sound files live.** `.gitignore` refuses `*.jpg` and `*.png` but says
   nothing about `*.mp3`, `*.ogg` or `*.wav` — that is an accident of the D15
   image rule, not a decision. The same argument applies (bundle weight, and art
   being re-sourceable), so the answer is almost certainly `cdn.hadoku.me`
   alongside the art, with a lookup like `packages/carddata/src/art` has.
2. **One seam, or twelve call sites.** Card art survived because it has exactly
   one resolver and one `<img>`. Sound needs the same discipline before the first
   `new Audio()` is written, or it will end up scattered through every component
   that wants a click.
3. **The trademark line is a deliverable, not a footnote.** No mana symbols, set
   symbols, tap symbol, card frames or wordmark — CLAUDE.md, and it is one of the
   four things holding the licensing posture up. So a drawn symbol set is itself
   a piece of work to commission or generate, not a detail of some other lane.

Also open, and relevant: **`apps/ui/src/draft/art-manifest.json` has zero
entries**, so every card in the app resolves to `cards.scryfall.io` today. The
lookup layer is built and correct; nothing has been put in it.

## Board

Status: `todo` · `wave-N` · `blocked` · `done` · `watch`

### PR-1 Ground truth

| Item | Status | Owner | Evidence checked |
| --- | --- | --- | --- |
| pnpm workspace, tsconfig, lint, vitest, CI | **done** | A `5b41cc1` | clean-clone `pnpm install --frozen-lockfile` **exit 0**, `pnpm check` **exit 0**. Gate mutation-tested: typecheck→2, lint→1, test→1, all restored to 0 |
| Maven user-local install | **done** | B `9f6f953` | Maven 3.9.16 → `~/.local/opt`, SHA-512 verified, no sudo |
| JDK user-local install | **done** | B `9f6f953` | **new row.** `openjdk-21-jre` has no `javac`; Temurin 21 → `~/.local/opt`. D14 amended |
| Stock `mvn install` of Forge passes | **done** | B `9f6f953` | `-pl forge-core,forge-game -am -DskipTests` exit 0, **13.2 s warm / 27 s cold** |
| Sentry stubbed out of engine | **done** | B `9f6f953` | overlay under `scripts/spike/`, NOT a patch to `forge/`; 2 stub classes, 5 members |
| **`forge-core`+`forge-game` → WASM GC (go/no-go)** | **done — NO-GO** | B `9f6f953` | 30 missing classlib APIs, no artifact. Manager reproduced: `run.sh wasm` exit 1. **D7 settled.** Root cause: TeaVM ships 0 classes in `java.util.concurrent.locks`; Guava `LocalCache$Segment` extends `ReentrantLock`; `Game.java:97` builds an `EventBus` |
| JVM headless engine runs a real interaction | **done** | B `9f6f953` | **new row.** 33,752 card scripts, 95,746 printings in 1.6 s; Glorious Anthem → Grizzly Bears 3/3, no `forge-gui`/`forge-ai`. Manager re-ran: exit 0 |
| Scryfall terms verified | **done** | C `7db43ca` | **The 403 was a phantom.** Manager re-ran: no UA/Accept → **400** quoting Scryfall's own rule; honest UA+Accept → **200**; `server: cloudflare`. It was bot-filtering of the fetching tool's egress, not policy |
| Card data ingest | **done** | C `7db43ca` | `pnpm --filter @hadoku/carddata sync` ran against live bulk data: 38,740 cards, 0 skipped, exit 0. Zero runtime deps |

### PR-2 Draft

| Item | Status | Owner | Evidence checked |
| --- | --- | --- | --- |
| Import Forge's `.draft` recipes (94) | **done** | A `ae5a076` | All 94 in `drafts/`. Tracker re-ran `cmp` on the 94 **committed git blobs** vs source: **0 differing**, and **2 blobs still CRLF** — `drafts/.gitattributes` (`*.draft -text`) is what preserves that; the root `* text=auto eol=lf` would have silently rewritten them. 8th key `CustomRankings` parsed too (`CustomLimited.java:123`) |
| Card resolution: `Name\|SET` → real card | **done** | A `ae5a076` | **49,337 of 49,345 resolved (99.984%); 93 of 95 cubes at 100%.** Tiers: 989 name+set+collector, 48,274 name+set, 74 name-only. The **8** failures are Scryfall data gaps (2 Arena `A-` rebalanced, 6 unspoiled), returned as values, never guessed. `packages/carddata/reports/cube-resolution.json` is the committed artifact and `resolve.test.ts` gates it |
| Two-faced cards written by front face alone | **done** | A `ae5a076` | **new row.** **942 references** write `Delver of Secrets` where Scryfall's `name` is `Delver of Secrets // Insectile Aberration`. Without front-face matching only **12 of 95** cubes resolve. This was the lane's real technical risk, and it was invisible in the planning numbers |
| Forge→Scryfall set-code translation | **done** | A `ae5a076` | **new row.** **26 of 388** set codes genuinely need translating, over 679 card lines; Forge's own `ScryfallCode` table (679 edition files → 760 keys) supplies them. `set-codes.generated.ts` |
| Import Forge's cube lists | **done** | C `7db43ca` | **95, not 96.** `res/cube/` = **95** `.dck`, all imported byte-identical (`diff -rq` clean). The 96 came from `res/draft/`, which has 96 *entries* = 94 `.draft` + a `rankings/` **directory** + `rankings_cubecobra.txt`. **Corrected 2026-09-14:** the board said "1 `.rankings` file"; `ls -F` shows `rankings/` is a directory. A `.dck` parser + 29 tests ship with it |
| **Pure draft engine (no transport)** | **DONE** | `2658ddf` | `@hadoku/draft`. Seeded + deterministic (`Math.random` banned; bot rngs keyed by seed+seat+pack+pick, so a human picking in a different order cannot change bot behaviour). Rejections are values, never throws. Seats consumed from `@wolffm/rooms-protocol@0.38.111` **including the W3 seat reservations**, wired at a 120 s TTL. 26 engine tests + 4 against Forge's **real** cube lists; a real 540-card Vintage Cube drafts to completion, 360 unique cards, 0 duplicates. Replay mutation-tested: non-determinism in the rng fails 2 tests |
| ~~superseded engine row~~ | — | — | **Lane B was never dispatched.** Gate `npm view @wolffm/rooms-protocol version` → **E401**; `NODE_AUTH_TOKEN` **unset**. The wave plan's own instruction was "if that returns E401, do not dispatch B", and the manager followed it rather than working around the credential. O2 settled TS; the design stands untouched. **Wave 3, the moment P1 clears** |
| ~~Wire schema (Zod, `packages/shared`)~~ | ~~BLOCKED — not built~~ **superseded: built in W3, extended in W5** | — | **new row.** Same gate as the engine — it was lane B's other half. `packages/shared` is still an empty directory. Lane C's fixtures are written against the §B.5 **prose** envelope instead, so the schema has a contract to satisfy the day it exists |
| Pack generation rules | **not built** (lane B) | — | **The "no oracle" risk does not apply to cubes.** Across all 94 `.draft` recipes: **91 are `Booster: 15 Any`** (corrected from 92 — 90 clean + 1 with trailing whitespace, which is what a naive `uniq -c` misses), plus `16 Any`, `9 Any`, and **exactly 1** rarity-slot recipe. 93/94 `Singleton:True`, 93/94 3 packs × 8 players |
| Draft UI in the canvas slot | **done** | C `1a7a2f4` | `@hadoku/ui` renders a pack fanned for picking, the pool grouped by mana value, pack/pick counters, `seq`, and a seat bar — from **5 committed fixtures**, 63 tests. No socket, no room chrome, no `@wolffm/watchparty-ui` (greppped in the **diff**, exit 1). Cards drawn by us: zero `<img>`, zero `url()`, pips are our own circles, `{T}` renders as the word TAP |
| **Hidden-information split holds** | **done** | C `1a7a2f4` | **new row.** The spectator payload is **1,077 bytes**, `viewer:{"kind":"spectator"}`, no pack and no pool. Tracker diffed it against the seat-3 payload's 30 card names: **0 leaked**. Mutation-tested — injecting seat 3's 19-card pool fails the suite (exit 1) |
| **B↔C integration check** | **outstanding** | tracker | **new row.** §C's done-when is half-open: "`apps/ui`'s fixtures parse under lane B's Zod schema" cannot run while B does not exist. When B lands, run its schema over `apps/ui/src/draft/fixtures/*.json`. **Per the wave plan a failure there is a lane C bug, not a B bug** |
| `.dck` export | **done** | B `a766665` | `@hadoku/deck` — pool→deck model + a Forge `.dck` **writer**, 1,408 lines, round-tripped over **all 95 cubes**: 79 byte-identical once header casing is restored, 92 identical modulo the losses `parseDck` itself imposes, and the 3 that differ each mix `Name\|SET` and `Name\|SET\|1` in one file — which **Forge's own `CardRequest` cannot represent either**. Zero external deps |
| ~~**Pure draft engine (no transport)**~~ | ~~BLOCKED — 2nd wave~~ **superseded: shipped `2658ddf`, see the DONE row above** | — | **Lane A never dispatched, again.** Same gate, same E401, same unset `NODE_AUTH_TOKEN`. The manager obeyed the wave's own "do not dispatch on E401" instruction both times, which is correct and is why the hole is clean rather than papered over |
| ~~**Wire schema (Zod, `packages/shared`)**~~ | ~~BLOCKED — 2nd wave~~ **superseded** | — | **2026-09-16: `packages/shared/src` holds `draft.ts`, `wire.ts`, `semantics.ts`, `index.ts` and `wire.test.ts`.** Originally: `packages/shared/src` is still `.gitkeep`. It was lane A's other half |
| **Envelope needs an `epoch` (W4)** | **DONE** | `2658ddf` | Envelope carries `{epoch, seq}` — a `rooms-protocol` `SeqCursor`, so `classifySeq` runs over it directly. All five fixtures updated |
| ~~superseded W4 row~~ | — | — | Tracker-found. Lane A's step 7 carries it; A did not run, so the five fixtures still have `seq` and no `epoch` |
| Wire the UI to a live engine | **DONE** | `2658ddf` | The app boots into a **live draft**; the 5 fixtures became the regression net behind a source switch. `types.ts`'s mirror and `validate.ts`'s hand-rolled checker both had explicit deletion conditions — both met, both deleted, module paths kept as re-exports so 12 importers did not move. **Played in a browser:** picked Mana Drain from the opening pack, packs passed, pick 2 of 15 arrived with 14 cards, seq 17 |
| **B↔C integration check** | **DONE** | `2658ddf` | Wave 2's outstanding item. All five committed fixtures validate under the schema, asserted in `engine.test.ts` and `fixtures.test.ts` |
| ~~47 of 540 cube cards do not resolve~~ | **FIXED — and it was never the set codes** | us | **The tracker's diagnosis was wrong.** Every failing card had a *known* Forge code that translated fine — `isKnownForgeSetCode` true, `toScryfallSetCode` non-null for all of them. The real cause: we synced `oracle_cards`, which carries **one** printing per card, and for 41 of these Scryfall's chosen representative is a **digital-only** printing, which the resolver correctly refuses. Lion's Eye Diamond, Mox Diamond, Bazaar of Baghdad, Cabal Ritual — ordinary paper cards with a digital representative. Switching the default to `default_cards` (every printing, 78 MB vs 24 MB) takes it to **534/540**. The remaining **6 are genuinely absent from Scryfall**: all `OM1` / "Through the Omenpaths", a Forge `Type=Online` set. 534 is the ceiling from this data source, not a bug |
| **A third source: a real socket** | **done** | H `2e88af1`, E `fcf8c13` | `App.tsx` offers `live` · `fixtures` · `socket`, and `DraftScreen`'s props did **not** change to add it — the interchangeability the fixture lane was built for, spent as intended. `live` and `fixtures` still work untouched (21 + 15 tests, neither file edited) |
| **Two browsers drafting one pod** | **NOT VERIFIED** | — | The done-when of both §E.6 and §H.5, and the point of PR-2. No lane claimed it; a test runner cannot. Settle by opening `https://hadoku.me/cardtable/` in two friend-authenticated contexts, Source → "Server", same draft id, pick in one and watch the other, then refresh one mid-draft |
| **Demo pool is committed (232 K)** | **done** | `2658ddf` | **new row.** `apps/ui/src/draft/pool.json` so the UI builds from a clean clone without a Scryfall sync. Gameplay text only: 13 named fields, **no image field, no URL anywhere**. `build-pool` refuses to write a pool that fails that check. The first version of that control fired on **"Phantasmal Image"** and **"Nissa's Pilgr*image*"** — it scanned free text; it now scans field names and URL shapes |

### PR-3 Room module

| Item | Status | Owner | Evidence checked |
| --- | --- | --- | --- |
| P0 stable `ParticipantId` | **done (theirs)** | watchparty | **`@wolffm/rooms-protocol@0.38.109`**, `participantId.d.ts`. Three tiers `fk:`/`dev:`/`eph:`, digests not credentials. Read out of the published tarball |
| P1 seats/roles | **done (theirs)** | watchparty | `seats.d.ts`. `SeatId` **is** the order; sticky across reconnect; `kind:'bot'` + `padWithBots` with positional `bot:<n>` ids; humans evict bots; `capacity`. Its own header cites *"in a draft the pack passes left, then right, then left again"* |
| P2 carve + publish `0.x` | **done (core)** | watchparty | **`0.38.109`**, three packages, verified with `gh auth token`. **`@wolffm/rooms` never shipped — renamed `@wolffm/rooms-protocol`** (still E404 under the old name, which is what made this look blocked). `rooms-protocol` is zero-dep; `rooms-server` peers `socket.io` |
| P3 per-recipient emit — **design** | **done** | D `81583ae` | `docs/requests/P3_PER_RECIPIENT_EMIT.md`. Carries a **correction to their own §4** — see D11 |
| P5 service participant — **design** | **done** | D `81583ae` | `docs/requests/P5_SERVICE_PARTICIPANT.md`, five-state lifecycle |
| P6 persistence — **design** | **done** | D `81583ae` | `docs/requests/P6_PERSISTENCE.md`, `RoomStore` in-memory by default |
| P4 ask/correlation — **clean-room spec** | **done** | E `e359649` | `docs/requests/P4_ASK_REGISTRY.md`. Firewall held: fresh agent, contamination grep over the doc returns nothing. Read-list is self-reported |
| **Deliver P3–P6 to hadoku-watchparty** | **done, but STALE and unpushed** | E `fd584664` | Delivered on branch **`cardtable-w2-requests`** in their repo — 5 files under `docs/requests/`, their `main` untouched, no PR (per the brief). **Two caveats, both live:** the branch has **no upstream** (never pushed), and it was written against `0.38.109` while they shipped `0.38.110` **mid-wave**. Needs a re-read and a rebase off `98610f42` before it is sent |
| P3 trimmed against shipped code | **done** | E `169cb9c` | Four asks deleted as already-shipped. The line that forced it, verbatim at `rooms-server/src/emit.ts:19`: `/** Droppable, EARLIEST FIRST. An event in neither list is never dropped. */` — plus `thresholdBytes:16`, `highPriority:18`, `lowPriorityOrder:20`. What survives: per-participant `seq`, the shed-envelope rule, fail-closed projections |
| **P3 — socket server + per-seat emit** | **done** | E `fcf8c13` | `apps/server/src/room/**`. `socket.io` on the existing express app; `io.engine.use(edgeProvenance)` then an `io.use` tier check, so the socket inherits the friend gate with **no second auth scheme**. Per-recipient payloads via `emitPerRecipient`; `broadcastToRoom` is not reachable from that file. 44 tests. **Tracker drove the BUILT bundle with a real socket.io-client:** no headers, forged `X-Hadoku-Tier: admin`, and forged `friend` all → REFUSED (`not found`); forged `friend` is refused because `EDGE_AUTH_SECRET` unset ⇒ `sanitizeHeaders` fails closed |
| **P4 — ask registry (MIT, clean room)** | **done** | F `a530349` | `packages/room-ask/**`, 23 tests, all seventeen of `P4_ASK_REGISTRY.md` §4's A-1…A-17 plus three for its own decisions. `"license": "MIT"` with its own `LICENSE` and a clean-room header on all six sources — the one carve-out in a GPL repo. Firewall: fresh agent, contamination grep for Forge vocabulary returns only the licence headers. Read-list self-reported, as with the spec |
| **P5 service participant + P6 persistence** | **done** | G `0465c08` | `packages/room-store/**`, 69 tests over 6 files, in-memory by default. Five-state service lifecycle (`lost` entered by the room's clock, not the peer); `RoomStore` with snapshot/restore, quarantine, and a **real** `SIGTERM` test that forks a child process rather than mocking the signal |
| **Client socket driver** | **done** | H `2e88af1` | `apps/ui/src/draft/socket.ts`, 28 tests. `classifySeq` on every inbound envelope; `duplicate` drops and **never** resyncs. `live` and `fixtures` untouched and still selectable — socket is a **third** source, not a replacement |
| **Wire envelope** | **done** | H `20346e1` | `packages/shared/src/wire.ts`, 20 tests. One socket.io event name per **direction** carrying a tagged union, so there is one handler per direction and no unvalidated entry point. Client→server schemas are `z.strictObject`: a browser supplying `participantId` is a parse **error**, not a stripped field |
| **`@hadoku/room-ask` — declined by watchparty** | **needs an operator decision** | us | Built because the operator asked for the full P3–P6 set, and because PR-4 play will need it. **A draft pick is an event, not an ask** — the wave file says so. Nothing imports it today |
| ~~**`emitPerRecipient` missing (W1)**~~ | **CLOSED — they fixed it** | watchparty | **Closed 2026-09-14.** Their `e58e3005` *"give SKIP its function, and ship the reconnect contract (W1, W2)"*. Verified in their source: `emit.ts:121 export function emitPerRecipient`, plus `emitToRole:148`, at **`0.38.110`**. The sentinel now has something to pass it to. Lane E reported the defect; they had already fixed it by the time the wave closed |
| ~~**`@wolffm/rooms-client` (W2)**~~ | **CLOSED — they shipped the contract we asked for** | watchparty | **Closed 2026-09-14.** We agreed with the deferral and asked instead for the reconnect/resync/identity-reassert **contract** in the zero-dep `rooms-protocol`. It exists: `rooms-protocol/src/resync.ts` exports `SeqCursor`, `classifySeq`, `missedCount`, `needsResync`, `RosterIdentity`, `IdentityReassert`, `resolveIdentityReassert`, re-exported from `index.ts:15`. **This is what P6's "survive a restart and a refresh" binds to** |
| ~~**Envelope needs an `epoch` (W4)**~~ | **CLOSED — see the PR-2 row** | us | **new row, ours not theirs.** Found reading `rooms-protocol@0.38.110` as its first consumer. `SeqCursor` is `{epoch, seq}`; all five committed fixtures carry `seq` and **no `epoch`**, so they cannot use `classifySeq`. The epoch separates "missed events" from "server restarted and recounted" — opposite responses, and the second **is** P6's restart case. Their `resync.d.ts` header says `lastEventSeq` is stamped only on watchparty's control events and an app wanting gap detection stamps its own cursor |
| **`SKIP` arm doesn't constrain (W5)** | **watch — possibly moving** | watchparty | **2026-09-14:** an untracked `apps/server/test/emit-payload-types.test-d.ts` sits beside a modified `emit.ts` in their `rooms-resv` worktree. Uncommitted; not shipped. |
| ~~superseded W5 row~~ | — | — | **new row.** `emitPerRecipient`'s `build` returns `unknown \| typeof SKIP`, and `unknown` absorbs the union — tsc 5.9.3 resolves it to plain `unknown`, so the SKIP arm type-checks nothing. Cosmetic today. Raised with the seat answer |
| **`ClientMeta.socketId` is one string (W3)** | **open upstream; we guard it locally** | watchparty | **Re-reproduced 2026-09-16 against the shipped `0.38.111`** — unchanged. Wave 5 lane E takes option (c), the host-side guard: after `leaveRoom`, if `clientByParticipant` still finds a live client for that id, `seatParticipant` returns them to the remembered seat. Mutation-tested — delete the guard and 3 tests fail, the socket-level one as `expected null to be +0`. See the Watches entry. **Every other `rooms-server` consumer still has this bug.** Originally: **found by lane E reading their source rather than their docs.** P3 §3.2 asked for `sockets: Set<string>`; what shipped is `state.ts:16 socketId: string`. On a refresh, `leaveRoom` can unseat a participant who is already back on a live socket. E reproduced it against their real `seats.ts` — the participant ends `spectator` with their seat empty. Closes when they confirm the ordering or take one of the three fixes |
| CI must use `HADOKU_NPM_READ_TOKEN` | **no longer vacuous — one caveat** | A `5b41cc1`, W5 | **Re-checked 2026-09-16.** `gh secret list` is **non-empty** (`HADOKU_NPM_READ_TOKEN`, `HADOKU_SITE_TOKEN`), and the repo now genuinely depends on `@wolffm/rooms-protocol` **and** `@wolffm/rooms-server`, so the path is no longer structurally dead. CI green on `5cc9773` installed 307 packages with `scope: @wolffm`. **Caveat, and it is this repo's own trap:** the runner is self-hosted and warm (`reused 299`), so a cached store can satisfy the install without ever hitting the registry. Settle with a cold runner or `pnpm store prune` before install |

### PR-4 Play

| Item | Status | Owner | Evidence checked |
| --- | --- | --- | --- |
| `case "server":` headless mode | **spiked — viable** | D `df716ef` | **Forge runs headless.** `SimulateMatch` played a full AI-vs-AI game to a damage win on turn 12, exit 0, no display, no X server, no network; actual output in `docs/spikes/headless-server.md`. `case "server":` itself reaches its arm headless and exits 0 — **the scaffolding works, only the body is missing.** Build: `mvn -B install -pl forge-gui-desktop -am -DskipTests`, 69 s cold / 15.9 s warm |
| **A headless net harness already exists in-tree** | **found** | D `df716ef` | **new row, nobody had budgeted for this.** `forge-gui-desktop/src/test/java/forge/net/` is **3,919 lines**: `HeadlessNetworkGuiGame`, `HeadlessNetworkClient`, `HeadlessGuiDesktop`, a `MultiProcessGameExecutor`, and an integration test that calls `FServerManager.startServer(port)`. **PR-4 is not greenfield** |
| `ProtocolMethod` surface | **measured** | D `df716ef` | **60 methods, not 62** — tracker re-derived independently from the enum: **45 SERVER / 15 CLIENT**. **38 required at the w1 measurement** (29 s→c + 9 c→s), 20 not, **2 dead** — superseded: forge-wire now models **40** (w19 lane B re-derived; see `packages/forge-wire`) (`setRememberedActions`, `nextRememberedAction` are not on `IGuiGame` at all). **For a browser *draft* client: 0 of 60** — `ProtocolMethod` is the *match* protocol and has no draft methods, which independently corroborates O2 |
| WS/JSON `IToClient` | todo | us | `IRemote` is 3 methods; `IToClient` is empty (D9: required in every branch) |
| ~~gdx-teavm embed payload~~ **or** React client | **decided: React** | us | D7 NO-GO. ~14 prompt components over a board renderer. D6's iframe payload does **not** already exist |
| Disable jUPnP | **answered: config, not code** | D `df716ef` | `FServerManager.java:230-274` — `mapNatPort()` runs only when the `UPnP` pref is `ALWAYS`, so `UPnP=NEVER` in `server.preferences` means jUPnP is never constructed. **No fork change needed.** The trap is the shipped `ASK` default: it calls `SOptionPane.showOptionDialog`, a blocking modal a headless server cannot answer |
| `FSerializableFunction` on the wire | **answered: real but narrow** | D `df716ef` | `one` never crosses the wire (it resolves locally to `getChoices`). `getChoices` serializes the lambda as a `SerializedLambda` no JS client can reconstitute — **but the server holds both the choices and the lambda**, so rendering labels server-side and sending strings loses nothing. That is the fix `WireClassFilter.java:45` already names |
| ~~**Strip upstream's Sentry DSN in the fork**~~ | **done** | us `1f19a230` | **Stale row, corrected 2026-09-18 — this landed with the fork and the board never caught up.** Verified in the *compiled artifact*, not the checkout: no `sentry` string in `forge/view/Main.class` inside the installed jar. Checking the source would not have been enough, since a stale incremental build can carry the old class |
| ~~**A drafted deck with basic lands cannot be played**~~ | **done** | D `8cda565` | **Closed 2026-09-19.** `splitBasicLands` moves basics out of `main` before the pool check, using `isBasicLand` (Forge's own five) and no second list. Tracker mutation-tested: neutering the split fails **5** tests, restored 77 pass — including *"exempts only Forge's five: an undrafted land outside them is pool-checked"*, which is what stops a Celestial Colonnade riding in. ~~Cannot be played~~ | **new row 2026-09-19, found by Wave 12 lane B.** `deckFromDeckFile` returns `basics: []` and leaves basics in `main` (`deck.ts:311`); `poolOf` is main+sideboard (`deck.ts:138`); the draft arm (`gate.ts:346`) counts every `Island` against the drafted pool → *"plays 17x Island but drafted 0"*. `deckIssues` has no basic-land exemption on the pool arm. Confirmed by execution, not reading. **The fix is already in-repo**: `isBasicLand`/`BASIC_LAND_NAMES` (`deck.ts:119`,`:40`) — split basics out of main before `deckIssues`. Lane B correctly declined it: `apps/server/src/http/**` was owned by nobody |
| **Forge jar built and installed in production** | **done** | tracker | `~/.local/share/cardtable/forge.jar`, sha256 `4935b266bce3f098…`, clean-built from pin `2ad70eb4` off-tree in `~/.cache/w7b-forge`. `java -jar … server --help` prints our `DedicatedServer` usage. After an mgmt-api restart: `jvm-spawned` + `spare-warm bootMs:3828`, and `index.ts:239`'s `play: no Forge` warning is **absent** — so `POST /api/play/matches` no longer 503s. Rebuild procedure (required on every pin move, `clean` mandatory): `docs/FORGE_JAR.md` |
| ~~Match run dirs are never cleaned up~~ | **done** | C `0f19af4` | **Closed 2026-09-19.** A finished match's dir is removed, a crash keeps `bridge.stderr.txt` + `config.json` + `crash.json` (newest 20, none older than 7 days), and boot sweeps what earlier servers left. Tracker mutation-tested: disabling the clean-end `rmSync` fails 2 of 14, restored 14/14. Live: production holds **1** dir, down from 174. ~~Never cleaned up~~ | **new row 2026-09-18.** `host.ts:274` `rmSync`s a run dir before creating it, never after the match ends; each match gets a fresh id, so `/tmp/cardtable-play/` grows without bound (78 dirs / 16 MB in one day, ~205 KB per match). `/tmp` is tmpfs, so it is RAM — 13 G free and a reboot clears it, hence low. Fix belongs on the existing `stop()`/`overGrace` path |

### PR-6 The game client

| Item | Status | Owner | Evidence checked |
| --- | --- | --- | --- |
| Streamed Forge — the second frontend — live in prod | **done (interim form)** | tracker `5301813` | `/cardtable/stream/<n>/**` proxies HTTP and websockets to the stream containers, both halves behind the friend gate: HTTP below `requireMinTier`, the upgrade half re-applying the floor by hand (404, never 403). Verified from artifacts: 12/12 stream tests including live-socket refusals the bench never had; `pnpm check` green; full e2e 6/6 including the real Forge match; CI run `35681372480` success; prod boot log `streamed Forge LIVE — 2 container(s)`; raw upgrade probe against `:9008` answers `404 not found` (the gate, not a hang). Containers recreated fresh and prepped (`Not Now`, window 1280×800). **Interim limits, on purpose:** one container is one session; a two-player match is started by hand through Forge's own Online lobby; the switch is `~/.local/share/cardtable/stream/STREAMS` on disk. Still unverified: a friend's click-through the edge — the operator holds the links |
| CheerpJ as a delivery route | **dead** | operator, D19 | Licence forbids self-hosting the runtime, the page needs a CSP carve-out, the tab holds ~1.4 GiB, and the operator chose our own UI as the primary route. Staging deleted with w17 lane D and not restored with the stream route |

## Waves 3, 4, 5 — all LANDED

`docs/planning/wave3-2026-09-14.md` · `wave4-2026-09-16.md` · `wave5-2026-09-16.md`

### Wave 3 (as planned) · `docs/planning/wave3-2026-09-14.md`

Five lanes, finishing PR-2. **A** draft engine + Zod schema (gated on P1) ·
**B** deck build + `.dck` export · **C** the stale facts in `CLAUDE.md` and
three docs · **D** deliver P3–P6 + the W3 seat answer, in their repo ·
**E** wire the UI to a live engine (after A).

Two operator decisions settled 2026-09-14 and written into the wave:
**W3 → we want reservation-with-TTL**, not the socket Set (it is the only one
of the two that survives a network blip or a server restart, which is what P6
actually requires); and **`cardtable-w2-requests` → rebase, re-read against
`0.38.110`, push**.

### Wave 4 · `docs/planning/wave4-2026-09-16.md` — card art moves to our CDN

Four lanes, all landed, CI green on `b2917ac`. **A** art-source indirection
(`packages/carddata/src/art/**` + `art-manifest.json`) · **B** the CDN upload
CLI · **C** the UI consuming the art source · **D** the rules rewritten
(`docs/LICENSING.md`, `CLAUDE.md`, `DECISIONS.md`, `NOTICE.md`, `ci.yml`).

The headline is **D15, which supersedes D13's image clause**: card art lives on
`cdn.hadoku.me`, image bytes still never enter the repo, and **our own origin
never serves an image**. `scripts/d13-gate.sh` replaced the inline CI gate.
Ran **concurrently with Wave 5** in a separate worktree; the two overlapped on
exactly `apps/ui/package.json` and `pnpm-lock.yaml`, both resolved at W5's
rebase.

**Its closing notes were never recorded on this board.** What the tracker can
verify from artifacts is in the 2026-09-16 ledger; a proper W4 closeout is owed.

### Wave 5 · `docs/planning/wave5-2026-09-16.md` — the room layer, P3–P6

Four lanes, all landed, one push, deployed. **E** socket server + room ·
**F** ask registry (clean room, MIT) · **G** service participant + persistence ·
**H** wire schema + client socket driver. Full ledger in the 2026-09-16
"Verified this pass" section below.

### What's next — the queue after Wave 5

| # | Item | Why it is next |
| --- | --- | --- |
| 1 | **Two browsers drafting one pod** | The only thing PR-2 exists for and the one claim no lane could make. Needs two friend-authenticated sessions, not a test runner |
| 2 | **Wave 4 closeout** | Its notes never reached this board |
| 3 | **Wire P6 into `apps/server`** | `@hadoku/room-store` exists and nothing imports it. Today a restart loses every draft — lane E runs **no GC** and keeps rooms for the process lifetime, which is a slow leak with no persistence under it |
| 4 | **`CLAUDE.md:101`** | Still says "Maven ✗" against an installed Maven 3.9.16 |
| 5 | **`KEY_SERVICE_CARDTABLE`** | Every redeploy reports nothing, silently, and passes |

### Superseded — the shape before it was planned

Not planned in detail and **not scaffolded** (that needs approval). What Wave 2
left determines it:

| Lane | Owns | Why |
| --- | --- | --- |
| **B (re-run)** | `packages/draft/**`, `packages/shared/**` | The engine + Zod schema Wave 2 could not build. **Gated on P1** — this lane is the whole reason P1 matters. Its brief in `wave2-2026-09-14.md` §B is still accurate and can be reused verbatim |
| **B↔C integration** | tracker, no files | Run B's schema over `apps/ui/src/draft/fixtures/*.json`. A failure is a **lane C** bug |
| **Deliver P3–P6, take 2** | `docs/requests/**` + a branch in watchparty | Re-read against `0.38.110`, drop what `e58e3005` answered (W1, W2), keep W3, rebase off `98610f42`, and **actually push it** |
| **Doc debt** | `CLAUDE.md` | The three stale facts. Wave 2 couldn't touch it — owned by nobody — and three separate lanes tripped over it |

The ordering that matters: **B before the integration check**, and B before
anything in PR-4, because the wire schema is what `IToClient` will carry.

### Found 2026-09-16 — the watchparty UI package cannot be composed with

The operator's expectation is reasonable and does not work today: *"my
expectation is that we import a package from watchparty for the ui."*

`@wolffm/watchparty-ui@0.38.115`, read from the published tarball, exports
**exactly three things** — `createWatchpartyRouter`, `mount`, `unmount`. It is a
**whole-app mount**: `mount(el)` puts the entire watchparty application into a
DOM node. There is no room shell, roster, chat or canvas-slot component to
compose with, and **0 `.d.ts` files ship** despite `types: "./dist/index.d.ts"`
being declared, so a TypeScript consumer gets nothing.

It is built for hadoku_site to mount watchparty at `/watchparty/`, not for a
second app to borrow its chrome. Wave 6 lane E asks them for composable exports
and reports the types defect; lane A builds our own shell behind a seam meanwhile
so nothing blocks. **Do not plan any wave on the assumption that this import
works.**

### Found 2026-09-16 — D6 and the deployed shape have been contradicting each other

**D6** says the draft UI renders inside the room's central canvas slot with
watchparty's chrome around it. **What is deployed** is a standalone loopback-UI
tunnel app at `/cardtable/` with its own server and its own chrome — the shape
hadoku_site's own agent chose when it onboarded us, and which is live and
working. Nobody reconciled the two; the tracker never put a row on the board for
either, which is why three waves went by without it surfacing.

The operator has now settled it: **cardtable is its own app and imports room UI
as a package.** That is neither of the two readings above and is compatible with
the deployed shape. D6's canvas-slot framing survives as the *layout* intent;
its "iframe payload inside watchparty" mechanism does not. **Needs a decision
entry — see O7.**

## Operator's list — only they can do these

| # | Item | Why it's theirs |
| --- | --- | --- |
| ~~**O8**~~ | **CLOSED 2026-09-18 — hadoku_site landed it.** `services/mgmt-api/src/deploy/deploy-executor.ts` now runs `syncSubmodules` after `git reset --hard origin/<branch>` and before `stopService`, only when `.gitmodules` exists (`git submodule sync --recursive && git submodule update --init --recursive --depth 1`, 10-min timeout, no `--force`). Test at `src/tests/deploy-submodules.test.ts`, 4 cases, mutation-tested (removing `update` fails 2 of 4). **Still unverified live:** nobody has fetched a non-tip sha at `--depth 1` for `forge` yet, so the first deploy after the *next* pin move is the real test. Settle it with `git -C ~/repos/hadoku-cardtable status --porcelain` printing nothing, and the deploy log showing `Synced submodules to the recorded pins`. ~~The deploy tree's submodule drifts on every pin move.~~ `deploy-config.json`'s cardtable entry runs `pnpm install && pnpm build` and mgmt-api's `git pull` does not touch submodules, so `forge/` goes ` M` each time the pin moves and a future pull can refuse outright. Harmless today (nothing builds or serves `forge/`). Durable fix is a `git submodule update --init` in hadoku_site's deploy step; the stopgap is `git -C /home/hadoku/repos/hadoku-cardtable submodule update --init forge`. | hadoku_site |
| **O9** | **Send the room-chrome request, or decide we are not asking.** `docs/requests/WATCHPARTY_ROOM_CHROME.md` is written and unsent. It asks watchparty for `RoomChrome` at 0.39.0, which commits cardtable to their release schedule for its room UI. Sending it is cheap; depending on it is not. Related: `packages/room-ask` has **no consumer** and this wave gave it none — hand it to watchparty (offered in §6 of the request) or delete it here. A package with no consumer and no owner is a liability. | Decision |
| **O10** | **D15 needs one more sentence: does "our own origin" mean the cardtable app server, or all of `hadoku.me`?** Lane D found watchparty's sprites load from `hadoku.me/watchparty/…`. Under the narrow reading we are fine and always were; under the broad reading, importing their room chrome would breach D15 on their assets, not ours. `scripts/d13-gate.sh` currently enforces the narrow reading. The rule should say which it means before a lane has to guess. | Decision |
| **O7** | **D6 needs superseding.** It specifies the UI as an iframe payload inside a watchparty room; production is a standalone app and the operator has now settled on "our own app, importing their room UI as a package". The layout intent survives, the mechanism does not. Nothing in `DECISIONS.md` records the new shape. | Decision log |
| **O5** | **D2 says "rules out: an MIT room layer living in this repo" — and `packages/room-ask` is now exactly that.** The code side is careful (SPDX, own `LICENSE`, clean-room so it is not a Forge derivative) and the licences are coherent: MIT so P4 can go upstream to watchparty's MIT packages, GPL for `room-store` which is ours. But `docs/DECISIONS.md` mentions `room-ask` **zero** times. Either amend D2 with the carve-out, or move the package to watchparty. A rule contradicted without a record is one that flips back. | Decision log |
| **O6** | **The CDN upload has never run** — `art-manifest.json` has 0 entries and all art still comes from Scryfall via fallback. `pnpm --filter @hadoku/carddata upload-art` needs a **friend-tier credential** that is not on this host. Lane B refused to invent an auth path, correctly. One credential turns a working pipeline into live art. | Credential |
| ~~O1~~ | ~~fork `Card-Forge/forge`~~ — **resolved 2026-09-11: deferred.** A plain clone already syncs upstream (`origin` *is* upstream); a fork only buys somewhere to push our Forge commits, a submodule URL, and the ability to PR `case "server"` back. None needed until the first line of Java, and lane B explicitly writes none. **Repo creation DONE 2026-09-14** — `WolffM/hadoku-cardtable` exists, private, created 07:26, `main` pushed, CI green. Only the *fork* half remains deferred. | |
| ~~**P1**~~ | **CLOSED 2026-09-16 — it is in the profile.** `~/.bashrc:166` exports `NODE_AUTH_TOKEN` (and again at `:167` — a duplicate export, harmless, worth tidying). `npm view @wolffm/rooms-protocol version` → **`0.38.115`**, exit 0. The bare-env control still 401s (`env -u NODE_AUTH_TOKEN npm view` → exit 1), which is what makes the export load-bearing rather than cosmetic. Note it is a **static `gho_` token in a dotfile**, not `$(gh auth token)`, so it will expire on its own schedule. ~~Export `NODE_AUTH_TOKEN`~~ — `~/.npmrc` reads `_authToken=${NODE_AUTH_TOKEN}` and the variable is unset, so npm sends the literal placeholder and gets `E401`. Not a rotation: `NODE_AUTH_TOKEN=$(gh auth token) npm view @wolffm/rooms-protocol version` → a version. **STILL OPEN — re-checked 2026-09-14 after Wave 2: the variable is unset and the bare `npm view` still returns E401.** ⚠️ **This already cost a lane.** Wave 2 shipped four lanes of five; lane B — the pure draft engine *and* the Zod wire schema, i.e. the middle of PR-2 — was never dispatched because of it. **Blocks Wave 3's first lane.** Put it in the shell profile. | Shell env |
| ~~**P2**~~ | **CLOSED — and it was already closed before Wave 5 started.** `gh secret list -R WolffM/hadoku-cardtable` on 2026-09-16 returns `HADOKU_NPM_READ_TOKEN` and `HADOKU_SITE_TOKEN`; the former was already dated 2026-09-15 when the Wave 5 manager first looked, and was re-seeded 2026-09-16T08:01Z. **The board carried "still empty" for two passes after it stopped being true.** ~~Set `HADOKU_NPM_READ_TOKEN` on the repo~~ — ~~`gh secret list` re-checked 2026-09-14: **still empty**.~~ CI's green runs are still vacuous: Wave 2 added no `@wolffm/*` dependency (because B never ran), so the token path has **still** never executed. The first lane that depends on `@wolffm/rooms-protocol` is where a cold runner surfaces the 403. | Repo secret |
| ~~**P3**~~ | **CLOSED 2026-09-14 — delivered.** `origin/cardtable-w2-requests` at `ccfeab46`, upstream set, rebased to 0 behind their `main`, re-read against `0.38.110`, carrying the seat answer. ~~Decide what to do with `cardtable-w2-requests` in `hadoku-watchparty`~~ — our P3–P6 delivery is committed there on a branch with **no upstream**, and it is already stale: they shipped `0.38.110` mid-wave and answered W1 and W2 in `e58e3005`. Either push/PR it after a rebase + re-read, or drop it and re-derive against `0.38.110`. **Nothing reaches them until someone pushes.** | Their repo; ours to send |
| ~~O2~~ | ~~P1 draft: reimplement in TS vs. reuse Forge's `limited/`~~ — **RESOLVED 2026-09-14: reimplement in TS.** | **Live and now decidable — the spike is in, and it changed the terms.** The "free draft engine *and* UI in the iframe" branch is **dead** (D7 NO-GO). But lane B proved the other half: `forge-core`+`forge-game` run headless on the JVM in 1.6 s and resolve real card interactions, so reusing `limited/` **server-side** is viable in a way nobody had evidence for before. So the trade is now: TS reimplementation (JVM-free P1, but pack collation/rarity/foil is accumulated correctness with no oracle but Forge — the D4 objection stands) vs. a JVM draft service (correct by construction, but P1 now carries a JVM and O3 arrives early). **Resolved.** The JVM branch lost on evidence gathered at planning time: `BoosterDraft.java` lives in **`forge-gui`** — precisely the module Wave 1's headless proof excluded — and carries 17 `SGuiChoose`/`SOptionPane` call sites plus the `FModel` singleton. Meanwhile the "accumulated correctness, no oracle" objection turned out to be about **set-booster collation**, which a cube never opens: **91** of 94 recipes are `Booster: 15 Any` (the planner said 92; lane A's count is the right one), 93/94 singleton, exactly 1 uses rarity slots. Reuse would cost `forge-gui` + a JVM to buy a pick/pass loop. **Revisit only for set/block draft or sealed**, where `BoosterGenerator` genuinely earns its keep. |
| ~~**P4**~~ | **CLOSED 2026-09-25 — seeded.** `gh secret list -R WolffM/hadoku-cardtable` shows `KEY_SERVICE_CARDTABLE` dated 2026-09-25T16:02:48Z, so `redeploy.yml`'s `report-job` has a service key and cardtable's redeploys reach monitoring-api. ~~Seed `KEY_SERVICE_CARDTABLE` on the repo, or decide cardtable does not report.~~ `gh secret list` has no such secret, so `redeploy.yml`'s `report-job` gets an empty `service-key`. It does not fail — `report-job@v1` guards it and emits `##[warning]service key unset — cardtable:redeploy outcome not reported`, observed verbatim on Wave 5's own redeploy of `5cc9773` **and** on the tracker's push of `a1cf214`. So every cardtable redeploy is green and monitoring-api never hears about it. Seed from an up-to-date hadoku_site checkout: `python3 scripts/administration.py github-secrets child-repos`. | Repo secret |
| **P5** | **Tidy the duplicate `NODE_AUTH_TOKEN` export** — `~/.bashrc` exports it twice (`:166` and `:167`). Harmless today; the second silently wins, so a future rotation that edits only one line will look like it did nothing. It is also a **static `gho_` token in a dotfile** rather than `$(gh auth token)`, so it expires on its own schedule. | Shell profile |
| O3 | One JVM per match vs. one hosting many | defer to PR-4, but decide before the service-participant lifecycle. **Arrives sooner if O2 goes the JVM way.** |
| ~~O4~~ | ~~Does the spike block Wave 2?~~ | **Resolved 2026-09-12: moot.** The spike ran and finished inside Wave 1. |

## Found by the fleet (2026-09-21): the header-fleet audit, and a nightly restart

hadoku_site's nightly `ci:header-fleet` audit paged @here at 13:09 UTC on two
cardtable gaps. It runs locally —
`node ~/repos/hadoku-fleet-manager/scripts/check-header-fleet.mjs` — across all
16 fleet repos, and **cardtable was the only one with findings**, so every fix
can be verified by re-running it.

### `no-update-flow` — FIXED, `b22e846`

cardtable had no `.github/workflows/update-wolffm.yml`, so no `@wolffm/*`
release after onboarding would ever reach it. Added from `templates/ui-app`.
Re-running the audit: **2 findings → 1.**

The template was wrong for this repo in two ways, both reported back to
hadoku_site as possible template fixes:
- **cardtable tracks `.npmrc`.** The template writes a literal token into it,
  leaving a secret one `git add` from a commit and making every no-update run
  fail. Replaced with `setup-pnpm@v1`, as `ci.yml` already uses.
- **It is an eleven-manifest workspace.** The template stages only the root
  `package.json`, which would commit a lockfile out of step with the manifests.

### `no-app-header` — FIXED, `b287fe2` (2026-09-22)

hadoku_site landed the catalogue entry (098737eb, then published as
`@wolffm/catalogue@1.0.2`): **cardtable → "Card Table"**, social, tier friend,
icon "layers". Our half then shipped as one commit:

- `apps/ui/app-name.ts` — the app's one identifier (`cardtable`), display name
  looked up via `labelFor`, so repo and catalogue cannot disagree.
- `__HADOKU_APP_NAME__` defined in vite and the root vitest config; index.html's
  title is the same token, rewritten at build. Tab and header are one string.
- `<AppHeader>` authored at the `App.tsx` root (where the audit reads it) and
  slotted into `AppChrome` so it still renders inside `HadokuThemeRoot`.

**Verified:** the fleet audit reads `OK — 16 repos, no drift` (tracker ran it);
the deployed tree at `b287fe2` carries `<title>Card Table</title>` and the
string in the bundle; CI fetched the new dep on the claws green.

**A finding raised while shipping it, and fully retracted after hadoku_site ran
it to ground: there was never a token problem.** The vault item, our repo's
GitHub-secret copy, and mgmt-api's LIVE env are all healthy — the 401s my
probes reported came from reading `/proc/<pid>/environ` and pm2's stored env,
which are EXEC-TIME snapshots: `bw.ts` mirrors the vault into the live
`process.env` after boot, and `pm2 restart` reuses the stored environment, so
several services carry months-old token fossils there that nothing reads.
**Nothing ever 401'd in a deploy**; the pre-warm was right for the window it
covered and harmless. The fossil cleanup (a fleet-wide delete+start at a quiet
time) is flagged to the operator by hadoku_site — not ours. The missing
`wolffm_published` dispatch for catalogue 1.0.2 was likewise not an incident:
site-published packages propagate on the daily 13:00 UTC fan-out by design.

### The service restarts at 08:00 UTC, every day

cardtable is one of ten wrappers `pm2:wrapper-key-rotation` restarts daily at
**08:00 UTC — 01:00 Pacific**. What survives:

| | survives the restart? |
| --- | --- |
| lobby rooms | **yes** — `room-store`, on disk |
| draft pods | **no** — in-memory (`draftRooms.ts:79-86`: rooms live for the process) |
| live matches | **no** — child JVMs die with the server |

Low collision for a friend group at 1 a.m., but it is a restart to **design
for, not rely on the timing of**. And it matters to the frontend plan below: a
seat surviving a *client* swap (a page reload) is a different guarantee from a
match surviving a *server* restart. The first is w18's; the second nobody has
yet.

## Found while closing Wave 20 — two e2e defects, one of them host-wide

**Docker had run out of network address pools on hokon.** Every streamed room
creates its own docker network, and removing a container does not remove the
network it sat on — so one leaked per e2e run from 2026-09-18 onward. At 22
leaked `cardtable-e2e-room-*` networks docker began refusing to create any
new one: `all predefined address pools have been fully subnetted`. That fails
provisioning for **every service on the machine**, not only cardtable, and it
is invisible to a container census, which is exactly what the spec had.

Cleared by the tracker (22 removed, bench untouched — `cardtable-lab` still
has its 2 containers), and closed at the source: `streamed-live.spec.ts`'s
teardown now reaps networks by the harness's own prefix and asserts none
remain. Proven: network count 9 before a run, 9 after, streamed room green.

**`e2e/play.spec.ts` proved item 5 by luck.** It hunts a castable spell to
show one resolves with nobody pressing a button — and the game was never
seeded, so the shuffle decided whether the proof was reachable at all. (And
stayed unseeded after this wave "fixed" it, for the reason the wave 22 section
below now records.) CI drew
a hand where Forge offered nothing but two lands (`casts: []`, `everOffered:
["Plains", "Celestial Colonnade"]`) and the wave's headline proof went red on
a dependency-bump commit that could not have touched it.

`MatchSpec.seed` already existed for this — *"seeds Forge's shuffles and the
precon pick, for a repeatable test run"* — and `bridgeConfig` already spread
it to the JVM, but **nothing on the product path ever set it**, so only
`jvm.test.ts` (which builds a spec by hand) could ask for one. The product
path now reads `CARDTABLE_PLAY_SEED`, unset everywhere but the harness, which
pins `e2e/playSeed.ts`. Mutation-tested: dropping the spread fails 1 of 16.

**Seeding alone was not enough, and the first seed made it worse.** Seed
20260925 produced a game where Forge never offered alice a castable spell at
all — so the check failed deterministically, locally and in CI both, which is
how the second half of this was found. Two things fixed it:

1. **The assertion now says only what it can prove.** A spell cast that does
   NOT resolve unattended is a real failure. A game that never offers a
   castable spell is reported loudly (`[play] UNPROVEN: …`) and not failed —
   because a proof whose precondition the shuffle grants is a proof that fails
   on luck. The BEHAVIOUR's proof of record is `auto.test.ts`, which decides
   every captured priority window deterministically and is mutation-tested
   (2 of 76).
2. **Seed 7.** ~~Casts Squadron Hawk and resolves it with no button press,
   verified over repeated runs.~~ That was two lucky deals: the seed was set on
   the OTHER e2e server, the one that cannot start Forge, so nothing was seeded
   until 2026-09-27. The seed does fix the deal — measured, mutation-tested, see
   the wave 22 section below — and seed 7 now deterministically casts Preordain
   and resolves Day of Judgment unattended, once the drag loop plays its lands.

### Open: `board-play.jvm.test.ts` times out at 120 s

Found running the jar-gated suites locally (they never run in CI):
*"a land and Raging Goblin by clicking: not done in 120 s"*. Lane B's closing
note recorded this suite passing during the wave, so it either regressed after
it or belongs to the same class as the play.spec finding — a real match not
reaching the state a test waits for. **Unverified either way.** Settle it with
`CARDTABLE_FORGE_JAR`/`_RES` + a scratch `CARDTABLE_PLAY_WORK_DIR` and
`pnpm vitest run apps/ui/src/play/live/board-play.jvm.test.ts`; if it is the
same class, it wants the same treatment — a seeded game and an assertion that
cannot fail on the shuffle.

### The `LiveBoard.test.ts` flake, and what it was not

Run `36140099030` failed on `expected 'Turn 13' to be 'Turn 14'`. Reran green
on the same sha, passes locally 5+ times including under 3x core load — so
the diagnosis (the helper waits on the LAST frame's render rather than on
delivery) is **plausible and unproven**, and the board says so. Hardened by
waiting on `stats.applied` first. If `Turn 13` returns, the wait is not the
cause and the replay server's send path is next.

**A process note for the tracker, earned here:** while verifying I ran a local
`pnpm e2e` and CPU-load tests that overlapped a CI `forge-e2e` job on this
same machine — the exact collision `ci-runner-shares-e2e-ports` warns about. It
was not the cause this time (the quiet-host rerun failed identically), but it
cost a round of diagnosis. Check `gh run list` before AND after starting a
local e2e, not only before.

## Verified this pass (2026-09-27 — tracker, closing Wave 22)

**Landed to `fee59ea`, apps 0.18.0.** Both CI jobs green, health 200, deploy
confirmed, worktree and branch gone. Tracker's own `pnpm check` green; lane
lists had been re-intersected at `ad6dc0f` before dispatch.

**The wave found and fixed a regression it had itself introduced**, and said
so rather than hiding it: lane E's hand-over removed the old
`process.on('exit')` SIGKILL, which had been brutally killing live matches —
correct to remove — but it had ALSO been the only thing reaping FINISHED ones,
so every completed game leaked a ~1 GB JVM until the next boot. Worse
precisely because this wave makes restarts rarer. Lane S found it, lane U
closed it. **Verified live by the tracker:** four `forge.jar` processes on the
host, and all four are legitimate — one warm spare (child of the server) and
two inside the friend-demo bench containers, up 5 days. No orphans.

### CLOSED 2026-09-27: the seed does fix the deal. It was set on the wrong server.

**Settled by measurement**, which is what both earlier entries here lacked. Two
cold matches on seed 20260918, through the real bridge against the real Forge
build on this host, put both libraries in the same order —
`apps/server/src/play/seed.jvm.test.ts`, and mutation-tested: with
`MyRandom.setRandom` skipped in `PlayBridge.startMatch` the two permutations
differ and the test fails.

**The actual bug:** wave 20 set `CARDTABLE_PLAY_SEED` on `e2e/harness.ts`'s
server — the one started deliberately *without* `CARDTABLE_FORGE_JAR`, which
therefore cannot start a Forge match at all. `play.spec.ts` runs against a
second server of its own (`e2e/play/harness.ts`), and that is the process the
variable had to be on. So no e2e match was ever seeded and every run dealt a
fresh shuffle, while the spec's comments said otherwise. Fixed by moving it, one
line.

**Both previous entries on this were wrong, in opposite directions**, and both
came from reading code rather than running it:

- Wave 20 recorded *"seed 7, which casts Squadron Hawk … verified over repeated
  runs"* — two lucky deals on an unseeded game.
- Wave 22's close recorded that the bridge never applies the seed, because
  `MyRandom.setRandom` appears in `SimulateMatch.java:89`. It also appears in
  `PlayBridge.java:1487`, and always has. That correction was itself wrong and
  is withdrawn.

**What the fixed deal then exposed**, first seeded run: `play.spec.ts` failed
with *"dragged 26x spell and none of them moved"*. Seed 7 deals alice six lands
and one Preordain, and the drag loop played exactly ONE land and then spent its
whole budget on a card she could not pay for. The gesture was never broken; the
loop was not playing her mana out. It drags a land whenever one is offered now —
Forge allows one a turn — and the spec is green in 40 s instead of 3.2 min, with
Preordain dragged, cast, and Day of Judgment resolving unattended at turn 9. The
spell half of that check had only ever passed on deals that handed it a one-mana
play in the opening hand, which is the same luck one level in.

Each silent drag now records the card and Forge's own prompt line, because the
bare count read exactly like a broken affordance and was not one.

### Follow-ups the wave deliberately did not take — all on the board now

| finding | why it matters |
| --- | --- |
| `resendAfterSnapshot` re-sends says + prompt + buttons but **not `setSelectables`** (`match.ts:485-493`) | a refresh mid-selection leaves a seat holding a prompt it cannot answer. **Pre-existing and found independently twice** — that is the signal it is real |
| `transport.ts:198-200` comment falsified by lane R; `:156-159` documents `MatchSnapshot.cursor` as a reading the server header explicitly warns against | a wrong explanation is worse than none — it is what the next lane will trust |
| `routes.ts` `legalIn[]` does 49 round trips per era | the era filter lane B just shipped rides on this |
| `bot.ts:142-143`, `engine.ts:215,:244` unguarded casts | same family as the `view.ts:38` crash lane H fixed |
| E's match-gone sentence is not rendered anywhere yet | the words exist; nothing shows them |

### On the runtimes, and the manager's own account

Lane R spent 84 minutes on two lines, *"mostly permission-denial churn"* —
worth fixing, and it is a harness cost rather than a lane failure. Lane S's
147 minutes bought the CI blocker and the JVM leak, which is a fair trade;
the manager's own proposal — cap the e2e lane's runs and report earlier —
is the right correction, since **7 real Forge matches is the floor** for that
lane and floors should be stated before dispatch, not discovered.

## Verified this pass (2026-09-25 — tracker, closing Wave 20)

**Landed `9ce3602..dc48e84`, ten commits, one push.** apps 0.16.0, CI run
`36108056554` green on BOTH jobs. Worktree removed, branch gone. Main has
since moved to `f823837` on two bot dependency bumps, which is what the
13:18Z restart is — not wave work.

**The closing note was three lines** — no per-lane notes, no mutation counts,
no unverified list — so everything below is the tracker's own run, not a
re-reading of prose.

| claim | how it was checked |
| --- | --- |
| the gate | tracker's `pnpm check` at both `dc48e84` and `f823837`: exit 0 |
| the wave's e2e proofs | tracker ran `play.spec.ts` + `table-fit.spec.ts` + `room-mode.spec.ts` at the wave head: **5 passed**, the fit log showing the new grouped rows (`lands 9 | artifacts 2 | creatures 8 | other 1`) |
| **#7 a turn is never auto-passed** | **mutation by the tracker**: removing `isOwnMainPhaseEntry`'s guard → **2 failed / 74**; restored → 76/76 |
| **#4/#6 one legal reply is no question** | **mutation by the tracker**: disabling the single-ability arm → **3 failed / 135**; restored → 138 passed |
| #5 the stack resolves | `auto.test.ts`'s captured-window table decides each real Forge frame: own-main-idle stops, own-main-stack-not-empty passes, both sides of the resolve |
| #3 status pills | `PlayerRow` renders `StatusPill` with shape AND colour (tick/cross/ring) — not colour alone |
| #10/#11 grouping, drag, anchors | `data-board-row` (lands/artifacts/creatures/other), drag on the viewer's own battlefield only, faces at the two ends |
| #12/#8 prompts are cards | the tutor is a grid of `CardTile`s with art ids; the manipulate prompt takes a `DragEvent` |
| #13 the inspector | `play/inspect/` exists with its own tests |
| #2 one theme | **diagnosed live, not guessed**: the chrome resolves its own default from its own store (`'dark'` when nothing loaded) while the page resolved `light` — measured, then removed by passing our theme through |

**#1, the GUID roster, is correctly still open.** watchparty accepted the ask
and their `name` prop has not shipped (`@wolffm/watchparty-ui@0.39.5` here,
no `name` in its `room-chrome.d.ts`), so lane E's one-liner waited exactly as
the wave file instructed. Their contract is settled: precedence is
custom name > our prop > auto identity, absent = no change.

### Found while verifying: CI is flaky in `LiveBoard.test.ts`, and main was red

Run `36140099030` (the bot's bump, `f823837`) failed BOTH jobs on
`expected 'Turn 13' to be 'Turn 14'`. Not a product bug: the same sha passes
on rerun (tracker re-ran it — `check` and `forge-e2e` both success), and the
file passes locally 5+ times including under 3× core load.

The race is real even though it was not reproducible: `liveBoard()` hands
every fixture frame to the socket in one loop and then waits only on the LAST
frame's RENDERED effect, so a slow drain exhausts the `waitFor` window with
the board on an earlier turn. Hardened by waiting on `stats.applied` —
delivery — before asserting what delivery renders.

**Unproven, and stated as such:** the hardening was never observed to fix a
failure, because the failure was never reproduced locally. What would settle
it is time: if `Turn 13` appears again after this, the diagnosis is wrong and
the next look should be at the replay server's send path, not the wait.

### Left over for track R

`fullControl` still absent from the snapshot (a refresh draws the toggle off);
arrow geometry still unverified in a real browser; combat still not driven by
drag anywhere; quest-precon art still excluded.

**Closed while verifying:** `KEY_SERVICE_CARDTABLE` is now seeded
(`gh secret list`, 2026-09-25T16:02Z) — **P4 on the operator's list is done**,
so cardtable's redeploys now report to monitoring instead of warning.

## Verified this pass (2026-09-25 — tracker, closing Wave 19)

**Landed `3c1a052..4899a14`, eight commits, one push.** Deployed tree at
`4899a14`, apps 0.15.0 / forge-wire 0.3.0 / carddata 0.2.0, pm2 restart
23:26:30Z, CI `check` + `forge-e2e` both success.

**Verified by the tracker, from artifacts and by re-running:**

| claim | how |
| --- | --- |
| the gate | tracker's own `pnpm check` at `4899a14`: exit 0 |
| the wave's own e2e proofs | tracker re-ran `play.spec.ts` + `table-fit.spec.ts`: 4 passed, incl. *"the canvas is static as the stack fills"* at both sizes |
| only-Forge-offered clickability | **mutation re-run by the tracker**: restoring the everything-glows fallback → 2 failed / 42; restored → 44/44 |
| Preordain fixed at the origin | `host.ts:370` sets `UI_SELECT_FROM_CARD_DISPLAYS: 'false'` — the wire had carried all 53 library refs (2 manipulable, names did NOT cross: no hidden-info leak), so the fix belongs where the pref is written, not in a component filter |
| every card an art id | `art-ids.json`: 2145 rows, all uuid-shaped, no host or URL anywhere; `d13-gate.sh --self-test` 9/9 |

**The manager re-cut the lanes before dispatch, and was right to:** the wave
file's "#1 is one line" diagnosis was incomplete — `setSelectables` only
arrives from the two selection inputs, so removing the fallback alone would
have shipped a dead board. B gained `forge-wire/**` and `PlayBridge.java`
(from C) and built `setWeaklySelectable`, a real mechanism, where the wave
file assumed a deletion. The lesson for wave files: a diagnosis naming one
line is a hypothesis about the fix's SIZE, not its shape.

**Left over (fold into track R):**

- `fullControl` is not in the match snapshot — a refresh draws the toggle off
  (declared in `match.ts`).
- Arrow geometry unverified in a real browser (jsdom zeroes boxes; snap
  targets asserted, coordinates not). Combat is not driven by drag anywhere.
- Blank art can still appear for quest-precon cards (a no-deck match draws a
  random Forge precon; 12,722 printings deliberately excluded from the table).
  Which room type produced the operator's blank hand is unasked — ask them.

**Landed with the close (same push):** room members are now their display
name, never their id — the edge injects `X-User-Name` (hadoku_site `78667246`,
verified on their origin/main with a green workers deploy) and `callerOf` uses
it, falling back to `'friend'`. The e2e identities carry a name deliberately
unequal to the id so ids-as-names cannot pass again. The operator's
*"come on man. GUIDs for names? hideous."* is the row's reason to exist.

## Streamed rooms, actually driven (2026-09-24 — tracker, after the wave)

**The wave shipped a streamed room that could not work, and every gate was
green.** Nothing had ever driven the feature against a live container: the
allocator's tests run `container.sh` in dry-run, and `room-mode.spec.ts` aborts
`/stream/**` so CI stays green without docker. The first test that let the
probe through (`e2e/streamed-live.spec.ts`, `d6dcfe8`) found three defects
stacked, any one of which made it useless to a person:

| defect | what a player would have seen |
| --- | --- |
| the seat pointed at the container's ROOT, which websockify answers with a **directory listing** — no `noVNC` marker, so the reachability probe said "unreachable" forever | "Waiting for the stream" for ever, on a healthy container |
| `proxyHttp` **spliced sockets** instead of parsing: it wrote the request by hand and piped the upstream socket into `res.socket`, around express. Survives one request on a fresh connection (how the bench is used, and why it looked fine); a browser pulling noVNC's dozen assets over keep-alive got 502 on all of them | a noVNC page whose JavaScript 502s — a black seat, no actionable error |
| the e2e harness shared **production's container namespace**, and every cardtable boot runs `sweepOrphans()`, which kills every container matching its prefix that its own live map does not own | `pnpm e2e` deleting a real player's room mid-match, and production's next restart deleting the test's containers mid-run |

The third was observed, not theorised: a hand-made `cardtable-room-*` container
was gone within two minutes, reclaimed by production's boot sweep after an
unrelated key-swap restart. The prefix is now env-settable and the harness
claims `cardtable-e2e-room-*` on ports 6300+ (`e2e/streamNamespace.ts`).

**Now proven, by two real browsers against real containers:** noVNC reports
`Connected (unencrypted)` and paints a **1280x800** desktop in **both** seats;
the friend gate still answers **404** to an unauthenticated caller *with a live
container behind it* — the moment a tier check is most dangerous; a **builtin
room starts no container at all**; and a `docker ps -a` census either side of
the suite shows the host exactly as it was found. The spec skips itself, with
the reason named, where docker is absent or its socket is not ours.

**Two CI reds fixed on top (`ae8d607`):** the new spec's teardown shelled
`docker` even when both tests had skipped, which reds the claws (docker
installed, socket not permitted) — reproduced with a refusing `docker` stub,
now 2 skipped / exit 0. And `deck.test.ts`'s two heaviest cases have an
explicit 20 s budget: ~0.4 s here, they timed out at the 5 s default on a
contended claw (run `36032980118`) and passed on rerun, so they were reddening
main on changes that cannot touch them. Nothing skipped or weakened.

**Deployed and verified:** `ae8d607`, `/health` 200, and the friend-demo
bench's `vnc.html` **and its JavaScript** both 200 through the fixed proxy —
the bench was served by the same spliced hop, so it benefits too.

**Still unproven, and only the operator can:** a human playing a streamed room
end to end — two people, Forge's own lobby, a real match.

## Verified this pass (2026-09-24 — tracker, closing Wave 18)

**Landed `ab93919..f42be96`, five commits, linear, one push.** `main` and the
served tree both at `f42be96`. Worktree removed, branch `w18` gone, the forge
submodule still registered (` 2ad70eb…`).

**Verified from artifacts, not prose:**

| claim | how it was checked |
| --- | --- |
| gate green | tracker re-ran it at `f42be96` in a detached worktree: **1965 passed / 8 skipped, exit 0** — matches the note exactly (was 1910 before the wave) |
| the real Forge match ran | CI run `35937434745` **jobs**: `forge-e2e` success AND `check` success. The claws job self-skips the Forge specs, so only the hokon job proves the match — it ran |
| the tier gate on the new room-keyed route | **mutation-tested by the tracker**: neutering `passesFloor`'s comparison → **3 failed / 22 passed**; restored → **25 passed** |
| deploy is completion | served tree `/home/hadoku/repos/hadoku-cardtable` at `f42be96`, both packages `0.13.0`, `dist/index.js` rebuilt 00:14:10Z carrying `clientMode` (14×) and `cardtable-room` (3×), `container.sh` shipped `-rwxr-xr-x`, `/health` 200 `bundle: ok`, and production's own log line reports both forms live: `"evt":"stream-attached","streams":2,"rooms":true` |
| the friend demo survived | `cardtable-lab-0/1` up 2 days across the whole wave, `STREAMS`=2, both `vnc.html` 200, and a raw upgrade to `/stream/0/websockify` still answers the gate's `404` |
| the wave created no containers | `docker ps -aq` census either side of the tracker's full gate run: 9 before, 9 after, no diff. The allocator's tests drive `container.sh` in `CARDTABLE_STREAM_DRY_RUN` mode |

### Found: an e2e can start real containers on this host — OPEN, and it never reached the closing note

A sub-agent recorded this in project memory mid-wave; the manager's report does
not mention it, so it is recorded here as the board's item.
`stream/alloc.ts`'s `findContainerScript()` resolves `scripts/stream/container.sh`
by walking up from `apps/server/dist/`, so the allocator is **live under the e2e
harness**, and `e2e/harness.ts` sets no `CARDTABLE_STREAM_DRY_RUN`. A GET of
`/stream/<roomKey>/<seat>/` for a streamed room would therefore `docker run` a
real ~1.25 GiB container **on the machine that also runs production and the
bench**.

Nothing does that today: `e2e/room-mode.spec.ts` aborts `**/stream/**` in the
browser. **The guard is in the spec, not the harness** — so it protects exactly
one test, and the next streamed-room e2e walks into it.

**Settles it:** add `CARDTABLE_STREAM_DRY_RUN: '1'` to `e2e/harness.ts`'s spawn
env, then confirm with a `docker ps -a` census either side of `pnpm e2e` — and
check what the route answers under dry-run, since the allocation then succeeds
with no container behind it. Untested as of w18. Small enough to fold into the
next wave.

### Two wave-file bugs, both the tracker's

Recorded because the lane-cutting rule is the thing that keeps parallel lanes
safe, and it failed twice in one wave even after a mechanical re-cut:

1. **§B told lane B to use `onRoomDelete`, which was not reachable from B's
   files.** The re-cut had already removed the A→B seam and pointed B at
   `lobby`/`draftRooms` in its own `index.ts`; §B's prose kept a stale
   instruction the file list did not support.
2. **`apps/ui/package.json` was in no lane's row.** C and D both changed
   `apps/ui`, so the version bump belonged to neither; the manager took it
   itself (`f42be96`) rather than widening a lane — the right call.

**Rule for the next wave file:** intersecting the lane lists is not enough.
Every *instruction* in a lane's brief must name only files in that lane's row —
check the prose against the row, not just row against row. And **every
package.json a wave will bump needs an owner**, named in the table.

### The handoff named the wrong deploy tree — corrected

The handoff sent the manager to
`/home/hadoku/actions-runner-hadoku-cardtable/_work/…` as "the deployed tree".
That is the **CI runner's workspace**. Production serves from the main checkout,
`/home/hadoku/repos/hadoku-cardtable` — confirmed authoritatively from the
running process: the node listening on 9008 has cwd
`…/repos/hadoku-cardtable/apps/server` and runs that tree's `dist/index.js`.
The manager ignored the handoff and verified the right tree. The existing
memory note already said this; the handoff contradicted it.

## Verified this pass (2026-09-21 — tracker, closing Wave 16)

Landed `1a4081b..0117283`. `forge/` pristine. Gate re-run here: `pnpm check`
exit 0, **1,871 passing / 7 skipped** (baseline 1,855). CI green on `0117283`.

### The latency argument that decided the route has evaporated

The operator chose CheerpJ on *"saves us ~150ms"*. That came from a **49.5 ms
floor** — one Swing component, which Wave 15 itself labelled *"an upper bound
on Forge, never a prediction of it"*.

Lane B measured real Forge: **146.7 ms median** to canvas, 163.8 ms composited,
n = 117 over three cold boots on a quiet host (load 2.3–3.9), p95 209.5.
**Three times the floor.**

Against streamed Forge's real UI measured the same way in a browser — 46.9 ms —
CheerpJ is now **~100 ms slower locally**, and the crossover is exact:

| player RTT | streamed (46.9 + 2×RTT) | CheerpJ (146.7, no RTT) | faster |
| --- | --- | --- | --- |
| 10 ms | 66.9 ms | 146.7 ms | **streaming** |
| 25 ms | 96.9 ms | 146.7 ms | **streaming** |
| **50 ms** | **146.9 ms** | **146.7 ms** | **dead even** |
| 100 ms | 246.9 ms | 146.7 ms | **CheerpJ** |

**Friends on the same continent would find streaming snappier.** This is an
operator decision to re-take, and the tracker flagged it rather than letting a
route ride on a number that moved.

**What has NOT changed is the reason the operator gave FIRST**, and it is the
stronger one: streaming bypasses the watchparty netcode — the objection that
killed "friends run Forge desktop" — and spends 1.26 GiB plus half a core of
**our** host per player, against 1.43 GiB in the player's own tab.

### Lane B's real finding is not the number

**Clicking a card in Forge's hand changes exactly zero pixels** — measured six
times by full-canvas diff across three boots. Forge's Card Detail and Card
Picture panels are driven by **mouse-over**. So the measured event is the
pointer *arriving*, not the button going down.

Which means **a press→pixel figure for a card in hand does not exist**, and
every refusal Wave 15 recorded under "THE NUMBER WAS NOT TAKEN" was the rig
correctly declining to invent one. A lane that had wanted a number could have
produced one by watching the wrong region and never known.

### Lane A's result is a negative, and it is worth more than a pass

20/20 cold boots now reach the home screen. But the lane **killed its own
theory**: the stall is not an IndexedDB quota — it is inside CheerpJ, upstream
of IndexedDB. And it said plainly that **its own mutation test had no power**,
naming the 175-unpack experiment that would settle it.

A lane reporting "my evidence does not support my fix as strongly as it looks"
is the behaviour this project has been short of, given its history with checks
that cannot fail.

### Found: CI has NEVER run the Forge match e2e

`play.spec.ts:411` is `test.skip(!forge.ok, …)`, and **`.github/workflows/ci.yml`
sets no `CARDTABLE_FORGE_JAR`** (verified — no mention anywhere in the file). So
green CI is **3 of 4** e2e tests, and the one it skips is the only test that
exercises a real child JVM.

Pre-existing, announced rather than silent, and **the tracker has been quoting
"CI green" across many waves without knowing it.** Now in memory as
`ci-skips-the-forge-e2e`.

### The wave file had a bug, and it was the tracker's

The manager re-cut `apps/server/package.json` from lane C to lane D before
dispatch, because D's 0.39.4 upgrade could not typecheck without it. **Correct,
and the tracker's error**: the lane file lists were intersected for *overlap*
and came back clean, but intersection cannot catch a file a lane **needs and
was not given**. Both checks are required; only one was run.

### Protocol deviations, both disclosed and both right

- **Sub-agents did not commit.** Four agents racing HEAD on one branch is worse
  than the protocol's letter; the manager committed each lane after verifying
  it.
- **Run data was moved out of `~/.cache`** into `boot/out/` and
  `firstpaint/out/` with derived TSVs — *"the wave's two numbers should not live
  only in a directory named cache."* Agreed, and it is why this close could
  check them.

### Still open

- **Starting a purely local game builds a Netty server, and epoll is not
  there.** One more patch; the blocker was not previously known to be on that
  path.
- Lane A's 175-unpack experiment, to give its fix real evidence.
- CI's missing Forge e2e.

## Verified this pass (2026-09-20 — tracker, closing Wave 15)

**Forge's real match UI paints in a browser.** The tracker opened
`~/.cache/w15d-firstpaint/shots/measure-hand.png` and confirmed it: Forge's own
desktop chrome, two battlefields at 20 life, a seven-card hand with card art
(Satyr Wayfinder, Returned Centaur ×2, Swamp, Forest), the Prompt panel reading
*"Ault, you are going first!"* with live **Keep / Mulligan** buttons. Reached by
**four small patches over stock Forge**.

`forge/` pristine (`2ad70eb4`, unchanged). Gate re-run here: `pnpm check`
exit 0, **1,855 passing / 7 skipped**.

### The number the operator asked for does not exist, and the manager said so

§0 required *"a click-to-pixel figure taken the same way streaming's was"*. It
was not produced, because a boot-reliability bug in the `res/` unpack fails
about half of runs. **The manager reported that plainly rather than inventing a
figure**, which is the right call and the reason the rest of this is worth
trusting.

### The tracker's own 65 ms was wrong, and the tracker propagated it

`docs/spikes/streaming.md`'s headline — *"65 ms of click-to-pixel on this
host"* — is **~50 ms of deliberate harness button-hold plus ~13.6 ms of real
work**. `rfb-latency.py` holds the button 50 ms and starts its clock at the
press; a browser acts on the press, so **a real player never pays that 50 ms**.

Independently reproduced by lane D. **The tracker quoted 65 ms as streaming's
bar repeatedly across Wave 14 and Wave 15 planning**, including in the wave file
that set this lane's gate. The comparison it implied — CheerpJ needing to beat
65 ms — was never the right test.

`streaming.md` is owned by no lane and **still carries the uncorrected
headline**. Fixing it is a tracker action, not a lane's.

### The real comparison, at the player's screen

| | streamed Forge | Forge under CheerpJ |
| --- | --- | --- |
| event→pixel, composited | 49.7 ms (real Forge) | 49.5 ms (**a floor** — one component, so real Forge is slower) |
| per cold cache | 0 | **19.19 MB** from a third party we cannot self-host |
| memory | **1.26 GiB on OUR host, per player** | **1.43 GiB in the PLAYER's tab** |
| the player's network | **2 × RTT on every click** — up with the click, back with the pixels. ~150–200 ms over the internet | **0** for anything the UI answers locally; 1 × RTT + ~6 ms only when game state moves |

**Latency does not decide this.** On loopback they are level; over the internet
the asymmetry is enormous and runs CheerpJ's way, because streaming pays an RTT
on *every click* while CheerpJ pays one only when the game state actually moves.

**What decides it is cost and risk.** Streaming spends 1.26 GiB and half a core
of *our* host per player and gives up the room layer entirely. CheerpJ spends a
**1.43 GiB browser tab**, a 19.19 MB third-party download, and ~12 s of boot —
with no fallback if `cjrtnc.leaningtech.com` goes away. The 1.43 GiB is new and
is a real ask of a laptop; it belongs in front of the operator beside the
download.

### Two debts this wave created

1. **Lane C's endpoint is landed, tested and UNREACHABLE.** Verified:
   `apps/server/src/play/browser/` exists with its own tests, and nothing in
   `apps/server/src/index.ts` references it. Two lines in a file no lane owned.
   Correct protocol, real debt — and a browser client cannot reach the server
   until it lands.
2. **`streaming.md` still says 65 ms.** Above.

### What this changes about the route

Wave 14 called CheerpJ *GO-WITH-COST* gated on an unrun probe. Wave 15 leaves it
**not a research risk** — an engineering cost with a known shape. The remaining
blocker is not latency and not architecture: it is that the `res/` unpack fails
about half the time on boot.

## SCHEDULED — the wave AFTER the game client: `templates/game` adoption

**Operator decision, 2026-09-20:** *"lets make sure that we work through their
new template after we're done testing the inner functionality. make sure thats
recorded as the objective for the next wave, after we're done with the game
client itself."*

So the order is settled and is not a judgement call for a later session:

1. **Now — the game client.** The browser-side Forge route: CheerpJ's transport
   (lane B item 1, unblocked by the natives probe), and/or the remaining
   `forge-gui-mobile` cuts. Prove the inner functionality works.
2. **Then — this.** Adopt hadoku_site's `templates/game` outer shell and
   **delete our own wrapper code in favour of it.** The operator's framing:
   *"we will need to take this seriously and remove all our custom outside
   wrapper code for it instead."*

That ordering is deliberate. The template is the shell; the client is what goes
inside it. Adopting the shell first would mean re-doing the adoption around
whatever the client turns out to need — and the client is the part that is
still unproven.

**Scope note for whoever runs it:** the operator said *remove* our custom
wrapper code, not wrap the template around it. The four deletions below are the
floor, not the ceiling — `apps/ui/src/chrome/**` (Wave 14 lane D, written by
hand because no template existed yet) is a candidate too, and should be checked
against what the template ships rather than kept by default.

Source:
`/home/hadoku/srv/hadoku_site/docs/requests/CARDTABLE_GAME_TEMPLATE_ADOPTION.md`.
Recorded with what the tracker verified independently, because every line
reference in it checks out.

**Their headline: we do not hydrate the template.** *"You already are it,
written by hand, a version behind."* Re-hydrating would scaffold a fresh app
next to a repo carrying a draft engine, a JVM bridge and a forge vendor tree.
They are explicitly not proposing it, and are not asking for a timeline.

### A security finding about OUR production, which they fixed

`injectUserId` was not only how the server learns who is calling. It is **the
only thing that strips a client-supplied `X-User-Id`** — `proxyRequest` deletes
that header inside `if (injectUserId)` and nowhere else. Verified in their
source (`workers/edge-router/src/proxy.ts:272-273`).

So before 2026-09-19 the edge forwarded whatever `X-User-Id` a caller invented,
**under a valid `X-Edge-Auth` seal telling our server to believe it**. Anyone
who could reach `hadoku.me/cardtable` could assert another player's identity.
The `anon` display name we reported was the mild, visible half of the same bug.

`injectUserId: true` is now on the cardtable mount
(`edge-router/src/index.ts:1577`, verified). **Live confirmation still
outstanding** — the server log's last entries predate their deploy and the
tracker cannot mint an authenticated request; the next real page load settles
it. Rooms already persisted with `anon` keep it; nothing backfills.

### UPDATED 2026-09-20 — target is **0.39.4**, and two new items

hadoku_site revised the doc mid-w15. The tracker checked all three against our
code: **none of it changes Wave 15**, which is the CheerpJ client and does not
touch the room layer. All three are for the w16 adoption.

**1. Go to 0.39.4**, not 0.39.3.

**2. `seatRows` — we do NOT have this bug, and the reason matters.** Their
warning is that a screen drawing a pod's seats from `room.seats` renders
arrivals rather than pod size, so a four-seat room with two players shows two
rows. Ours come from the engine: `packages/draft/src/view.ts:54` is
`Array.from({ length: state.seatCount }, …)`, with `capacity` carried
separately, so a pod of 8 always renders 8.

**The interaction to watch in w16:** their deletion #2 asks us to drop
`room.seats = state.table` (`draftRooms.ts:230`) in favour of `RoomRegistry`'s
seat-table factory. That aliasing is *precisely* what keeps our seating
full-size and single-sourced — `draftRooms.ts:14-21` explains why two tables
would be two answers to "which seat is Alice in". Taking the deletion without
routing the engine's table through the factory would introduce the very bug
`seatRows` warns about. **Do the deletion and the `seatRows` adoption
together, or neither.**

**3. `onRoomDelete` — only bites once we start deleting rooms, which we
deliberately do not.** `draftRooms.ts:79-86` records the decision: `collectGC`
reaps a room whose `clients.size` is 0, which for a forty-five-minute draft is
every room the moment a blip lands on the last connected player. So rooms live
for the life of the process — *"a slow leak and a much smaller one than
destroying a game in progress."*

What we would leak **if** w16 enables GC: the `vacating` timers
(`draftRooms.ts:130`, `:407`) and, for play rooms, the match's JVM handle.
`onRoomDelete` is the hook for exactly that. So the order in w16 is: adopt the
hook **first**, then consider enabling GC — never the reverse, and the
"no GC" decision should be re-taken explicitly rather than inherited by
accident from a package default.

### Four deletions, gated on upgrading 0.38.115 → **0.39.4**

All three packages are published at **0.39.3** (checked). **All four targets
exist at the lines they name** (checked):

| our file | delete | replaced by |
| --- | --- | --- |
| `room/draftRooms.ts:378` | the re-seat guard `seatParticipant(room.seats, …)` | `leaveRoom` now drops the client first |
| `room/draftRooms.ts:230` | `room.seats = state.table` | `RoomRegistry`'s seat-table factory |
| `room/identity.ts:35` | the whole `createHash` digest | `createParticipantIdDeriver(domain)` |
| `room/identity.ts:132` | `participantHandle` | `@wolffm/rooms-protocol` |

**They adopted our domain scheme** — `hadoku.cardtable.participant.v1` produces
the same ids, so this is a cleanup, not a re-identification. Two shapes changed
and will not typecheck silently: the deriver returns `{ id, tier }`, not a bare
id; and per-tier separation is enforced inside the package, so there is nowhere
to pass a second domain string.

### The trap in it, which this project has now hit six times

> *"Whatever currently pins your re-seat guard now passes because the PACKAGE
> does it. That reads as coverage and is not."*

**A test that goes quiet rather than red.** It is only observable with **both**
`seatHoldMs: 0` and `disconnectGraceMs: 0`, where a seat is empty, unreserved,
and the next arrival takes it while its owner is still connected on another
tab. Under shipped defaults the grace and the reservation each hide it.

**Re-aim that test; do not delete it.** Their
`templates/game/apps/server/test/rooms.test.ts` runs a second server configured
that way for exactly this.

### Do NOT delete our disconnect grace

Watchparty deliberately did not take it and they were right: it covers the
other ordering — a refresh drops the old socket ~36 ms **before** the new one
joins, so there is nothing live to find at close time. That is Wave 11's own
finding, independently arrived at. If it ever goes upstream they would take the
API from ours rather than invent a second.

### They guessed we share the `sendFile` trap. Half right — and their fix is better

`res.sendFile(absolutePath)` 404s from any dot-directory, because `send`
applies its dotfiles rule to the whole path. We **found this in Wave 11** and
**detected** it: `checkBundle` mounts the real `sendIndex` on a throwaway
loopback server and `/health` says `degraded` if it 404s
(`apps/server/src/base-path.ts:18-36`).

Detecting is not fixing. Their one-liner —
`res.sendFile('index.html', { root: CONFIG.webDir })` — makes the app **work**
from a worktree instead of honestly reporting that it cannot. Worth taking.

### Shared fate we did not have before

`MAX_EPHEMERAL_ROOMS` (800) is now **one pool across every namespace**, so a
second game app shares it with our draft rooms. Measured headroom is 1600 rooms
/ 6400 sockets at 10% of a core, and a per-namespace cap is on offer if a draft
night ever meets a runaway neighbour. Also: `EPHEMERAL_ROOM_NAMESPACES`
**replaces** the default, so `cardtable` must stay in the list when the next app
is added — their wrapper now states it explicitly rather than relying on the
default.

## Verified this pass (2026-09-20 — tracker, closing Wave 14)

Landed `b597510..1aaf108`. **`forge/` is pristine** — submodule unchanged, no
`target/` dirs, D2 holds. **The three spikes changed zero product code**, which
I checked by diffing `apps/` and `packages/` across each: empty. Gate re-run
here: `pnpm check` exit 0, 1,841 passing.

### The answer to the question the wave asked

| lane | verdict | the number that carries it |
| --- | --- | --- |
| A — TeaVM on the client | **NO-GO**, but not where D7 died | the **view layer links clean: 0 missing APIs, a 493 KB artifact** |
| B — CheerpJ | **GO-WITH-COST** — contingent | the whole GO rests on one probe **never exercised** |
| C — streaming | **WORKS** | 1.26 GiB, 0.5 core, ~1 Mbit/s, **65 ms click-to-pixel** |

**Lane A is the important result and "NO-GO" undersells it.** D7 could not
produce an artifact at all. Lane A produced a real 493 KB one for
`GameView`/`CardView`/`PlayerView`/`Tracker` and the 214-property
`TrackableProperty` — **the half that is actually on the wire** — with zero
missing APIs on both WASM GC and JS. `java.util.concurrent.locks`, D7's killer,
is **not** on the client's path except through a dev-mode snapshot that is dead
when `GameView.getGame()` is null and a quest-draft bracket behind the win/lose
screen. Forge's outbound half costs 3 APIs, none of them `java.util.concurrent`.

What actually blocks it: `forge-gui-mobile` is a whole product — quest,
adventure, gauntlet, deck editor, a server-hosting singleton — reachable in a
few hops from the match screen, and TeaVM's whole-program analysis links all of
it. Cutting **eight named edges** takes 53 missing APIs → **11**, measured, and
removes `forge.game.Game` from every chain. The lane's own caveat, inherited
correctly from D7: *fixing all 53 only gets you to the next link error*, because
these entry points call each protocol method once with null arguments.

**Lane B corrected my brief.** I wrote *"targets `forge-gui-desktop`
essentially unmodified"*; it does not — the stock jar boots, reaches
`SplashFrame`, and dies on networking and the filesystem, both needing fork
changes. The verdict is GO-WITH-COST because all three fixes are local and
named to the line, not research. **But its own "NOT verified" section says the
entire GO depends on CheerpJ's `natives` JS-interop path, which was never
exercised.** That is not a GO yet; it is a GO gated on one afternoon's probe.

**Lane C built the thing.** A real Magic match, real Forge UI, card art and
all, rendering in Chrome — for less RAM than a browser tab and 65 ms of
click-to-pixel measured on this host. And it is still the wrong default for the
reason the operator already gave: the match stops travelling through our
netcode, which reduces the watchparty room layer to chat around a video feed.
The lane says so itself rather than selling it.

### Lane D shipped, correctly — and with no tests

`HadokuThemeRoot` + `AppHeader`, no local theme hook (the template's
capitalised rule, honoured). 450 lines of product code and **zero test files**;
`AppChrome` has no test at all.

**That is a flaw in the wave file, not the lane.** §D's done-when asked that
"the theme picker works and persists across a reload" without demanding a test
that proves it, so the lane met the letter. The claim that persistence works is
currently unverified by anything that runs.

### Found: `@wolffm/themes@5.8.5` calls `matchMedia` unguarded

`prefersDark()` guards it; the effect that follows the OS light/dark switch does
not — `dist/useTheme.js:216` is a bare
`window.matchMedia('(prefers-color-scheme: dark)')` inside a `useEffect`. jsdom
has never implemented it, so mounting `AppChrome` threw in **26** existing
tests. Lane D shipped a feature-detected polyfill
(`apps/ui/src/chrome/matchMedia.ts`) and documented it as upstream's bug. It is
not a test-only concern: any embedder without the API takes the same throw in a
real browser. **Worth reporting to the themes owner.**

### CI has been QUEUED for 15 minutes, and the host is why

Load average **44.51 on 12 cores** — a manually started
`dataplatform.cli media perceptual --workers 4` is saturating hokon, which is
also the CI runner. The manager reported one unreproducible e2e red (a Forge
match spec blowing a 300 s wall-clock budget at turn 4, then passing three times
at ~38 s under higher load) and blamed this. **The load corroborates it**, and
`e2e/**` is byte-identical to what was green, so no lane introduced it. The
tracker has NOT re-run `pnpm e2e` for the same reason — a timing-budgeted test
on a 3.7× oversubscribed host measures the host.

## Previously verified (2026-09-19 — tracker, closing Wave 13)

Landed in one push, `e08bb68..06006f4`. Gate re-run by the tracker: **1,836
passed / 6 skipped**, exit 0 — up from 1,775. Deploy tree at `06006f4`, PM2
restarted **after** the install (21:57:36.675Z start, 21:57:36.803Z complete),
warm JVM at 6.5 s, `/health` healthy. `/api/rooms` answers **404 to anon**, so
the friend gate bites on the new surface.

| lane | commit | verdict |
| --- | --- | --- |
| A | `9577740` | rooms, list, passwords — **mutation-tested by the tracker** |
| B | `2c4a253` | front page is the room list |
| C | `d6396de` + `d0d07d8` | in-room 1v1 — **the old two-deck path is closed, verified** |
| D | `8cda565` + `9a784f8` | basics exempt — **mutation-tested by the tracker** |
| E | `06006f4` | **unplanned lane**, see below |
| wave | `509b086`, `8c089bc` | the files no lane owned |

### Lane D — the bug that made the draft half unplayable

Mutation-tested here, not accepted: neutering `splitBasicLands` in `gate.ts`
fails **5** tests, restored 77 pass. The five names show the edges were
actually thought about, not just the happy path:

- *is legal with 17 Islands, and the text checked is the text sent*
- *still refuses a non-basic the caller did not draft, by name*
- **exempts only Forge's five: an undrafted land outside them is pool-checked**
- *does not let the lands count twice or vanish: 23 + 17 Islands is 40*
- *still refuses a non-basic in the basics pile*

The third is the one that matters. A blanket "lands are fine" would have let a
Celestial Colonnade ride in as a land; the exemption is `isBasicLand` —
Forge's own five from `MagicColor.java:138` — and no second list.

### Lane A — the password is built as privacy, as specified

scrypt with a per-room random salt, `timingSafeEqual`, and the salt and hash in
a **private map off the room record**, so a room cannot be serialised with its
secret by accident.

Mutation-tested: changing the wrong-password response from 404 to 403 fails
**4** tests, including *"answers a wrong password and a missing room with the
SAME bytes"* — the anti-enumeration property. There is also a test that greps
the captured **log**, not just the body, for the password, its hash and its
salt.

### Lane C — the shape the operator rejected is actually closed

`routes.ts:622`: a body naming two decks with `opponent: 'human'` gets **422**
with *"a match against a person starts from a room"*, and `h.specs` is empty so
Forge never launches. The AI arm stays, correctly — the AI's deck is nobody
else's choice. The test notes the default opponent is `'human'`, so the shape
is closed even when the field is omitted.

The manager removed the deck builder's "against a friend" radio in the wave
commit, out of lane, and was right to: C's gate now refuses exactly that body,
so leaving the control would have shipped a button that returns 422.

### Protocol deviations, both disclosed, both acceptable

1. **Sub-agents did not commit.** The manager committed every lane itself via a
   per-lane temp `GIT_INDEX_FILE`, because the tracker's handoff prompt told it
   to commit each lane. That contradicts the wave file, which says implementers
   commit. **The handoff prompt was the tracker's error, not the manager's.**
   It verified each lane's commit in isolation in a throwaway worktree, which
   is a stronger check than the shared tree gives.
2. **One red intermediate commit.** `2c4a253` (B) alone reds a `constructed.test.ts`
   case that is lane C's file, fixed by C's next commit. Disclosed **in B's own
   commit message**, which is where a bisector meets it. Cost is a bisect
   landing on one red commit; the alternative was ordering B after C for a test
   neither wholly owns.

### Lane E was not in the wave file

`06006f4` rewrites `e2e/play.spec.ts` (+444) and `harness.ts` so the play e2e
starts **from a room**, each friend loading their own deck. `e2e/**` was listed
as owned by NOBODY, so this is an unowned-file edit rather than a lane
collision, and it is the right work — without it the browser suite would still
drive the flow the wave deleted. **Recorded because the tracker did not plan
it**, and an unplanned fifth lane is the kind of thing that is fine once and a
process problem if it becomes normal.

### Found: room persistence lives INSIDE the clone (new, low, latent)

`index.ts:238` resolves the store to `apps/server/data/rooms`. It survives a
deploy today — `data/` is gitignored (`.gitignore:24`) and the deploy runs
`git reset --hard` but **no `git clean -fdx`**, and reset leaves gitignored
files alone. Verified in hadoku_site's `deploy-executor.ts`.

It is still fragile, and it contradicts the pattern this fleet already settled:
the Forge jar was deliberately put at `~/.local/share/cardtable/` because, in
hadoku_site's words, *"it sits outside the clone, so no deploy's stash or reset
can touch it."* Rooms and their passwords now depend on nobody ever adding a
`git clean` to a deploy step — a completely ordinary thing to add. Moving it
under `~/.local/share/cardtable/rooms` is a one-line change to the same
`CARDTABLE_ROOMS_DIR` default that already exists.

## Previously verified (2026-09-19 — tracker, the match-hang bug)

**Every production match hung at Turn 0, and the browser suite was green
throughout.** The operator found it by trying to play: both seats claimed, an
empty table, nothing to click.

### The bug

Forge opens a match with `showPromptMessage` + `updateButtons` — the coin toss.
Neither is a blocking `ask`: no `callId`, no reply schema, nothing for
`currentAsk` to return. `LiveBoard` drew only `asks`, so there was nothing on
the page to answer with, and Forge parks forever waiting. `Turn 0 / hand 0 /
library 60` was the CORRECT state: the toss happens before opening hands are
dealt, so the board was right about everything except the one thing you could
act on.

**The server was never at fault.** `match.ts` already stored both frames per
seat and `resendAfterSnapshot` replayed them on join. The client folded them
into the state channel and drew nothing. Diagnosed from Forge's own stderr in
the live run dir (`GuiGameEvent 12: updateButtons`, `13: showPromptMessage`)
against a seat whose browser rendered neither.

Fixed in `LiveBoard` + `live/match.ts` (`8137132`): `LiveMatch` carries
`prompt`/`buttons`, `pressButton` sends the act, a disabled button refuses the
click, and pressing one disables the bar until Forge sends a fresh one —
otherwise a stale bar answers the NEXT question, which is worse than drawing
nothing.

### The seventh green gate that did nothing — and this one was load-bearing

`e2e/play/hands.ts` opens a second socket per friend to press these buttons.
Its own header says so: *"TEST SCAFFOLDING for a product gap: the buttons the
board does not have"*. The spec recorded the gap as `uiAloneAtStart` —
`controlsOnPage 0, promptOnPage 0, turnOnPage "Turn 0"` — which is a precise
description of the operator's screenshot, written by our own suite, and passed
anyway.

**The tracker reported that suite as "two friends play one Forge match" and
told the operator production was ready. That was wrong**, and it was wrong
because "4 passed" was read instead of what the test did.

`e89a78c` fixes the test: whichever seat holds the ENABLED bar must answer by
clicking its own page, and the click must move the game (Forge deals opening
hands only once the toss is answered, so a library still at 60 means nothing
happened). Which seat wins the toss varies by seed — bob on one run, alice on
the next — so it finds the decider rather than assuming.

Mutation-tested against a real Forge, both directions:

| board | result |
| --- | --- |
| pre-fix | **FAILS** — *"neither board drew Forge's button bar — the match cannot be started by a human"* |
| restored | passes — *"alice answered the opening prompt on their own board"*, 1 passed (32.8s) |

`controlsOnPage` moved **0 → 2**.

### A third instance of the same shape, in the tracker's own verification

The first mutation run **passed** with the broken board. Cause:
`VAR=x cmd1 && cmd2` exports to `cmd1` only, so Playwright ran without
`CARDTABLE_FORGE_JAR`, **skipped** the test, and exited 0. A skip reads as a
pass. Three instances in one session — the scaffolding, `| head; echo $?`, and
this — all of them a green signal proving nothing.

### Still open: the board cannot click CARDS

`hands.ts` remains, narrowed to what it is still needed for. A human can now
start a match and answer prompts; they **cannot play a land or cast a spell**
through the UI. Nothing covers that for a human, and it is the next lane —
the last thing between the operator and an actual game.

### Not verified: production itself

The fix is verified against the BUILT BUNDLE of the deployed commit, in two
real Chromium contexts. The Chrome extension is not connected, so the tracker
could not drive an authenticated production session. That is strictly less than
a production test and is not being reported as one.

## Previously verified (2026-09-19 — tracker, closing Wave 12)

Landed in one push, `8ec31f6..481875e`. Deployed tree carries it, PM2 restarted
**after** the install (`Starting PM2 service: cardtable` 00:16:33.839Z, deploy
complete 00:16:33.917Z), friend gate still 401 anonymous, play healthy
(`spare-warm bootMs:3537`). Gate re-run by the tracker: **1,773 passed / 5
skipped**, exit 0 — matching the manager's number exactly.

| lane | commit | verdict |
| --- | --- | --- |
| Step 0 | `bc54f99` | rooms 0.38.111 → **0.38.115** in all six `package.json`, re-checked by grep |
| A | `12fefad` | four eras, 6 decks each — **verified, mutation-tested by the tracker** |
| B | `481875e` | builder works; drafted decks with basics blocked by a **server bug** — confirmed in code and at runtime |
| C | `0f19af4` | run dirs bounded — **verified live and mutation-tested by the tracker** |
| D | `d40f92a` | settled "cannot" — **central claim re-derived from the tarball independently** |

### The window now has a collection in all six eras

49 decks across 8 collections. New: SCG Orlando 2011-05-14 (NPH), SCG Richmond
2011-08-14 (M12), SCG Indianapolis 2012-06-16 (AVR), SCG Kansas City 2012-08-11
(M13) — 6 decks each, five colours per era, one deck per archetype label rather
than a Top 8 full of Caw-Blade and Delver mirrors. SCG Opens over GPs because
the GP Top 8s failed the five-colour rule.

**Mutation-tested by the tracker, not accepted:** swapped `Augur of Bolas|M13`
for `Sphinx's Revelation|RTR` (a set *after* that era) in Prokop's UW Delver →
**1 failed / 229 passed**, naming
`scg-kansas-city-2012-1-mike-prokop is legal in its own era's frozen pool`.
Restored → **230 passed**. The pool genuinely bites.

### Lane B found a real bug and correctly refused to fix it

**A drafted deck with basic lands cannot be played.** The builder works, a
drafted deck reaches Forge, and a match was created (`m-f90d2b408dad`, 201) —
but only with **zero basics**. Add 17 Islands and the server refuses with
*"plays 17x Island but drafted 0"*.

The tracker confirmed the mechanism by execution, not by reading:
`deckFromDeckFile` returns `basics: []` and leaves the Islands in `main`
(printed directly), `poolOf` is `main + sideboard`, and the draft arm
(`gate.ts:346`) compares that whole thing against the drafted pool.
`deckIssues` has **no** basic-land exemption on the pool arm — it only checks
`deck.basics` for *"is in the basics pile but is not a basic land"*, and that
pile is always empty on this path.

**The fix is already in the repo**: `isBasicLand` / `BASIC_LAND_NAMES`
(`deck.ts:119`, `:40`). Split basics out of `main` before `deckIssues` in the
draft arm. It sits in `apps/server/src/http/**`, which **no lane owned this
wave**, so declining it was right — a lane that reached outside its files would
have been the worse outcome. **First item of Wave 13.**

### Incident: a test server swept production's run directory

Lane C's new boot sweep is correct. Lane B started a test server **without**
`CARDTABLE_PLAY_WORK_DIR`, so it defaulted to production's
`/tmp/cardtable-play` and removed **173 dead directories**. The live-process
guard held and production's running JVM was untouched, which is the part that
matters — but **old crash diagnostics among those 173 are gone**.

The cause is a default that points at production, not a bug in the sweep. The
manager had B restart with the var set and saved
`dev-servers-need-play-work-dir` to memory so future waves brief it. Worth a
stronger fix than a memory: a dev server that boot-sweeps a directory it did
not create is a footgun with one safe configuration and no warning.

### Lane C, mutation-tested by the tracker

Disabled the clean-end `rmSync` (`host.ts:619`) → **2 failed / 12 passed**;
restored → **14/14**. One of the two names its own hazard:
*"a finished match's directory is gone — and Forge's res behind its symlink is
untouched"*. A recursive delete that followed that symlink would have eaten the
vendored Forge resources.

Live: production's `/tmp/cardtable-play` holds **1** directory (its own spare),
down from 174, and the boot sweep logged
`run-dirs-swept … removed:2 crashRecordsRemoved:0`.

### Lane D — re-derived independently, and it is worse than "no types"

The tracker re-packed `@wolffm/watchparty-ui@0.38.115` and checked the tarball
without reading the lane's numbers first: **0 `.d.ts`**, no `exports` map, no
`peerDependencies` — and `types` is set to `./dist/index.d.ts`, **a file the
tarball does not contain**. The package advertises types it does not ship,
which is a packaging bug on their side, not a preference of ours.

The 34 `data:image/png` URIs are confirmed and the tracker's own first count of
68 was the sloppy one — 34 in the `.js` that ships, 34 more in sourcemaps. The
three chunks named (`cover`, `GameModule`, `MapEditor`) are right.

`docs/requests/WATCHPARTY_ROOM_CHROME.md` asks for `RoomChrome` on
`@wolffm/watchparty-ui/room-chrome`, contracts C1–C10, target **0.39.0**. It is
written and **not sent** — sending is the tracker's call, and it is an operator
decision because it commits us to a dependency. **See O9.**

### Corrections the tracker owes

**The AI-attribution trailers were mine and they were wrong.** `AGENTS.md`
forbids them, the harness reminder that supplies them explicitly yields to the
user's own instructions, and `git-identity-and-attribution` was already in
memory saying so. Three pushed commits carry them — `367f963`, `41878d6`,
`8ec31f6` — and the manager was right to rebuild the unpushed `cfa4e76` as
`ccf6aef` without them. Not rewriting pushed history unasked; stopping.

## Previously verified (2026-09-18 — tracker, closing Wave 11 from artifacts)

**The w11 worktree, branch and directory are all gone, and the closing notes
were never pasted.** That cost nothing. The protocol's own rule is that the
commits, the gates and the deployed tree *are* the report and the prose never
was — so this close is built entirely from artifacts I re-ran myself.

All four lanes landed on `main`, and **every lane stayed inside its declared
files** (checked with `git show --name-only` per commit):

| lane | commit | done-when | verdict |
| --- | --- | --- | --- |
| A | `fe17cfd` | resyncs proportional to genuine gaps, before/after both quoted | **met — and better than the target.** See below |
| B | `0100177` | two contexts play a real match, prompts answered from both seats | **met.** `play.spec.ts` passes in 35.6 s |
| C | `ce9fe9c` | the guard's status settled and stated; flicker fixed or explained | **met**, and honestly — see below |
| D | `debd2c2` | a constructed match starts from the UI with a validated deck | **met**, narrower than its row |

### Lane A — measured, not accepted

The done-when needed live data, so the tracker ran `pnpm e2e` and read
`e2e/.run/summary.json` directly rather than taking a number on trust:

```
serverPicks: 90, serverResyncs: 0
```

Before was **90/90** — every round a gap, a dropped update and a snapshot
request. It is now **90/0**. Not "proportional to genuine gaps" but zero of
them, because with `carries: 'full-state'` on the envelope there are no genuine
gaps in a draft. `passDirections` still alternates (`alice→bob, bob→alice,
alice→bob`), so the wheel and the pass order survived the change.

### Lane D fixed a sharper bug than its title

"The deck the gate checks is the deck Forge plays" is a **format-gate bypass**.
`parseDck` and Forge's own reader disagree about where a section ends on certain
characters (tab, LF and friends), so a crafted `.dck` could be validated as one
deck and played as another. The fix refuses the text wherever the two readers
would split it differently, rather than patching either parser to match.

Its row also allocated `apps/ui/src/screens/**` and the lane touched none of it.
**Not a miss** — the constructed screens landed in Wave 10 (`0a92f13`), so only
the server half was outstanding. The wave file over-allocated; the lane was
right to leave it alone.

### Lane C said what it could not prove

Wave 10's finding 3 was that the refresh guard is never exercised in a real
browser — the seat reservation does the work, and on loopback the old socket's
close lands *before* the new join. C did not manufacture a test to hide that. It
documented that the guard still earns its place for the ordering it protects
against, fixed the flicker via the reservation path, and left the guard covered
by its unit test. That is the correct outcome for a "settled and stated"
done-when.

### The suite, re-run by the tracker

`pnpm e2e` — **4 passed (1.8m)**, plus `isolation.test.ts` 8/8 with all six
mutations failing as designed. The play run used **real Standard decks**: Ben
Stark's Mystic Caw-Go v Naoki Nakada's Mystic Caw-Go, PT Paris 2011, format
`2011-02-13`. It reached turn 5, cast `Mana Leak` and `Spreading Seas`, answered
a real coin-toss prompt from Forge, took 39 and 40 acts from the two seats, and
finished with `serverRefused: []` and **`jvmsLeft: []`**.

CI green on `367f963`; the local gate is 1,645 passing / 5 skipped.

## Verified this pass (2026-09-18 — tracker, Forge jar install)

**Play is live in production.** The half hadoku_site assigned to us is done, and
the 503 on `POST /api/play/matches` is gone.

### The jar

Built from the submodule pin `2ad70eb4` in the scratch clone `~/.cache/w7b-forge`,
which `git status --porcelain` confirmed clean at that sha. Installed to
`~/.local/share/cardtable/forge.jar` (hadoku_site's chosen path: outside every
checkout, so no deploy's reset can touch it; no version in the name, so the path
never changes). sha256 `4935b266bce3f098…`, 39,686,151 bytes.

**The vendored `forge/` tree was never built in and is still pristine** — D2
holds: `git submodule status forge` unchanged, no `target/` dirs.

### The clean build was not a formality

The first build I ran was incremental (`mvn package`, no `clean`) and produced a
jar byte-identical to lane B's 2026-09-16 scratch build. The clean rebuild from
the same sha produced a **different** sha256. So an incremental build across a
checkout change does not reproduce, and `clean` is now a documented requirement
in `docs/FORGE_JAR.md` rather than caution. The clean artifact is what is
installed.

### What proves it works

| claim | evidence |
| --- | --- |
| the jar carries `2ad70eb4` (`forge server`) | `unzip -p … forge/view/Main.class \| strings \| grep -x server` hits; `java -jar … server --help` prints our own `DedicatedServer` usage and exits |
| the jar carries `1f19a230` (Sentry DSN stripped) | no `sentry` string in the compiled `Main.class` — so **our crashes do not report to the upstream Forge project** |
| the 503 is gone | `index.ts:239`'s `play: no Forge` warning is **absent** from `cardtable-error.log` after the restart. The route 503s iff `deps.host === null` (`play/socket.ts:218`), and `host` is `forge.ok ? jvmHostFactory(…) : null` — no warning means `forge.ok`, so that branch is unreachable |
| Forge actually launches | `{"evt":"jvm-spawned","pid":2240909,"spare":true}` then `{"evt":"spare-warm","bootMs":3828}`. `pgrep` shows the JVM running `-cp /home/hadoku/.local/share/cardtable/forge.jar`, headless, `-Xmx1g`. A config that resolved but could not launch would have died here |

Restarted through **mgmt-api** (`POST http://127.0.0.1:4000/api/cardtable/restart`
→ 200), never raw `pm2`, per `services/mgmt-api/CLAUDE.md`.

Gate re-run after the doc change: **1,645 passing / 5 skipped**, typecheck and
lint clean — unchanged from `8940bcf`.

### hadoku_site's ask-1 landed, and the error message proved it

Before the jar existed the warning read `CARDTABLE_FORGE_JAR is not set`; after
their wrapper change it read `does not exist: /home/hadoku/.local/share/cardtable/forge.jar`.
That flip is the proof their `tunnel.pathEnv` wiring is live — the var is being
passed, the file simply was not there yet. The generated wrapper
(`~/srv/hadoku_site/services/pm2/cardtable-wrapper.mjs:42-43`) carries both vars
in the child's `env:` block.

### Correction to my own ask-3 premise

I told hadoku_site there was no service-tier upload path. There is. Tiers rank
`public < friend < service < wife < admin` and `requireUploader` is
`tierAtLeast(auth,'friend')`, so a **service** key clears a friend floor. I read
that as friend-only. cardtable lacks an *identity*, not a path — which is why O6
stays open as a credential item and not a code one.

### Found: match run dirs are never cleaned up (new, low)

`stageRunDir` (`apps/server/src/play/host.ts:274`) `rmSync`s a run dir *before*
creating it, and nothing removes it afterwards. Every match gets a fresh random
id, so `/tmp/cardtable-play/` grows without bound — 78 dirs / 16 MB from one
day's testing, ~205 KB per match. `/tmp` is **tmpfs**, so this is RAM, though
13 G is free and a reboot clears it. Not urgent at friend-group volume; it is a
leak with no ceiling, so it gets a row rather than a shrug. Fix belongs wherever
the match's `stop()`/`overGrace` path already runs.

## Previously verified (2026-09-18 — tracker, closing Wave 10)

**All four lanes landed.** Gate **1,596 passed / 64 files**; CI and redeploy
green on `edf1847`; production 401; submodule intact; worktree and branch gone.

**PR-2's four-wave gap is closed. Two humans drafted a whole pod.** Lane D's e2e
drives two independent browser contexts — separate cookie jars — through join,
pick, pass, wheel, refresh and finish, 45 picks each, and **isolation holds over
every envelope received**. Ran it myself: **2 passed in 1.2 minutes**. Final
pools are reproducible across runs (digests `2a2131959181e76f` /
`2efa3f8728daeed8`).

**I ran every gated test rather than trusting the skip count.**

- `apps/server/src/play/` with the JVM gate on: **90 passed**, and the live leak
  control holds again — **144→0, 142→0, 140→0, 145→0** secrets per seat.
- `prompts.jvm.test.ts`: **2 passed**, twelve prompt types answered against a
  real Forge match with real counts (`getAbilityToPlay×19`, `getChoices×3`, …)
  — and the line that matters: **"0 state frames arrived while an ask was
  open"**. That is the desync failure mode the wave asked for, measured.
- **The 3 fixture-only prompts have checkable reasons, and I checked the
  sharpest.** `showOptionDialog` has **0 callers** in `forge-game`/`forge-ai` —
  it lives on `AutoUpdater` and `FServerManager`, lobby paths, not game code.
  `chooseEntitiesForEffect` is not reached (Forge prefers a card-pointing
  input); `sideboard` is answered by the bridge itself
  (`PlayBridge.java:150`). Those are findings, not gaps.

### Lane D found three real problems and correctly fixed none of them

It was a measurement lane and said so. All three are now owned by Wave 11.

1. **Every round is a gap followed by a resync — the recovery path is the
   normal path.** Root-caused and confirmed here in the code: the engine bumps
   `seq` on *every* state change, `runBots` takes six bot picks in one call, and
   the room emits **one** update — so the client sees `seq` jump by ~7,
   classifies a `gap`, drops the update and asks for a snapshot. Measured:
   **serverPicks 90, serverResyncs 90**, 45 resync requests per browser. The
   draft completes and costs an extra round trip every round. The deeper issue
   is conceptual: **`classifySeq` is built for a delta stream and the room emits
   full state**, where a gap is irrelevant.
2. **A real refresh does not exercise the `leaveRoom` guard.** On loopback the
   old socket closes 36 ms *before* the new one joins, so the seat is held by
   the **reservation**, not the guard. The guard is covered only by its unit
   test, and for ~80 ms the other player sees the seat empty.
3. **Dev-only: `/health` is green while every page 404s** when the server runs
   from a path containing a dot-directory — which is every agent worktree.
   express's `send` uses `dotfiles: 'ignore'`; `checkBasePath` uses
   `readFileSync` and does not care. Production is unaffected (no dot segment),
   but it will waste an agent's afternoon.

## Previously verified (2026-09-18 — tracker, closing Wave 9)

**All four lanes plus the integration check landed.** Gate **1,523 passed / 61
files**, CI and redeploy green on `e795cfc`, production 401, submodule intact.

**The big unknown is closed, positively.** A browser answers Forge's
`showConfirmDialog` mid-match — **5.8 ms median**, board state after the answer
matching the server. That loop had never run inside a live game before this
wave, and it was the single largest risk left in PR-4.

### I ran the two skipped tests rather than accepting the skip

`pnpm check` reported **2 skipped**, gated on `CARDTABLE_FORGE_JAR`. The gate is
honest — the test title carries its own skip reason — but a test that never runs
is not evidence. Wave 7 lane B's scratch build is still on disk, so I pointed
the env at it and ran them. **Both pass**, and the output is the strongest
evidence this project has produced:

- a real Forge match in a child JVM, **Forge boot 3.8 s**, two seats opened
- **seat 0: 142 secrets in Forge's raw stream, 0 in what was emitted**;
  seat 1: 148 → 0. Then 170 → 0 and 162 → 0 on a second pairing.
  **That is the hidden-information control measured against live game data**, not
  a fixture — the strongest form of it in the repo.
- a real ask answered in ~52 ms, across a fixed seed and random precons

**They still do not run in CI**, and that is the right trade (a 1 GB Maven build
does not belong in CI) — but it means the per-seat leak control is only ever
proven by someone running them deliberately. Recorded as a watch, not a defect.

### O3 is answered, and the answer is forced rather than chosen

**One JVM per match** — not a preference. `FServerManager` is a per-JVM
singleton holding one lobby; a second match dies with
`IllegalArgumentException: Hook previously registered` at
`FServerManager.java:276`, and **upstream's own test suite spawns one JVM per
networked game "to avoid the FServerManager singleton limitation"**
(`MultiProcessGameExecutor.java`). Both architectures were measured anyway —
shared would have been ~10 MB of live heap per match against **~730 MB of RSS**
for a separate JVM — so the cheaper option is the one that does not exist. The
spike still recommends putting a `matchId` on every Node↔JVM message, so the
architecture does not foreclose sharing if the singleton is ever fixed. Open
since Wave 1, deferred twice; closed with measurements.

### The remaining shape of PR-4

Fourteen prompt components exist **on fixtures** (lane C); one is wired live
(lane B). The gap between those two states is Wave 10.

## Previously verified (2026-09-17 — tracker, closing Wave 8)

**All four lanes landed; worktree and branch gone.** Gate **1,298 tests / 46
files** (was 1,143 / 37). CI and redeploy green on `c757a98`; production 401.

- **The submodule survived the close-out slip.** The manager reported git
  refusing to remove the worktree. Checked the failure mode a `submodule deinit`
  would have caused — **the deploy tree IS this checkout** — and it is intact:
  registered in `.git/config`, populated (19 entries), pinned at `2ad70eb4`,
  tree clean. The fix held.
- **Tier C's refusal is gone** — `grep -c 'z.never|tierCRefusal'` on `tier-c.ts`
  → **0** — and replaced with a schema validated against real captures.
- **The events arm is 41 modelled + 17 refused = 58**, not the 36/22 the wave
  predicted. More events fired than the 12-game sample had shown, which is the
  right direction to be wrong in. The 17 refuse **by name**, as instructed.
- **The cross-lane check exists and bites.** `tier-c.fixture.test.ts` parses all
  27 packets of the UI's board fixture under `DeltaPacketSchema`. Mutation-tested
  here: corrupting one numeric value in the real fixture **fails** it; restored,
  3/3 pass. That is the A↔C integration the wave asked the manager to run, and
  it is a committed test rather than a one-off.
- **The board renders from a real game's packet stream** and imports no socket —
  the fixture discipline held.

### Correcting my own framing, prompted by the operator

I wrote "~14 prompt components" without saying what a prompt component *is*, and
the operator rightly asked whether Forge doesn't run on discrete rules. It does,
and that is the reason the number is small: **the client decides nothing.** The
count is the SERVER→client methods that **return a value** — re-derived from
`ProtocolMethod.java`, it is **15**:

`showConfirmDialog` · `confirm` · `showOptionDialog` · `showInputDialog` ·
`getChoices` · `chooseSingleEntityForEffect` · `chooseEntitiesForEffect` ·
`getAbilityToPlay` · `assignCombatDamage` · `assignGenericAmount` · `order` ·
`manipulateCardList` · `sideboard` · `openZones` · `tempShowZones`

They are **UI affordances, not rules**. The rules stay Forge's, and the set is
closed because the enum is closed — which is the only reason the work was
sizeable at all.

## Previously verified (2026-09-16 — tracker, closing Wave 7)

**All four lanes landed; worktree gone.** Gate **1,143 tests / exit 0** (was
635). CI and redeploy green on `40060fa`; production 401 to anonymous.

- **Tier C is settled, and it is good news.** 48 delta packets from the stock
  harness, **658 over 12 captured games**, and **73,549 of 73,549 values
  round-trip through JSON — zero failures, zero unrepresentable.** The `mutate`
  target requires all three mutations to exit non-zero, so the control can fail.
  Lane F's week/month/quarter question resolves to **the state channel is days**.
- **The pin moved to `2ad70eb4`, and no count drifted — because lane B branched
  from `2cd497c` rather than upstream tip.** Verified the parent chain
  (`2ad70eb4 → 1f19a230 → 2cd497cfbeb`) and re-derived every documented figure at
  the new pin myself: **ProtocolMethod 45 SERVER / 15 CLIENT = 60**, **ApiType
  202 constants / 199 distinct / 206 files**. All unchanged. That was the wave's
  condition on moving the pin and it was met properly.
- **The Sentry DSN is genuinely gone.** `grep -cE '^\s*Sentry\.init'` → **0**,
  no DSN string anywhere in `Main.java`, and the removal is explained in a
  comment rather than silently blanked. `case "server":` now calls
  `DedicatedServer.start(args)` where it used to print "Not implemented."
- **The `ReplyPool` correction is right, and I read the source rather than the
  note.** `ReplyPool.java:54` is `private static final class CompletableFuture
  extends FutureTask<Object>` and `java.util.concurrent.CompletableFuture` is
  **never imported** — a nested class shadowing the JDK name. Wave 6 had the
  right mechanism and the wrong name; the correction had the right name and
  invites the wrong semantics. Both are now recorded with the trap named.
- **The events arm is the new long pole, and the finding is subtler than a
  count.** 32,604 event items survived base64 with 0 byte differences — and lane
  A says plainly that **a clean byte count is not "events round-trip"**: the
  payload is a Java object stream, so a browser that decodes it holds bytes it
  cannot read. It needs **36 per-event JSON schemas** (36 distinct `GameEvent`
  classes fired across 12 games, of 58 declared). Sized 1–2 days.

### The deploy tree's submodule — closed by accident, and it WILL recur

The manager reported ` M forge` on the deploy tree and correctly refused to
write to production. **That tree is this checkout** — `deploy-config.json:143`
is `"localPath": "hadoku-cardtable"` — and it is **clean now**, because syncing
the submodule earlier in this pass was the same one-liner.

**It is not durably fixed.** `buildCommand` is `pnpm install && pnpm build` with
**no submodule step**, and mgmt-api's `git pull` does not update submodules — so
every future pin move re-dirties the deploy tree, and eventually a `git pull`
refuses with *"local changes would be overwritten"*. **Operator item O8**; the
durable fix is in hadoku_site, not here.

### D12 note, recorded rather than actioned

The Wave 7 manager read `ReplyPool.java`, and `docs/FORGE_ANALYSIS.md` now
documents its mechanism. That is fine — P4 (`room-ask`) was already built clean
in Wave 5, and D12 already forbids a P4 clean-room agent from reading
`FORGE_ANALYSIS.md`. But **that manager, and this session, are contaminated for
any future P4 work.** A fresh agent is required if P4 is ever reopened.

## Previously verified (2026-09-16 — tracker, closing Wave 6 + PR-4 unblock)

**Wave 6 landed: all six lanes on `main`, worktree gone.** Gate **635 tests / 37
files** (was 473 / 28). The manager's three self-corrections and four handoffs
were re-derived here, not taken from the note.

- **`forge/` is genuinely clean after the incident.** The manager ran a Maven
  build inside the vendored tree, created 6 `target/` dirs, and removed them:
  **0 target dirs, 0 tracked changes, HEAD still `2cd497c`.** Confirmed.
- **The fifth vacuous gate is real, and is now fixed.** `git status --porcelain`
  on `forge/` cannot see build output — Forge's own `.gitignore` covers
  `target` — so §F.3's pristine check reported clean throughout. Proved it:
  with a `target/` dir present, **git reports 0 changes** while the new check
  fails. `scripts/spike/itoclient/run.sh` now uses `pwd -P` (the guard compared
  logical paths, so a worktree symlink never matched and waved the build
  through — reproduced: the fixed guard exits **2** through a symlink) and
  `assert_forge_pristine` checks for `target/` dirs as well as asking git.
- **The repealed-D13 survivor was ONE, not two.** `packages/shared/src/semantics.ts:59`
  carried it live and is fixed — the control stays, because what it guards
  changed rather than ended: the *payload* must carry an id, not a URL.
  `CLAUDE.md:17`'s mention is correctly **historical** ("until then this rule
  read…") and was not a survivor.
- **`CLAUDE.md`'s "Maven ✗" was stale and actively misleading** — Maven 3.9.16
  and Temurin JDK 21 have been under `~/.local/opt` since Wave 1 (D14),
  deliberately off `PATH`. It has now cost two sessions. Rewritten to say where
  to look before concluding the toolchain is absent.
- **Corpus is 118,026**, not the board's 117,941. Recounted.
- **"6 cards absent from Scryfall, all OM1" is WRONG and is now corrected.** OM1
  is in the corpus: **189 printings, all 189 `digital: true`.** They are not
  absent — they are digital-only, which the resolver refuses. That is the *same
  root cause* as the original 47, one layer down: `default_cards` fixed the
  cards whose representative printing was digital, and cannot fix a set whose
  every printing is.
- **`@hadoku/room-ask` MIT / D6 contradiction: both closed.** D16 amends D2 with
  the carve-out (clean-room, MIT destination, `room-store` GPL as the contrast);
  D17 supersedes D6's mechanism and keeps its layout intent.
- **PR-4 is unblocked.** `WolffM/forge` forked (1038 MB, master `994c5d9`);
  `forge/` is now a **submodule pinned at `2cd497c`** — the commit every
  verified number in `docs/` was measured against. CI does **not** fetch it
  (`actions/checkout` defaults to `submodules: false`, and no workflow overrides
  it), so the 1 GB costs CI nothing.

### Numbering collision, flagged

`docs/DECISIONS.md` has its own **O5** (how much card art to host) which is a
*different item* from this board's O5 (the MIT carve-out, now closed as D16).
The two documents number their open questions independently. Worth reconciling
before a third one appears.

## Previously verified (2026-09-16 — tracker, closing Waves 4 and 5)

Re-derived from artifacts, not from closing notes. **Both waves landed; all
eight lanes are on `main`; both worktrees are gone.** Gate: install 0, check 0,
**473 tests / 28 files** (was 242 / 15). CI and `Redeploy on hadoku_site` both
green on `fca12a9`. Production answers **401 to anonymous** on `/`, `/health`
and `/api/whoami` — the friend gate holds.

- **The hidden-information control bites, and I proved it rather than read it.**
  Injected a leak into `apps/server/src/room/emit.ts` — every recipient built
  from seat 0's view instead of their own — and `two sockets in one room > each
  receive ONLY their own seat's cards` failed by name, catching **45 cards** of
  another seat's pool arriving at the wrong socket. Restored: **16/16 pass**.
  `broadcastToRoom` is not reachable from that file.
- **The P4 clean-room firewall held.** `grep -rniE 'forge|replypool'` over
  `packages/room-ask/` returns **nothing**. Lane F's note: *"Written clean room
  from `docs/requests/P4_ASK_REGISTRY.md` and nothing else."*
- **The art swap requirement is asserted, not asserted-to.** Three tests in
  `packages/carddata/src/art/index.test.ts`: repointing one card, rolling a card
  back from `cdn` to `scryfall`, and adding a row for an unlisted card — each
  checking every *other* id is byte-identical, with the compared count pinned so
  deleting a fixture cannot shrink the test to nothing.
- **The D13 gate's new arms are correct.** Mutation-tested all three: a
  same-origin `/cardtable/assets/leak.jpg` **fires**; a `cdn.hadoku.me` URL is
  **allowed**; the clean bundle ships **0** image files and **0** disallowed-host
  URLs.
- **D15 supersedes D13's image clause properly** — D13's text left intact as the
  record, the repeal dated and attributed, and the placeholder constraint
  written down as the load-bearing part.
- **The CDN upload has NOT run.** `art-manifest.json` holds **0 entries**, so
  every card still renders from Scryfall through the fallback. Lane B said so in
  bold rather than implying otherwise — *"It has not been run against the real
  CDN. There is no friend-tier credential on this host and none was invented."*
  That is the right call and it is the wave's one open item.

### Found — a settled decision was contradicted and not recorded

**`packages/room-ask` declares `"license": "MIT"`, and D2's "rules out" line
still reads: *"an MIT room layer living in this repo (see D11)"*.**

Lane F handled the code side carefully — SPDX header, its own `LICENSE`, and a
module comment calling itself *"the single carve-out in a repo that is otherwise
GPL-3.0-or-later"*, written clean-room so it is not a derivative of Forge. The
licences are also internally coherent: `room-ask` is MIT because D12 clean-roomed
P4 precisely so it *could* go upstream to watchparty's MIT packages, while
`room-store` is GPL-3.0-or-later because it is ours and merely consumes their
primitives.

What is missing is the record. `grep -c 'room-ask' docs/DECISIONS.md` returns
**0**. A decision log that says a thing is ruled out, beside a package that does
it, is how the question gets re-litigated in three months — and this repo has
already watched a rule flip back for exactly that reason. **Operator item O5.**

## Previously verified (2026-09-16 — tracker, closing Wave 5)

Nothing below is taken from a closing note. Each line names the command that
produced it, and every mutation test reports **reverted fails N / restored
passes N** or it does not appear.

**The wave landed and is running.**

- **Seven commits, one push.** `b2917ac..5cc9773`, 46 files, +9582/−34. One push
  and not four, because `redeploy.yml` sets `concurrency: redeploy-cardtable,
  cancel-in-progress: true` — lane-by-lane pushes would have been four deploy
  chains cancelling each other.
- **Gates on `main`, exit codes read directly:** `pnpm install --frozen-lockfile`
  **0** (what CI runs) · `pnpm run typecheck` **0** · `pnpm check` **0** →
  **28 files, 473 tests** · `pnpm -r build` **0** · `bash scripts/d13-gate.sh
  apps/ui/dist` **0** · `--self-test` **65 fixtures, 65 as expected** · CI green
  on `5cc9773`.
- **DEPLOY confirmed, not assumed.** Deployed tree HEAD `5cc9773` ==
  `origin/main`. `apps/server/dist/index.js` rebuilt **06:42:19Z** (push was
  06:42:01Z) and contains `draft:c2s` and `emitPerRecipient`. The serving
  process started 06:42:19Z, **after** the install. `restart_time` reads 0
  because the PM2 wrapper does delete+start, which resets that counter — the
  **uptime** is the evidence, not the counter.
- **Re-checked 11 h later:** the PID had changed (host-side restart, no new
  redeploy run), but the bundle mtime is unchanged and still carries the wave.
  Still landed.
- **Production, anonymous:** `/cardtable/`, `/cardtable/health`,
  `/cardtable/api/whoami` and
  `/cardtable/socket.io/?EIO=4&transport=polling` all → **HTTP 401**. A socket
  path is a path, and the edge treats it as one.
- **The deploy tree IS `/home/hadoku/repos/hadoku-cardtable`** — the repo's own
  main checkout, not a separate clone. That makes "never work in the main
  checkout" a **production** rule here, not hygiene. Worth knowing before the
  next wave scaffolds anything.

**Mutation tests, all four lanes, counts both ways.**

| Guard | Broken | Restored |
| --- | --- | --- |
| E — per-seat leak (`emit.ts`, leak the neighbour's pack into a new view field) | **1 failed / 15 passed**, by name: `expected [ '$.view.neighbourPack[0]', …(14) ] to deeply equal []` | byte-identical, **44 pass** |
| E — refresh guard (`draftRooms.ts`) | **3 failed / 41 passed**; socket-level one fails `expected null to be +0` — the seat really went null | byte-identical, **44 pass** |
| F — requirement 8 drop counter (`registry.ts:413`) | **7 failed / 16 passed** — A-3, A-4, A-11, A-12, A-16, A-17, A-20, i.e. every requirement-8 test | byte-identical, **23 pass** |
| G — §4.5 unknown `storeVersion` (`snapshot.ts:325`) | **2 failed / 67 passed** | byte-identical, **69 pass** |
| G — §4.1 save-before-load (`persistence.ts:340`) | **2 failed / 67 passed** | byte-identical, **69 pass** |
| H — duplicate-never-resyncs (`socket.ts:399`) | **2 failed / 26 passed** | byte-identical, **28 pass** |

**Three mutation attempts were INVALID and looked exactly like success.** Worth
recording as a method, because all three produced a red suite:

1. A `perl` substitution on G's §4.1 guard silently did not match the source
   line. Empty diff, 69 passing, exit 0 — indistinguishable from a decorative
   guard, in the *other* direction.
2. Three attempts at E's leak used `room.app.packs`, but `DraftApp` is
   `{ state: DraftState | null }`. The build callback threw, `emitPerRecipient`
   fail-closed, no envelope reached anyone, and every test **timed out**. Red
   suite, zero evidence.

The rule that falls out: **assert the mutation diff is non-empty before trusting
the run, and read HOW the test failed, not just that it did.** A timeout is not
an assertion.

**Claims the tracker re-ran independently, not the lanes' own tests.**

- **The wire schema** (before lane E was unblocked): a client message carrying
  `participantId` is rejected **and named by key**; an honest pick parses; a
  forged envelope cursor disagreeing with its payload is rejected; a Scryfall
  `image_uris` blob **inside** the embedded view is rejected at
  `$.view.viewer.pack[0].image_uris`; all five engine `PickRejection` codes are
  carryable and exactly those five.
- **A precise limit on that control, found by probing it:**
  `safeParseServerMessage` **accepts** a card-shaped object in a *new* field, and
  accepts bare card names as strings. `semanticIssues` walks `viewer.pack` and
  `viewer.pool` and applies D13 **there**; it does not hunt card-shaped objects
  in arbitrary fields. The positional hidden-information control lives in the
  **tests** (`leakedCardPaths`) and in `apps/ui/src/draft/hiddenInfo.ts` — not in
  the shipped validator. That is defensible (the envelope's type design means a
  leak requires *adding a field*, which a reviewer sees) but it is not what
  "the parser rejects leaks" would imply, and the board should not imply it.
- **P6's headline, on the tracker's own driver** rather than lane G's fixtures:
  20 real picks, `flushAll`, then a fresh `FileRoomStore` over the same
  directory in a second `RoomPersistence` → same roomId · same seat · **pool
  identical card-for-card (20 cards)** · **epoch CHANGED** · next pick accepted
  and the pool grew by exactly 1 · no other seat's cards anywhere in the view
  (**20 ids checked**). The first run of that last check read `checked 0 ids`
  and *passed* — vacuous, the same shape as the D13 test that kept passing
  because its fixtures had no ids. It only became real once the restore
  actually restored.
- **`tsc` genuinely cannot emit `apps/server` any more.** Rebuilt the old
  emit-to-`dist` tsconfig against the new sources: exit 2, **16×TS5097**; with
  tests excluded the errors move into `packages/draft/src` itself
  (**13×TS5097**), because the workspace packages export TypeScript source whose
  imports carry `.ts`. Adding `allowImportingTsExtensions` then demands `noEmit`
  (TS5096). So `build` is now `tsc --noEmit && esbuild --bundle`. **The external
  contract is unchanged**: `main`, `start` and `dist/index.js` are byte-identical
  in intent, and the PM2 wrapper
  (`hadoku_site/services/pm2/cardtable-wrapper.mjs`) runs
  `node <repo>/apps/server/dist/index.js` — read directly, confirming the
  choice. Bundle externalises exactly `express`, `socket.io` and the two
  `@wolffm` packages; `zod` is inlined because pnpm's strict layout will not
  expose a transitive next to `dist/`.
- **`esbuild@0.28.2` clears the supply-chain gate** — published 2026-08-08, 38
  days old against `minimumReleaseAge: 10080` (7 days).
- **The pool resolves on the deploy host** — lane E listed this as
  unverifiable; the deployed process logs `draft socket ready — MTGO Vintage
  Cube 2025-12: 534 cards`. Production also shows **no** `EDGE_AUTH_SECRET
  unset` warning, so provenance verification is live there.

**Still NOT verified — these stay on the board.**

- **Two browsers drafting one pod** (§H.5 / §E.6). No lane claimed it; all of
  them said so. Needs two friend-authenticated browser contexts. Settle with:
  open `https://hadoku.me/cardtable/` in two contexts → Source → "Server" → same
  draft id → pick in one, assert the other's pack updates without a reload →
  refresh one mid-draft, assert it returns to the same seat with its pool intact.
- **P5's acceptance criterion** is a four-player *match* with a board and a
  hand. There is no match engine in this repo (O2 put the draft in-process), so
  every P5 clause is tested against a room with four seated participants and an
  opaque `TApp`. Not a gap in the lane; a gap in what exists to test against.
- **"No filesystem call during a full lifecycle"** is asserted as an empty temp
  directory, not by stubbing `node:fs`. Lane G's own test comment says so.
- **W4's art gate proved nothing on this artifact.** `d13-gate.sh` says so
  itself: arms 2–4 examined **zero** references because the art manifest is
  empty until the upload CLI runs. Arms 1 and 5 ran; the 65-fixture `--self-test`
  is what shows the arms bite. **If the count stays 0 after an upload, the gate
  has stopped seeing the artifact** — the script says that too.

**Found, and now owed to someone.**

- **`markDirty` is a silent-loss edge.** A host that mutates `room.app` and
  forgets `persistence.markDirty(roomId)` flushes nothing and loses everything;
  `flushAll()` returns `[]` and nothing complains. The tracker hit it writing
  the restore test. It is the standard explicit-dirty contract and it is
  documented — and `apps/server` is not a consumer yet, so nothing depends on it
  today. It will the day P6 is wired in.
- **Two pieces of P5/P6 are built but not wired**, both correctly declined as
  out-of-lane rather than quietly skipped: cancelling pending asks on service
  `lost` (needs `@hadoku/room-ask`, lane F's package) and `collectGC` →
  `RoomPersistence.destroy`. Lane E deliberately runs **no GC at all** — rooms
  live for the process lifetime, a slow leak — because `collectGC` reaps on
  `clients.size === 0`, which for a 45-minute draft is every room the moment the
  last connection blips.
- **A false claim shipped in production and was corrected mid-wave.**
  `App.tsx`'s footer and `apps/ui/package.json`'s description both said this
  project "never loads, caches or proxies a card image" / "Never renders a card
  image", false since `aea07a6` shipped card art — `CardTile.tsx:105` renders
  `<img src={imageUrl}>`. Lane H fixed the footer and missed the manifest line
  it had rewritten in the same commit; the manager sent it back (`9a99fa3`). On
  the rebase the tracker resolved it a third time, because W4's **D15** landed
  underneath and made H's own correction wrong too — art comes from
  `cdn.hadoku.me`, not Scryfall. Repo-wide grep now finds no surviving copy.
- **Both waves bumped `@hadoku/ui` to 0.2.0 independently** and git auto-merged
  the collision silently. Resolved by taking main's and re-bumping to **0.3.0**,
  rather than letting one version number cover two waves' content.
- **This board contradicted itself.** The header said "Wave 2 LANDED" while a
  Wave 3 closing ledger sat 170 lines below it; a 39-line ledger block appeared
  **twice**, byte-identical; two different Wave 2 ledgers shared one heading;
  and the epoch (W4) row said "wave-3 lane A" in PR-3 while the same row in PR-2
  already said DONE. All corrected this pass. **Wave 4's closing notes were
  never recorded at all** and are not invented here.

## Verified this pass (2026-09-14 evening — tracker, closing Wave 3)

- **`ApiType` is 199 distinct, 7 unnamed — and my 200 was wrong.** Re-derived:
  `ApiType.java:137` is `//NoteCounters (CountersNoteEffect.class),`, commented
  out; my unanchored grep matched inside it. Anchored → **199**. The 7 unnamed,
  listed: `AnimateEffectBase`, `CountersNoteEffect`, `DamageBaseEffect`,
  `DetachedCardEffect`, `ManifestBaseEffect`, `PermanentEffect`,
  `TokenEffectBase`. And 202 − 3 `CharmEffect` duplicates = 199 on its own.
- **Lane C's docs document the trap rather than just the number.** `CLAUDE.md`
  now carries the derivation commands inline and names both of my grep failures
  — the `Mode.` off-by-one at `ProtocolMethod.java:136` and the unanchored
  `.class` at `ApiType.java:137`. `WASM_AND_PORTING.md:91` explicitly says the
  unanchored form "yields exactly the old pair — 200 distinct, six unnamed".
- **P2 is untested, not passed** — the manager is right. Lane B's lockfile delta
  is **6 lines and one workspace link** (`@hadoku/carddata: link:../carddata`);
  `grep -rn '@wolffm' pnpm-lock.yaml packages/*/package.json` returns **nothing**
  repo-wide. `gh secret list` still empty. CI green proves nothing about it: no
  cold runner has tried to resolve an `@wolffm/*` tarball yet. Lane A was that
  first dependency, and lane A did not run.
- **P1 still open, third wave.** `NODE_AUTH_TOKEN` unset; bare `npm view` → E401.
- **Lane D delivered.** `origin/cardtable-w2-requests` at `ccfeab46`, upstream
  set, **0 behind** their `main`, 5 files, commit *"re-read P3-P6 against
  0.38.110, and answer the seat question"*. Committed is now pushed.
- **W3 is genuinely moving, and shaped to our asks.** Their worktree
  `.claude/worktrees/rooms-resv` on `rooms/seat-reservations` is **0 commits
  ahead of main with 7 dirty files** — in progress, uncommitted, so nothing is
  verifiable as shipped. Read-only, their `seats.ts` already carries
  `SeatReservation`, an opt-in **`reservationTtlMs`** (our ask: configurable,
  not a constant), the note that a reservation *"survives the case nothing else
  can"* when a server restarts (our restart argument), that it is **data** so it
  persists with the table (P6), and that it **blocks other humans, not bots** so
  `padWithBots` fills the held seat — which is the botted-and-reclaimable
  behaviour our ask #2 wanted. **Do not record any of this as shipped.**
- **W5 may be moving too** — a new untracked `apps/server/test/emit-payload-types.test-d.ts`
  sits beside a modified `emit.ts` in that same worktree. A *type* test is what
  fixing the `unknown | typeof SKIP` collapse would need.
- **Gate on `main`:** install **0**, check **0**, **187 passed / 11 files**, up
  from Wave 2's 138 / 9.

## Verified in the previous pass (2026-09-14 morning — tracker, closing Wave 2)

Re-derived rather than read. **Every one of the manager's five corrections to
the board is right, including the two I initially failed to reproduce.**

- **Four lane commits are ancestors of `origin/main`** (`df716ef` D, `169cb9c`
  E, `ae5a076` A, `1a7a2f4` C; lane E is three commits, not one). Worktree
  removed, tree clean, `pnpm install --frozen-lockfile` **0**, `pnpm check` **0**.
- **`forge/` pristine** — HEAD still `2cd497c`, **0** dirty lines, after a wave
  that built `forge-gui-desktop`.
- **`Booster: 15 Any` is 91.** My 92 was an addition error over my own
  `uniq -c` buckets, which trailing whitespace had split three ways.
- **The corpus is 49,345 / 388, and my 47,315 / 375 was wrong twice over.**
  Reproduced the whole chain: `^[0-9]+\s+` silently drops **1,958** card lines
  that carry no leading count, across exactly three cubes — `Old School 93-94
  Magic Full Set 878 Card Cube` (878, the entire cube), and both Grixis cubes
  (540 each). 47,315 + 1,958 + 72 bare names = **49,345**. Set codes by field
  `[1]` = **388**; by last field = **720**, which is the wrong answer the
  manager reports getting first, reproduced exactly.
- **`ProtocolMethod` is 60.** 61 lines mention `Mode.SERVER`/`Mode.CLIENT`, but
  line **136** is inside a method body (`if (mode == Mode.SERVER && ...)`), not
  a constant. So **45 SERVER / 15 CLIENT**. `CLAUDE.md`'s "62-method enum" is
  wrong and is still uncorrected.
- **`ApiType` is 206 / 202 / 200 — all three confirmed.** I first read 204 and
  doubted the 206: it is **204 `*Effect.java` plus `AnimateEffectBase.java` and
  `TokenEffectBase.java`**, i.e. 206 `.java` files in `effects/`. 202 constants,
  200 distinct, `CharmEffect.class` named **4×**, and **every** class ApiType
  names has a file on disk.
  > **SUPERSEDED 2026-09-14 by Wave 3 lane C — the tracker was wrong here.**
  > The distinct count is **199**, not 200, and **7** files are unnamed, not 6.
  > `ApiType.java:137` is `//NoteCounters (CountersNoteEffect.class),` — a
  > **commented-out** constant, and the tracker's unanchored
  > `grep -oE '[A-Za-z0-9_]+\.class'` matched inside the comment. Anchoring on
  > the line start gives 199. **The old pair was self-refuting on its face:**
  > 202 constants with `CharmEffect` named 4× removes 3 duplicates, so
  > 202 − 3 = **199**, never 200 — and the tracker asserted both facts in the
  > same sentence. Same failure class as the `^[0-9]+\s+` regex that dropped
  > 1,958 card lines: a pattern that silently matched the wrong thing.
- **`rankings` is a directory**, beside `rankings_cubecobra.txt`.
- **Mutation-tested the hidden-info control myself, with counts.** Injected one
  card-shaped object at `seats[0].lastPick` in `spectator-pack2-pick5.json`:
  **4 failed / 134 passed, exit 1**, the failure naming the exact path
  `$.seats[0].lastPick`. Restored: **138 passed, exit 0**, tree clean. The
  control is positional, not nominal — it walks the whole payload — and it bites.
- **W1 and W2 are genuinely shipped at `0.38.110`**, read from the published
  tarballs, not their source: `emit.d.ts:63 emitPerRecipient`, `:71 emitToRole`,
  `:43 SKIP`; `rooms-protocol/dist/resync.d.ts` exporting `SeqCursor`,
  `classifySeq`, `missedCount`, `needsResync`, `resolveIdentityReassert`.
- **W3 is real and still open.** `rooms-server@0.38.110` `state.d.ts:11` is
  `socketId: string`. Singular, as lane E found.
- **Lane B genuinely did not run.** `packages/draft` does not exist;
  `packages/shared/src` holds only `.gitkeep`. The manager obeyed the wave
  plan's own "do not dispatch B on E401" instruction rather than routing around
  a credential — the right call.
- **P1, P2, P3 all still open**, each re-checked: `NODE_AUTH_TOKEN` unset and
  bare `npm view` → **E401**; `gh secret list` **empty**;
  `cardtable-w2-requests` at `fd584664` with `upstream=[]` and **2 behind**
  their `main`.

## Watches the tracker holds

- ~~**Watchparty P0→P2.**~~ **Closed 2026-09-14.** `@wolffm/rooms-protocol`,
  `@wolffm/rooms-server` and `@wolffm/watchparty-ui` all resolve at
  **`0.38.109`**. Note the watch was checking the **wrong name** — `@wolffm/rooms`
  is still E404 and always will be; it shipped as `rooms-protocol`. Had the token
  in `~/.npmrc` been live, the E401 would have said "exists" three days sooner.
- **Watchparty P2-full.** They shipped P0–P2-**core**, now at **`0.38.115`**.
  Closes when the rest of P2 lands or they confirm P2 complete.
- **`KEY_SERVICE_CARDTABLE` (new).** **Settled 2026-09-16, and the answer is
  "unset".** `gh secret list` has no such secret, so `redeploy.yml`'s
  `report-job` step receives an empty `service-key`. It does **not** fail the
  job: `report-job@v1` guards it and emits `##[warning]service key unset —
  cardtable:redeploy outcome not reported`, observed verbatim on this wave's own
  redeploy run for `5cc9773`. So every cardtable redeploy goes green while
  monitoring-api never hears about it — the exact "a red run is seen by nobody"
  failure the workflow's own header was written about, half-open. Closes when
  the operator seeds it from hadoku_site (`administration.py github-secrets
  child-repos`) or decides cardtable does not report.
- **Our `ParticipantId` bytes vs. watchparty's (new).** `deriveParticipantId`
  is **not published** — `rooms-protocol` ships only the format half — and the
  digest input is undocumented (`P5_SERVICE_PARTICIPANT.md` §7.2's open ask).
  Lane E minted its own: `sha256("hadoku.cardtable.participant.v1" ␟ tier ␟
  material)` truncated to 16 hex, pinned by a test. Ids minted here agree with
  ids minted here, and this process is the only minter for our rooms, so it is
  not a live bug. It becomes one the day anything else mints an id for a
  cardtable room. Closes when they publish the derivation or we agree one.
- ~~**`emitPerRecipient` (W1).**~~ **Closed 2026-09-14** — they exported it
  (`emit.ts:121`) in `e58e3005`. See the PR-3 row.
- ~~**`@wolffm/rooms-client` (W2).**~~ **Closed 2026-09-14** — they shipped the
  resync/identity contract into `rooms-protocol` (`resync.ts`), which is what we
  asked for instead of the client. See the PR-3 row.
- **`ClientMeta.socketId` (W3).** **Still open upstream; we now route around
  it.** Re-reproduced 2026-09-16 against the shipped `0.38.111`, replaying
  `state.js`'s own call order: after a refresh the drafter is `roleOf ==
  'spectator'` with their seat empty, a live reservation held for them, and
  `remembered` intact. `leaveRoom` still calls `unseatParticipant`
  unconditionally. Wave 5 lane E took **option (c)** — the hosting app guards
  the call: after `leaveRoom`, if `clientByParticipant` still finds a live
  client for that id, `seatParticipant` puts them back in the remembered seat.
  Mutation-tested: delete the guard → 3 tests fail, the socket-level one as
  `expected null to be +0`. **Closes when they fix it upstream**; until then
  every consumer of `rooms-server` has this bug unless it writes the same guard.
- ~~**`0.38.110` publication.**~~ **Closed 2026-09-16.** `npm view
  @wolffm/rooms-protocol version` → **`0.38.115`**, exit 0. They are five
  releases past the version this watch was opened on. `rooms-server` lists
  `0.38.108`…`0.38.115`. We pin **`0.38.111`** everywhere, deliberately and
  consistently — that is the version every Wave 5 claim was verified against.
- **`HADOKU_NPM_READ_TOKEN` (P2).** **Half closed 2026-09-16.** `gh secret
  list` is non-empty and the repo now really depends on two `@wolffm/*`
  packages, so the first half is met and the path is no longer structurally
  dead. The second half is **not** proven: the self-hosted runner is warm
  (`reused 299` of 307), so the install can be served from a cached store
  without authenticating. Closes on a cold runner, or `pnpm store prune`
  before `pnpm install --frozen-lockfile`.
- **`CLAUDE.md` — two of three fixed, one still wrong.** Re-verified against
  the tree 2026-09-16, after Wave 4 lane D rewrote the file: **(2) FIXED** —
  line 57 now reads "60-method enum: 45 server→client, 15 client→server", with
  the derivation and the `Mode.SERVER`-in-a-method-body off-by-one spelled out;
  **(3) FIXED** — line 67 now reads "202 constants naming 199 effect classes".
  **(1) STILL WRONG** — `CLAUDE.md:101` still says *"**Maven ✗** — hokon has no
  `mvn`"*, but `command -v mvn` → `/home/hadoku/.local/bin/mvn`, **Apache Maven
  3.9.16**. W4 rewrote the licensing half of the file and did not touch the
  build-prerequisites half. Closes when a wave owns `CLAUDE.md` and fixes line
  101.
- ~~**`docs/LICENSING.md` §3.**~~ **Closed 2026-09-14 by Wave 2 lane E**
  (`62b1e64`). §3 is rewritten from a live `200` fetch, not a relayed claim, and
  carries both required halves — verified in the committed file: the no-images
  rule is *"stricter than Scryfall [requires] … driven by **WotC's IP**"*
  (lines 185-187), and §3.2 *"The anti-paywall clause, and the tension we are
  not resolving"* quotes the clause verbatim and records that we offer
  **neither** anonymous access **nor** free accounts, unresolved, ending "do not
  fix this by opening a public tier". E also caught that their list gates on
  *"join chat servers, or follow channels"* — social gates, not only payment.
  The original ask, kept for the record:
  **(1)** Scryfall's image rules govern *presentation*, not redistribution —
  they publish no blanket no-caching prohibition, so our no-images rule is
  **stricter than they require and stays**, because it is driven by WotC's IP.
  Say so, or someone will later relax D13 on the grounds Scryfall didn't forbid
  it. **(2)** Their anti-paywall clause says end-users "should be able to access
  card data anonymously or with free accounts"; we take no money so the paywall
  proper isn't engaged, but we offer neither. Write the tension down.
- ~~**D7 / the spike.**~~ **Closed 2026-09-12: NO-GO.**

## Verified in the previous pass (2026-09-14 morning — tracker, closing Wave 2, second ledger)

Every line was re-run by the tracker against live state, not taken from the
manager's note. **Five of them correct the board's own prior numbers.**

- **All four landed lanes are green on `main`.** `gh run list --branch main`:
  `df716ef` · `169cb9c` · `ae5a076` · `1a7a2f4`, each **completed success**.
  Worktree `w2-manager` and branch `w2` are gone; `git worktree list` shows only
  the main checkout.
- **`forge/` is byte-for-byte pristine**, checked again at closing: `git -C
  forge status --porcelain` **0 lines**, HEAD still `2cd497c`, **0** `target/`
  dirs. Two lanes built and ran Forge; both did it in a `cp -a` copy the manager
  made under `~/.cache` and never told them the real path.
- **`ProtocolMethod` is 60, not 62.** Re-derived independently of lane D's tool:
  `grep -cE '^\s+\w+\s*\(Mode\.(SERVER|CLIENT)'` → **60** (45 SERVER, 15
  CLIENT). `CLAUDE.md` and the Wave 2 plan both said 62. The 2 "dead" constants
  really are absent from `IGuiGame.java` (grep exit 1).
- **`15 Any` is 91 recipes, not 92.** `grep -h '^Booster:' | sed 's/ *$//' |
  sort | uniq -c` → 91 `15 Any`, 1 `16 Any`, 1 `9 Any`, 1 rarity. **The board's
  92 came from not trimming trailing whitespace** — one recipe writes `15 Any  `
  and splits off as its own bucket. The O2 argument is unaffected.
- **The corpus is 49,345 lines over 388 set codes — and the board's 47,315/375
  were wrong for a findable reason.** The tracker first *reproduced* 47,315,
  then found why: three cubes (`MTGO Grixis Cube`, `MTGO Grixis Cube 2019-09`,
  `Old School 93-94 … 878 Card Cube`) write card lines **with no leading
  count** — `Abbot of Keral Keep|ORI`, not `1 Abbot …`. Any regex requiring
  `^\d+\s+` silently drops all three, i.e. **1,958 lines and an entire 878-card
  cube**. 47,387 − 72 bare = 47,315 exactly. Lane A's parser handles the
  countless form, which is why its number is the right one. Likewise **388**
  set codes, not 375, and not 720: **3,991 lines carry a third
  collector-number field**, so splitting on the *last* `|` counts collector
  numbers as sets. Take field `[1]`.
- **`res/draft/`'s extra entries are a `rankings/` DIRECTORY plus
  `rankings_cubecobra.txt`**, not "1 `.rankings` + 1 `.txt`" as the board said.
  `ls -F` shows the trailing slash.
- **`ApiType` is three counts, not two** (lane E's refinement, re-counted here):
  **206** `.java` files in `effects/`, **202** `ApiType` constants, **200**
  *distinct* classes. 202 > 200 because `CharmEffect.class` is named **4×**
  (lines 47, 216, 217, 218); 206 > 199 because **seven** files are never named
  — the seventh being `CountersNoteEffect`, whose constant is commented out at
  `ApiType.java:137`. *(Corrected 2026-09-14: this line said 200/six.)* The
  board previously said "202, not 206", which reads as a 202-of-206 subset and
  is not one.
- **W1 and W2 are both closed by watchparty's own `e58e3005`, landed mid-wave.**
  `emit.ts:121 export function emitPerRecipient` (plus `emitToRole:148`) and
  `rooms-protocol/src/resync.ts` exporting `classifySeq`/`needsResync`/
  `resolveIdentityReassert`, re-exported at `index.ts:15`. Their `main` moved
  `624091b8` → `98610f42` **while lane E was writing the delivery**, which is
  the same staleness lane E was correcting P3 for.
- **Lane E's delivery is committed but has never been sent.** `git
  for-each-ref` on `cardtable-w2-requests` shows **`upstream=[]`**; their `main`
  is untouched by us. Committed ≠ delivered.
- **P1 and P2 are both still open**, re-checked at closing: `NODE_AUTH_TOKEN`
  **unset**, bare `npm view @wolffm/rooms-protocol version` → **E401**, `gh
  secret list` → **empty**.
- **No TODO/FIXME/XXX in source** (`grep -rn` over `packages/ apps/ scripts/`,
  exit **1** read directly, not through `head`). **No open issues.** Tree clean.
- **Both safety controls bite** — the tracker re-ran the mutations, it did not
  take the counts on trust. D13 no-images: injecting `image_uris`/`.jpg` into
  `resolve.ts` flips the grep to exit 0 **and** fails the test; restored, grep 1
  / test 0. Spectator leak: injecting seat 3's 19-card pool into the spectator
  fixture fails the suite (exit 1); restored, exit 0. Lane D's
  `run.sh verify-pristine`: clean 0, dirtied **1**, restored 0.

## Verified in the previous pass (2026-09-14 — tracker, planning Wave 2)

Every line below was run by the tracker at planning time, not taken from a
report. Four of them contradict the board as it stood.

- **The remote exists and CI is green.** `WolffM/hadoku-cardtable`, **private**,
  created 07:26 on 2026-09-12; `origin/main == local main` (`df26cbd`);
  `gh run list` shows **4 runs, all success**. The board said "no remote" and
  "workflow has never run". O1's repo half is done.
- **…but `gh secret list` is EMPTY.** `HADOKU_NPM_READ_TOKEN` is not set. CI is
  green only because no `@wolffm/*` dependency exists. **The row was true and
  vacuous at the same time**, which is the exact failure class watchparty's own
  closing note warns about — a gate reporting success while doing nothing.
- **Watchparty published.** `rooms-protocol`, `rooms-server`, `watchparty-ui`
  all at **`0.38.109`**, read from the tarballs. **`@wolffm/rooms` was renamed
  `@wolffm/rooms-protocol`** — the old name is still E404, which is why the
  watch read as blocked.
- **The E401 is an unsubstituted env var, not a dead token.** `~/.npmrc` line 1
  is `//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}` and the variable is
  **unset**, so npm sends the placeholder string as the credential. pnpm warns
  `Failed to replace env in config: ${NODE_AUTH_TOKEN}` on every install.
  `NODE_AUTH_TOKEN=$(gh auth token) npm view @wolffm/rooms-protocol version`
  → **`0.38.109`**. Also worth keeping: **E401 ≠ E404** — a 401 means the
  package exists, which is what disproved the "still blocked" reading.
- **`SKIP` is exported without `emitPerRecipient`.** `rooms-server@0.38.109`
  `emit.d.ts:34` declares the sentinel and points at a function that is in
  neither `emit.d.ts` nor `index.d.ts`. → W1.
- **They shipped our P3 correction.** `EmitPolicy`'s own doc comment says the
  hardcoded list *"would have silently dropped a card game's state deltas as
  'low priority'"*, and `lowPriorityOrder` is documented *"An event in neither
  list is never dropped"* — the D11 correction, now in their code. `thresholdBytes`
  **is** the queue bound our corrected P3 §2.2 asked for. **So P3 must be trimmed
  before delivery**, or we ask them for what they already shipped.
- **O2, settled on evidence.** `BoosterDraft.java` = 925 lines in **`forge-gui`**,
  17 `SGuiChoose`/`SOptionPane` call sites, `FModel` singleton. Reusable core is
  5 methods. Cube pack recipes across all 94 files: ~~92~~ **91
  `Booster: 15 Any`** (corrected above — trailing whitespace on one recipe),
  93/94 singleton, 93/94 3×8, **1** with rarity slots, 7 keys total — and an
  8th, `CustomRankings`, which lane A found in `CustomLimited.java:123`. The O2
  conclusion is unchanged.
- ~~**Card resolution is the real lane-A risk:** **47,315** set-qualified card
  lines vs **72** bare names, over **375 distinct set codes**.~~ **The risk call
  was right; two of the three numbers were wrong.** Corrected in the Wave 2
  ledger above to **49,345** lines / **49,273** set-qualified / **388** set
  codes. Only the **72** bare names survived re-counting.
- **`SimulateMatch.java` is the headless precedent** — 404 lines, `case "sim":`
  implemented right beside the unimplemented `case "server":` at `Main.java:111`.
- **`GameModule.tsx` is 1,341 lines, not 1,344**, and lines 129-133 state the
  iframe *"can't touch this app's Socket.io connection"*. That is what settles W2.
- **No TODO/FIXME in source, no open issues, no stale worktrees, tree clean.**

## Verified in the previous pass (2026-09-12 — Wave 1 manager, re-run from artifacts)

Every one of these was re-run by the manager, not taken from a lane's report.

- **`pnpm check` bites.** Not vacuous: typecheck→exit 2, lint→exit 1, test→exit 1
  under injected faults, all restored to 0.
- **The D13 no-images control is real, both halves.** Sneaking `'image_uris'`
  onto the allowlist fails 1/7; making `projectCard` a `{...raw}` pass-through
  *also* fails 1/7. The second is the one that matters — a static allowlist
  assertion alone would pass while the projection leaked everything.
- **TeaVM NO-GO reproduces.** `run.sh wasm` exit 1, exactly 30 distinct missing
  APIs, 0 tinylog-attributable, 11 in `java.util.concurrent`, 7 Guava.
- **`teavm-classlib-0.15.0.jar` has 0 entries under `java/util/concurrent/locks/`**
  and 14 types in `java.util.concurrent` — read out of the jar.
- **`ApiType` is 202 constants**, not 206. `docs/WASM_AND_PORTING.md` still says
  206 and was owned by nobody this wave — ~~**stale, needs fixing.**~~ **Fixed
  2026-09-14 by Wave 2 lane E (`e5102de`)**, and refined: it is **three** counts
  (206 files / 202 constants / **199** distinct), not two. `CLAUDE.md` still carries
  the old 206 — see the watch.
- **`res/cube/` = 95 `.dck`**, not 96; `res/draft/` = 96 entries (94 `.draft`).
- **Scryfall:** no UA/Accept → 400 with Scryfall's own error text; honest UA +
  Accept → 200; `server: cloudflare`.
- **watchparty `safeEmit.ts:32-48`:** unlisted events take `idx === -1` and reach
  `socket.emit` at line 48. **Never shed.** Their §4 and our D11 were wrong.
- **`forge/` is byte-for-byte pristine** after the whole spike — 0 dirty lines,
  HEAD still `2cd497c`. Every build ran against a `cp -a` copy in `~/.cache`.
- **No AI attribution** in any of the six commits; all authored `WolffM`.

## Verified in the previous pass (2026-09-11)

- `@wolffm/rooms` and `@wolffm/rooms-server` → **E404**. Pre-package confirmed.
- Watchparty `rooms/p0-participant-identity` worktree is at `39e47007`, same as
  main — their "P0 is underway" means scaffolded, **not** started.
- `mvn` absent; Maven installable user-local without sudo (D14).
- `forge/` is stock upstream, untracked, unmodified — nothing to fork from yet.
- Forge module LOC re-measured correctly after a bad `xargs`/`tail` count:
  `forge-game` 127,083 · `forge-gui-mobile` 103,038 · all-but-mobile-platforms
  516,450.
