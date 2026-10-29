# The front page and the replay feature

A Twitch-like front page: the first thing on `#/` is a live board, a match where something is
actually happening. Behind it sits a recording of every match, which gives the front page
something to show when nothing is live and gives us replays.

## The operator's words (2026-10-26)

> we need to redesign the front page. i want to show a live twitch-like frontpage experience where
> we highlight a room that is currently active and playing. we should choose a room that has things
> actually going on rather than an idle one. To accomplish this we need to properly design the
> replay and recording feature on the site. help me figure out how to get this working

## What exists (verified 2026-10-26, on 957a76bd)

- **The front page** is `LobbyScreen`: a nav row and `RoomList`, fed by `GET /api/rooms` plus a
  `rooms:changed` push (`apps/ui/src/screens/LobbyScreen.tsx`, `apps/ui/src/rooms/feed.ts`).
  `lobby.offered()` sorts by `createdAt`, not activity (`apps/server/src/room/lobby.ts`).
- **A public projection of every match already exists.** The watcher channel is
  `createProjector(null)`, fed from the first human seat's raw stream. It carries public zones only
  and never a prompt (`apps/server/src/play/match.ts`, `watcher` field, `sendState`,
  `watcherSnapshot`). Everyone who is not seated gets the same bytes.
- **Nothing outlives a match.** `<workDir>/<matchId>/stream.jsonl` holds the *raw*, pre-visibility
  Forge stream for crash re-attach, and a clean end deletes the directory
  (`apps/server/src/play/host.ts`). It carries both hands and both libraries, so it must never be
  served as a replay.
- **The client is already a replayer.** `foldPackets` (`apps/ui/src/play/fold.ts`) followed by
  `toBoardView` is pure. `LiveMatch` takes any `MatchTransport`, and
  `apps/ui/src/play/live/replay-server.ts` already replays a fixture through one, for tests.
- **Activity signals:** `noteLive()` fires on every turn, active-seat or life change, and the room
  view carries `tableGames[…].live {turn, active, life, hand}`. Nothing tracks when a match last
  *did* something, or how many people watch it.

## The design: one recording, three uses

**The recording is the watcher channel, timestamped, on disk.** Every frame `sendWatcher` emits is
appended to `<recordings>/<matchId>.jsonl` as `{at, seq, frame}`. A header line holds the room,
players, decks and `startedAt`. A footer holds the result and `endedAt`. Because these frames have
already been through `createProjector(null)`, the file is safe to show to anyone who passes the
friend gate. **The leak question is answered by construction, not by a filter we have to keep
right.**

That one file serves three uses:

1. **Live**: the front page's hero is an ordinary watcher of a live match.
2. **Replay**: `#/replay/<matchId>` feeds the file through a `MatchTransport` into the same
   `LiveMatch` and `LiveBoard`. `at` paces playback. Seeking re-folds frames `0..k`, which is cheap
   because the fold is pure.
3. **Fallback hero**: when nothing is live, the front page loops the best recent recording.

### Pieces, in landing order

**R1. Watching never sits anyone (already true, 2026-10-27).** The first draft of this plan had a
step here to stop a front-page viewer from claiming an empty seat. The operator questioned it, and
it was not needed. `POST /api/play/matches` binds every human seat to its player in `seatPlayers`
(`http/routes.ts`) before the match is announced. A room's match therefore never has a free human
seat, and every other `forge:join` lands on `WATCHER_SEAT`. `Match.claim`'s first-free-seat branch
is reached only by test harnesses that call `registry.create` directly.

**R2. The recorder (server).** Write a sink beside `sendWatcher`. It goes in its own directory on
disk, not tmpfs and not the run dir, so a clean end never deletes it. Default:
`~/.local/share/cardtable/recordings`, overridable by env, and tests write to a temp dir. Gzip the
file at the end. Prune by age and total size. Add `GET /api/recordings` (list: header + footer) and
`GET /api/recordings/:id` (the frames). Both are friend-tier like everything else.
**Gap:** the arrangement and placement echoes (`arrangement-sync.ts`) are not in the watcher
history. Record them as their own line kind, or a replay's board layout drifts from what players
saw.
**Gap:** AI-vs-AI has no watcher channel (`watcherSource()` finds no human seat). Fall back to seat
0's stream so AI matches can be watched and recorded too.

**R3. "Something is happening" (server). Built 2026-10-27, `play/featured.ts`.**

- `Match.activity()` counts the whole seconds of the last two minutes in which the watcher channel got
  a state frame. One act's burst of frames is one second, and a game waiting on a player stamps
  nothing.
- `GET /api/rooms` now answers `{ rooms, featured }`. `featured` is `{ matchId, roomId }` or null,
  and only ever points at a room in that same list.
- A change of pick pings the room feed's list followers, so no new channel or event is needed. It is
  re-picked on every `liveChanged` and every 15 s, because going idle is the absence of an event.
- *Eligible:* dealt and running (`Match.live()` not null), the table changed within 60 s, and not in
  a testing room.
- *Score:* active seconds in the last two minutes, plus 10 past turn 2, up to 10 for close life
  totals, and 15 for two people rather than a person and an AI.
- *Kept:* the current pick stays until it ends or goes idle. A hero that switches mid-combat is
  worse than one that shows a slightly duller game.
- *Not yet:* the watcher count, which nothing on the server counts per match yet. And the
  nothing-live fallback, a replay or an AI exhibition, which is the operator's open question. Until
  then `featured` is null and the banner shows no viewer.

**R4. The front page (UI). Approved 2026-10-27.** The operator approved the design canvas,
https://claude.ai/artifact/STWgBB4waoah93m8aMqrps, artboard "A": *"love it. lock it in. these cards
might change in the future, but the general structure is correct."* Their rulings while shaping it:
the banner takes **at most 50% of the viewport height**, the viewer must not crowd out the other
cards, and there is **no "Recent games"** (that belongs on the player's profile).

- **The banner** is one row of cards about 380 px tall, wrapping on narrow screens:
  - **The live match.** Two card-widths wide: `LiveBoard` in a read-only `embedded` mode, scaled
    whole to its box rather than re-laid-out (the board's table-fit stays the board's). Its title
    bar reads LIVE · players · game and turn, with **Watch** opening `#/match/<id>`. It is muted.
  - **Patch notes.** The newest release's title and its first bullets, read from `docs/releases/`,
    with *Read all* and *Older*.
  - **Upcoming.** An event calendar: a date block, a title and one detail line per event.
  - **A wildcard.** A small carousel (arrows and dots) of anything else: game of the week, a
    leaderboard, #lfg.
- **Rooms**, directly under the banner, in a card grid. Each card has four rows, shown mostly as
  symbols:
  - **Type and name.** Draft or Constructed as an icon, a trophy when it is a tournament (a draft pod,
    or `settings.tournament`), and seats filled (`6/8`).
  - **Mode.** A chip with the mode's icon (Classic, Gauntlet, All Random) and its format or pool, or
    the cube for a draft, then Bo1 or Bo3.
  - **State.** A dot and a label: lobby, drafting, building, playing, sideboarding, rounds or done,
    then one detail ("Pack 2 · pick 5", "Game 2 · turn 7", "Round 2 of 3").
  - **Actions.** Join or Watch, chosen by the state (one Join for members and newcomers alike, the operator, 2026-10-29), plus Watch whenever a game is on. This
    replaces a separate "also live" rail.
  - Everything here except the draft's pack and pick is already on the room wire.

**R5. Replay (UI).** `#/replay/<id>` adds a transport bar: play/pause, 1×/2×/4×, scrub by turn. It
uses the board the players used. Replays are reached from the table card's finished state, the
player's profile and the wildcard card; there is no replay list on the front page.

### Side benefit

The match registry never deletes a match, and each one holds its whole history in memory. Once the
recording is the durable copy, a finished match can be dropped from memory.

## Rulings (2026-10-26)

- **Feature everything by default.** No per-room opt-out.
- **Replays on demand rather than long retention.** The operator asked: *"is it possible to store
  every game action and recreate the game history from that?"* See below.

## Replay from actions

The operator: replays force every decision from the log; the AI never decides in a replay.

**Not proven — corrected the same day.** `replay-determinism.jvm.test.ts` (`[nightly]`) plays a
seeded two-human match, then replays only its commands on a fresh JVM. Eight local replays across
three deck pairs (100–269 commands, up to turn 11) ended on identical boards. On the claws it went
red 2 of 2 at 646f07a6, and on hokon only the final board matched, never the prompts. The cause is in
"Wave 77 results" below: an action log records what was sent, not what Forge applied. The test
left main with the rebuild it tests and lives on branch `w77-d`. The deal is identical from the seed alone: the same hands and library order. What the
recorder has to get right, each found by a red run:

- **Compare the folded board, never frames.** Forge batches state into packets on its own clock,
  sends a property at its default or omits it (`Mana: []`, `Loyalty: "0"`) depending on that
  batching, and interleaves the two seats' prompts by thread timing.
- **Place each command by position.** That is the seat's board and prompt when it was sent. A
  command sent from the same position as the one before it goes straight after it. A reply waits
  for its ask.

**Still to do before AI matches replay:**

- **One `Random` is shared.** Every `Collections.shuffle` passes `MyRandom.getRandom()`, but the AI
  draws from it too (120 call sites in forge-ai, 32 in forge-game). A live AI's thinking consumes
  numbers a replay with forced decisions never draws, so later shuffles differ. Fork change: the
  rules get their own seeded `Random`.
- **AI decisions are not commands.** `PlayerControllerAi` decides inside Forge (110 abstract
  methods on `PlayerController`). It needs a recording wrapper, and a replaying controller that
  answers from the log by card and ability id.

**Engine drift.** A replay runs on the jar it was played on. Per-pin jars are already kept under
`~/.local/share/cardtable/jars/` (27, about 40 MB each, on 2026-10-26), and their `res` under
`~/.cache/cardtable-forge/<pin>/`. Keep any pin a replay still needs.

**Not yet measured:** a replay under CPU load (run it on a claw, not hokon), and the per-view CPU
for a long human game. Replay time scales with command count, not game length: 170 commands took
22 s, mostly the test's settle waits.

**Plan:**
- **Every match** keeps its action log (seed, decks, pin, commands with positions): a few KB.
- **Human-vs-human replays** re-simulate on demand. The resulting public stream is cached for a day.
- **Matches with an AI** keep the gzipped public stream until the two fork changes above land.

## Wave 77 results (2026-10-27)

**Shipped:**
- **The recorder** (`play/recording/`, 130c25ce): every match is seeded, with an action log kept
  90 days and a public stream kept 7 days, gzipped, under `CONFIG.recordingsDir`
  (`<dataDir>/recordings`, so PPE, prod and each e2e run are separate). Both files are written
  at the game's end. `GET /api/replays` and `GET /api/replays/:id` serve them.
- **The front page** (fc5381be): artboard A, with the live slot as `FeaturedMatch`, quiet through
  `holdMatchQuiet`.
- **`#/replay/<id>`.**
- **Replays work from the stored public stream**, so they last 7 days.

**Rebuild from the action log is not shipped.** Lane D's `rebuild.ts` is on branch `w77-d`,
unlanded. A real two-human match (Spirit Flames v Decay, seed 20261027, 268 commands) rebuilds
identically for its first ~148 commands, then runs ahead.

The cause, read from the log:
- Command 145 is seat 0's OK (a pass) with a spell on the stack.
- Live, seat 0 still held priority afterwards (146–148: another card and its payment), so Forge
  **ignored** that OK: it arrived while no input was waiting.
- The rebuild sends it when Forge *is* waiting, so it passes, and the game runs ahead.

The action log records what was *sent*, not what Forge *took*. The bridge acknowledges no act.
`replay-determinism.jvm.test.ts` passed 8/8 because its driver acts only on a settled screen, which
makes a dropped act rare. Real players click whenever they like.

Lane D's workaround made it worse. It skipped a pass once a later board digest matched, but passing
priority barely changes the board. The skip passed a seat that had not passed, and the next command
waited forever on "Waiting for A…". It is removed; a cross-seat burst rule replaced it.

**Second cause, found when the claws went red** (`PlayBridge.java`'s own `setPhaseDelayOff` comment):
a seat's act goes to Forge over its net layer (`NetGameController`), and Forge's server runs every
decoded message on a fresh, unsynchronized thread (`FThreads.invokeInBackgroundThread`). Two acts
sent in order can be applied in either order, and the bridge, which is the client side, cannot see
which input took which.

**To ship rebuild:** Forge must say which acts it applied, in the order it applied them.
- The echo must come from Forge's server side, where the input is consumed, so it is a fork change:
  a jar built on a claw and a pin switch. The recorder logs only applied acts, in applied order,
  and a rebuild sends only those.
- It is an engine change, so it is a wave of its own: the next wave's
  first item.
- Then rebase `w77-d`, re-run its `[nightly]` jar test to green, and wire it. The `ask` number on
  reply lines (646f07a6) already makes the reply mapping exact.
- Until then a replay lasts as long as its public stream (7 days).

## Wave 78 results (2026-10-27)

**Rebuild shipped, behind a check.**

What it does:
- The bridge echoes each act at the moment Forge applies it (`SeatController`'s seven
  `IGameController` overrides, in `PlayBridge.java`). It also echoes when a seat's input opens (an
  `InputQueue` observer).
- The action log (`v:2`) records applied acts, in applied order, and answers with their `ask`
  number. Nothing else.
- A rebuild sends each act only once its seat has an open input. That way ActGate's 5 s
  between-inputs hold (`GameServerHandler.java`'s `BETWEEN_INPUTS_MS`) never holds or drops one.
  Then it waits for the act's echo.
- The pin comes from the jar's name or its bundle directory (`<pin>/forge.jar` on CI).

**Not yet deterministic:**
- On the claws, a strict replay matched 4 of 6 times. One stalled, and one finished clean on a
  different board.
- So the recorder writes each seat's final board digest into the log's end line. A rebuild that
  does not reach both is refused, and never written or served.
- Proof: three claw runs at 4240b371 (40580147774, 40580161358, 40580174354), all green. The real
  rebuild came back ok each time. An earlier round's one divergence was refused and wrote nothing,
  as designed.
- `replay-determinism.jvm.test.ts` asserts the stronger, still-false property. It stays off main,
  on branch `w77-d`.

**Mutations the log does not carry:**
- `setTriggerDecision` (`PlayBridge.java:5160`) and `setPhaseDelayOff` (`:5130`) write straight into
  Forge's `YieldController`.
- Today's server never sends either one in play, but a player's own trigger-remember choice would.

**Open:** the remaining drift. A replay that cannot be rebuilt shows as unavailable once its 7-day
public stream has expired.

## Still open

- Rebuild matches most games, not all (wave 78 above); the drift's last cause is unknown.
- The replay scrubber moves by time, not turn: the public stream carries no turn markers yet.
- The draft card shows no pack and pick: not on the room wire.
- The Upcoming card reads `/api/events` (`apps/server/src/http/events.ts`); events are made from Create event beside Create room.
