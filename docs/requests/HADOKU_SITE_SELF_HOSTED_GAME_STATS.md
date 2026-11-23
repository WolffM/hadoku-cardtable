# Request to hadoku_site: shared game stats, self-hosted on dataplatform Postgres, plus room history

From hadoku-cardtable's tracker, 2026-11-23, on the operator's decision. **Waits on**
`DATAPLATFORM_MANAGED_POSTGRES.md`: do not start the cutover before dataplatform's Postgres is
live. The design work can start now. Reply in `docs/requests/HADOKU_SITE_SELF_HOSTED_GAME_STATS_REPLY.md`
in hadoku-cardtable.

## What the operator decided (2026-11-23)

- *"i would prefer if all the data was self-hosted so we don't rely on cloudflare for this"*, and
  he rejected keeping history in D1.
- On bomberman: *"do whatever keeps us unified, yes. ideally we share as much code and infra as
  possible. if something needs to be abstracted and made generic then go for it."*
- On settings: *"game settings make sense to keep where they are"*. **prefs-api keeps prefs, items,
  avatars and everything else.** Only the game-stats half moves.
- *"we do want a room-history record."*

## What exists (yours, verified by the cardtable tracker 2026-11-23)

- prefs-api `/api/v1/_games/:gameId/*` (`workers/prefs-api/src/routes/games.ts`: matches, profile,
  leaderboard, breakdown), store `src/games/store.ts`, D1 tables `game_matches`,
  `game_match_players` and `game_ratings` (`migrations/0003_game_stats.sql`).
- Clients: `@wolffm/prefs-client/games` (`games.ts`, `games-contract.ts`) and `@wolffm/game-stats-ui`.
  Cardtable and bomberman both report through them.
- Data: cardtable 292 matches / 584 seats since 2026-10-11 (216 unrated); bomberman's imported
  history (36 matches / 152 seats on 2026-10-10, plus whatever has accrued since).

## The ask

1. **One self-hosted game-stats service**: the same HTTP contract and the same client packages, so
   cardtable and bomberman change at most a base URL. It is a tenant of dataplatform's managed
   Postgres. Where it runs (a hadoku_site PM2 service like mgmt-api, or elsewhere) is yours.
2. **Generic, not per game.** Everything stays keyed by `gameId`. A third game onboards with no code.
3. **Room history, generic across every app that uses the shared room logic** (cardtable,
   watchparty, bomberman): a room's id, app, mode, who opened it, when it opened and closed, and
   who was in it. Today a closed cardtable room leaves no record at all (its file is deleted).
   Cardtable will report open/close/member events. Design the contract so watchparty's rooms fit
   too.
4. **Migrate the D1 history** with every count checked before and after, then point the clients
   at the new service. Retire the D1 tables only once the counts match and the operator agrees.
5. **Erase.** Account erase covers the new store, as it covers D1 today.

## Done when (checkable)

- Cardtable's `#/stats` and bomberman's stats render the same numbers from the new service as from
  D1, compared on the migration day.
- A cardtable room's open and close show up in room history, with its members.
- No game-stats read or write reaches Cloudflare.
