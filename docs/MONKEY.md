# The monkey seat

A headless client that joins real vs-AI matches on a real running server —
over the actual socket protocol a browser speaks, through the e2e stand-in
edge, never an in-process shortcut — and plays to the end by picking a random
LEGAL answer to every ask Forge raises and a random legal board action
otherwise (land, spell, attacker, blocker, mana payment, pass). The goal
(the operator, 2026-10-26): find the next soft lock — a card or an ask shape
the UI cannot answer — before a player does.

Code: `games/magic/server/src/play/monkey/`. It lives under `games/magic/server/src/` rather
than `scripts/` because its wire transport needs `socket.io-client`, which is
a real dependency of `@hadoku/magic-server` and not resolvable from a bare script;
the rest of it reaches into `games/magic/ui/src/play/live/match.ts` and
`games/magic/ui/src/play/prompts/rules.ts` for the exact same functions the real
board and prompt components call, so "legal" is never a second model of
Forge's rules — see each file's own header.

## Running it

```sh
export PATH="/home/hadoku/.local/share/fnm/node-versions/v24.18.0/installation/bin:$PATH"
export CARDTABLE_FORGE_JAR="$HOME/.local/share/cardtable/jars/<THIS WORKTREE'S PIN>.jar"   # git ls-tree HEAD forge
export CARDTABLE_FORGE_RES="<a forge-gui/res with cardsfolder/>"                            # see the warning below
pnpm --filter @hadoku/ui build && pnpm --filter @hadoku/server build

apps/server/node_modules/.bin/tsx games/magic/server/src/play/monkey/cli.ts \
  --seed 1 --sample 8 --matches-per-deck 1 --out /tmp/monkey-report.json
```

**The jar must be built from THIS checkout's own forge pin.** The bridge
(`games/magic/server/src/play/bridge/PlayBridge.java`) is compiled fresh against
whatever jar `CARDTABLE_FORGE_JAR` names, against the bridge SOURCE in this
checkout — so a jar built from a different Forge pin than the one this
checkout's `PlayBridge.java` was written for fails with a Java compile error
naming the moved API (`bridge.stderr.txt`), not a card-logic problem. This bit
once while proving this tool: the deploy tree's `forge/` pin and this repo's
own `forge` submodule pin can differ (several lanes bump it independently),
so `~/.local/share/cardtable/jars/<pin>.jar` for `git ls-tree HEAD forge`'s
own hash is the one to use, built if missing
(`docs/FORGE_JAR.md`/`scripts/forge-bundle.sh`). `RES` only has to carry a
`cardsfolder` — it does not have to be at the exact same pin, because nothing
here is testing one card's specific behaviour.

### Flags

| flag | what it means | detected from |
| --- | --- | --- |
| `no-legal-answer` | an ask demanded more answers than it offered (the client-side mirror of the server's own `ask-unanswerable`/`auto.ts`'s `answerability`) | the ask's own `min`/`max`/`optionList` |
| `stuck` | no progress for `--stuck-ms` (default 20 s) while an ask was open, or this seat's input was live and either Forge gave it priority or its bar or board offered a press. A seat waiting under a dead "Waiting for …" bar while the other player holds priority is not stuck, however slow they are; a game that stopped there is `no-finish` | the ask's `callId`, or Forge's view seq, turn and phase + the button bar + selection size + the cards picked into it so far, unchanged (`isBlocked`, `signatureOf`) |
| `click-refused` | the server (Forge's `flashIncorrectAction`) or this client's own guard refused an answer — not the server's `cause: 'unpayable'` flash, which is it cancelling a cost nothing can pay (e2d49c260), a handled case (`isRefusal`) | the wire tap on `forge:s2c`, and `selectCard`/`selectPlayer`/`pressButton`/`answerAsk`'s own return value |
| `loop` | a DECLINED optional ask came back with the same method and the same offered shape three times running, AT THE SAME turn and phase, with no act of this seat's own in between (a click on the same card again opens a new question, not the old one coming back; a `tempShowZones` that recurs every cleanup step by design is excluded outright) | `declineStreak` in `seat-driver.ts` |
| `server-unclassified` | the server logged `ask-unclassified` for this match — a question `answerability` has no rule for. Not `ask-unanswerable`: that is the server answering, by its own rule (7f343ec90), a question no seat could (`serverFlagsOf`) | the running stack's own JSON log file, tailed per match |
| `no-finish` | the match never started (`POST /api/play/matches` refused it for a reason other than a 503), the connection broke (`report`'s `disconnected`, `snapshot-failed`, `no-snapshot` or `stale-build-reload`; a `slow-connect` or one `connect-error` is a board noting its connect while it keeps trying, and ends nothing), one turn went on past `--turn-stall-ms` (default 300000), the server ended the match itself (its `ended` notice, as `Match.fail` sends when Forge stops: the flag quotes it, and the match's outcome is `crashed`), or the match ran past `--match-timeout-ms` (a backstop, default 30 s per turn of the turn cap). Reaching `--turn-cap` (default 60) ends a match as `turn-capped` and a run's `--budget-ms` running out ends one as `cut-short`; neither is flagged, since a long game is not a finding | `run-match.ts` |

### Reading a report

`--out` is one JSON document (`report.ts`'s `MonkeyReport`): `seed`,
`decksCovered`, one `MatchResult` per match played (`matchId`, the two deck
names, `outcome`, how many decisions this seat made, and that match's own
`flags`), and a top-level `flagged` list with every flag from every match. The
human summary (printed to stdout, and the last thing a run prints) is the
same data as one line per flag plus an outcome tally.

A **503** from `POST /api/play/matches` (the server at its match ceiling,
draining, or without Forge or a JVM) is not a flag: it stops the run. No
further match is started, the ones already playing finish, `stopped` in the
report says why, and the CLI exits **2** (as for no Forge), not 1. Every
later start would be refused the same way — the nightlies of 2026-11-03..05
started ~1400 more after their first and flagged each one. Exit codes: 0
clean, 1 flagged, 2 could not run its matches.

Every match the run leaves unfinished (past its cap, or its connection
broke) is conceded and waited on, so it gives its slot back: a walked-away
match is kept for its holder, and the run is one holder, always online.

### Reproducing a seed

Every top-level `--seed` derives, per deck, a PER-MATCH seed
(`seedFrom(\`${seed}:${deckId}:${i}\`)`, `cli.ts`) — printed in the log line
`run <n>: <deck> (monkey) vs <opponent> (AI), seed <matchSeed>` and on every
flag (`Flag.seed`). To replay exactly one reported match:

```sh
apps/server/node_modules/.bin/tsx games/magic/server/src/play/monkey/cli.ts \
  --deck <the deck id from the match's log line or report> \
  --seed <the TOP-LEVEL seed the run printed, not the per-match one> \
  --matches-per-deck 1
```

The per-match seed is derived from the top-level seed and the deck id, so
naming the same deck under the same top-level seed reproduces the same
per-match seed and therefore the same run — moves, draws, AI, the lot
(`rng.ts`'s `makeRng`/`mulberry32` is deterministic). The opponent deck is
also picked by that per-match RNG, so it is reproduced too.

## The card sweep

The monkey finds what random play happens to reach. The sweep (`games/magic/server/src/play/monkey/sweep/`)
is the other half: it plays **every scripted card of one set on purpose**, one match per card, on
the same running stack, through the same client code and the same `driveSeat` loop, so each flag
above means the same thing. It exists for a set cube: before a set is drafted, every card in it
has been cast against real Forge and every question it raises has been answered by the client.

```sh
# the same env and builds as the monkey, above
apps/server/node_modules/.bin/tsx games/magic/server/src/play/monkey/sweep/cli.ts \
  --set BLB --out /tmp/sweep-blb.json            # every scripted card, both variants
  # --card "Parting Gust" (repeatable)  --variant accept|decline  --concurrency 2  --seed 1  --per-match 1
```

The card list is the `[cards]` section of the edition whose `Code=` is `--set`, read from the
`res` the match runs on (`set-cards.ts`); a card whose script is keywords only (a vanilla or
french-vanilla creature, a basic land) is left out unless named with `--card`.

Each card is played on one fixed board (`board.ts`): the card in hand on the seat's own main
phase, four of each basic, creatures, an artifact and an enchantment on both sides, cards in both
graveyards and hands. The seat (`policy.ts`) clicks the card, answers what the cast asks, passes
until it resolves, clicks the card on the battlefield while it is offered (a Class's levels, an
ability), then plays two more turns, attacking with it, and concedes.

Every card runs twice. **`accept`** takes every optional question (promises the gift, pays the
offspring cost, picks a target that is "up to one", says yes to a "may"); **`decline`** refuses
every one.

`--per-match N` puts N cards in one match (their lands and the board are shared, `with` in the
report names the others). It is off by default because it did not pay: measured on Bloomburrow at
twelve a match, 114 of 514 plays asked what they ask alone (cards on one board change each other's
targets and triggers), the rest had to be played again alone, and the whole run took four times as
long as one card a match. `--concurrency` is the lever that works.

### Reading a sweep report

One JSON document, written after every match: `cards[]`, one `CardResult` (`run-cards.ts`) per card
and variant.

| field | what it says |
| --- | --- |
| `cast` | `resolved`, or why not: `not-offered` (the main phase never offered the card: the board lacks what it needs, or it needs a spell on the stack), `rolled-back` (the cast came back to hand) |
| `asks` | every question the seat was asked, in order: the ask's method, its own words and bounds and its first options, whether the seat declined it, and whether it came `during` the card's own `play` or the turns that `follow`. `method: "bar"` is a yes/no on Forge's two buttons; `"selection"` is a pick Forge opened on the board (a target, a cost) |
| `server` | what the server answered for the seat (`ask-auto-answered`, `auto-picked`, `auto-confirmed`, `ask-unanswerable`), with its reason |
| `board` | the board when the run ended, by card name: the difference from `board.ts` is what the card did |
| `flags` | the monkey's flags, plus `no-finish` when the card was not played and followed inside `--timeout-ms` |

A `decline` run that cancels the cast itself (Forge asks a spell's target and its X in the same
optional shape as a cost) casts the card again and takes the question it refused last.

### What each card is expected to ask

No flag means nothing got stuck. It does not mean the card still asks what it should: a gift
promised without asking, or an offspring cost the server pays for the seat, plays through cleanly.
So each run is reduced to a signature (`expected.ts`: how the cast ended, the questions of the
card's own play and which were refused, what the server answered in the seat's place) and checked
against `sweep/expected/<SET>.json`. A difference prints both sides and fails the run.

A recording is seed 1's boards (`RECORDED_SEED`): the targets a pick names, whether a sacrifice
cost has a nonland permanent to offer, which mode the seat picks all depend on it. So a run with
another `--seed` prints its differences and does not fail on them (on Bloomburrow, seed 1129 at
three a match, 23 of 514 plays differed this way and none was a card that changed). It still fails
on a flag or a broken keyword promise. `--update` refuses another seed. `--seed` reads digits as
the number a run printed (`seedArg`), so `--seed 1` is the recorded seed.

A play that differs is first played again alone, three times at most: a question can land a frame either
side of the click that answers it, and a card that really changed differs every time. The run says
which plays matched only on a replay.

The recording cannot catch a card that was already wrong when it was recorded, so a keyword that is
an optional cost is checked on its own, in any set (`mechanics.ts`: Gift, Offspring): the cast must
ask for it, `accept` must take it, and `decline` must be able to refuse it. A broken one prints
`MECHANIC <card> — <what>` and fails the run, recorded or not.

`--update` records instead of checking. Read the diff of the expectations file before committing
it: every changed line is a card that now asks something different.

Exit codes: 0 clean, 1 flagged, a keyword promise broken or differing on the recorded seed, 2 could not run. A `not-offered` card is not a flag
(nothing went wrong), and it is not covered either: it needs a scenario of its own.

## Decks covered

Every deck `GET /api/tables/decks` lists for the running server (`deck-pool.ts`)
— 1459 at this writing, the whole `@hadoku/deck/library` manifest. `--deck
<id>` runs one; `--sample <n>` runs a random `n`; neither flag takes every
one, in an order the seed shuffles. `--budget-ms` stops starting matches once
it is spent (the ones playing get 8 minutes more, then are conceded as
`cut-short`) and writes the report; the nightly CI job takes the whole library
with a 75-minute budget, so each night covers a different slice of it. Each run's seat 0 is the named deck; seat 1
(Forge's AI) is a second deck drawn by the same per-match RNG — so across many
runs every deck is played BOTH by the monkey directly and by the AI, though
within one run the monkey only ever holds seat 0. Two monkeys a match, one per
seat, is the next section's run.

## Two seats

`monkey/pvp/` plays the match a tournament table plays: two people, each driven by its own
`driveSeat` on its own socket and account, and a third account that joins the full match as its
watcher. Both seats' asks, holds and passes, the opponent's mirror and the watchers' channel are
the shared match's own.

```sh
# the same env and builds as the monkey, above
apps/server/node_modules/.bin/tsx games/magic/server/src/play/monkey/pvp/cli.ts \
  --set BLB --pods 2 --seed 1 --restart-every 3 --concurrency 2 --out /tmp/pvp-report.json
```

- **Decks.** Each pod is the server's set cube (`pod.ts`): the set's cards through `createSetsStore`
  and the e2e fixture catalog, dealt as 8 seats of 3 × 15, drafted by 8 bots, built by
  `botDeckText`. Its eight decks play four matches.
- **The start.** A match between two people starts from a room, and a room has no client outside a
  browser. So the probe stack's `{ opponent: 'human', scenario }` starts it: both decks shuffled by
  the run's random, seven drawn, turn 1's first main phase. No mulligan; everything after is the
  shared match.
- **Restart turn.** At each turn's start, one turn in `--restart-every`, the seat whose turn it is
  asks at a random point of the turn and the other seat allows. Behind the probe flag the server
  logs each turn-start snapshot's text (`play/match.ts`, `turn-snapshot`'s `state`). Each restart is
  checked against it (`restarts.ts`): the restored game's own first snapshot of the turn must equal
  the one it came from, card ids read through the names they are (`play/snapshot-text.ts`, which
  `restore.jvm.test.ts` checks with too).
- **Restart turn unavailable.** A turn whose snapshot cannot hold the game (`snapshot-lossy`) greys
  the button. The kinds name what the text cannot write, not the card, so each kind is charged,
  the turn it first appears, to the cards that arrived in a public zone since the snapshot before.
  The report's `tally` sums both across the run.

A finding (`findings.ts`, exit 1) is a driver flag, a restored turn that differs, an allowed restart
that never restored, a take-back the server refused (`restart-refused`, not `rate-limited`), or a
watcher that is not one or shows another turn or other lives than the seats. A lossy turn is not a
finding. CI: `forge-monkey.yml` with `pvp_args` (`gh workflow run forge-monkey.yml -f pvp_args="--set
BLB --pods 2 --seed 7"`) runs the `forge-pvp` job instead of the monkey; its report is the
`pvp-report` artifact.

## Proof

Local, clean: `--sample 3 --matches-per-deck 1` played three real matches
(49/115/104 decisions) to a real finish (`lost` all three — a random seat
loses to Forge's AI, which is the expected result and not itself a flag) with
zero flags.

Mutation evidence, each reverted before landing:

- **`stuck`** — `board-action.ts`'s `takeRandomBoardAction` forced to always
  return `null` (this seat never acts). A real match against the jar
  immediately produced `stuck` flags once this seat held priority with
  nothing happening, at `--stuck-ms 3000`.
- **`click-refused`** — `board-action.ts` forced to also click card id
  999999 (never offered by Forge) every tick. A real match against the jar
  flagged it on every single such click — 72 flags over 87 decisions — until
  the match timed out at its turn cap, both flags correctly raised. The
  SERVER-side half (Forge's own `flashIncorrectAction`, caught by the wire
  tap rather than this client's own guard) is the same code path
  `games/magic/ui/src/play/live/mistakes.ts` already proves against a real jar in
  its own test suite; not separately re-proved here.
- **`no-legal-answer`**, **`loop`**, **`server-unclassified`** — proved by a
  direct unit test of the pure function each flag is built on
  (`seat-driver.test.ts`, 13 cases, `CI=1 vitest run
  games/magic/server/src/play/monkey/seat-driver.test.ts`): the exact shape each
  flag is designed to catch (an ask demanding more than it offered; the same
  declined ask shape recurring three times at the same turn/phase; a fresh
  `ask-unclassified` log line for this match's id), and the exact shape
  beside it that must NOT flag (asking for what was offered; the same shape
  recurring across DIFFERENT turns, which is ordinary play; `tempShowZones`/
  `openZones` recurring by design; another match's log line).
- **`no-finish`** — a real match with a short `--turn-stall-ms` timed out and
  flagged `no-finish`. (`--turn-cap 1` no longer does: a game at the turn cap
  is `turn-capped`, unflagged.)

## CI

`.github/workflows/forge-monkey.yml`, a workflow of its own: the library in a
seed-shuffled order for a 75-minute budget, nightly at 07:30Z (the `30 7 * * *`
cron), two matches at a time with each Forge JVM capped at `-Xmx1g`
(`CARDTABLE_PLAY_JVM_OPTS`), on the per-pin bundle `scripts/forge-bundle.sh`
resolves for whatever commit is on `main` that night. A manual dispatch of that
workflow runs a sample of 8 by default (`monkey_sample`/`monkey_seed`/`monkey_deck`
inputs to narrow or reproduce). It gates nothing and reaches no fleet alert: a
flag shows red on the Actions tab and in the workflow's own history; that
alerting decision is the operator's to make.

The same workflow has a second job, `forge-sweep`: the card sweep on every set with a
`sweep/expected/<SET>.json`, nightly after the same cron, two matches at a time. A dispatch with
`sweep_set=BLB` runs the sweep on that set instead of the monkey, and `sweep_args` adds sweep flags
(`--seed 1129 --per-match 3`). Its report is the `sweep-report`
artifact, and like the monkey it gates nothing.

Both stacks keep a finished match's game on its JVM for 10 s (`CARDTABLE_PLAY_OVER_GRACE_MS`,
`RUN_STACK_ENV` in `monkey/pool.ts`), not play's ten minutes. At ten minutes, a run that
finishes a match every few seconds kept dozens of finished games live and opened a JVM for
every 25 of them. The sweep hit the runner unit's 8 GB memory cap about 55 matches in (all
three dispatches on 2026-11-20, #82). With the short grace, 84 matches ran on one match JVM
beside the pool JVM, ~4.1 GB RSS between them and flat. The monkey had the same problem until
2026-11-22 (#89): a claw's 6.2 GiB unit was OOM-killed 34 matches in, holding three JVMs. It
did not get the short grace, and its `-Xmx1g` never reached the server either, because the play
stack passes the server a fixed env list that did not include `CARDTABLE_PLAY_JVM_OPTS`. Measured
on one 40-match seed: 6.8 GB peak and three match JVMs before the fix, 4.3 GB and one JVM after.

Until 2026-11-19 it was a job in `forge.yml`, started by the 10:00Z nightly
full run, three matches at a time on the server's 2 GiB default heap. The full
run's e2e and jvm shards filled the lane-forge claws, so the monkey overflowed to
hokon, and its JVMs (2.5–2.8 GB RSS each) were cgroup-OOM-killed on claw-9
(2026-11-17) and hokon (2026-11-19). The workflow's header has the measurements
behind the new slot.

## What it does not do yet

- Two seats start from a scenario, not a room's ready flow ("Two seats", above): the room start and the mulligan are not played.
- A flag carries the lines of the match's `bridge.stderr.txt` that name it or
  say concede, exception, error or timed out (`jvmStderrLines`; a highlight scan
  out of budget is `AvailableActions: heuristic timed out`), not the whole file.
  The JVM's stdout, where Forge reports an AI decision cut short at its deadline,
  is the bridge's frame pipe and is not attached.
- `makeLogTail` re-reads its WHOLE file from byte 0 on construction (once per
  match) rather than seeking to the file's size at that moment — correct
  (each match's own `matchId` filter drops every other match's lines), but
  wasteful on a long-running stack with many matches; worth fixing if a future
  wave makes the nightly job markedly slower as the library grows.
