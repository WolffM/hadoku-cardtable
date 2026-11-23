# To hadoku_site: host a friend's game inside cardtable rooms

From cardtable, 2026-11-23. A friend of the operator is writing a new game to run in cardtable
rooms next to Magic and Bomberman, friends only. Cardtable's half landed in `a51b8e034`; three
pieces are hadoku_site's. The game itself does not exist yet: its id, label and bundle are
unknown, so build the mechanism and leave the game's own values to fill in.

## What cardtable already does

- An external game is one entry in `EXTERNAL_GAMES`
  (`packages/game-ui/src/rooms/external-games-config.ts`): `id`, `label`, `seats`,
  `runtime: 'relay'`, `embedSrc` (a **same-origin** path to its `GameBundleModule` bundle, e.g.
  Bomberman's `/bomberman/embed/bomberman-embed.js`), `seatRejoinGraceMs`, and now
  `minTier: 'friend'`.
- `minTier: 'friend'` makes every room of that game invisible and unjoinable below the edge's raw
  `friend` tier (verified members excluded): room list, GET, join, chat socket, relay socket and
  link preview, checked on the server by the edge's own tier (`edgeTierOf`).
- The server registers external games only when `CARDTABLE_EXPERIMENTAL_GAMES=1`
  (`apps/server/src/plugins/external-games.ts`). Neither `services/pm2/cardtable-wrapper.mjs`
  nor `cardtable-ppe-wrapper.mjs` sets it today, so prod and PPE have no external games.
- A seat's `userId` handed to a bundle is the member id since `a51b8e034` (it was the display name).
- Relay outcomes are **not** recorded to game stats anywhere yet.

## The asks

1. **Turn external games on.** Set `CARDTABLE_EXPERIMENTAL_GAMES=1` in the PPE wrapper first and
   prove a Bomberman room starts and plays on `hadoku.me/cardtable-ppe/` (its embed is served from
   `/bomberman/embed/` today). Then prod. Note what this exposes: Bomberman becomes a room game in
   prod cardtable for anyone who switches on Settings → Experimental features. Show the operator
   that before flipping prod.
2. **Serve the friend's bundle same-origin, at friend tier.** A path on hadoku.me (like
   `/bomberman/embed/`) for the new game's bundle, gated at the edge at raw friend tier, so a
   non-friend cannot even fetch the code. Decide where the bytes come from (an npm package, a
   GitHub Pages build, an R2 upload) in a way the friend can publish to without operator help, and
   write that down as the friend's instructions. Use a placeholder id until the operator names it.
3. **Game stats for relay games.** Cardtable needs a way to record a relay game's finished match
   (seats by member id, winner/placings) to game stats, per game, the way Bomberman's standalone
   site does. Say what key or endpoint cardtable's server should hold (vault key name, wrapper
   env) and what shape it posts; cardtable will wire the relay end once that exists. Answer back
   in a `docs/requests/` reply in cardtable or as a message to the operator.

## Not asked

- No change to the member/guest floor, and no tier below guest.
- Cardtable adds the game's `EXTERNAL_GAMES` entry itself once its id and path exist.
