# Telemetry and state inventory (2026-11-23)

The operator's question: can "last played" come from telemetry, do we have a database, and should
dataplatform give every cardtable node one SQL (or Redis) source of truth. Single primary, no
distributed DB.

Read-only pass on origin/main `83c23f132`. Every number below was measured on hokon on 2026-11-23
unless marked **unverified**. Paths: `PS` = `packages/service-kernel/src`, `GS` =
`packages/game-server/src`, `MS` = `games/magic/server/src`, `D` = `~/srv-data/cardtable` (prod;
PPE is `~/srv-data/cardtable-ppe`).

**Short answers.** There is a SQL database already: prefs-api's D1 (`hadoku_prefs`), and "last played"
is already a read from it. The prefs-api `breakdown` returns `lastPlayedAt` (`workers/prefs-api/src/games/store.ts:484`),
and the profile Decks table already shows it (`games/magic/ui/src/stats/StatsDecks.tsx:363`). That
read has a blind spot (§3, G1). What blocks a second node is not the lack of SQL. Authoritative room, draft and
match state lives in one process's memory with JSON files behind it, and sockets are pinned to that
process (§4).

## 1. Every place cardtable data is written

| # | Store | Holds | Writer (file:line) | Reader | Retention (measured) | Queryable | Shareable by 2 nodes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `D/rooms/*.json` | open lobby rooms: members, seats, app state | `@wolffm/rooms-server/store` `FileRoomStore`, built at `MS/room/lobby.ts:1097` | the same lobby at boot | 24 files, 136 KB, oldest `createdAt` 2026-11-01. Idle rooms close after 8 h (`MS/room/lobby.ts:400`); the file goes with the room, so **closed rooms leave no record** except `game_matches.room_id` | no (scan files) | no: one process owns the room in memory |
| 2 | `D/drafts/*.json` | draft pods: seats, picks, pool, built decks, `deckMeta` (rename/delete) | `MS/room/draftRooms.ts:564` (temp+rename), quarantine `:594` | draft rooms at boot; `/api/decks` (`MS/http/decks.ts`) | 25 files, 8.5 MB (largest 312 KB). Pods are never deleted (`MS/http/decks.ts:13`) | no | no |
| 3 | `D/recordings/*.gz` | per match: `actions.jsonl.gz` (header + commands, 90 d) and `public.jsonl.gz` (frames, 7 d) | `GS/play/recording/writer.ts:221`; rebuild `MS/play/recording/rebuild.ts:115`; erase rewrite `GS/erase/recordings.ts:58` | replays, rebuild | 102 actions + 62 public files, 8.7 MB, oldest 2026-10-28. 7 d / 90 d / 2 GB cap (`GS/play/recording/retention.ts:21-24`), swept hourly | no. The header names seats `"Player 1"` and carries the deck **text**; it has no userId (R12) | no |
| 4 | `D/parked/*.json` | parked (resumable) games | `MS/play/parked.ts:158` | resume route `MS/http/parked.ts` | 7 files, 60 KB | no | no |
| 5 | `D/tournaments.json` | every tournament: pods, results, standings | `MS/room/tournaments.ts:98`; correction CLI `MS/cli/tournaments.ts` | lobby, the tournament tab (re-read on mtime change) | 26 entries, 56 KB, kept forever | no | **would race**: whole-file rewrite, no CAS |
| 6 | `D/events.json` | scheduled events (Discord-linked) | `GS/room/events.ts:115` | events routes | 1 KB | no | would race |
| 7 | `D/presets.json` | draft plan presets | `MS/pools/presets.ts:106` | draft setup | 2.3 KB | no | would race |
| 8 | `D/cubes/*.json` | imported cubes (CubeCobra) | `MS/pools/cubes.ts:285` | cube pool | 2 files, 120 KB | no | would race |
| 9 | `D/chat/*.jsonl` | room and table chat | `@wolffm/rooms-server` via `GS/room/serve.ts:212` (`stateDir` from `MS/plugins/room.ts:27`) | the room on rejoin | 3 files, 20 KB | no | no |
| 10 | `D/sounds/` | generated SFX takes, `catalogue.json`, `assignments.json`, `marks.json`, `retired.jsonl` | `MS/http/sounds.ts:231,252,456,486,535` | sound routes and the music review | 2,605 files, **419 MB** (96% of `D`) | no | yes if moved to blobs; read-mostly |
| 11 | `D/callers-seen.json` | every userId this server ever admitted | `PS/telemetry/telemetry.ts:277` | first-seen middleware `:236` | prod 47 ids, PPE 130 ids | no | would race |
| 12 | `D/trim.json` | admin card-frame trim | `GS/http/trim.ts:78` (path `MS/plugins/routes.ts:134`) | trim route | absent on prod (never saved) | no | would race |
| 13 | `D/legacy-ids.done.json` | one-time id migration marker | `GS/erase/legacy-ids.ts:23` | boot | 259 B | n/a | n/a |
| 14 | pm2 logs `~/.pm2/logs/cardtable-out*.log` | every JSON log line: access log, `evt:*` (match, room, draft, jvm, placement), and **all browser `client` events** (`PS/relays/client-events.ts:78`). The "match log" is these lines filtered by `matchId` | `jsonLogger` everywhere | humans, `scripts/telemetry/player.ts`, the frames relay on the frames-telemetry branch | pm2-logrotate: 10 MB per file, 30 files kept (`~/.pm2/module_conf.json`). Prod has 24 files, 90 MB, **oldest 2026-11-06 (17 days)**. Top events: `client` 42k, `connected` 27k, `seats-told` 14k | grep only | no, host-local |
| 15 | monitoring-api D1 `service_events` | `capacity` 11,775 · `costly-act` 977 · `caller-first-seen` 762 · `usage` 729 · `forge-flaky` 207 · `seal-refused` 80 · `usage-user` 69 · `alert` 62 · `bot-game` 34 · `rate-limited` 1 · `session-takeover` 1 · `capacity-refused` 0 · `concede-forced` 0. 14,735 rows in all | `capacity` `PS/capacity/capacity.ts:109`; `costly-act`/`rate-limited` `PS/limits/limits.ts:42,45`; `usage`/`usage-user` `PS/relays/usage.ts:122,134`; `seal-refused`/`caller-first-seen` `PS/telemetry/telemetry.ts:211,241`; `alert` `:85`; `bot-game` `MS/play/botgames.ts:70,88`; `capacity-refused` `MS/play/socket.ts:763`; `concede-forced` `GS/play/match/shell.ts:367`; `session-takeover` `GS/room/session.ts:98` | `scripts/telemetry/watch.ts` (daily cron), `player.ts` | 90 d by policy (hadoku_site `docs/child-apps/TELEMETRY.md:13`). Oldest cardtable row is 2026-11-02; `usage-user` only since 2026-11-22 (`155c8c933`) | HTTP filter by `event`/`since`, ≤1000 rows a page. No SQL for us | yes (it is remote) |
| 16 | monitoring-api D1 `request_logs` | every edge request: path, status, userId, tier, UA, geo | edge-router | `watch.ts`, `player.ts` | 90 d (TELEMETRY.md:12) | HTTP filter by path/user/status | yes |
| 17 | prefs-api D1 `game_matches` / `game_match_players` / `game_ratings` | every finished room match and series: seats, user_id, outcome, rating, attrs (`deck`, `deckId`, `colors`, `avatar`, `onPlay`, mode) | `MS/stats/index.ts:63-91` → `GS/stats/reporter.ts` (bounded idempotent retry) → `POST /_games/cardtable/matches` | Stats page, profile, deck picker order (`games/magic/ui/src/stats/source.ts:64-191`) | kept forever ("we should keep the logs", `source.ts:10`). cardtable: **292 matches** (76 rated), 584 seats, 18 distinct users, 2026-10-11 → 2026-11-22 | **yes, SQL**, through fixed routes (`profile`, `leaderboard`, `breakdown`, `matches`) | yes |
| 18 | prefs-api D1 `prefs` / `items` | per-user settings rows | the browser, and the server through service routes (`MS/http/musicReviewStore.ts:54-64`) | same | `cardtable-play` 17 rows, `cardtable-sound` 9, `cardtable-music-review` 1; **`items`: 0 cardtable rows** | SQL behind routes | yes |
| 19 | Art mirror `~/.local/share/cardtable/art/mirror.jsonl` | scryfallId → CDN key, one line per uploaded image | `games/magic/packages/carddata/src/cli/upload-art.ts:274` (append) | `MS/pools/art-keys.ts` → `/api/art/<id>` (`MS/http/card-art.ts`) | 113,835 lines, 14 MB, last write 2026-11-07 | no (in-memory map) | no, host-local file |
| 20 | `MS/play/art-manifest.json` (committed) | hand repoints scryfallId → {source,key} | humans | `games/magic/packages/carddata/src/art/index.ts` | in git; currently has no rows | n/a | yes (it is in the build) |
| 21 | Card catalog `~/.local/share/cardtable/catalog/cards.json` (+ `scryfall/` corpus) | every card the server knows | `games/magic/packages/carddata/src/catalog-build.ts:96`, daily refresh `MS/pools/refresh.ts` | catalog, card-art artist lookup | 30 MB (83 MB with 2 backups), `scryfall/` 188 MB | no | each node rebuilds its own; derived data |
| 22 | Backups: dataplatform data store, ns `mgmt`, `cardtable-backup/` | nightly packs + manifest of all of `D` and the PPE dir | hadoku_site `services/mgmt-api/src/routes/jobs/cardtable-backup.ts` (05:00 PT) | restore script | 14 daily + 8 weekly (hadoku_site `docs/operations/CARDTABLE_BACKUP.md`) | no | n/a |

## 2. The questions, and what answers them today

| Question | Store | The read | Status |
| --- | --- | --- | --- |
| Last played, per deck | #17 | `GET /_games/cardtable/breakdown?attr=deckId&rated=…` → `lastPlayedAt` (`store.ts:495`). The UI reads it **rated only** (`source.ts:50,89`) | **answerable now** for rated games. Games against Forge AI need a new read with no rated filter (G1) |
| Last played, per player | #17 | `profile` / `matches?player=` | answerable now |
| Who played what deck | #17 | `game_match_players.user_id` + `attrs.deck/deckId`. 284 of 290 non-series user seats carry `deckId` | answerable now |
| A player's history | #17 (games), #16 + #15 (visits: `scripts/telemetry/player.ts`), #14 (in-match moves, 17 d) | three reads joined by userId | games answerable now. The full visit trail needs a new read, and pm2 has already lost what happened before 2026-11-06 |
| Deck usage / win rate | #17 | `breakdown?attr=deck` | answerable now |
| Colour usage | #17 | `breakdown?attr=colors` | answerable now (the Colours tab) |
| Art usage (which images are drawn) | #16 `request_logs` path `/cardtable/api/art/<id>` | count by path over 90 d | **answerable with a new read**, as a lower bound: the browser caches the redirect for a day (`card-art.ts:6`), so a count is browser-days, not draws |
| Card usage (which cards are played) | #3 deck text in recording headers (90 d), #2 pools | parse gzipped files | answerable with a new read, local only |
| Room history (who made what room, when, its mode) | #15 `costly-act act=room-create` (throttled: one per caller per minute, so a lower bound), #17 `room_id` for rooms that had a match | — | **not answerable** for closed rooms: the room file is deleted (G3) |
| Draft history (who drafted which cube, picks) | #2 (pods kept forever), #14 `pick`/`bot-picks` (17 d) | scan `D/drafts` | answerable with a new read, local files only, not SQL |
| Tournament history | #5 | `MS/cli/tournaments.ts list` | answerable now (CLI), not SQL |
| Active players per day / new accounts | #16 user_id, #15 `caller-first-seen` | `watch.ts` | answerable now |

## 3. Duplication and gaps

| # | Finding | Evidence |
| --- | --- | --- |
| G1 | **"Last played" hides bot games.** The UI asks only for rated matches. A match with Forge AI or a guest in it is unrated. 216 of 292 cardtable matches are unrated, so a deck played only against the AI shows as never played | D1: `SUM(rated)=76` of 292; `source.ts:50` |
| G2 | **`caller-first-seen` and `callers-seen.json` disagree.** Monitoring has 53 prod first-seen accounts, but the prod file holds 47 ids, and only 40 of them overlap. PPE has 698 first-seen accounts against a 130-id file. Account erase drops ids (`telemetry.ts:251`), and prod logged `account-erased` 1,115 times in 17 days of pm2 logs. Two stores of one fact | measured |
| G3 | Closed rooms vanish. Nothing records a room's lifecycle, so "rooms per week" has no answer | §1 #1 |
| G4 | Browser `client` events (42k lines) go **only** to pm2 stdout, kept 17 days. The frames-telemetry branch (`8f31e91d5`, `PS/relays/frames.ts`) re-reads those log lines to post a `frames` summary: the same data on a second path | `PS/relays/client-events.ts:78` |
| G5 | Match outcome is written three times: the pm2 log (`game-over` 77, `stats-recorded` 115), the recording file, and D1. Only D1 is queryable and kept | §1 |
| G6 | `bot-game` service events (34) duplicate bot seats in D1 (194 `kind='bot'` seats) | measured |
| G7 | PPE dominates monitoring: 569 of 798 `page-load` costly-acts and 698 of 762 first-seen rows are PPE (the automated tour and e2e). `watch.ts` must keep splitting by `site` | measured |
| G8 | Read by nobody in practice: `D/legacy-ids.done.json`; `capacity` every 5 min from both sites (11.8k rows, read only by `watch.ts` peaks); `D/sounds/*.bak-*` catalogue backups (9 files) | — |
| G9 | No store links a draft deck (`deckId` = pod roomId) to the pod's cube and the date it was drafted in SQL. Joining "decks drafted but never played" means reading `D/drafts` beside D1 | `MS/http/decks.ts:40-52` |

## 4. One source of truth for several cardtable servers

### What has to move off local disk

| State | Hot? | Why it blocks node 2 | Where it belongs |
| --- | --- | --- | --- |
| rooms, chat, drafts, parked, live matches | yes: every pick and seat change | authoritative copy is **in memory** of one process; sockets attach to that process | stays owned by one node per room. The durable copy goes to a shared store, under a lease that names the owner |
| tournaments, events, presets, cubes, trim, callers-seen | rarely written, read by every room | two nodes rewriting a whole file lose each other's writes | a shared record with compare-and-swap |
| recordings, sounds | write-once blobs | a node can't replay a match another node recorded | blob store |
| art mirror, catalog | derived, rebuilt daily | none: each node can rebuild it, or read one shared copy | keep per node, or share as a blob |
| match/game history | append-only | already shared (prefs-api D1) | stays |

The routing half is outside storage. The edge (hadoku_site) must send a room's sockets to the node
that owns it. None of the options below remove that.

### The options

| | (a) prefs-api D1, extended | (b) dataplatform data store, as is | (c) new SQL service on dataplatform | (d) Redis |
| --- | --- | --- | --- | --- |
| Exists today | yes, holds the match history | yes, hokon `100.99.82.75:9002`, used by pygmalion, watchparty, ArchiveBot and cardtable's backup | no. The only Postgres on hokon is `temporal-postgres` (Temporal's own) | no Redis anywhere in the fleet (checked `which`, `docker ps` on hokon) |
| Model | SQL behind hand-written worker routes | versioned KV, `If-Match` CAS, appends, blobs up to 16 GiB, **prefix leases that fence a lapsed holder**, change feed (`server/dataplatform/data/AGENTS.md`) | SQL | in-memory KV, pub/sub, TTL keys |
| Latency from a node | Cloudflare round trip (**unverified**; tens of ms) | LAN: 0.6–2.4 ms p50 for 2 MB ranges (measured by dataplatform 2026-10-26) | LAN | sub-ms |
| Fit for hot room/draft state | poor: every pick becomes a worker deploy's schema and an internet round trip | good: the snapshots are already whole JSON documents written temp+rename, which is exactly one PUT with `If-Match` | good, but rows for what is today one JSON document | poor as truth (durability is opt-in), good as cache |
| Fit for history queries | **best**, and already there | none (no query) | good | none |
| Cost to adopt | a hadoku_site change per table; prefs-api is a fleet-wide user service | a TS client (the Python `client.py` is stdlib HTTP, so it is small), one grant, one env var | a new service: auth, grants, peers, migrations, backups, its own on-call. That duplicates what (b) already has | a new service with the same costs, and it is still not the source of truth |

### "Maybe Redis"

Redis is good at three things here, and the fleet already covers each of them:

| Redis job | Need at one primary | Already covered by |
| --- | --- | --- |
| Presence (who is online in a room) | per room, on the owning node, in memory | the room's own sockets (`GS/room/session.ts`) |
| Locks (which node owns room X) | yes, once there are 2 nodes | data store leases. They are fences: a write on a lapsed token is refused, which a Redis `SET NX PX` lock does not give you |
| Pub/sub (node A tells node B "tournaments changed") | yes, for the shared records | the data store change feed (poll by cursor). Seconds of lag is fine for tournaments and presets |

What needs SQL is history and analytics (§2), and D1 already does that. Redis would be a fourth
store to run, back up and reason about, and it would answer none of §2's questions.

### Recommendation

**Use (b), dataplatform's data store, as cardtable's one source of truth for state, and keep
prefs-api D1 as its one SQL history.** Don't build (c) or (d).

The reasons:
- (b) already has the primitives a second node needs: CAS, fencing leases and a change feed. It sits on
  the LAN, and it is backed up nightly with verification.
- D1 already answers the operator's SQL questions.
- Each fact keeps exactly one home: live state in the data store, finished history in D1.

**First slice**, with no second node yet:
1. Add a TS client for the data store to `packages/service-kernel/src/state/`.
2. Grant a `cardtable` namespace and a `cardtable-ppe` one.
3. Move the cross-room singletons (`tournaments.json`, `events.json`, `presets.json`, `cubes/`,
   `callers-seen.json`) behind it. Each write is `PUT` with `If-Match`, and each read comes from a
   change-feed cursor.

These files are the ones that would silently lose writes with two nodes. They total 180 KB and are
rarely written. Moving them also fixes G2's file half, and the night's backup of them becomes the
store's own.

Rooms and drafts move after that, one record per room, under a lease that names the owning node.
That waits until the edge can route a room to its owner.

**Alongside it, in D1**, two small changes would answer §2's "not answerable" rows:
- A `rated=any` read for "last played" (G1).
- A room-lifecycle append for room history (G3): the room id, its mode, who created it, and when
  it opened and closed. It could ride `game_matches` with a `mode` of its own, or be a new table;
  that choice is hadoku_site's.
