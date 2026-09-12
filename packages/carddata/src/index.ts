/*
 * @hadoku/carddata — card data for cardtable.
 *
 * Two things live here, both needed in either branch of D7 (the gdx-teavm
 * spike), which is why this is not blocked on it:
 *
 *   1. A scheduled Scryfall bulk-data ingest that caches gameplay fields
 *      locally. Never a per-request call to their API, and with no image code
 *      path at all — see `scryfall/project.ts` for how that is enforced.
 *   2. A parser for Forge's `.dck` format, plus Forge's 95 bundled cube lists
 *      copied into `cubes/` at the repo root.
 *
 * Operational notes are in `docs/CARD_DATA.md`, including the verified Scryfall
 * terms this package is built against.
 */

export {
  parseDck,
  parseCardLine,
  parseCardRequest,
  countCards,
  countEntries,
  DEFAULT_ART_INDEX,
  type DeckFile,
  type DeckEntry,
  type CardRequest,
} from './dck.ts';

export { cubesDir, listCubeFiles, loadCube, loadAllCubes } from './cubes.ts';

export {
  sync,
  fetchBulkListing,
  selectBulkEntry,
  downloadUrl,
  readManifest,
  BULK_TYPES,
  type BulkType,
  type BulkDataEntry,
  type SyncManifest,
  type SyncOptions,
  type SyncResult,
} from './scryfall/bulk.ts';

export {
  projectCard,
  ALLOWED_CARD_FIELDS,
  ALLOWED_FACE_FIELDS,
  ALLOWED_PART_FIELDS,
  type RawCard,
  type GameplayCard,
} from './scryfall/project.ts';

export { SCRYFALL_API, userAgent, getJson, RateLimitedError } from './scryfall/client.ts';
