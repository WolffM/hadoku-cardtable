# Per-game RNG — every game draws from its own random

Step 3 of `docs/planning/forge-hosting-plan.md` (§4, §5 "Exact replay"), 2026-10-25.
Fork branch `rng-per-game` on WolffM/forge, **`7878fe7546132874e158c5cf8b62c4bc8e593e83`**
(pin `9e5f5b75` + 2 commits). Proof ran on claw-8 (8 cores, CI jobs alongside: the
load column in `per-game-rng/runs.txt`'s source runs was 2.5–20).

## Answer

- Each match owns a `Random`; every thread working for one of its games draws from
  it through the unchanged `MyRandom.getRandom()`, so the ~286 call sites did not
  change. Code outside any game keeps the JVM-wide random.
- **VERIFIED:** 32 AI-vs-AI games run at once in one JVM are each identical (full game
  log + final state, hashed) to the same seed run alone; so are 16 at once (three
  repeats) and 8 at once. The same seed alone is identical across three separate JVMs
  and within one JVM.
- **VERIFIED:** a seeded game plays exactly as it did on the stock pin: 24 seeds give
  the same hash on stock `9e5f5b75` and on `7878fe75`. The stream is not re-seeded or
  re-ordered, only isolated.
- **VERIFIED RED:** on the stock pin, 8 and 16 games at once differ from their solo
  runs in **every** game (8/8, 16/16). The harness detects cross-talk.
- Two causes had to be fixed, not one. The shared `MyRandom` was the obvious one. The
  second was **`AiCache`, a JVM-global cache that every AI cleared at the start of
  every decision**: game A's AI wiped game B's cached board evaluation, B recomputed it,
  the recomputation drew extra random numbers (`ComputerUtilCombat.lifeInDanger`), and B
  played differently. With only the RNG fixed, 2–4 of 16 concurrent games still
  diverged; with the cache per game, 0 of 16 ×3 and 0 of 32.

## Design

`forge-core/.../util/MyRandom.java`:

- `getRandom()` answers the random this thread is **bound** to, else the JVM-wide one.
- `bind(Random)` → an `AutoCloseable` `Scope`; scopes nest and restore what they
  replaced; `bind(null)` unbinds for the scope.
- `propagate(Runnable|Callable)` wraps a task with the **submitting** thread's binding,
  applied on whatever thread runs it, for as long as it runs. `bindTo(Random, task)`
  does the same with an explicit random. Binding travels with the task, never with the
  thread: pools reuse threads, so an `InheritableThreadLocal` would hand a reused
  thread the wrong game.
- `setRandom` sets only the JVM-wide random. Inside a game it changes nothing that game
  draws (`MyRandomTest.bindScopesNestAndRestore`).

Where the bindings are made (all in the fork):

| Where | What |
| --- | --- |
| `Match` | owns `random`. Its constructor adopts the creating thread's bound random if there is one (a simulation's or snapshot's copy shares the real game's stream, as it always did, and a host seeds a match by binding before creating it); otherwise `new Random(MyRandom.getRandom().nextLong())`, so a JVM seeded with `setRandom` (`SimulateMatch`) still plays the same way. `setRandom(Random)` seeds explicitly. |
| `Match.createGame` | binds the match's random while the `Game` is built (an AI's random profile, avatars). |
| `Match.startGame` | binds it for the whole game on the calling thread. |
| `Game.getRandom()` | its match's random. |
| `GameAction.invoke` | wraps the proc in `bindTo(game.getRandom(), …)` on both paths: the caller may be a UI/Netty thread working for no game. |
| `AiController` eval thread | `new Thread(MyRandom.propagate(future), "Game AI Eval")`. |
| `AiAttackController` pool | each task is `MyRandom.propagate(...)`d when it is added. |
| `SpellAbilityPicker.evaluateSa` | binds a fresh `Random(seedFromGameStream)` per simulation instead of swapping the JVM-wide one (which would no longer reach a bound thread, and raced other games before). |
| `AiCache` | per game (`Cache<Game, …>` with weak keys); `getCached(Game, key, …)`, `clear(Game)`. |

The bridge (`apps/server/src/play/bridge/PlayBridge.java`, `startMatch`): the seed
block builds `seeded = seed == null ? new SecureRandom() : new Random(seed)`, wraps it
in `RiggedCoinToss` when a `chooser` is set, and **binds it to the starting thread**
from where it used to call `setRandom` until `start.run()` returns. Everything that
used to draw from the seeded global on that thread (slot setup, `lobby.startGame()`,
`HostedMatch`'s `new Match`, which adopts the binding) draws from it now; the game
thread gets it through `Match.startGame`/`GameAction.invoke`. The precon pick keeps its
own `random`. lane-multimatch moves this block into its per-match `play()` with the
scope opened at the same point and closed in a `finally` (agreed 2026-10-25).

## Proof

Harness: `scripts/stress/src/ForgeReplay.java` (`run.sh replay <claw> <label> …`).
Fixed-seed AI-vs-AI games on the 16 cube decks (game *i* plays deck pair *i* mod 8),
solo (one after another) or all at once, one `GAME` line each: a 16-hex SHA-256 of the
full game log plus the final state (turn, phase, life, poison, and every card of
library, hand, battlefield, graveyard and exile in order, with id, tapped state and
counters), and `ai_timeouts`, the 5 s cutoff firing for that game. It seeds through
`Match.setRandom` when the jar has it and otherwise the JVM-wide `MyRandom`, so one
source runs on both pins. All `GAME` lines: `per-game-rng/runs.txt`.

| Run | Jar | Seeds | Result |
| --- | --- | --- | --- |
| a. solo ×2 in one JVM, and a second JVM | `a401b5d0` (RNG only) | 101–108 | 16/16 and 8/8 identical |
| b. 8 at once | `a401b5d0` | 101–108 | 8/8 identical to solo |
| c. stock solo ×2, second JVM | stock `9e5f5b75` | 101–108 | identical to each other **and to the fork's solo hashes** |
| c. stock 8 at once | stock | 101–108 | **8/8 differ** from solo |
| 16 at once ×3 | `a401b5d0` | 201–216 | 2–4/16 differ each time — the `AiCache` leak below |
| 16 at once ×3 | `7878fe75` | 201–216 | 16/16 identical, all three |
| stock solo / stock 16 at once | stock | 201–216 | solo identical to `7878fe75` solo; at once **16/16 differ** |
| 8 at once | `7878fe75` | 101–108 | 8/8 identical to solo |
| 32 at once vs solo | `7878fe75` | 301–332 | 32/32 identical; longest game 40 s |

`ai_timeouts=0` in every game of every run: the cutoff never fired, so these games are
the ones that should be reproducible. Unit tests in the fork, all green on claw-8
(`mvn -pl forge-gui-desktop -am clean package -Dtest=MyRandomTest,GameRandomTest`):

- `forge-game/src/test/java/forge/util/MyRandomTest` — outside a game draws the global;
  scopes nest and restore, `setRandom` inside a game leaves the game's stream alone; a
  task submitted from two games and from outside runs on one **reused** pool thread
  with each submitter's binding (the attack pool's shape); a spawned thread
  (the eval thread's shape) runs with its spawner's.
- `forge-gui-desktop/src/test/java/forge/ai/GameRandomTest` — a whole AI-vs-AI game
  with the JVM-wide random replaced by a recorder: zero draws fall through to it from any
  thread working for the game, the game thread and an `Game AI Eval` thread both draw
  from the match's random; the same seed plays the same game twice; a match owns or
  adopts its random; one game's `AiCache.clear` leaves another game's entries.

### How the `AiCache` leak was found

`-Dreplay.trace=true` writes every draw of a game's random with its thread and Forge
caller frames. On `a401b5d0`, seed 214 solo and at once agree for 102 draws; at draw
102 the concurrent run makes one the solo run never made:

```
102 Game AI Eval ComputerUtilCombat.lifeInDanger:445 … ComputerUtil.evaluateBoardPositionChanged:2953
    ComputerUtil.lambda$evaluateBoardPosition$21:2924 AiCache.getCached:40 ComputerUtil.evaluateBoardPosition:2923
    ComputerUtilCard.evaluateRemovalTargetPriority:611 … DamageDealAi.canPlay:274 … AiController.canPlaySa:903
```

— a cache miss where solo had a hit. Seed 208 parts at the same frame. `AiCache.dataMap`
was static (`forge-ai/.../AiCache.java:16`) and `AiController.chooseSpellAbilityToPlay`
cleared all of it (`AiController.java:1352`).

Ruled out on the way, by measurement: the JVM-wide ability id counters. Building 7 or
1000 throwaway cards before each solo game (which only advances `SpellAbility`,
`Trigger`, `ReplacementEffect` and `StaticAbility` ids) left all 16 hashes unchanged.

### The bridge

One `forge.yml` dispatch on `verify/lane-rng` (forge pin `7878fe75`, bundle built by
`forge-bundle.sh` on the claw): the jar-gated suites that exercise the seed, hand
smoothing and the chooser, and the seeded e2e specs —
[run 40280573266](https://github.com/WolffM/hadoku-cardtable/actions/runs/40280573266),
**green**, on `2d2c0c8f` (`CARDTABLE_FORGE_JAR` = the `7878fe75` bundle, built in that run):

- forge-jvm: `seed`, `hand-smoothing`, `w71-chooser`, `precon-pick`, `match`, `mulligan`,
  `mulligan-cap`, `scenario-harness`, `reload` — 9 files, **30/30 tests passed**, none
  skipped. `seed` (one seed, one deal, twice) and `hand-smoothing` (filtered hands and
  weighted redraws on fixed seeds) are the seeded ones; `w71-chooser` the rigged toss.
- forge-e2e: `play`, `w33`, `af64-mulligan-order`, `aa-ai-beats` — **14/14 passed**,
  `skipped 0`.

The stock-vs-fork parity above (same hash for every seed) is the stronger statement
for "seeded matches behave exactly as before"; these suites show the bridge's
binding reaches Forge's game thread with the seed and the rig intact.

## What is NOT reproducible yet, and why

- **The AI's wall-clock cutoff.** `AiController.java:1686` waits
  `game.getAITimeout()` (5 s) for the eval thread; when it fires, the decision and the
  number of draws depend on how far the thread got, and the cancelled thread may keep
  drawing while the game moves on. Likewise the attack pool's `invokeAll` timeout
  (`AiAttackController.java:949`). Plan §5's AI-decision recording is the fix: replay
  the answers, not the computation. `ForgeReplay` reports `ai_timeouts` per game.
- **Human seats.** What a human does and when is input, not randomness: replay needs
  the decision log. Also time-dependent on a human's priority: our
  `AvailableActions.walk` deadline (`AvailableActions.java:133`, `:515`) runs AI
  `canPlay` checks on the human's game thread, which draw from the game's random; the
  number of draws depends on whether the deadline fires. Deterministic when it does not.
- **The attack pool's parallel draws.** Its tasks run on several threads at once; if
  two draw from the game's random concurrently their order is a race. Not observed
  (every run above agrees), and ASSUMED rare: the tasks only classify forced attackers.
- **Hash order.** `SpellAbility`/`Trigger`/`ReplacementEffect`/`StaticAbility` hash
  with `Objects.hash(X.class, id)` (`SpellAbility.java:224` and siblings), and
  `Class.hashCode` is an identity hash that differs between JVM runs; ids come from
  JVM-wide counters (below). Iteration over a `HashSet`/`HashMap` of them could differ
  between JVMs. Not observed in 3 separate JVMs × 24 seeds; ASSUMED low risk, and the
  first thing to suspect if a cross-JVM replay ever parts.

## Audit: every other randomness source a game can reach

At pin `9e5f5b75`. "Fixed" means in `rng-per-game`.

| Source | Where | On a game's path? | Status |
| --- | --- | --- | --- |
| JVM-wide `MyRandom` | `forge-core/.../MyRandom.java:34` | yes | **fixed** (per-game binding) |
| `AiCache` global, cleared by any AI | `forge-ai/.../AiCache.java:16`, `AiController.java:1352` | yes | **fixed** (per game) |
| `SpellAbilityPicker` swaps the JVM-wide random | `forge-ai/.../simulation/SpellAbilityPicker.java:357`, `:368` | AI simulation only | **fixed** (binds per simulation) |
| AI eval thread | `AiController.java` (`new Thread(future, "Game AI Eval")`) | yes | **fixed** (propagate) |
| Attack pool | `AiAttackController.java:876`, `:949` | yes | **fixed** (propagate at submission) |
| `GameAction.invoke` hop to the game pool | `forge-game/.../GameAction.java:2508` | yes | **fixed** (bindTo the game) |
| `ThreadUtil.invokeInGameThread` direct | `InputConfirmMulligan.java:121` (Serum Powder), `InputPassPriority.java:313` (mana-lost prompt) | human input | runs unbound; neither draws (exile + draw; a confirm then a pass). Matters only if one ever gains a draw. |
| `Math.random()` | `forge-core/.../item/BoosterSlot.java:48` | no (boosters) | not a game; left |
| `BagRandomizer` own `SecureRandom` | `forge-core/.../util/BagRandomizer.java:15` | no (chaos boosters) | left |
| `new Random(seed)` | `forge-gui/.../quest/setrotation/QueueRandomRotation.java:28` | no (quest) | left |
| `Collections.shuffle` without a `Random` | `DeltaSyncManager.java:530`, `:545` | network checksum sampling, not game state | left; changes which properties are checksummed, not the game |
| same | `ServerGameLobby.java:270` | draft seats, not a game | left |
| same | ~20 more in `forge-gui` limited/quest/deck generation | no | left |
| `MyRandom` in lobby/GUI code | `GamePlayerUtil.java:52` (AI avatar/sleeve), `MusicPlaylist.java:62` | before the game, on the starting thread | bridge: drawn from the match's random (bound from the old `setRandom` point), as before |
| `PoolService` seeds the JVM-wide random | `apps/server/src/play/bridge/PoolService.java:327` | no (draft pools) | correct while one request runs at a time; two concurrent pool requests in one JVM would share it — a pool-service concern, not a game's |
| `SimulateMatch` seeds the JVM-wide random | `forge-gui-desktop/.../view/SimulateMatch.java:89` | its matches | still reproducible: an unbound `Match` seeds itself from the global |
| Ability id counters (non-atomic `++maxId`) | `SpellAbility.java:79`, `Trigger.java:55`, `ReplacementEffect.java:50`, `StaticAbility.java:54`, `SpellAbilityStackInstance.java:41`, `Game.java:67` | yes | **measured harmless** to determinism (above). Non-atomic increments across games can hand two games the same id; ids compare only within a game. Left. |
| Identity-hash ordering | `Objects.hash(X.class, id)` hashCodes | yes | see "Hash order"; left, not observed |
| `Deck` lazy section load, unsynchronised | `forge-core/.../deck/Deck.java:288` | a shared `Deck` opened by two matches at once | harness bug found here (a player dealt an empty library); `ForgeScale.loadDecks` now loads sections first. The bridge parses a fresh `Deck` per match, so it cannot hit this. |
| Static UI caches | `Card.java:7453` (`cp2card`), `Keyword.java:295` | UI / pure lookups | unsynchronised `HashMap`s shared by every game; no effect on play, a thread-safety note for many matches per JVM |
| Wall clock | `AiController.java:1686`, `AiAttackController.java:949`, `AvailableActions.java:133` | yes | see "NOT reproducible" |
