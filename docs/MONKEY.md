# The monkey seat

A headless client that joins real vs-AI matches on a real running server —
over the actual socket protocol a browser speaks, through the e2e stand-in
edge, never an in-process shortcut — and plays to the end by picking a random
LEGAL answer to every ask Forge raises and a random legal board action
otherwise (land, spell, attacker, blocker, mana payment, pass). The goal
(the operator, 2026-10-26): find the next soft lock — a card or an ask shape
the UI cannot answer — before a player does.

Code: `apps/server/src/play/monkey/`. It lives under `apps/server/src/` rather
than `scripts/` because its wire transport needs `socket.io-client`, which is
a real dependency of `@hadoku/server` and not resolvable from a bare script;
the rest of it reaches into `apps/ui/src/play/live/match.ts` and
`apps/ui/src/play/prompts/rules.ts` for the exact same functions the real
board and prompt components call, so "legal" is never a second model of
Forge's rules — see each file's own header.

## Running it

```sh
export PATH="/home/hadoku/.local/share/fnm/node-versions/v24.18.0/installation/bin:$PATH"
export CARDTABLE_FORGE_JAR="$HOME/.local/share/cardtable/jars/<THIS WORKTREE'S PIN>.jar"   # git ls-tree HEAD forge
export CARDTABLE_FORGE_RES="<a forge-gui/res with cardsfolder/>"                            # see the warning below
pnpm --filter @hadoku/ui build && pnpm --filter @hadoku/server build

apps/server/node_modules/.bin/tsx apps/server/src/play/monkey/cli.ts \
  --seed 1 --sample 8 --matches-per-deck 1 --out /tmp/monkey-report.json
```

**The jar must be built from THIS checkout's own forge pin.** The bridge
(`apps/server/src/play/bridge/PlayBridge.java`) is compiled fresh against
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
| `stuck` | no progress for `--stuck-ms` (default 20 s) while this seat held priority or an ask was open | the ask's `callId`, or the button bar + selection size, unchanged |
| `click-refused` | the server (Forge's `flashIncorrectAction`) or this client's own guard refused an answer — not the server's `cause: 'unpayable'` flash, which is it cancelling a cost nothing can pay (e2d49c260), a handled case (`isRefusal`) | the wire tap on `forge:s2c`, and `selectCard`/`selectPlayer`/`pressButton`/`answerAsk`'s own return value |
| `loop` | a DECLINED optional ask came back with the same method and the same offered shape three times running, AT THE SAME turn and phase, with no act of this seat's own in between (a click on the same card again opens a new question, not the old one coming back; a `tempShowZones` that recurs every cleanup step by design is excluded outright) | `declineStreak` in `seat-driver.ts` |
| `server-unclassified` | the server logged `ask-unclassified` for this match — a question `answerability` has no rule for. Not `ask-unanswerable`: that is the server answering, by its own rule (7f343ec90), a question no seat could (`serverFlagsOf`) | the running stack's own JSON log file, tailed per match |
| `no-finish` | the match never started (`POST /api/play/matches` refused it for a reason other than a 503), the connection broke (`report`'s `disconnected`, `snapshot-failed`, `no-snapshot` or `stale-build-reload`; a `slow-connect` or one `connect-error` is a board noting its connect while it keeps trying, and ends nothing), one turn went on past `--turn-stall-ms` (default 300000), or the match ran past `--match-timeout-ms` (a backstop, default 30 s per turn of the turn cap). Reaching `--turn-cap` (default 60) ends a match as `turn-capped` and a run's `--budget-ms` running out ends one as `cut-short`; neither is flagged, since a long game is not a finding | `run-match.ts` |

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
apps/server/node_modules/.bin/tsx apps/server/src/play/monkey/cli.ts \
  --deck <the deck id from the match's log line or report> \
  --seed <the TOP-LEVEL seed the run printed, not the per-match one> \
  --matches-per-deck 1
```

The per-match seed is derived from the top-level seed and the deck id, so
naming the same deck under the same top-level seed reproduces the same
per-match seed and therefore the same run — moves, draws, AI, the lot
(`rng.ts`'s `makeRng`/`mulberry32` is deterministic). The opponent deck is
also picked by that per-match RNG, so it is reproduced too.

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
within one run the monkey only ever holds seat 0. (Scope decision: a
two-human-monkey match, one per seat, would need the room/ready flow rather
than the deck-builder's direct `POST /api/play/matches` and was out of
budget for this lane — `run-match.ts`'s header is where that would start.)

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
  `apps/ui/src/play/live/mistakes.ts` already proves against a real jar in
  its own test suite; not separately re-proved here.
- **`no-legal-answer`**, **`loop`**, **`server-unclassified`** — proved by a
  direct unit test of the pure function each flag is built on
  (`seat-driver.test.ts`, 13 cases, `CI=1 vitest run
  apps/server/src/play/monkey/seat-driver.test.ts`): the exact shape each
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

`.github/workflows/forge.yml`'s `forge-monkey` job: the library in a
seed-shuffled order for a 75-minute budget, nightly (the `0 10 * * *` cron, beside the existing full-run schedule), on
the per-pin bundle `scripts/forge-bundle.sh` resolves for whatever commit is
on `main` that night. A manual dispatch with `monkey: true` runs a sample of
8 by default (`monkey_sample`/`monkey_seed`/`monkey_deck` inputs to narrow or
reproduce). Gates nothing — same as every other job in this file — and is
deliberately NOT in the `report` job's `needs`, so a flag shows red on the
Actions tab and in the schedule history without reaching the fleet's Discord
alert; that alerting decision is the operator's to make once this has run a
few nights for real.

## What it does not do yet

- **Human-vs-human (two monkeys, one per seat)** — see "Decks covered" above.
- A flagged run's `bridge.stderr.txt`/raw frames are not attached to the
  report; today a run's own stdout (which `cli.ts` already prints per match)
  and the stack's `workDir` are what a flagged run's `matchId` is looked up
  against by hand.
- `makeLogTail` re-reads its WHOLE file from byte 0 on construction (once per
  match) rather than seeking to the file's size at that moment — correct
  (each match's own `matchId` filter drops every other match's lines), but
  wasteful on a long-running stack with many matches; worth fixing if a future
  wave makes the nightly job markedly slower as the library grows.
