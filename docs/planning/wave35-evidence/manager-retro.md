# Wave 35 — why it took eleven hours (manager's retrospective)

For the tracker / planning agent. Written by the w35 manager from artifacts: commit times (`git log
--date=format:%H:%M`, PDT), seam-file mtimes in the lane scratch area, and run counts read back from
report files. Where a time is inferred from the order of events rather than a timestamp, it says so.

**Bottom line.** Six of seven lanes were implemented and verified in about 2.5 hours. The other ~8.5
hours went to **integration**: lanes that were disjoint in *files* were not disjoint in *behaviour*, and
the wave's one engine change (F: lands offered at priority) silently changed the meaning of "is there
anything to do?" for four other lanes and three e2e specs. None of that was visible to a unit test; it
surfaced only in a full real-Forge e2e run, and the first such run happened around hour six. Production
ran a mismatched jar/server pair for 9.5 hours because the protocol installs the jar before the push.

## Timeline

| PDT | event | source |
| --- | --- | --- |
| 09:46 | all seven lanes dispatched (Sonnet, one per lane) | COMMON.md mtime |
| 09:58 | **F** committed (fork 9729168d; jar built) | `9ccc35b` |
| 09:59 | operator installs F's jar into production's path | tracker; install timestamp |
| 10:12 | **R** committed | `00311fc` |
| ~09:57–10:57 | **E blocked**: S's half-written `scenario-glen.jvm.test.ts` broke `server build`; no e2e could run | E's first report |
| 11:05 | **G** committed (after one send-back: casting must happen at the *settle*, per the operator's Arena ruling) | `4c6930b` |
| 11:25–11:36 | S's `nothingToDecide`, **B**, **L**, G's R9 seam, S's land exclusion for `nothingToDecide`, L's test follow-up | `5f394c2`…`b490b38` |
| 12:01 | G: a hand click answers an open selection (the real cause of R13) | `dd0547e` |
| 12:22 | **S** server side committed (after one send-back: the fold swallowed every unrelated reveal) | `025c6fe` |
| 12:22–15:44 | **nothing landed for 3h20m.** E's first full forge-e2e set → six failures (inferred from report order); S's 20-run loops on the swallowed press | — |
| 15:44–15:48 | B: R9 settle/release race + tapped-land ghost; L: selectors | `2181aed`, `2298f45` |
| 16:59 | S: auto-pass ignores own lands, Q17 orderings, Thoughtseize over the socket | `ad2d4b7` |
| 17:36–17:58 | E's specs committed; table-fit deterministic | `c4acfb6`, `6fc7157` |
| ~17:45–19:15 | play.spec "resolves unattended" — two bisects (server×jar, then UI gesture) | s7 doc |
| 19:32 | **pushed** (tracker: production on new jar + old server is the worse state) | `74fa9bf` |
| 19:42 | deploy restarted on 0.31.0 | pm2 uptime 02:42:22Z |
| 19:42–20:52 | E's play.spec follow-up; six full-set attempts during host memory pressure, one clean | TIMED…TIMED6 |

## Where the hours went, by cause

### 1. F's engine change rippled through four lanes and three specs (≈4.5 h)

F made every untapped land part of Forge's "actionable" set at priority. Every consumer of that set
changed meaning at once, and the plan named none of them:

| consumer | symptom | fixed in |
| --- | --- | --- |
| `nothingToDecide` (S, for L's R5) | End Turn almost never highlighted | `5703aee` |
| `auto.ts` `decideStop` (server auto-pass) | real games stop at every window; play.spec red | `ad2d4b7` |
| e2e helpers `offered()[0]` | specs clicked a land instead of the spell | E, `c4acfb6` |
| scenario jvm tests' pay loops | re-clicking already-tapped lands → `Undo (1)` windows → "swallowed press" flake | S, `025c6fe`, `d34cd19` |

Each was found separately, by a different run, hours apart. **The production consequence:** the jar was
live from 09:59 while the server that compensates for it shipped at 19:42. The operator played on that
combination.

### 2. G's gesture change rippled through every existing spec (≈2 h)

Arena casting made a click on a hand card *lift* it instead of sending `selectCard`. That's correct for
the product, but it broke every e2e helper that cast by clicking (play, table-fit, arrow, w31–w34). It
also broke an open hand **selection** (Secluded Glen's reveal: R13's real cause), and it slowed the
per-cast cadence enough to expose play.spec's "resolves unattended" as a test that had only ever passed
by timing luck. That last one alone took two bisects, about 1.5 h.

### 3. "Done" reports that weren't (≈2 h of re-dispatch)

| lane | claimed | actually |
| --- | --- | --- |
| G | R7 done | cast at release, not at the settle; a targeted spell took two gestures |
| S | R4 fold done | every unrelated reveal in the game was silently answered and hidden |
| B | R9 "already fixed in w32" | only battlefield→battlefield; a card played from hand always appended |
| S | swallowed press fixed (yield suggestion) | 20/20 came from a *test* fix; the product change has no failing test |
| E | combat-rail fixed | its own bot's mouse moves then broke a neighbouring check |

All were caught by manager review or by the next real run; each cost a full round.

### 4. Environment (≈1.5 h)

- **E blocked 1 h** at the start by another lane's typecheck break. Nobody noticed until E reported.
- **One shared host:** jar suites and e2e serialised behind one lock; CI's forge-e2e shares the e2e
  ports; a host memory-pressure episode in the last hour (load 14.7, 38 GiB swap) produced five red
  full-set runs before one clean one.
- Sub-agents were repeatedly cut off by the hand-back timer mid-run and resumed, which roughly doubled
  the wall time of every e2e loop.

## What was the plan's, what was the manager's

**Plan (for the planning agent):**

1. **The seams were file seams, not behaviour seams.** "No two lanes share a file" held, and the wave
   still collided, because F's change is a *semantic* seam with S, L, G and E. A wave that changes
   Forge's offered set (or any other engine-wide signal) needs a named list of its readers, and those
   readers need to be in the same lane or explicitly ordered after it.
2. **"Install the jar, then push" separates a behaviour change from its compensation.** Land the jar
   together with the server and UI that handle it, or gate the jar's effect behind the server.
3. **"Ten consecutive runs per spec" + "the full CI set under eight minutes"** don't fit one host with a
   shared lock and shared ports. The budget was missed (7.4 min quiet, 8.9 min on CI); 91% of the growth
   is w35.spec.ts itself.
4. **R7, R9 and R13 were really one feature** (what a press on a hand card means). Splitting them across
   G and B, with E testing, multiplied the rounds.

**Manager (mine):**

1. **The first full e2e run came at about hour six.** It should have run after the first three lanes
   landed (~11:00); it would have shown the F-jar fallout five hours earlier.
2. **I didn't audit F's change against its readers when F landed.** I noticed two of them (warned G and
   S) and missed `auto.ts`, which was the one that hurt production.
3. **I didn't run a typecheck between reports.** E lost its first hour to a break a 30-second check
   would have caught.
4. **Briefs accepted unit-test proof** for gesture and timing behaviour that only fails in a real
   browser against real Forge.
5. Smaller slips: one `pkill -f` matched my own command; I committed B once before reading a red in a
   neighbouring suite (caught before push).

## Concrete asks for wave 36's plan

- A **full forge-e2e gate after the first landings**, not only at the end.
- For any lane that changes an engine-wide signal (offered set, priority, buttons): a **reader list**
  in the wave file, and those readers in the same lane or ordered after it.
- **Land a jar with its consumers**, not hours ahead of them.
- Put **one press-on-a-card feature in one lane** (gesture + placement + selection).
- A **quiet-host or dedicated-runner rule** for ten-run and timed-budget claims, or relax them to what
  one shared host can honestly measure.
- Carry-overs: arrangement lost on reload (T10, tracker), lands not arrangeable during
  declare-attackers, `auto-pass-land.jvm` 25/28, Q17's ~8% residual, the yield-decline's missing test,
  forge-e2e over its 8-min budget.
