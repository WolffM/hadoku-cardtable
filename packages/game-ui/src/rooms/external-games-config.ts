/**
 * The ONE config for every external game cardtable may host as a room type: the HOST's half of
 * each, pure data. "Deleting that one entry removes bomberman from cardtable" (wave 119's settled
 * rule): an entry names the game's id, that it runs on cardtable's relay, where its same-origin
 * embed bundle is, and who may play it. Nothing here is the game's to decide: its name, seat range
 * and seat hold are in the `manifest.json` it publishes beside its embed entry
 * (`@hadoku/platform-wire/external-game-manifest`, `docs/GAME_AUTHORS.md`), which the server reads.
 *
 * Read by both sides, which never import each other:
 * - `apps/server/src/plugins/external-games.ts` (the site) reads each entry's manifest, builds the
 *   pair into a `GameTypeSpec` (`@hadoku/shared`'s `externalGameSpec`) and registers it, gated on
 *   `CARDTABLE_EXPERIMENTAL_GAMES=1`, and answers `GET /api/external-games` with the labels.
 * - `./external-games.tsx` (platform) registers each entry's room UI, a `BundleSlot` on the relay,
 *   unconditionally: a room already made keeps rendering whatever today's deployment flag says.
 */
import type { ExternalGameManifestInput } from '@hadoku/platform-wire/external-game-manifest';

export interface ExternalGameConfig {
  /** The room's wire `gameType`. */
  id: string;
  /**
   * This game type's match runs on cardtable's relay (`RelaySession`): the host has no engine
   * of its own for it, only seats, watchers and a channel each seat's bundle speaks over.
   */
  runtime: 'relay';
  /** The same-origin path the client's `BundleSlot` loads this game's bundle from; its `manifest.json` is beside it. */
  embedSrc: string;
  /**
   * Every room of this game is friends-only (`GameTypeSpec.minTier`): the server hides and refuses
   * it below friend tier, as the edge names it, and lists it only to a friend or above.
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
  /** An `e2eOnly` fixture's manifest, since no publisher serves one for it. A real game's is always its own file. */
  manifest?: ExternalGameManifestInput;
}

/**
 * One entry per external game cardtable may host, plus one e2e-only fixture entry. Bomberman's own
 * repo serves `/bomberman/embed/bomberman-embed.js` same-origin, the same path watchparty loads it
 * from.
 */
export const EXTERNAL_GAMES: readonly ExternalGameConfig[] = [
  {
    id: 'bomberman',
    runtime: 'relay',
    embedSrc: '/bomberman/embed/bomberman-embed.js',
  },
  // An outside author's game (Cozmiverse/crossover-cards), served friends-only from
  // `/games/crossover-cards/` by hadoku_site's game-bundles.json row. Its rooms are friends-only
  // too, whatever the app's floor: it carries other publishers' card data.
  {
    id: 'crossover-cards',
    runtime: 'relay',
    embedSrc: '/games/crossover-cards/embed.js',
    minTier: 'friend',
  },
  {
    id: 'e2e-toy-relay',
    runtime: 'relay',
    embedSrc: '/e2e/toy-relay-embed.js',
    e2eOnly: true,
    manifest: { label: 'Toy Relay Game', seats: { min: 2, max: 4 }, seatRejoinGraceMs: 120_000 },
  },
];
