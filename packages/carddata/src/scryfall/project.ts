/*
 * Projection of a Scryfall card object down to the fields this project is
 * allowed to keep.
 *
 * This is an ALLOWLIST, and that is the whole design. A denylist ("strip the
 * image fields") would need this file to name them, would silently start
 * storing anything Scryfall adds later, and would leave us one typo away from
 * caching art. An allowlist cannot: a field that is not named below never
 * reaches disk, today or after any future Scryfall schema change.
 *
 * Consequences, all intentional:
 *   - No image or art field of any kind is read, stored, or re-emitted.
 *     Card art is fetched by the browser, direct from upstream (D13).
 *   - No price field. "No money, ever" is the brightest line in this repo, and
 *     Scryfall themselves call bulk prices "dangerously stale after 24 hours".
 *   - No purchase or marketplace links, for the same reason.
 *   - No Scryfall page/API back-links: we are not a directory of Scryfall.
 *
 * `artist` IS kept. It is attribution text, not art, and Scryfall's usage rules
 * require that a viewer be able to identify the artist wherever art is shown.
 * Keeping the name locally is what lets the UI satisfy that without us ever
 * holding an image.
 */

/** Fields kept from a top-level Scryfall card object. */
const CARD_FIELDS = [
  // identity
  'id',
  'oracle_id',
  'name',
  'lang',
  'layout',
  'released_at',
  // gameplay
  'mana_cost',
  'cmc',
  'type_line',
  'oracle_text',
  'power',
  'toughness',
  'loyalty',
  'defense',
  'colors',
  'color_identity',
  'color_indicator',
  'keywords',
  'produced_mana',
  'legalities',
  'reserved',
  'game_changer',
  'hand_modifier',
  'life_modifier',
  'all_parts',
  'card_faces',
  // printing — what a cube list's `Name|SET|n` reference resolves against
  'set',
  'set_name',
  'set_type',
  'collector_number',
  'rarity',
  'booster',
  'digital',
  'promo',
  'reprint',
  'variation',
  'border_color',
  'frame',
  'full_art',
  'textless',
  'watermark',
  'finishes',
  'games',
  // attribution
  'artist',
] as const;

/**
 * Fields kept from each entry of `card_faces`. Faces carry their own copy of
 * most gameplay fields on split, transform and modal cards — and their own
 * image references, which this list simply never mentions.
 */
const FACE_FIELDS = [
  'name',
  'mana_cost',
  'cmc',
  'type_line',
  'oracle_text',
  'power',
  'toughness',
  'loyalty',
  'defense',
  'colors',
  'color_indicator',
  'layout',
  'artist',
  'watermark',
] as const;

/** Fields kept from each entry of `all_parts` (tokens, melds, combo pieces). */
const PART_FIELDS = ['id', 'component', 'name', 'type_line'] as const;

/** A Scryfall card object as received: unknown shape, treated as data only. */
export type RawCard = Readonly<Record<string, unknown>>;

/** A card projected onto the allowlist above. */
export type GameplayCard = Readonly<Record<string, unknown>>;

/** The exact set of top-level keys a projected card may contain. */
export const ALLOWED_CARD_FIELDS: ReadonlySet<string> = new Set(CARD_FIELDS);
/** The exact set of keys a projected card face may contain. */
export const ALLOWED_FACE_FIELDS: ReadonlySet<string> = new Set(FACE_FIELDS);
/** The exact set of keys a projected related-part entry may contain. */
export const ALLOWED_PART_FIELDS: ReadonlySet<string> = new Set(PART_FIELDS);

function pick(source: RawCard, fields: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const value = source[field];
    // `null` is meaningful in Scryfall's schema (an absent power differs from a
    // power of "0"), so only genuinely missing keys are skipped.
    if (field in source && value !== undefined) out[field] = value;
  }
  return out;
}

function pickEach(value: unknown, fields: readonly string[]): unknown {
  if (!Array.isArray(value)) return undefined;
  return value.map((item) =>
    typeof item === 'object' && item !== null ? pick(item as RawCard, fields) : {},
  );
}

/**
 * Project one raw Scryfall card onto the gameplay allowlist, recursing into
 * `card_faces` and `all_parts` so nested objects are filtered too.
 */
export function projectCard(raw: RawCard): GameplayCard {
  const out = pick(raw, CARD_FIELDS);

  if ('card_faces' in raw) {
    const faces = pickEach(raw['card_faces'], FACE_FIELDS);
    if (faces === undefined) delete out['card_faces'];
    else out['card_faces'] = faces;
  }
  if ('all_parts' in raw) {
    const parts = pickEach(raw['all_parts'], PART_FIELDS);
    if (parts === undefined) delete out['all_parts'];
    else out['all_parts'] = parts;
  }

  return out;
}
