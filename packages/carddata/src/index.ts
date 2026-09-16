/*
 * @hadoku/carddata — card data for cardtable.
 *
 * The card-data half of the app lives here — all of it needed in either branch
 * of D7 (the gdx-teavm spike), which is why none of it was blocked on it:
 *
 *   1. A scheduled Scryfall bulk-data ingest that caches gameplay fields
 *      locally. Never a per-request call to their API, and the projection it
 *      writes has no image field — `ALLOWED_CARD_FIELDS` in
 *      `scryfall/project.ts` names every field that survives, and none of them
 *      is an image. That is still true and still enforced.
 *   2. A parser for Forge's `.dck` format, plus Forge's 95 bundled cube lists
 *      copied into `cubes/` at the repo root.
 *   3. A parser for Forge's `.draft` recipe format, plus Forge's 94 bundled
 *      recipes copied into `drafts/`. A cube list says which cards; a recipe
 *      says how packs are made out of them.
 *   4. The resolver that turns `1 Stoneforge Mystic|PRM` into a real card, and
 *      returns its failures instead of throwing them.
 *   5. **Card art**, which is a separate pipeline on purpose: `src/art/` (the
 *      manifest types and `resolveArtUrl`, exported as `@hadoku/carddata/art`)
 *      and `src/cli/upload-art.ts` (fetch from Scryfall, upload to
 *      `cdn.hadoku.me`, record the key).
 *
 * ## Where the image code path is, and where it is not
 *
 * This package used to claim it had "no image code path at all". Since D15
 * (2026-09-15, `docs/DECISIONS.md`) it does, in exactly one place — item 5 —
 * and the claim now has to be made at the right granularity rather than
 * dropped, because the narrow version is load-bearing and still true:
 *
 * - **The ingest, the projection, the resolver and the pool writer carry no
 *   image data.** `ALLOWED_CARD_FIELDS` names no image field, `resolve.ts`
 *   emits none, and `build-pool.ts` refuses at runtime to write a pool
 *   containing an image field or a URL that looks like one.
 * - **Art is an indirection keyed by `scryfallId`**, held in
 *   `apps/ui/src/draft/art-manifest.json` and resolved by `src/art/`. It is
 *   deliberately NOT in `pool.json`, because `build-pool` regenerates the pool
 *   wholesale and would discard it.
 * - **Image bytes never enter this repo.** They go from Scryfall to the CDN
 *   through `upload-art`, in memory; `.gitignore` refuses `*.jpg`/`*.png` and
 *   the CI gate fails on an image in the bundle.
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
