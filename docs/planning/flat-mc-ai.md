# Flat Monte Carlo AI: measured, not on yet (2026-11-09)

Upstream Forge's Flat Monte Carlo AI (`81628c048c` and ~22 more, synced on 2026-11-08) plays each
option of an AI decision out a few times on a copy of the game and takes the best. The operator
wanted it on (*"seems nice, let's get that also"*), after a measurement. This is that measurement.

**Outcome: it stays off.** Two findings:

1. On today's pin every level fills a JVM's 2 GB heap within minutes, because of **a leak in our
   own fork** (`AiCache`, below). The fix is fork branch `cardtable/aicache-per-game`
   (`21ad8f3ae3`, on pin `c0275250da`); it also stops today's heuristic AI keeping one finished
   game per match, so it belongs in the next pin whatever happens to Flat MC.
2. On the fixed jar, `base` (the only level a person would not notice waiting on) won 196 of 378
   games against the plain AI: 51.9 %, 95 % interval 47–57 %, not distinguishable from even. It
   costs ~2× the AI's CPU and a 5–15 s stall about once in 330 decisions, for no measured gain.

The setting is ready, `CARDTABLE_AI_FLAT_MC` (default `off`), for when upstream's search is worth
it: a rerun is `ForgeScale -Dstress.flatMcAb=true` on the pin of the day.

## The setting

`CARDTABLE_AI_FLAT_MC` = `off` | `base` | `lite` | `max` (`apps/server/src/play/local-jvm.ts`,
`AI_FLAT_MC` is the default, `off`). The server sends it with every match's `start`
(`host.ts`'s `bridgeConfig`, logged on `match-placed` as `aiFlatMc`), and the bridge sets the
game's three Flat MC fields in its start-game hook (`PlayBridge.java`, `MatchContext.aiFlatMc`).
A server restart therefore flips it for every match started after, JVMs already running too.
Anything that is not a level reads as `off`. Bot-vs-bot pod games (`botgames.ts`) never use it:
no one waits on them, and their rollouts would take CPU from human matches on the same JVM.

| level | what Forge does (`FlatMonteCarloPicker.Config`) |
| --- | --- |
| `off` | the heuristic AI alone (today) |
| `base` | the AI profile's own search: 5 lines × 4 samples, 450 ms a decision, 2 s a turn |
| `lite` | Forge's phone setting: base + the attack search, 600 ms / 2.5 s, the opponent's next turn for ≤ 3 lines |
| `max` | Forge's desktop setting (what HostedMatch picks on a non-mobile GUI): 8 × 8, 1.5 s / 6 s, the opponent's turn always |

## How it was measured

`scripts/stress/src/ForgeScale.java` (hosting-test-plan's harness): N concurrent matches in one
JVM, a paced stand-in for the human (2–15 s per decision) against the AI, held for a fixed wall
time with churn. New: `-Dstress.flatMc=<level>` sets the game's fields as the bridge does (paced
seats never run it), and `-Dstress.flatMcAb=true` (full mode) plays Flat MC against the plain AI on
the same deck pairs, the Flat MC seat swapped every lap, and counts wins. Run on claw-1 under a
lease drain (the win rate on hokon, below), the prod slice: 4 CPUs, 4 GB, `-Xmx2048m`, 25 matches (`MATCHES_PER_JVM`), the 16
cube decks in `scripts/stress/decks`. Commands: `~/.cache/lane-flatmc/drive*.sh` in the closing
note; `run.sh run claw1 <tsv> <label> 4 4G 2048m -Dstress.matches=25 -Dstress.flatMc=<level>`.

## Pin `c0275250da` (today's): every level breaks the JVM

| 25 paced matches, 10 min | off | base | lite | max |
| --- | --- | --- | --- | --- |
| games failed (OutOfMemoryError) | 0 | 145 | 83 | JVM hung, no result |
| AI decision p50 / p95 / p99 | 1.2 / 4.4 / 12 ms | 4.8 / 2528 / 7092 ms | 2.8 / 4768 / 11958 ms | — |
| AI decision max | 209 ms | 14.5 s | 20.8 s | — |
| attack/block p95 | 24 ms | 1073 ms | 3279 ms | — |
| AI timeouts (5 s cutoff) | 0 | 75 | 100 | 95 by 571 s |
| cores busy (of 4) | 0.29 | 3.23 | 2.43 | — |
| CPU s per match-minute | 0.71 | 7.82 | 5.85 | — |
| GC share of wall time | 1 % | 73 % | 52 % | — |
| live heap after full GC | 352 MB | 2023 MB (cap) | 2012 MB (cap) | 2028 MB (cap) |
| median turns per game | 15 | — | 13 | — |

Lower load did not save it. With 8 paced matches the live heap after each forced GC climbed
without levelling off (lite: 203 → 665 → 1137 → 1867 MB over 10 min; base hit the cap at 6 min
and failed 43 games). Four AI-vs-AI matches filled 2 GB in 40 s at `max` and failed 624 of 637
games at `lite`. A heap that grows for as long as games are played is a leak, not a working set.

### The leak: our fork's per-game `AiCache`

A class histogram of 4 matches held 198 live `forge.game.Game` and 18,303 `Card`; a JFR
old-object sample of 2 matches (`path-to-gc-roots=true`) held 628 games and 80,645 cards, rooted
at `forge.ai.AiCache.byGame`. Our fork commit `7878fe7546` (*"AiCache is per game"*, for
per-game determinism, `docs/spikes/per-game-rng.md`) made upstream's global cache a
`Cache<Game, …>.weakKeys()`. Its values cache the AI's arguments and results, the game's own
players and cards, and those hold the game: each entry keeps its own key alive, so no game is
ever collected. With the heuristic AI that is one finished game per match (the slow climb of the
`off` arm), harmless while idle JVMs retire. With Flat MC every rollout is a new copy of the game,
and every copy stays.

Fix, `cardtable/aicache-per-game` on WolffM/forge: the cache lives on the game itself
(`Game.getAiCache`), so it dies with its game, a rollout's copy included. The determinism property
is unchanged (each AI clears only its own game's cache). `GameRandomTest.aGameIsCollectedThoughItsCacheHoldsItsOwnPieces`
fails on `c0275250da` (the game is never collected) and passes on the fix, with the other four
GameRandomTest cases (same seed, same game).

## The fixed jar: `base` holds, `lite` and `max` stall

Same harness, same slice, jar built from `21ad8f3ae3` on claw-5 (sha256 `e76b6356…d301`), 7 min an arm:

| 25 paced matches | off | base | lite | max |
| --- | --- | --- | --- | --- |
| games failed | 0 | 0 | 0 | 0 |
| AI decision p50 / p95 / p99 | 1.2 / 4.4 / 12.5 ms | 4.2 / 133 / 681 ms | 2.2 / 165 / 10790 ms | 2.5 / 212 / 11177 ms |
| AI decision max | 181 ms | 14.7 s | 18.8 s | 19.6 s |
| decisions over 5 s | 0 of 4438 | 25 of 8352 (0.3 %) | 134 of 5745 (2.3 %) | 160 of 6103 (2.6 %) |
| attack/block p95 / max | 22 / 87 ms | 12 / 307 ms | 73 / 14464 ms | 14 / 14254 ms |
| cores busy (of 4) | 0.32 | 0.69 | 0.47 | 0.57 |
| CPU s per match-minute | 0.77 | 1.67 | 1.14 | 1.37 |
| live heap median / max | 317 / 369 MB | 337 / 384 MB | 310 / 371 MB | 311 / 378 MB |
| GC share | 0.7 % | 1.1 % | 0.5 % | 0.7 % |
| median turns per game | 14 | 15 | 14 | 13 |

(Base made more decisions than lite or max in the same 7 minutes; its CPU is higher for that.)

- **Capacity:** unchanged at every level. The heap is flat and at most 0.69 of the slice's 4
  cores are busy at 25 matches, so `MATCHES_PER_JVM` (25) stands. Flat MC costs about 2× the
  AI's CPU, and the AI's CPU was never the limit.
- **The tail is the cost.** Forge's 5 s cutoff (`AITimeoutTracker`) does not interrupt one
  rollout already playing, and one rollout can take 3–4.5 s against a 450–600 ms budget. In
  `lite` and `max`, 131 of 163 slow decisions were inside `FlatMonteCarloPicker.withOpponentTurn`,
  the look at the opponent's next turn (base never does it). A person waiting 10–19 s on 1 AI
  decision in 40 is a noticeable change from today's 0.2 s worst case, so `lite` and `max` fail
  the bar. `base` stalls 5–15 s once in ~330 AI decisions (`FLATMC-SLOW MAIN 3743ms … rollouts=1`).

Of the levels, only `base` passes on wait: p95 133 ms is invisible beside the board's own
animations, p99 0.7 s is a pause, and capacity does not move. Its rare long stall is upstream's: a
rollout that honours the deadline would remove it.

## Does it play better? Not measurably

`base` against the plain AI, AI vs AI at full speed, the same 8 deck pairs with the Flat MC seat
swapped every lap (`-Dstress.flatMcAb=true`), fixed jar, 2 matches at a time for 25 min (run on
hokon at the operator's word, capped at 2 cores and niced, 2026-11-10):

| | Flat MC (base) | plain AI |
| --- | --- | --- |
| wins (378 games, 0 failed, 0 draws) | **196 (51.9 %)** | 182 |
| AI decisions | 201,620 | 79,273 |
| decision p50 / p95 / max | 3.6 / 186 / 4308 ms | 0.7 / 5.3 / 407 ms |

51.9 % over 378 games is 0.7 standard errors from even. Flat MC's own count says why: of its
decision points it kept the heuristic's play 9,814 times, held 11,888 times, had one candidate
5,986 times, and overrode the heuristic 1,590 times (`FLATMC-REASONS`). A cube deck's turn
rarely has two plays far enough apart for a few short playouts to tell them apart.

**Choice: `off`.** The cost is real (CPU, the rare stall, AI choices that vary with load in
scripted e2e), and the gain is not measurable. `lite` and `max` fail on wait before win rate
matters.

## Not measured

- A real bridge match's own timings with Flat MC on (the bridge adds a socket and a browser
  round trip, never AI time). After the pin move, one PPE match vs the AI with
  `CARDTABLE_AI_FLAT_MC` set reads its `match-frames` timings.
- Whether Flat MC changes a scripted e2e scenario's AI choices: its search is wall-clock budgeted,
  so its choices vary with load. A default other than `off` needs a full Forge run (`-f full=true`).
