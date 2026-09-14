/*
 * Turning a cube list's `1 Stoneforge Mystic|PRM` into an actual card.
 *
 * The contract, and the reason this file is written the way it is: resolution
 * **returns** its failures. There is no throw and there is no `null` that a
 * caller can spread into a card object and put on a draft table. A cube that
 * is 97% resolvable is not draftable, and the only way anyone finds that out
 * before eight people sit down is if the 3% comes back as data.
 *
 * Three tiers, tried in order, each strictly more specific than the next:
 *
 *   1. `name` + `set` + `collector_number` — the cube pinned an exact printing
 *   2. `name` + `set`                      — the cube named a set
 *   3. `name`                              — earliest non-digital printing
 *
 * Tier 3 is reached both by the bare-name references in the vendored cubes and
 * by any reference whose set code did not resolve. Those two cases look
 * identical in the returned card and completely different in a bug report, so
 * a resolution carries `requestedSet` and `scryfallSet` alongside its tier, and
 * the report counts them separately.
 *
 * Within every tier a name is matched through four variants, in a fixed
 * priority (see `NAME_VARIANTS`). Which one hit is reported as `matchedBy`,
 * because "resolved" and "resolved via an accent-folded front-face name" are
 * not the same claim and the weaker one should have to say so.
 *
 * No image code path (D13). Nothing here reads, stores or emits an image field;
 * the cache it reads was already projected onto a gameplay allowlist by
 * `scryfall/project.ts`, so there is nothing image-shaped to reach.
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import type { CardRequest } from './dck.ts';
import type { GameplayCard } from './scryfall/project.ts';
import { toScryfallSetCode, isKnownForgeSetCode } from './set-codes.ts';

/** Which of the three lookups produced a card. */
export type ResolutionTier = 'name+set+collector' | 'name+set' | 'name';

/**
 * Which spelling of the card's name the lookup matched, best first.
 *
 * - `name` — Scryfall's top-level `name`, matched exactly (case aside).
 * - `front-face` — the cube named only the front face of a two-faced card.
 *   Scryfall's top-level `name` for those is `"Front // Back"`, while Forge
 *   stores and writes just `"Front"`, so `Delver of Secrets|ISD` has to find
 *   `Delver of Secrets // Insectile Aberration`. This is the single biggest
 *   source of matches after exact names: 951 references across the corpus,
 *   spanning `transform`, `modal_dfc`, `adventure` and `flip` layouts.
 * - `folded-name` / `folded-front-face` — the same two, after stripping
 *   diacritics. This exists because `Jim Davis's Cube.dck` writes
 *   `Lim-Dul's Vault` where the card is `Lim-Dûl's Vault`. The fold is safe
 *   here and that was measured, not assumed: across all 36,308 distinct
 *   English card and front-face names in the cache, **no two fold to the same
 *   key**, so the fold cannot introduce an ambiguity. It is still ranked last
 *   and still reported, because the guarantee is about today's card pool.
 */
export type NameMatch = 'name' | 'front-face' | 'folded-name' | 'folded-front-face';

/** Name variants in priority order. A lower index always wins. */
export const NAME_VARIANTS: readonly NameMatch[] = [
  'name',
  'front-face',
  'folded-name',
  'folded-front-face',
];

/** Why a reference produced no card. */
export type UnresolvedReason =
  /** The name is not in the card cache under any variant of any printing. */
  | 'unknown-name'
  /** The name is known, but every printing of it is digital-only. */
  | 'digital-only'
  /** The line carried no name at all — a malformed cube list. */
  | 'empty-name';

export interface ResolvedCard {
  readonly ok: true;
  readonly tier: ResolutionTier;
  readonly matchedBy: NameMatch;
  readonly card: GameplayCard;
  /** The set code as the cube wrote it (Forge's vocabulary), or `null`. */
  readonly requestedSet: string | null;
  /** What `requestedSet` translated to, or `null` if Forge doesn't know it. */
  readonly scryfallSet: string | null;
  /**
   * True when a set WAS requested and the card still came back at tier
   * `'name'`. The card is real, the printing is not the one asked for. This is
   * the flag that separates "the cube is fine" from "the cube resolves but to
   * the wrong printings".
   */
  readonly setFellBack: boolean;
}

export interface UnresolvedCard {
  readonly ok: false;
  readonly reason: UnresolvedReason;
  readonly name: string;
  readonly requestedSet: string | null;
  readonly scryfallSet: string | null;
  readonly collectorNumber: string | null;
}

export type Resolution = ResolvedCard | UnresolvedCard;

/** A printing plus how good the name match that found it was. 0 is best. */
interface RankedPrinting {
  readonly card: GameplayCard;
  readonly rank: number;
}

/**
 * A loaded card cache, indexed for the three lookups.
 *
 * Built once and reused: the vendored cubes carry ~49,000 card lines between
 * them, and re-scanning 117,941 printings per line is not a thing anyone
 * should do by accident.
 */
export interface CardIndex {
  /** Printings by name key, best name-variant first then earliest release. */
  readonly byName: ReadonlyMap<string, readonly RankedPrinting[]>;
  /** Printings by `SET|nameKey`, same ordering. */
  readonly bySetAndName: ReadonlyMap<string, readonly RankedPrinting[]>;
  /** One printing by `SET|nameKey|collector_number`. */
  readonly bySetNameCollector: ReadonlyMap<string, RankedPrinting>;
  /** Every Scryfall set code present in the cache, upper-cased. */
  readonly knownSets: ReadonlySet<string>;
  /** How many printings were indexed. */
  readonly printings: number;
  /** How many were skipped, and why — non-gameplay layouts and non-English. */
  readonly skipped: Readonly<Record<string, number>>;
}

/**
 * Layouts that are not draftable cards. A `token` named "Goblin" and an
 * `art_series` card share their `name` with real cards, and indexing them
 * would let a name lookup return an object with no mana cost or type line —
 * a blank card by another route. `art_series` is the one that actually bites:
 * 36 of the corpus's front-face names have an art-series printing.
 */
const NON_GAMEPLAY_LAYOUTS = new Set(['token', 'double_faced_token', 'emblem', 'art_series']);

/**
 * Only English printings are indexed.
 *
 * Scryfall gives every printing the English `name` regardless of language (the
 * localised string lives in `printed_name`, which this repo does not keep), so
 * including other languages would add thousands of entries that are
 * indistinguishable on lookup but differ in `collector_number` — making
 * "earliest printing" depend on which translation Scryfall happened to list
 * first. Forge's cube lists are English throughout.
 */
const INDEX_LANG = 'en';

/** Lowercase for lookup. Forge and Scryfall agree on ` // ` for split cards. */
export function normaliseName(name: string): string {
  return name.trim().toLowerCase();
}

/** Lowercase with diacritics stripped — `Lim-Dûl's` and `Lim-Dul's` agree. */
export function foldName(name: string): string {
  return name
    .trim()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

function str(card: GameplayCard, field: string): string | null {
  const value = card[field];
  return typeof value === 'string' ? value : null;
}

/** The front face's name, for a card that has faces. */
function frontFaceName(card: GameplayCard): string | null {
  const faces = card['card_faces'];
  if (!Array.isArray(faces) || faces.length === 0) return null;
  const first: unknown = faces[0];
  if (typeof first !== 'object' || first === null) return null;
  const name = (first as Record<string, unknown>)['name'];
  return typeof name === 'string' && name.length > 0 ? name : null;
}

/**
 * Every key this card answers to, with the rank of the variant that produced
 * it. Ranks match `NAME_VARIANTS`. Duplicates are dropped keeping the best
 * rank, so an unaccented single-faced card contributes exactly one key.
 */
function nameKeysFor(card: GameplayCard, name: string): Map<string, number> {
  const keys = new Map<string, number>();
  const add = (key: string, rank: number): void => {
    const existing = keys.get(key);
    if (existing === undefined || rank < existing) keys.set(key, rank);
  };

  add(normaliseName(name), 0);
  const front = frontFaceName(card);
  // A single-faced card's `card_faces[0].name` equals its `name`; `add` folds
  // that back to rank 0 rather than recording a spurious front-face match.
  if (front !== null) add(normaliseName(front), 1);
  add(foldName(name), 2);
  if (front !== null) add(foldName(front), 3);
  return keys;
}

/**
 * Sort key for "earliest printing". `released_at` is an ISO date so it sorts
 * lexically; set code and collector number break ties so the order is total
 * and the same cache always answers the same way. A non-deterministic tier-3
 * pick would make the resolution report unreproducible, which would make it
 * useless as a regression check.
 */
function printingOrder(a: GameplayCard, b: GameplayCard): number {
  const ra = str(a, 'released_at') ?? '9999-12-31';
  const rb = str(b, 'released_at') ?? '9999-12-31';
  if (ra !== rb) return ra < rb ? -1 : 1;
  const sa = str(a, 'set') ?? '';
  const sb = str(b, 'set') ?? '';
  if (sa !== sb) return sa < sb ? -1 : 1;
  const ca = str(a, 'collector_number') ?? '';
  const cb = str(b, 'collector_number') ?? '';
  if (ca === cb) return 0;
  // Collector numbers are mostly numeric but carry suffixes ('123a', '★12').
  const na = Number.parseInt(ca, 10);
  const nb = Number.parseInt(cb, 10);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return ca < cb ? -1 : 1;
}

/** Best name-variant first, then earliest printing. Total and deterministic. */
function rankedOrder(a: RankedPrinting, b: RankedPrinting): number {
  if (a.rank !== b.rank) return a.rank - b.rank;
  return printingOrder(a.card, b.card);
}

/** Build an index from already-parsed cards. */
export function buildCardIndex(cards: Iterable<GameplayCard>): CardIndex {
  const byName = new Map<string, RankedPrinting[]>();
  const bySetAndName = new Map<string, RankedPrinting[]>();
  const bySetNameCollector = new Map<string, RankedPrinting>();
  const knownSets = new Set<string>();
  const skipped: Record<string, number> = {
    'non-english': 0,
    'non-gameplay-layout': 0,
    'no-name': 0,
  };
  let printings = 0;

  for (const card of cards) {
    const lang = str(card, 'lang');
    if (lang !== null && lang !== INDEX_LANG) {
      skipped['non-english']++;
      continue;
    }
    const layout = str(card, 'layout');
    if (layout !== null && NON_GAMEPLAY_LAYOUTS.has(layout)) {
      skipped['non-gameplay-layout']++;
      continue;
    }
    const name = str(card, 'name');
    if (name === null || name.length === 0) {
      skipped['no-name']++;
      continue;
    }

    printings++;
    const keys = nameKeysFor(card, name);
    const set = str(card, 'set');
    const SET = set === null ? null : set.toUpperCase();
    if (SET !== null) knownSets.add(SET);
    const collector = str(card, 'collector_number');

    for (const [key, rank] of keys) {
      const entry: RankedPrinting = { card, rank };

      const nameBucket = byName.get(key);
      if (nameBucket === undefined) byName.set(key, [entry]);
      else nameBucket.push(entry);

      if (SET === null) continue;
      const setKey = `${SET}|${key}`;
      const setBucket = bySetAndName.get(setKey);
      if (setBucket === undefined) bySetAndName.set(setKey, [entry]);
      else setBucket.push(entry);

      if (collector !== null) {
        const cnKey = `${setKey}|${collector.toLowerCase()}`;
        const existing = bySetNameCollector.get(cnKey);
        if (existing === undefined || rank < existing.rank) bySetNameCollector.set(cnKey, entry);
      }
    }
  }

  for (const bucket of byName.values()) bucket.sort(rankedOrder);
  for (const bucket of bySetAndName.values()) bucket.sort(rankedOrder);

  return { byName, bySetAndName, bySetNameCollector, knownSets, printings, skipped };
}

/**
 * Stream `cards.jsonl` out of a sync directory and index it.
 *
 * Streamed rather than read whole: the `default_cards` cache is ~180 MB of
 * JSON, and `readFile` + a parse per line over one giant string is the
 * difference between a peak of one card object and a peak of the entire file
 * plus its parsed form.
 */
export async function loadCardIndex(dataDir: string): Promise<CardIndex> {
  const path = join(dataDir, 'cards.jsonl');
  const cards: GameplayCard[] = [];
  const lines = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (line.length === 0) continue;
    cards.push(JSON.parse(line) as GameplayCard);
  }
  return buildCardIndex(cards);
}

function isDigital(card: GameplayCard): boolean {
  return card['digital'] === true;
}

/** The four keys a request is looked up under, best first. */
function requestKeys(name: string): readonly string[] {
  const keys: string[] = [];
  for (const key of [normaliseName(name), foldName(name)]) {
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

/**
 * Resolve one card reference against a card index.
 *
 * Tiers 1 and 2 honour whatever set the cube asked for, digital sets included:
 * the cubes reference `VMA` (Vintage Masters, MTGO-only) 1,687 times, and
 * refusing digital printings there would fail the single most-referenced set
 * in the corpus. Tier 3 is the one that prefers paper, because there the
 * choice of printing is ours rather than the cube's.
 */
export function resolveCard(request: CardRequest, index: CardIndex): Resolution {
  const name = request.name.trim();
  if (name.length === 0) {
    return {
      ok: false,
      reason: 'empty-name',
      name: request.name,
      requestedSet: request.set,
      scryfallSet: null,
      collectorNumber: request.collectorNumber,
    };
  }

  const keys = requestKeys(name);
  const requestedSet = request.set;
  const scryfallSet = toScryfallSetCode(requestedSet);

  if (scryfallSet !== null) {
    // Tier 1: the cube pinned an exact printing.
    if (request.collectorNumber !== null) {
      const cn = request.collectorNumber.toLowerCase();
      let best: RankedPrinting | null = null;
      for (const key of keys) {
        const hit = index.bySetNameCollector.get(`${scryfallSet}|${key}|${cn}`);
        if (hit !== undefined && (best === null || hit.rank < best.rank)) best = hit;
      }
      if (best !== null) {
        return {
          ok: true,
          tier: 'name+set+collector',
          matchedBy: NAME_VARIANTS[best.rank],
          card: best.card,
          requestedSet,
          scryfallSet,
          setFellBack: false,
        };
      }
    }

    // Tier 2: the cube named a set.
    let best: RankedPrinting | null = null;
    for (const key of keys) {
      const bucket = index.bySetAndName.get(`${scryfallSet}|${key}`);
      if (bucket !== undefined && bucket.length > 0) {
        const head = bucket[0];
        if (best === null || rankedOrder(head, best) < 0) best = head;
      }
    }
    if (best !== null) {
      return {
        ok: true,
        tier: 'name+set',
        matchedBy: NAME_VARIANTS[best.rank],
        card: best.card,
        requestedSet,
        scryfallSet,
        setFellBack: false,
      };
    }
  }

  // Tier 3: the name alone, earliest non-digital printing.
  const candidates: RankedPrinting[] = [];
  for (const key of keys) {
    const bucket = index.byName.get(key);
    if (bucket !== undefined) candidates.push(...bucket);
  }
  if (candidates.length === 0) {
    return {
      ok: false,
      reason: 'unknown-name',
      name,
      requestedSet,
      scryfallSet,
      collectorNumber: request.collectorNumber,
    };
  }

  candidates.sort(rankedOrder);
  const paper = candidates.find((c) => !isDigital(c.card));
  if (paper === undefined) {
    return {
      ok: false,
      reason: 'digital-only',
      name,
      requestedSet,
      scryfallSet,
      collectorNumber: request.collectorNumber,
    };
  }

  return {
    ok: true,
    tier: 'name',
    matchedBy: NAME_VARIANTS[paper.rank],
    card: paper.card,
    requestedSet,
    scryfallSet,
    setFellBack: requestedSet !== null,
  };
}

/** Whether a Forge set code is one Forge's own edition data recognises. */
export { isKnownForgeSetCode };
