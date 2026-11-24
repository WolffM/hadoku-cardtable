/**
 * The ONE config for every external game cardtable may host as a room type — pure data, no
 * React, no import beyond this file's own types. "Deleting that one entry removes bomberman from
 * cardtable" (wave 119's settled rule): each entry names everything a room of that type needs —
 * its id, its label on the create form, its seat range, that it runs on cardtable's relay, its
 * same-origin embed bundle and its seat-rejoin grace — and nothing of that game's own code lives
 * here, exactly as `packages/shared/src/bomberman-game-type.ts` (deleted this wave) said of
 * itself.
 *
 * Read by both sides, which never import each other:
 * - `apps/server/src/plugins/external-games.ts` (the site, which may import anything) builds
 *   each entry into a `GameTypeSpec` and registers it, gated on `CARDTABLE_EXPERIMENTAL_GAMES=1`
 *   — unset, nothing here ever reaches the room registry, and creating or joining one of these
 *   room types refuses the same way any unregistered type always has.
 * - `./external-games.tsx` (platform) builds the same shape into a client `GameTypeSpec` plus the
 *   room UI's `BundleSlot`, unconditionally — a room already made keeps rendering whatever today's
 *   deployment flag says, since reading it needs no server round trip the client doesn't already
 *   make.
 *
 * Two test files outside this package read this same array rather than re-typing its fields:
 * `games/magic/server/src/plugins/relay.test.ts` and `games/magic/server/src/room/codec-generic.test.ts`.
 */

export interface ExternalGameConfig {
  /** The room's wire `gameType`. */
  id: string;
  /** What Create room's radio calls it. */
  label: string;
  /** The ROOM's own capacity — one meaning across every registered type (`GameTypeSpec.seats`). */
  seats: { min: number; max: number };
  /**
   * This game type's match runs on cardtable's relay (`RelaySession`): the host has no engine
   * of its own for it, only seats, watchers and a channel each seat's bundle speaks over.
   */
  runtime: 'relay';
  /** The same-origin path the client's `BundleSlot` loads this game's bundle from, its own repo's own embed entry. */
  embedSrc: string;
  /** How long a dropped seat is held for its player to come back (`relay-match.ts`'s `seatRejoinGraceMs`). */
  seatRejoinGraceMs: number;
  /**
   * Every room of this game is friends-only (`GameTypeSpec.minTier`): the server hides and refuses
   * it below friend tier, as the edge names it, and Create room offers it only to a friend or above.
   */
  minTier?: 'friend';
  /**
   * An entry that proves the GENERIC mechanism rather than any one real game (wave 120 §F:
   * "deleting the `bomberman` entry deletes nothing else" — `e2e/external-game-room.spec.ts` rides
   * on this one, never on `bomberman` by name). `apps/server/src/plugins/external-games.ts`'s
   * `setup()` filters an `e2eOnly` entry out of its registration loop unless
   * `CARDTABLE_E2E_TOY_GAMES=1` — a SECOND, dedicated gate on top of the shared
   * `CARDTABLE_EXPERIMENTAL_GAMES` every entry already has, so this one stays unregistered even
   * where a real external game is turned on. The e2e spec's own `startPlayStack` sets both.
   */
  e2eOnly?: boolean;
}

/**
 * One entry per external game cardtable may host, plus one e2e-only fixture entry. Bomberman's own
 * repo serves `/bomberman/embed/bomberman-embed.js` same-origin, the same path watchparty loads it
 * from.
 *
 * - `seats: {min:2, max:10}` — `hadoku-bomberman/game/src/consts.rs:54` (`MAX_PLAYERS = 10`) and
 *   `game/src/board.rs:136` (no 1-player map).
 * - `seatRejoinGraceMs: 120_000` — bomberman's own seat hold (its `BOMBERMAN_SEAT_HOLD_MS`), so a
 *   player who drops keeps their seat as long here as on bomberman's own server.
 */
export const EXTERNAL_GAMES: readonly ExternalGameConfig[] = [
  {
    id: 'bomberman',
    label: 'Bomberman',
    seats: { min: 2, max: 10 },
    runtime: 'relay',
    embedSrc: '/bomberman/embed/bomberman-embed.js',
    seatRejoinGraceMs: 120_000,
  },
  // An outside author's game (Cozmiverse/crossover-cards), served friends-only from
  // `/games/crossover-cards/` by hadoku_site's game-bundles.json row. Its rooms are friends-only
  // too, whatever the app's floor: it carries other publishers' card data.
  {
    id: 'crossover-cards',
    label: 'Crossover Cards',
    seats: { min: 2, max: 4 },
    runtime: 'relay',
    embedSrc: '/games/crossover-cards/embed.js',
    seatRejoinGraceMs: 120_000,
    minTier: 'friend',
  },
  {
    id: 'e2e-toy-relay',
    label: 'Toy Relay Game',
    seats: { min: 2, max: 4 },
    runtime: 'relay',
    embedSrc: '/e2e/toy-relay-embed.js',
    seatRejoinGraceMs: 120_000,
    e2eOnly: true,
  },
];
