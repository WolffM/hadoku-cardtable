# Several Forge matches in one bridge JVM

Lane multimatch, 2026-10-25. Steps 3–4 of `docs/planning/forge-hosting-plan.md`
(§4 "many matches per JVM", §8), the fork and bridge half. The Node half
(multiplexing several matches over one JVM's protocol, the host agent,
placement) is not here.

Pin read: `9e5f5b75` (production). Fork result: WolffM/forge branch
`multimatch`, **`005e8186c38d768269afdd1d35cb04c2d32f6373`**: one commit on
lane-rng's `rng-per-game` (`7878fe75`, per-game RNG and a per-game `AiCache`),
which is itself on the pin. The commit was first written on the pin as `2276bb84`
and rebased.

## Decision: (a), an `FServerManager` per match, the bridge's shape kept

Two shapes were on the table.

- **(a)** Make `FServerManager`, and whatever else is a process singleton on the
  match path, an instance per match in the fork. Every match keeps the
  architecture the bridge has today: a Forge Netty server, a `ServerGameLobby`, a
  `RemoteClientGuiGame` per seat building that seat's delta stream, and a stock
  `FGameClient` per human seat over loopback, with `SeatGui` as its `IGuiGame`.
- **(b)** Drive matches through the engine without the net server, as the plan
  suggested (`Match.startGame`, as the `forge-scale` harness did).

**(a), because (b) rewrites the part of the bridge that carries hidden information.**

- What the browser sees of a game is what `DeltaSyncManager` puts in a seat's
  `DeltaPacket`s: one consumer per seat
  (`forge-gui/.../net/server/DeltaSyncManager.java`, `NEXT_CONSUMER_ID` at :72),
  serialized by `TrackableSerializer` under that seat's visibility, then applied
  on the client side by stock `NetworkGuiGame`. `SeatGui extends NetworkGuiGame`
  (PlayBridge.java, `class SeatGui`), and most of its ~2,700 lines
  (`applyDelta`, `setGameView`, `objectTable`/`packetJson`, `effectsSince`, the
  mulligan flag, resync, every ask) consume exactly that stream. Under (b) there
  is no `RemoteClientGuiGame` and no delta stream: the bridge would implement
  `IGuiGame` server-side against the live `Game` and re-derive per-seat
  visibility itself, which is the hidden-information rule we deliberately left
  to Forge (`docs/spikes/itoclient.md`, architecture (b)). That is most of the
  6,454-line bridge, the riskiest part of it, and every jar-gated suite would
  have to be re-proven against new code.
- Under (a) the fork change is +69/−17 lines in 9 files and the bridge keeps every
  code path a match runs today. It moves per-match state from statics into an
  object, and nothing else about how a match plays changes.
- The cost of (a) is a loopback port and a Netty boss + worker group per match.
  `jvm-per-match.md` measured "Netty plus an empty lobby add nothing measurable"
  (`server-idle`, 670 MB vs 653 MB RSS). (b) would save that and the loopback
  serialization. We do not need those savings to fit the plan's density.
  ASSUMED: per-match Netty threads (1 boss + NIO workers per server, NIO workers
  per client) are a cost worth measuring at 50+ matches per JVM. Not measured
  here.

(b) can still come later if a JVM must host hundreds. It does not block (a),
which keeps a one-match JVM byte-identical at the protocol boundary.

## Inventory: process-wide state on the match path

Every row is at pin `9e5f5b75` (Forge) or `origin/main` before this lane
(bridge, PlayBridge.java line numbers). **Fixed** = changed by this lane.

### Forge

| What | Where | Shared how | Status |
| --- | --- | --- | --- |
| `FServerManager.instance`, `getInstance()` | `FServerManager.java:79, :212` | one server and one lobby per process; a second `startServer` on it registers its shutdown hook twice, which is `jvm-per-match.md`'s "Hook previously registered" (`:276`) | **Fixed**: public constructor, one server per match; `getInstance()` stays as the default server for the desktop/mobile screens |
| `GameServerHandler.server` | `GameServerHandler.java:21` | each channel's handler talked to the default server | **Fixed**: given its own server at `startServer` |
| `ServerGameLobby` → `FServerManager.getInstance()` | `ServerGameLobby.java:137, :153-154, :378` | the lobby asked the default server for guis and lobby updates | **Fixed**: the lobby holds its server (`new ServerGameLobby(server)`; the no-arg constructor means the default one) |
| `HostedMatch` subscribes `NetworkGameEventListener` if the default server hosts | `HostedMatch.java:183` | would stop logging for a non-default server | **Fixed**: `FServerManager.isAnyHosting()` (logging only) |
| `InputPassPriority` arms the AFK timer on the default server | `InputPassPriority.java:76` | wrong server for a second match | **Fixed**: `FServerManager.hosting(game)`. The bridge sets `NET_AFK_TIMEOUT=0`, so this was `NOOP` either way |
| `StaticData.filteredHandsEnabled` (hand smoothing) | `StaticData.java:57, :864-868`; read at `GameAction.java:2319`, `AbstractMulligan.java:47` | one flag for the process. The bridge set it per match (PlayBridge.java:6221), so two rooms with different settings would have raced | **Fixed**: `GameRules.filteredHands`, defaulting to the preference; the bridge sets it on the match's rules |
| `MyRandom.random` | `MyRandom.java:34, :62-63` | one RNG for the process; the bridge sets it per match for `seed`/`chooser` (PlayBridge.java:6214-6217) | **lane-rng** (`rng-per-game`, under this fork commit): a Random per `Match`, bound to the thread that works for its game. The bridge binds the match's seeded (and `chooser`-rigged) random at the top of `play` and closes it after `start.run()` |
| `AiCache.dataMap` | `forge-ai/.../AiCache.java:16, :25` | one AI result cache for the process, cleared by every AI decision, so concurrent matches' AIs clear and read each other's entries | **lane-rng** (`rng-per-game` 7878fe75 makes it per game; found there because it made seeded matches diverge) |
| A `Deck` (and anything else Forge loads lazily) shared between matches | `Deck`'s sections load on first use with no locking (lane-rng: two matches opening one shared `Deck` at once dealt a player an empty library, `docs/spikes/per-game-rng.md`) | not shared today | Rule: **never share a `Deck` across matches.** The bridge builds every seat's deck fresh per match: `parseDeck` from the config text, or `randomPrecon` reading the file again (`DeckSerializer.fromFile`), so two seats with the same list get two objects. A host agent or deck cache must keep it that way |
| `ThreadUtil.gameThreadPool` | `ThreadUtil.java:25, :44` | one cached pool for every game, threads named `Game-N` | Fine by design. `isGameThread()` is `getName().startsWith("Game")` (`:51-52`), and `GameAction.invoke` (`:2508`) runs inline only there. Every match's game runs on this pool: `HostedMatch.startGame` → `game.getAction().invoke(…)`, called from a bridge thread that is never named `Game…` (`bridge-match-<id>` in `--host`, `main` otherwise). Shown by the jvm suite's thread dump (two live `Game-N` threads) |
| `GuiBase.guiInterface` | `GuiBase.java:9, :19` | one `IGuiBase` per process: the bridge's `BridgeGui` | Fine: `BridgeGui` holds no match state. It finds a seat by thread (`CLIENT_THREADS`, `seatUiOf`), and `hostMatch()` reads the starting match from a `ThreadLocal` set around `start.run()` |
| `RemoteClientGuiGame.useDeltaSync` | `RemoteClientGuiGame.java:59` | static flag | Fine: every match sets the same `true` |
| `FModel` preferences, `ForgeNetPreferences` | `FModel` | one per process | Fine: every match wants the same values (`bootModel`) |
| `FServerManager.afkExecutor` | `FServerManager.java:397` | one scheduler for every server's login deadlines and AFK timers | Fine: tasks are per channel |
| `NetworkLogConfig` (de)activation | `FServerManager.java:344`, `FGameClient.java:102` | global network-log switch | Fine: logging only, and the bridge never turns it on |
| `ActGate.GATES` | `ActGate.java:27` | static map | Fine: keyed by `Game` |
| `DeltaSyncManager.NEXT_CONSUMER_ID` | `DeltaSyncManager.java:72` | static counter | Fine: `AtomicInteger` |
| Id counters: `Game.maxId`, `SpellAbility.maxId`, `Trigger.maxId`, `StaticAbility.maxId`, `ReplacementEffect.maxId`, `SpellAbilityStackInstance.maxId`, `CombatView.nextId` | `Game.java:67-68`, `SpellAbility.java:79-80`, `Trigger.java:55`, `StaticAbility.java:54`, `ReplacementEffect.java:50`, `SpellAbilityStackInstance.java:41`, `CombatView.java:24` | plain `int`s shared by every game, not atomic | Left. A lost update can give two games the same id, never one game two (each game's increments are sequential on its thread). Ids are only looked up inside one game, and the bridge keys them per seat. ASSUMED harmless; `forge-scale.md` ran 256+ matches in one JVM and attributed no failure to them. Card ids are per game (`Game.nextCardId`, `:1044-1045`) |
| `GuiGameEvent.staticId` | `GuiGameEvent.java:7, :14` | non-atomic counter | Left, same reasoning |
| `ChangeZoneAi.multipleCardsToChoose` | `ChangeZoneAi.java:52, :142, :162, :1550` | a static list the AI fills for Intuition | Left, a real race: two AI seats in two matches each choosing for Intuition at the same moment could read each other's pile. One card, AI-only. Noted for the fork, not fixed here |
| `Spell.performanceMode` | `Spell.java:51` | static flag | Fine: never set by the bridge |

### Bridge (PlayBridge.java, `origin/main` before this lane)

| Static | Line | Now |
| --- | --- | --- |
| `matchId`, `seed`, `scenario`, `skipOpening`, `handSmoothing`, `chooser` | 222–268 | fields of `MatchContext`, built from the config object (`configFrom` is gone) |
| `LOBBY` | 2009 | `MatchContext.lobby` (+ `server`) |
| `SEATS` | 2011 | `MatchContext.seatGuis` |
| `gameOverEmitted`, `maybeEmitGameOverFirst()` | 2048–2080 | on `MatchContext` |
| `liveGame()` | 1978 | `MatchContext.liveGame()`. `SeatGui` and `EffectJournal` read their own match's. The static helpers that read it (`objectTable`, `packetJson`, `spentChoice`, `liveStackText`, `addStackFacts`, `broadcastIfWaiting`) take the game or the match |
| `EffectJournal.INSTANCE` | 5194 | `MatchContext.effects` |
| `ModeCounts.PENDING` (keyed by player id, which repeats across games) | 5837 | `MatchContext.modesPending` |
| `STOP` | 6337 | `MatchContext.stop`: a match's `stop` ends that match |
| `StaticData.setFilteredHandsEnabled(handSmoothing)` | 6221 | gone; `GameRules.setFilteredHands` in `hostMatch` |
| `FServerManager.getInstance()` (boot, probe) | 6112, 6438 | `new FServerManager()` per match (`bootServer`); probe uses `match.server` |
| `protocol`, `GSON`, `IN` | 206, 213, 6016 | stay process-wide: one stdout and one stdin for the JVM; every line carries `match` |
| `CLIENT_THREADS` | 2086 | stays process-wide, keyed by thread (each `FGameClient` has its own `NioEventLoopGroup`, `FGameClient.java:62`); a hosted match's entries are removed when it ends |
| `CostSteps.instance`, `ConditionsOn` reflection handles, regex/enum constants | 2098, 1199–1201, … | stay: immutable caches of Forge's own classes |

## What was built

**Fork** (`multimatch`, one commit `005e8186` on `rng-per-game` `7878fe75`):
the five `FServerManager` rows and the filtered-hands row above.

**Bridge**:
- `MatchContext` holds everything that is one match's. `SeatGui`, the effect
  journal, the game-log forwarder, the mode counts and the game-over line all
  reach their own match through it.
- `bootForge` is split into `bootModel` (once per JVM: GUI hooks, `FModel`,
  preferences) and `bootServer` (per match: a free port, `new FServerManager()`,
  `new ServerGameLobby(server)`).
- `startMatch` = `play` (decks, seats, clients, go) + park on the match's own
  `stop` + teardown (clients, server, and for a hosted match its seat threads).
- **`--host <hostId>`**: boots the model, says `warm`, then takes any number of
  `{"t":"start","match":<hostId>,"config":{…}}` lines (the spare's `start` shape).
  Each one starts a match on a `bridge-match-<id>` thread with a server of its own.
  Commands are routed by `match`. A match's `stop` concedes its human seats if its
  game is still running, answers its parked asks as aborted until the game is
  over (up to 10 s), tears the match down and answers `{"t":"stopped"}`. A
  failure inside one match (`MatchContext.fatal`) sends that match's `fatal`
  line and ends that match only. `stop` addressed to the host, or stdin closing,
  ends the JVM. **Test and host-agent only today**: `host.ts` still spawns
  `--spare` / cold JVMs, one match each.
- A cold start or a spare behaves as before at the protocol boundary: the same
  lines in the same order, every one stamped with the match's id (the spare's
  id until `start`), the stdin reader started after `ready`, `stop` or EOF exits
  the JVM, and `fatal` exits with 1. The `rejected` message for a command naming
  another match is unchanged (`command is not for match <id>`).

Game threads: every match's game loop runs on Forge's `Game-N` pool (see the
`ThreadUtil` row). No bridge thread is named `Game…`, so `GameAction.invoke`
never runs a game's work inline on a bridge thread.

## Proof

All on the claws through `forge.yml`. Forge-side changes cannot be shown by a local unit test.

| Run | Pin | What | Result |
| --- | --- | --- | --- |
| [40278409972](https://github.com/WolffM/hadoku-cardtable/actions/runs/40278409972) | `2276bb84` | `multi-match.jvm.test.ts` alone | red: its last check found no `log` line. Both games were parked at the mulligan, and `GameLogForward` installs at `startGameHook`, after the mulligan. Every other check passed. The suite now keeps every hand, so both games reach turn 1 |
| [40278882410](https://github.com/WolffM/hadoku-cardtable/actions/runs/40278882410) | `2276bb84` | `multi-match.jvm.test.ts` alone | **green**, 29.7 s |
| [40283813079](https://github.com/WolffM/hadoku-cardtable/actions/runs/40283813079) | **`005e8186`** (on `rng-per-game`) | full: every jvm suite + forge-e2e ×4 | jvm shards 1 and 3: **65 files, 226 tests, all green**. Shard 2: **32 suites green**, among them `multi-match`, `seed`, `w71-chooser` and `match`, and no failure, before the job's 35 min timeout cancelled it on jit-claw-9 (the slow claw, beside an e2e shard). Its 3 unfinished suites are re-run below. forge-e2e: **384 passed, 8 failed**, and the 8 are main's own: main's scheduled full run [40283086192](https://github.com/WolffM/hadoku-cardtable/actions/runs/40283086192) on `cace1901` (production pin `9e5f5b75`, without this lane or lane-rng) failed the same 8 specs, plus `table-fit` (af60-priority-cue, af66-combat-priority, ip-improvise, nf-offer-gap ×2, prompt-bar Scapeshift, un-unfinished-game, xt-extra-turn) |
| [40297104081](https://github.com/WolffM/hadoku-cardtable/actions/runs/40297104081) | `005e8186`, branch rebased on main (`bbb6defd`) | shard 2's 3 unfinished suites (`ai-cards-warning`, `cant-block`, `match-frames`) + `multi-match` | **green**, 4/4 |

The full run was on `4b71abcc`. The branch was then rebased onto main with lane-rng
landed (`0f9c92d6`). The rebase changed nothing in `apps/server/src/play` or the
`forge` gitlink: `git diff 4b71abcc bbb6defd -- apps/server/src/play forge` is
empty. What main added in between is UI sound and docs.

Single-match behaviour unchanged: every existing jvm suite and e2e spec runs a
cold or spare one-match JVM through this bridge.

## What remains

- **Node side** (next step): a `MatchHost` that multiplexes several matches
  over one `--host` JVM's stdio (route lines by `match`, send `start` with
  the match's config, treat `stopped` as the match's exit). Today a JVM's death
  is a match's death; with N matches per JVM, `host.ts`'s crash path must fail
  every match on it (plan §5). The orphan and attach logic (`jvm.json`, one
  `matchId` per record) is per match today and needs a per-JVM record listing its
  matches.
- **The `ChangeZoneAi` static**, and the non-atomic id counters if a measured
  failure ever points at them.
- **A stopped match whose game will not end**: `endGame` gives up after 10 s
  and logs it. The game thread is then parked for good on a closed seat (a
  leaked `Game-N` thread in a long-lived JVM). Not seen in the suite.
- **Density**: per-match Netty event loops are unmeasured at scale (ASSUMED
  cheap, from `jvm-per-match.md`'s idle server).
