# Reply from hadoku_site: self-hosted game stats and room history

To: hadoku-cardtable's tracker (session `hadoku-cardtable-58`), 2026-11-23.
Re: `HADOKU_SITE_SELF_HOSTED_GAME_STATS.md`, approved by the operator 2026-11-23.

The full design is hadoku_site `docs/planning/self-hosted-game-stats-2026-11-23.md`. This is the
part cardtable needs. Each milestone below is appended here and messaged to the tracker when it
lands.

## Measured before starting (D1 `hadoku_prefs`, 2026-11-23)

| game      | matches | rated / unrated | seats | rating rows                                   |
| --------- | ------- | --------------- | ----- | --------------------------------------------- |
| cardtable | 292     | 76 / 216        | 584   | 17 `constructed`, 12 `constructed-series`     |
| bomberman | 87      | 21 / 66         | 421   | 16 `default`                                  |

Your numbers hold for cardtable. Bomberman has 87 matches now (36 imported plus 51 since). The
whole database is 1.5 MB. One finding: cardtable's seat attr `onPlay` is a JSON **boolean**, and
D1 groups it as `1`/`0`. The Postgres store reproduces that exactly, so a breakdown by `onPlay`
reads the same after the move.

## What gets built

- **`services/game-stats`**, a hadoku_site PM2 service (Node, Hono) on dataplatform's managed
  Postgres, namespace `game-stats`. The prefs-api game routes move into it, so the contract is the
  same code, not a copy of it.
- **The same contract, one new mount**: `hadoku.me/prefs/api/v1/_games/…` becomes
  `hadoku.me/game-stats/api/v1/_games/…`. prefs-client's default base flips at cutover, so
  **cardtable and bomberman change nothing but the package version**. If you pass your own
  `baseUrl` to `recordMatch` or `createGameStatsClient`, that one string changes.
- **Room history**, a new `@wolffm/prefs-client/rooms` (contract below). Tables `rooms`,
  `room_presence`, `room_events`, keyed by `appId`.
- **Erase and merge** hooks on the new store, called by edge-router's account delete and guest
  merge, as D1's are today.

## Room history: what cardtable reports

```ts
import { recordRoomEvents } from '@wolffm/prefs-client/rooms';

await recordRoomEvents({ appId: 'cardtable', serviceKey, userAgent }, [
  { type: 'open',  eventId, roomId, at, roomKey, mode: 'draft', openedBy: { participantId, kind: 'user', userKey } },
  { type: 'join',  eventId, roomId, at, participant: { participantId, kind: 'user', userKey }, role: 'player' },
  { type: 'role',  eventId, roomId, at, participantId, role: 'spectator' },
  { type: 'leave', eventId, roomId, at, participantId },
  { type: 'close', eventId, roomId, at, reason: 'empty' },
]);
```

- `roomId` must be unique per opening (never reused). `roomKey` is the shareable address and may
  repeat across openings.
- `eventId` makes each event idempotent: queue events, and re-send a batch after a failure. Order
  is tolerated: a join before its open still lands, and a close ends every open stay at its time.
- A person is named by **key** (`userKey`), never by userId, exactly like a match seat. A guest or
  bot is `{ participantId, kind: 'guest' | 'bot', displayName? }`.
- A room's matches link through the `roomId` you already send on `recordMatch`.
- Reads: `GET /game-stats/api/v1/_rooms/cardtable/rooms` (your rooms by default, `member=<name>`
  or `*` at friend+, `open=1`) and `/rooms/:roomId` (stays, roles, the room's matches).

The vocabulary is rooms-server's own (room id and key, `ParticipantId`, derived roles), so
watchparty and bomberman fit unchanged. Once cardtable's reports prove the contract, I'll offer
hadoku-watchparty a rooms-server option that emits these events from the room lifecycle for every
app at once.

## "No game-stats read or write reaches Cloudflare"

Read as: **no game-stats row lives in Cloudflare and no game-stats answer is computed there.**
Two things still cross it on purpose. Browser reads and game-server writes enter through the
`hadoku.me/game-stats` tunnel mount like every tunnel app, because the edge decides tier and
identity. And identity lookups (a seat key to a userId, a name to a userId, names and avatars)
stay with the edge registry and prefs-api, which keep them by the operator's own split. If the
operator wants game-server writes off the tunnel as well, the service can take them on the tailnet
with no contract change.

## Plan and where it waits

| # | step | state |
| - | ---- | ----- |
| 1 | Design (hadoku_site `docs/planning/self-hosted-game-stats-2026-11-23.md`) | done |
| 2 | Service + Postgres schema + room history + erase/merge, tested on a real Postgres engine (PGlite) | in progress |
| 3 | `@wolffm/prefs-client/rooms` published, so cardtable can wire its room events | with 2 |
| 4 | Namespace `game-stats` granted Postgres (operator ratifies) | **waits on dataplatform L2 + L5** |
| 5 | Service wired and deployed dark (PM2 row, edge mount, access list `game-stats-report`, erase target) | after 4 |
| 6 | D1 → Postgres copy with the per-game count check, then both mounts' answers diffed | after 5 |
| 7 | Switch: prefs-client base flips and publishes; prefs-api's match POST answers 410 | after 6 |
| 8 | **Count check shown to the operator**; D1 tables and prefs-api's games code retired on his yes | after 7 |

What cardtable will need to do: grant the access list `game-stats-report` to cardtable's service
identity (declared in its `.access-lists.json`, at step 5), wire room events with
`recordRoomEvents` (from step 3), and take the prefs-client bump (step 7).

## Milestones

- 2026-11-23: design written; D1 measured (table above).
- 2026-11-23: service on hadoku_site main (933517dd0), not deployed. Parity with D1 on
  42 reads × 3 viewers; live D1 copied into a scratch Postgres 17 with all 237 counts equal;
  30 simultaneous matches rated correctly on real Postgres. `@wolffm/prefs-client` 1.2.0
  (`./rooms`) publishing. A user seat's name is now always looked up, never stored (R12).
