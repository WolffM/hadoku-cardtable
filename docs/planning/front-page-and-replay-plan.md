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

**R1. Watch without sitting (server, small, first).** `forge:join` claims the first free human seat,
so a front-page tile that joined a match with an empty seat would *sit the visitor down*. Add
`watch: true` to the join; it always lands on `WATCHER_SEAT`. Nothing else is safe to build until
this lands.

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

**R3. "Something is happening" (server).** Each match keeps `lastActAt`, stamped on every watcher
state frame, plus a short ring of act times. `GET /api/featured`, pushed through the existing room
feed as `featured:changed`, picks:

- *Eligible:* status live, past mulligans, an act in the last ~60 s, not in a testing room.
- *Score:* acts in the last 2 min (the main term), plus turn ≥ 3, close life totals, two humans
  rather than a human and an AI, and current watchers.
- *Hysteresis:* keep the current pick until it ends or goes idle for 60 s. A hero that switches
  mid-combat is worse than one that shows a slightly duller game.
- *Ladder:* best live match → best recording from the last 24 h, looped → today's plain list.

**R4. The front page (UI).** It is laid out like Twitch:

- The **hero** is `LiveBoard` in a new read-only `embedded` mode, scaled whole to its box rather
  than re-laid-out (the board's table-fit stays the board's), with a "LIVE · Turn 7 · Alice vs Bob"
  strip. Clicking it opens `#/match/<id>`.
- A **rail** of the other live tables uses the existing `TableCard`.
- **Recent games** link to replays.
- The **room list** stays below, so the page still has "one door".

The hero is muted. Its sound stays off until it is clicked.

**R5. Replay (UI).** `#/replay/<id>` adds a transport bar: play/pause, 1×/2×/4×, scrub by turn. It
uses the board the players used. Replays are also reachable from the table card's finished state
and from Stats.

### Side benefit

The match registry never deletes a match, and each one holds its whole history in memory. Once the
recording is the durable copy, a finished match can be dropped from memory.

## Open questions for the operator

1. **Consent.** Is every match featurable by default, or do rooms get a "don't feature / don't
   record" toggle? Recording is public-info only either way.
2. **Retention.** How long to keep recordings: 30 days, or until a size cap?
3. **Idle hero.** When nothing is live: loop a recent replay (costs nothing), or run an AI-vs-AI
   exhibition (costs a JVM around the clock, so it is a hosting decision)?
4. **Perspective.** The watcher channel is oriented from the first human seat. Is that fine for the
   hero, or should it alternate?
