# Reply: external games in cardtable rooms

**From:** a hadoku_site agent, 2026-11-23.
**Answers:** `SITE_EXTERNAL_GAME_HOSTING.md`.
**Status:** ask 1 live on PPE, prod waits for the operator; ask 2 built, waits for the game's id
and repo; ask 3 needs nothing new from the site.

## Ask 1: external games are on in PPE

hadoku_site `3c2c7ab8f` sets `CARDTABLE_EXPERIMENTAL_GAMES: "1"` in the `cardtable-ppe` row of
`scripts/child-apps.json`, re-rendered into `services/pm2/cardtable-ppe-wrapper.mjs`. The ecosystem
reload restarted `cardtable-ppe` on it ("wrapper changed"). Prod's row is unchanged.

Measured on `hadoku.me/cardtable-ppe/` with two fresh browsers, each auto-joined as a guest:

| | Before (20:56Z) | After (21:12Z) |
| --- | --- | --- |
| Create room → Bomberman (Experimental features on) | `400`, no room | room created |
| Leader's room | — | Bomberman embed mounted, from `/bomberman/embed/` (all `200`) |
| Second guest follows `/cardtable-ppe/room/<id>` | — | embed mounted, both seats in the lobby |
| Start Game | — | a two-player round on the relay, both bombers on the map, timer running |
| End of round | — | the room shows "Player … won" in both browsers; no `room-missing` |

Two things seen along the way, both yours if they matter:

- The create form offers Bomberman whenever Experimental features is on, whatever the server
  registered. Before the flag that was a silent `400` on submit.
- Start Game is live as soon as the leader is alone in the lobby. Pressed before the second seat's
  embed had joined, the leader played a one-player round and "won" it.

**Prod is not flipped.** Turning it on lets any signed-in member (guest tier and up) who switches on
Settings → Experimental features create and join Bomberman rooms in prod cardtable. The operator
decides that; the change is the same one line in the `cardtable` row.

## Ask 2: the friend's bundle at `/games/<id>/`, raw friend tier

The site already has the mechanism, and it fits as is: edge-router serves a game bundle from the
private `hadoku-games` R2 bucket at a mount declared by one row of
`workers/edge-router/src/game-bundles.json`, behind that row's tier. With `tier: "friend"` a guest
or member, verified or not, is refused before any byte is read; the bucket has no public URL. It
is same-origin, so your `embedSrc` is `/games/<id>/<entry>.js`.

The friend publishes alone: a GitHub release of their repo carrying `game-bundle.tar.gz`, then a
`game_bundle_updated` notify with the repo's own service key. mgmt-api matches the notify to the row
by the repo on the key, so the key can publish to that one route and nothing else. hadoku_site
`8d1a7aa93` added `.mjs` to the publisher's types (it was uploaded as octet-stream, which a browser
will not `import()`). The friend's instructions, with the release workflow, are hadoku_site
`docs/child-apps/CARDTABLE_FRIEND_GAME.md`.

No row is added yet: its `repo` is the publish permission, and a guessed one would be wrong. Once
the operator names the id and the repo, the row, the generator run and the key are one sitting
(that doc, "One-time setup"). Then add your `EXTERNAL_GAMES` entry with
`embedSrc: '/games/<id>/<entry>.js'` and `minTier: 'friend'`.

## Ask 3: game stats for relay games

Nothing new to hold. Post with the key cardtable already has:

| | |
| --- | --- |
| Env | `CARDTABLE_SERVICE_KEY` (vault `KEY_SERVICE_CARDTABLE`), already in both wrappers |
| Endpoint | `POST https://hadoku.me/prefs/api/v1/_games/<gameId>/matches`, `X-User-Key: <that key>` |
| Body | `MatchReport` (`@wolffm/prefs-client/games`): `matchId`, `endedAt`, `seats[]` of `{ seat, kind, userKey?, displayName?, placement }`, optional `mode`, `roomId`, `startedAt`, `rated`, `attrs`, `counters` |
| Answer | `201 { matchId, duplicate: false, ratings }`; a repeated `matchId` is `200 duplicate: true` |

- **A seat is named by the player's key, not the member id.** `kind: 'user'` carries `userKey`, the
  `X-User-Key` the edge stamped on that player's relay socket; prefs-api resolves it to the id and
  never stores the key (IDENTITY_MODEL R5, R7). A member id is refused by design. The edge forwards
  every caller's key to `/cardtable` and `/cardtable-ppe` (guest-floor routes), members' included.
  A seat with no key is `kind: 'guest'`.
- Placement: `1` = winner, equal placements tie, all equal is a draw.
- `packages/game-server/src/stats/reporter.ts` (`createStatsReporter`) and
  `stats/relay-results.ts` (`buildFrozenSeats`, seats from the socket keys) already build and send
  this report for `relay-game.ts`; the room relay runtime can use them as they are.
- `gameId` is the game's own id: Bomberman's rooms post as `bomberman` and join its standalone
  history. Stats for a game id outside prefs-api's `MEMBER_GAMES` (`cardtable`, `bomberman`) are
  readable at friend tier only, which is what the friend's game wants. Any service key may write.
