# Wave 28 — the manager's pre-dispatch checks

Run before any sub-agent started, as commands rather than as intentions
(`memory/check-a-wave-brief-mechanically.md`). Every count and path below was
produced by a command in the wave-28 worktree at `4f0c753`.

## 1. The lane file lists do not intersect

All eighteen owned paths exist:

```sh
for p in apps/ui/src/play apps/server/src/play/{auto,auto.test,auto.jvm.test,match,match.test,socket,socket.test}.ts \
         e2e/play.spec.ts apps/ui/src/screens/{ConstructedScreen.tsx,constructed.test.ts,screens.css} \
         packages/deck/src/library decks/pools apps/server/src/{room,http} apps/ui/src/{rooms,room}; do
  [ -e "$p" ] && echo "OK   $p" || echo "MISS $p"
done
```

→ 18 OK, 0 MISS. No two lanes name one path, and no lane's path is a prefix of
another's. `apps/server/src/play/` is shared as a *directory* between §B (seven
named files) and nobody (`host.ts`, `index.ts`, `jvm.test.ts`, `seed.jvm.test.ts`,
`transport.ts`, `visibility.ts`, `visibility.test.ts`, `fixtures/`, `bridge/`,
`browser/`, `dev/`) — §B owns files, not the directory, and that is correct.

## 2. What else pins each file a lane changes

Three real cross-lane pins the wave file does not carry. Each was handed to the
lane concerned as a named constraint rather than discovered mid-flight.

### 2a. `apps/ui/src/screens/MatchScreen.tsx` pins §A's `play/live/`

```
apps/ui/src/screens/MatchScreen.tsx:31  import { LiveBoard } from '../play/live/LiveBoard.tsx';
apps/ui/src/screens/MatchScreen.tsx:32  import { closeMatch, startMatch, type LiveMatch, type MatchTransport } from '../play/live/match.ts';
```

`MatchScreen.tsx` is owned by **nobody** (§C owns three other files in that
directory). So `LiveBoard`'s props and `live/match.ts`'s exports are **add-only**
for §A. Told to §A.

### 2b. §B's `match.ts` is imported by §D's files

```
apps/server/src/http/tables.test.ts:29  import type { MatchRegistry } from '../play/match.js';
apps/server/src/http/gate.test.ts:28    import { createMatchRegistry, type Match } from '../play/match.js';
```

`apps/server/src/http/` is §D's; `match.ts` is §B's. So `MatchRegistry`,
`createMatchRegistry` and `Match` are **add-only** for §B, or §D breaks
mid-flight with nobody assigned. Told to both.

### 2c. §C's deck chooser is driven by three e2e specs, two of which nobody owns

`grep -rn selectOption e2e/` — the `data-testid="deck-mine"` `<select>`
(`ConstructedScreen.tsx:1262`) is driven by:

| spec | line | owner |
| --- | --- | --- |
| `e2e/play.spec.ts` | 648 | §B |
| `e2e/arrow.spec.ts` | 213 | **nobody** |
| `e2e/table-fit.spec.ts` | 666 | **nobody** |

Item 2 says *"we cannot use a standard dropdown for this"*, so §C's lane cannot
be delivered without those three call sites moving. `ConstructedScreen.tsx:233`
had already recorded this as the reason the control stayed a `<select>`.
Resolution: §C ships the control and writes the exact before/after Playwright
line per spec into its own evidence file; the **manager** makes the three edits
once §B and §C have landed, which is when those files are free. Nothing was
widened.

### 2d. `e2e/table-fit.spec.ts` also reads the log, which §A and §B both change

```
e2e/table-fit.spec.ts:344  for (const id of ['live-says', 'live-log'])
e2e/table-fit.spec.ts:410  '[data-testid="live-logbook"] [data-testid="live-says"]'
```

Owned by nobody. §A owns what the log looks like and §B owns whether it is the
table's log; either can move this. Both told to report rather than edit. Also
manager work.

### 2e. Checked and NOT a hazard

- `apps/server/src/play/transport.ts:106` names `play/auto.ts` in **prose only**;
  no code dependency on the stop policy.
- `apps/server/src/play/host.test.ts` has 18 lines matching `stop` — every one is
  about stopping a **JVM process** (`host.stop()`, `stopGraceMs`), not a stop
  phase. Not moved by §B.
- `apps/ui/src/components/ManaPip.test.ts:57`, `packages/carddata/src/art/ids.test.ts:10`
  and `apps/ui/src/sound/index.ts:44` mention `play/adapter.ts` in **prose only**.
  The wave file's add-only constraint on `adapter.ts` still stands, because
  `e2e/play/hands.ts:36` and `e2e/play.spec.ts:123` import from it for real.
- `apps/ui/src/play/live/parity.test.ts` — the file wave 27 had to re-record by
  hand — is inside `apps/ui/src/play/`, so §A owns it this time.

## 3. What generates each generated file

`decks/pools/*.generated.json` — each fixture's own `command` field names
`packages/deck/src/library/build-pool-fixture.ts`, which is inside §C's lane.
The wave file names the same path. Correct; read from the artifact, not inferred.

## 4. Every factual claim in the brief, grepped

| claim | verdict |
| --- | --- |
| `ARENA_STOP_POLICY` exists with `skipNonStopPhases: 'always'` | **true** — `auto.ts:311,315` |
| `DEFAULT_STOP_POLICY` has `'never'` | **true** — `auto.ts:256,261` |
| `FULL_CONTROL_POLICY` keeps every stop | **true** — `auto.ts:326,329` |
| `skipsThisTurn` is where `'always'` applies | **true** — `auto.ts:713-715` |
| `[data-attack-intent='refused']` is the orange dotted outline | **true** — `gestures.css:91` |
| the marquee already exists | **true** — `live/gestures/marquee.ts` |
| `--peek` sizes the pile | **true** — `board.css:1078,1082,1086` |
| `.seat__counts` holds the counts | **true** — `board.css:471,524`, `Board.tsx:1409` |
| the counts are words, not symbols | **true** — `Board.tsx:1410-1411` render `hand {n}` / `library {n}` |
| `HiddenHand` draws `.card-back` divs | **true** — `Board.tsx`, `card.css` |
| the radio at `ChoicePrompts.tsx:178` is unstyled | **true** — bare `<input type="radio">` in a `<label>` |
| `PlayerFace` draws the seat's face | **true** — `Board.tsx:1385` |
| the era row draws a glyph with the code beside it | **true** — `ConstructedScreen.tsx:336-341,359` |
| `avatarId` is on `RosterIdentity` / `LocalIdentity` | **true** — `@wolffm/rooms-protocol@0.39.8` `dist/resync.d.ts:77-84`, typed `string \| null` |
| `room-store/snapshot.ts` already persists it | **true** — `:63`, `:236`, `:268`, `:380` |
| nothing in `apps/` reads `avatarId` | **true** — zero code hits across `apps/server/src` and `apps/ui/src` |
| watchparty's `.d.ts` files carry no `avatar` | **true** — zero `.d.ts` hits in `@wolffm/watchparty-ui@0.39.8`; only `dist/room-chrome.js` and its chunks/maps |
| Scryfall's set object carries `block`/`block_code` | not re-checked — the wave file states it verified (`mbs` → `som`) |

### One claim that is FALSE, and what replaces it

> §A.6.2: *"Delete the alpha-strike affordance."*

**There is no alpha-strike affordance in this repo.** `grep -rni alpha` over
`apps/`, `packages/` and `e2e/` returns zero UI hits; the only matches are
`docs/spikes/headless-server.md:286` and `docs/FORGE_ANALYSIS.md:259`, both
describing Forge's `alphaStrike` protocol method. The play UI's only buttons are
Concede, Regroup, seat-select, stack-select and the prompt controls.

What the operator actually saw is **Forge's own button label, rendered by us**:

```
forge-gui/.../match/input/InputAttack.java:89
  String alphaLabel = canCallBackAttackers() ? localizer.getMessage("lblCallBack")
                                            : localizer.getMessage("lblAlphaStrike");
res/languages/en-US.properties:472
  lblAlphaStrike=Alpha Strike
```

and our side:

```
apps/ui/src/play/live/LiveBoard.tsx:640  {bar === null || bar.label2 === '' ? 'Cancel' : bar.label2}
apps/ui/src/play/live/LiveBoard.tsx:878  {bar === null || bar.label2 === '' ? 'Cancel' : bar.label2}
```

So during `InputAttack`, Forge sends `label2 = "Alpha Strike"` (or `"Call Back"`)
and `LiveBoard.tsx` paints it. The fix is in `apps/ui/src/play/live/`, which is
§A's lane — the target just is not the one the wave file named. §A was given this
derivation instead of the wrong instruction.

## 5. Every done-when that demands an artifact names a repo path

All four lanes' artifacts go to `docs/planning/wave28-evidence/`.
`git check-ignore -v docs/planning/wave28-evidence/test.png` →
`.gitignore:41:!docs/**/*.png`, so screenshots there are committable even though
`*.png` is refused repo-wide. Confirmed before dispatch rather than after.

## 6. Host and toolchain, confirmed rather than assumed

| thing | check | result |
| --- | --- | --- |
| node major | `node -v` with fnm v24 on `PATH` | `v24.18.0`, matching CI's `node-version: '24'` (`ci.yml:60,205`) |
| worktree links | `realpath apps/ui/node_modules/@hadoku/carddata` | this worktree's `packages/carddata`, **not** the deploy tree |
| the Forge jar | `ls` | present, 39,686,151 bytes |
| the Forge res | `ls -d` | present |
| both app versions | `grep '"version"'` | both `0.23.0` |
| git hooks | `core.hooksPath` unset, `ls $(git rev-parse --git-common-dir)/hooks` | **none** — so the protocol's `MM package.json` / stale-DELETE hazards, which are hook artifacts, cannot arise this wave |
| `flock` form | `flock -x <lock> bash -c '…'` | exit 0. Never flock's `--` (exits 69 having run nothing) |

## 7. Forge JVMs alive before the wave (the teardown baseline)

```
1244215  /tmp/cardtable-play/spare-cbf44511aff7   Mon Sep 28 21:00:57 2026
3213136  /tmp/cardtable-play/spare-26a500f4cfe6   Mon Sep 28 15:18:52 2026
```

Both are **production's** spares under `/tmp/cardtable-play/`. Leave them. Two
further pids matched `pgrep` and had already exited by the next command, so they
were never this wave's. Anything under a workspace that no longer exists at
teardown is ours to kill.

## 8. Locks, and what each one actually protects

A check writes no shared artifact, so it gets no lock — wave 27 queued eleven
full checks behind its build lock for no signal
(`memory/dont-lock-pnpm-check-behind-builds.md`).

| lock | protects |
| --- | --- |
| `/tmp/claude-1000/w28-locks/jvm.lock` | every jar-gated vitest suite and every Playwright run — CI's `forge-e2e` runs on this host and binds 19008/19028/19108/19128 |
| `/tmp/claude-1000/w28-locks/build.lock` | `pnpm --filter … build`, the one shared `dist/` |
| `/tmp/claude-1000/w28-locks/gitidx.lock` | the one shared git index |
| — | scoped non-jar `pnpm vitest run <file>`: **no lock**. One authoritative full `pnpm check` by the manager at the end |

## 9. A hazard the manager created and corrected before it fired

The dispatch told all three parallel lanes to commit with
`git add -A -- … docs/planning/wave28-evidence`. That is a **directory**, and
three lanes write into it concurrently, so lane B's commit would have swept
lanes C and D's in-progress evidence — which breaks "a failing lane reverts
alone". Corrected by message to all three before any of them committed: commit
evidence **by explicit filename**, prefixed with the lane letter.

## 10. A correction to this wave's own teardown check

The handoff says to check `pgrep -f PlayBridge.java` for orphaned Forge JVMs
before teardown. **That command matches its own command line**, so it reports a
process every time it runs, and this manager twice read those self-matches as
lane JVMs before catching it. The real check is to enumerate actual JVMs and
filter by cwd:

```sh
for p in $(pgrep -x java); do echo "$p $(readlink /proc/$p/cwd)"; done
```

Production's spares live under `/tmp/cardtable-play/spare-*` and are left alone;
a wave's own live under its `CARDTABLE_PLAY_WORK_DIR`. Anything under a
workspace that no longer exists is the orphan the rule is about.
