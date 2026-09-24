/*
 * Where a card's art comes from — as a lookup, not as a URL.
 *
 * ## The point of this module
 *
 * The operator expects to re-source card art later: *"there's a good chance i
 * source the art from somewhere else in the future… just make sure that it's
 * easy to simply hook up a link to a new image in the cdn whenever that
 * happens."* So the deliverable is deliberately NOT a list of URLs. It is one
 * level of indirection:
 *
 *   manifest row  →  { source, key }  →  resolveArtUrl  →  a URL
 *
 * Repointing one card is a one-line edit to committed JSON, reviewable in a
 * diff, touching no component. Adding a whole new source later is a new `case`
 * in the one switch below plus manifest rows — again, no component changes.
 * `index.test.ts` pins that with an assertion rather than a promise: two
 * manifests differing in a single entry, resolved over several ids, and every
 * unchanged id's URL compared byte-for-byte.
 *
 * ## Why keys, and why we compose the URL ourselves
 *
 * A manifest row stores a CDN **key**, never a URL. That is `@wolffm/cdn-client`'s
 * own instruction, in its README §"Store the `key`, never the URL": the CDN
 * hostname is expected to move (`cdn.hadoku.me` is same-site with the app, and
 * the isolation upgrade is a separate registrable domain), so a consumer that
 * holds keys survives that as a config change while one holding absolute URLs
 * needs a migration over its own history. We honour that rule exactly — the
 * hostname lives in one constant, in one function.
 *
 * We do not, however, import that client here. Its `urlFor` is
 * `` `${cdnBase}/${key.replace(/^\/+/, '')}` `` (verified in
 * `dist/chunk-QCRVVO7U.js:145`) — one string concatenation, which is not worth
 * pulling an upload client, its error classes and its fetch wrapper into a
 * browser bundle for. The **upload CLI** uses the real client, because that is
 * where the client earns its keep. This module is the render path.
 *
 * ## Why the manifest is not in `pool.json`
 *
 * `pool.json` is regenerated wholesale by `build-pool`. Art assignments are
 * hand-curated. Putting them in the pool would mean the next regeneration
 * silently discarded them, which is precisely the kind of quiet loss this repo
 * keeps finding after the fact. So the manifest is its own committed file,
 * `apps/ui/src/draft/art-manifest.json`, and `build-pool` never writes it.
 *
 * ## `size` is a Scryfall-only concept
 *
 * A CDN key addresses **one stored object at one size** — the CDN is
 * content-addressed by SHA-256, so a different size is a different key and
 * therefore a different manifest row. `options.size` is passed straight through
 * to Scryfall's path and is ignored by the CDN arm. This is not an oversight;
 * do not "fix" it by appending a size to a key, which would name an object that
 * does not exist.
 *
 * `normal` is the default because it is the right one, and that was measured
 * rather than guessed. A card tile is `--card-w: 190px`; Scryfall's `normal` is
 * 488px wide, covering that to ~2.5x device pixel ratio, so `large` (672px) is
 * never the right choice for this UI at any display density. The first cut of
 * the UI shipped a `srcset` whose `sizes` attribute held a CSS variable —
 * not a valid length, so the browser discarded it, fell back to `100vw` and
 * picked the largest candidate every time: 780x1086 images for a 190px slot,
 * verified in a real browser, roughly three times the bytes for no visible
 * difference. `apps/ui/src/draft/cardImage.ts` carries the full story.
 *
 * ## No Node APIs
 *
 * This module goes into the browser bundle. No `fs`, no `path`, no `process`,
 * and no reading of the manifest from disk — the caller imports the JSON and
 * hands it in.
 */

/** Where a card's art is stored. A new source is a new member plus a new `case`. */
export type ArtSource = 'cdn' | 'scryfall';

/**
 * One card's art assignment.
 *
 * `key` is meaningful only to sources that address objects by key — today, just
 * `cdn`, where it is the SHA-256 of the bytes plus an extension. A `scryfall`
 * row needs no key: the URL is derived from the card id.
 */
export interface ArtEntry {
  readonly source: ArtSource;
  readonly key?: string;
}

/** scryfallId -> entry. Absent ids are not an error; they fall back. */
export type ArtManifest = Readonly<Record<string, ArtEntry>>;

/**
 * The shape of the committed `art-manifest.json`.
 *
 * `version` exists so a future format change is detectable rather than
 * silently misread. Nothing switches on it yet; when something does, it will be
 * because the shape actually changed.
 */
export interface ArtManifestFile {
  readonly version: 1;
  /** Human note in the committed file. Carried so the type matches the file. */
  readonly note?: string;
  readonly entries: ArtManifest;
}

/** Scryfall's image sizes, in the URL shape they publish. */
export type ArtImageSize = 'small' | 'normal' | 'large';

/** Our CDN's origin. Expected to move one day; that is why it is one constant. */
export const CDN_BASE = 'https://cdn.hadoku.me';

/** Scryfall's image host. */
export const SCRYFALL_IMAGE_BASE = 'https://cards.scryfall.io';

/**
 * Every origin an art URL may legally carry, and nothing else.
 *
 * Same-origin is deliberately absent: we serve the app, not the bytes. A
 * relative or same-origin image URL means our server is the host, which is the
 * one thing the whole arrangement is built to avoid. Tests assert against this
 * list rather than against a single hardcoded host, so adding a source means
 * adding it here on purpose.
 *
 * `options.cdnBase` can of course produce an origin outside this list — that
 * override exists for tests and for the hostname move. The list names what the
 * defaults produce.
 */
export const ALLOWED_ART_HOSTS: readonly string[] = Object.freeze([
  CDN_BASE,
  SCRYFALL_IMAGE_BASE,
]);

/**
 * A CDN key: the SHA-256 of the object's bytes, plus an extension.
 *
 * Copied from `@wolffm/cdn-client`'s own `KEY_PATTERN`
 * (`dist/chunk-QCRVVO7U.js:87`) rather than imported, for the bundle reason in
 * the header. If the client ever widens its pattern, this diverges silently —
 * that is the cost of not importing it, and it is written down here so the next
 * person finds it rather than discovers it.
 */
const CDN_KEY_PATTERN = /^[0-9a-f]{64}\.[a-z0-9]{1,8}$/;

/** Scryfall ids are uuids. An id that is not one builds a URL that 404s. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * True if `value` is a well-formed CDN key.
 *
 * This is the single discrimination between a manifest row that names an object
 * and one that does not, and `resolveArtUrl` calls it — it is not merely
 * exported for callers to remember. Declared as a type predicate so the
 * resolver's narrowing falls out of the check rather than out of a cast; a
 * predicate is still a `boolean` everywhere a boolean is wanted.
 */
export function isCdnKey(value: string | undefined): value is string {
  if (typeof value !== 'string') return false;
  return CDN_KEY_PATTERN.test(value);
}

/**
 * Compose the URL for a CDN key.
 *
 * Leading slashes on the key are stripped, matching `urlFor`, so a key written
 * as `/<sha>` in a hand-edited manifest does not produce a doubled slash.
 * Trailing slashes on the base are stripped for the same reason.
 *
 * **Deliberately a dumb composer: it does not validate.** Validation lives at
 * the trust boundary — `resolveArtUrl`, where hand-edited JSON enters — and
 * putting it in one place beats putting it in two. `@wolffm/cdn-client` splits
 * the same way, `urlFor` and `isKey` side by side rather than fused, and the
 * upload CLI is why: a key handed back by the CDN is well-formed by
 * construction, so making the composer return `string | null` would force a
 * null check on a path where the case cannot arise. Callers that compose a key
 * of unknown provenance call `isCdnKey` first; the resolver does exactly that.
 */
export function cdnUrlFor(key: string, cdnBase: string = CDN_BASE): string {
  return `${cdnBase.replace(/\/+$/, '')}/${key.replace(/^\/+/, '')}`;
}

/**
 * Scryfall's sharded image path: `<size>/front/<id[0]>/<id[1]>/<id>.jpg`.
 *
 * Deterministic, so nothing has to be looked up and no request is made to find
 * out where an image lives. Returns `null` for an id that is not a uuid — a
 * 404 per card is a slow, silent way to look broken, and the caller's text tile
 * is a complete card on its own.
 */
function scryfallArtUrl(scryfallId: string, size: ArtImageSize): string | null {
  if (!UUID_PATTERN.test(scryfallId)) return null;
  return `${SCRYFALL_IMAGE_BASE}/${size}/front/${scryfallId[0]}/${scryfallId[1]}/${scryfallId}.jpg`;
}

/**
 * Resolve a card's art URL, or `null` when there is none to build.
 *
 * Four cases, each pinned by a test:
 *
 * 1. a `cdn` row with a key  → `${cdnBase}/${key}`;
 * 2. a `scryfall` row, or no row at all → Scryfall's sharded URL;
 * 3. no usable id → `null`, and the caller renders the text tile;
 * 4. a row this resolver does not understand → it falls back, below.
 *
 * ## The unknown-source decision: fall back to Scryfall, never throw
 *
 * A row whose `source` is a value this build has never heard of — or a `cdn`
 * row whose `key` is missing, empty, **or not a well-formed key** — resolves
 * exactly as if the row were not there at all. Two reasons, both about what
 * this file actually is:
 *
 * - The manifest is hand-edited data. A typo in `source`, or a row written
 *   ahead of the upload that would fill in its key, is a mistake someone makes
 *   at the keyboard. To this resolver such a row carries no information, which
 *   is the same situation as an absent row — so it gets the same answer. One
 *   rule, not two, and §A.3's "a missing entry must fall back, not fail" covers
 *   it without amendment.
 * - Returning `null` instead would blank a card that has perfectly good
 *   upstream art, turning a data typo into a visibly missing image. Falling
 *   back degrades to today's behaviour instead, which is the weaker failure.
 *
 * "Well-formed" means `isCdnKey`, and this function **calls** it. That is the
 * point worth defending: a pattern that is defined, exported, documented and
 * never consulted is a control that does nothing, and `docs/handoff/w4.md`
 * lists three controls in this repo that already passed while doing nothing —
 * a CI token path that never executed, a D13 test whose fixtures had no ids,
 * and a "no-images" assertion that was the wrong invariant. Enforcing the guard
 * here also keeps this module in step with the CI D13 gate, which discriminates
 * on the same pattern: if only well-formed keys are reachable from the resolver,
 * the gate and the resolver agree by construction rather than by coincidence.
 *
 * What it must never do — and the tests assert this directly — is throw, or
 * return a relative or same-origin URL. Either would make our own server the
 * image host by accident.
 *
 * The switch is written so a fifth source is a new `case` and nothing else.
 */
export function resolveArtUrl(
  scryfallId: string | undefined,
  manifest: ArtManifest,
  options?: { readonly size?: ArtImageSize; readonly cdnBase?: string },
): string | null {
  if (typeof scryfallId !== 'string' || scryfallId.length === 0) return null;

  const size = options?.size ?? 'normal';
  const cdnBase = options?.cdnBase ?? CDN_BASE;

  const entry = manifest[scryfallId];
  if (entry == null) return scryfallArtUrl(scryfallId, size);

  // Read `source` as a plain string on purpose. The manifest is JSON on disk,
  // so its declared type is a claim about what we intend to write, not a proof
  // about what is there — and a `default` arm that TypeScript has narrowed to
  // `never` is an arm nobody maintains. This keeps the runtime fallback honest.
  const source: string = entry.source;
  switch (source) {
    case 'cdn': {
      // A CDN row is usable only if its key names an object the CDN could
      // actually be holding. Missing, empty and malformed all fail one guard
      // and take one fallback — `deadbeef.jpg` names no object any more than
      // `''` does, so there is no reason to treat them differently.
      const key = entry.key;
      if (!isCdnKey(key)) return scryfallArtUrl(scryfallId, size);
      return cdnUrlFor(key, cdnBase);
    }
    case 'scryfall':
      return scryfallArtUrl(scryfallId, size);
    default:
      return scryfallArtUrl(scryfallId, size);
  }
}

/*
 * The other half of the art path: which id a card IS.
 *
 * `resolveArtUrl` above takes an id; Forge's play wire carries a name and a set
 * code and no id at all. `./ids.ts` is the lookup between them, re-exported
 * here so `@hadoku/carddata/art` is the one import a renderer needs.
 */
export {
  ART_ID_TABLE_VERSION,
  artIdIndex,
  artIdIndexFromTable,
  artIdKey,
  mergeArtIdIndexes,
  scryfallIdFor,
  type ArtIdIndex,
  type ArtIdSource,
  type ArtIdTableFile,
} from './ids.ts';
