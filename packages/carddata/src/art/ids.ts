/*
 * `Name|SET → Scryfall id` — the lookup that stands between Forge's wire and
 * `resolveArtUrl`.
 *
 * ## Why this is a separate step from `./index.ts`
 *
 * `./index.ts` answers "where do this id's bytes live". It cannot answer
 * "which card is this", because Forge never sends an id. A card crosses the
 * play wire as a `Name` plus a `SetCode` in Forge's own set vocabulary — the
 * `ImageKey` spells it `c:Mountain|MRD|1` — so something has to turn that pair
 * into an id first. That is this module, and it is deliberately the only place
 * that knows the shape of that key.
 *
 * Splitting it out of `apps/ui/src/play/adapter.ts` (where it started) is what
 * lets it be tested against the real resolver without dragging the whole UI
 * package in, and is why the play board and the draft screen now agree on one
 * implementation instead of two.
 *
 * ## The fallback, which is the whole point
 *
 * Three answers, in order:
 *
 *   1. the exact printing — `Name|SET`;
 *   2. **any** printing of the same name — the bare `Name` key. Another
 *      printing's art is still that card's art, and a slightly wrong Lightning
 *      Bolt beats a blank rectangle every time;
 *   3. nothing, and the caller draws its text tile.
 *
 * ## Ids, never URLs
 *
 * Nothing in this file builds a URL or names a host. A card's art is a lookup
 * (D15); which host serves it is `resolveArtUrl`'s decision alone, so
 * re-sourcing the art stays a one-line data edit in `art-manifest.json`.
 *
 * ## No Node APIs
 *
 * This goes into the browser bundle. The committed table is imported as JSON by
 * the caller and handed in; nothing here reads a file.
 */

/**
 * `Name|SET` (set upper-cased) and bare `Name` → Scryfall id.
 *
 * A table of ids, never of URLs.
 */
export type ArtIdIndex = ReadonlyMap<string, string>;

/** Anything that knows a card's name, printing and id. */
export interface ArtIdSource {
  name: string;
  setCode: string;
  scryfallId?: string | undefined;
}

/**
 * The committed `art-ids.json`: a flat map whose keys are already index keys.
 *
 * `version` exists so a format change is detectable rather than silently
 * misread, exactly as `ArtManifestFile` carries one. Nothing switches on it
 * yet; when something does it will be because the shape really changed.
 */
export interface ArtIdTableFile {
  readonly version: number;
  /** Human note in the committed file. Carried so the type matches the file. */
  readonly note?: string;
  readonly ids: Readonly<Record<string, string>>;
}

/** The version `scripts/art/build-art-ids.ts` writes. Version 2: a value may carry {@link BACK_FACE}. */
export const ART_ID_TABLE_VERSION = 2;

/**
 * The marker that makes an art id name a card's BACK face: `<scryfall id>#back`.
 *
 * A transform or modal double-faced card is one Scryfall card with two images,
 * and Forge names whichever face is showing — Delver of Secrets turns into
 * Insectile Aberration, a name that is not a card of its own anywhere. So the
 * back face's art id is its card's id plus this marker: still a lookup, still
 * keyed in `art-manifest.json` like any other id (a `<id>#back` row repoints
 * the back alone), and resolved to Scryfall's back image when no row does.
 */
export const BACK_FACE = '#back';

/** The key an exact printing answers to. */
export function artIdKey(name: string, setCode: string): string {
  return `${name}|${setCode.toUpperCase()}`;
}

/**
 * Build an index from any list of known printings.
 *
 * The exact printing wins; failing that, the first printing of the same name.
 * A double-faced card is also indexed by its front face, since Forge names the
 * face it is showing.
 */
export function artIdIndex(cards: Iterable<ArtIdSource>): ArtIdIndex {
  const index = new Map<string, string>();
  for (const c of cards) {
    if (c.scryfallId === undefined || c.scryfallId === '') continue;
    const names = [c.name];
    const front = c.name.split(' // ')[0];
    if (front !== undefined && front !== c.name) names.push(front);
    for (const name of names) {
      const exact = artIdKey(name, c.setCode);
      if (!index.has(exact)) index.set(exact, c.scryfallId);
      if (!index.has(name)) index.set(name, c.scryfallId);
    }
  }
  return index;
}

/**
 * Read a committed table straight into an index.
 *
 * Its keys are already index keys — that is the format's one job, and it is why
 * loading it needs no logic that could disagree with `artIdIndex`. Values that
 * are not strings are dropped rather than trusted: this is committed JSON, so
 * its declared type is a claim about what we meant to write.
 */
export function artIdIndexFromTable(table: ArtIdTableFile): ArtIdIndex {
  const index = new Map<string, string>();
  for (const [key, id] of Object.entries(table.ids)) {
    if (typeof id === 'string' && id.length > 0) index.set(key, id);
  }
  return index;
}

/**
 * Merge indexes, **earlier wins**.
 *
 * Same precedence as `artIdIndex`'s own first-write-wins, so composing two
 * tables behaves like concatenating the lists they came from. Callers put the
 * more specific table first: the drafted pool before the general table, because
 * the pool is the printing that cube was actually built from.
 */
export function mergeArtIdIndexes(...indexes: readonly ArtIdIndex[]): ArtIdIndex {
  const merged = new Map<string, string>();
  for (const index of indexes) {
    for (const [key, id] of index) {
      if (!merged.has(key)) merged.set(key, id);
    }
  }
  return merged;
}

/** The exact printing, else any printing of the same name, else `undefined`. */
export function scryfallIdFor(index: ArtIdIndex, name: string, setCode: string): string | undefined {
  return index.get(artIdKey(name, setCode)) ?? index.get(name);
}

const backFaceIndexes = new WeakMap<ArtIdIndex, Map<string, string[]>>();

/**
 * The faces that draw `scryfallId`'s back image (`<id>#back`): a transformed or modal double-faced
 * card's other faces, by the table alone — for a card known only by its name (a library deck's
 * line), which carries nothing else to find them by. Empty for a one-image card, and for an id that
 * is itself a back.
 */
export function backFaceNames(index: ArtIdIndex, scryfallId: string | undefined): string[] {
  if (scryfallId === undefined || scryfallId.endsWith(BACK_FACE)) return [];
  let byFront = backFaceIndexes.get(index);
  if (byFront === undefined) {
    byFront = new Map();
    for (const [key, id] of index) {
      // A bare name only: `Name|SET` rows name the same faces again.
      if (!id.endsWith(BACK_FACE) || key.includes('|')) continue;
      const front = id.slice(0, -BACK_FACE.length);
      const names = byFront.get(front) ?? [];
      if (!names.includes(key)) names.push(key);
      byFront.set(front, names);
    }
    backFaceIndexes.set(index, byFront);
  }
  return byFront.get(scryfallId) ?? [];
}

/**
 * A token's art by the tokenscript its `ImageKey` names (`t:c_3_3_a_phyrexian_wurm_deathtouch|2XM|29|1`):
 * the exact printing under `t:<script>|<SET>`, else any printing of that token under `t:<script>`.
 * A token's NAME cannot pick its art — Forge calls Wurmcoil Engine's deathtouch and lifelink Wurms
 * and a green toxic one all "Phyrexian Wurm Token" — so this is tried before any name row.
 * Undefined for anything that is not a token's image key, or a script the table has no row for.
 */
export function tokenArtId(index: ArtIdIndex, imageKey: string | null | undefined): string | undefined {
  const m = /^t:([a-z0-9_]+)(?:\|([A-Za-z0-9]+))?/.exec(imageKey ?? '');
  if (m === null) return undefined;
  return m[2] === undefined ? index.get(`t:${m[1]}`) : scryfallIdFor(index, `t:${m[1]}`, m[2]);
}

/**
 * The card a `c:<name>|<set>|…` image key names. An effect Forge makes in the Command zone ("Teferi's
 * Effect") is a card of its own name drawn with its source's image key (`createEffect`), so this is
 * the art its own name never finds (the operator, 2026-10-22: "can we make this have teferi's art?").
 */
export function cardKeyArtId(index: ArtIdIndex, imageKey: string | null | undefined): string | undefined {
  const m = /^c:([^|]+)\|([A-Za-z0-9]+)/.exec(imageKey ?? '');
  return m === null ? undefined : scryfallIdFor(index, m[1]!, m[2]!);
}

const backsByIndex = new WeakMap<ArtIdIndex, ReadonlySet<string>>();

/**
 * These art ids, each followed by its card's back face when the index knows
 * one — what a match preloads, so a card that transforms is drawn with its
 * art on the first frame of the other face.
 */
export function artIdsWithBacks(index: ArtIdIndex, ids: Iterable<string>): string[] {
  let backs = backsByIndex.get(index);
  if (backs === undefined) {
    backs = new Set([...index.values()].filter((id) => id.endsWith(BACK_FACE)));
    backsByIndex.set(index, backs);
  }
  const out: string[] = [];
  for (const id of ids) {
    out.push(id);
    if (backs.has(`${id}${BACK_FACE}`)) out.push(`${id}${BACK_FACE}`);
  }
  return out;
}
