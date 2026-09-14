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
 *   3. A parser for Forge's `.draft` recipe format, plus Forge's 94 bundled
 *      recipes copied into `drafts/`. A cube list says which cards; a recipe
 *      says how packs are made out of them.
 *   4. The resolver that turns `1 Stoneforge Mystic|PRM` into a real card, and
 *      returns its failures instead of throwing them.
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
  parseDraftRecipe,
  parseBoosterSlots,
  packSize,
  totalCardsDealt,
  GENERIC_DRAFT_BOOSTER,
  type DraftRecipe,
  type BoosterSlot,
} from './draft.ts';

export {
  draftsDir,
  listDraftFiles,
  loadDraftRecipe,
  loadAllDraftRecipes,
  cubeForRecipe,
} from './drafts.ts';

export {
  resolveCard,
  buildCardIndex,
  loadCardIndex,
  normaliseName,
  foldName,
  NAME_VARIANTS,
  type CardIndex,
  type Resolution,
  type ResolvedCard,
  type UnresolvedCard,
  type ResolutionTier,
  type UnresolvedReason,
  type NameMatch,
} from './resolve.ts';

export {
  toScryfallSetCode,
  isKnownForgeSetCode,
  FORGE_TO_SCRYFALL_SET,
} from './set-codes.ts';

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
