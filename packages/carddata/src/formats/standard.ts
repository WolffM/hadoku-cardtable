/*
 * "Was this card Standard-legal in September 2019?"
 *
 * ## The trap this module exists to avoid
 *
 * The projected corpus carries `legalities.standard` (`scryfall/project.ts:33`
 * keeps it). It is TODAY'S Standard and it is the WRONG ANSWER for a historical
 * format, in three separate ways:
 *
 *   1. It is **oracle-level, not printing-level.** Every Scryfall printing of a
 *      card carries the same `legalities` block, so a Limited Edition Alpha
 *      Mountain reads `standard: legal`. Measured on the 2026-09-15 corpus:
 *      488 sets contain at least one card whose `legalities.standard` is
 *      `legal`, against the 19 sets Standard actually consists of.
 *   2. It is **a snapshot of one day.** A card banned in 2020 and unbanned
 *      since reads `legal` today and was not; a card printed last year reads
 *      `legal` today and did not exist in 2019.
 *   3. It **moves under you.** The field changes every time the corpus is
 *      re-synced, so a test written against it is a test of the sync date.
 *
 * So Standard is derived here from SET ROTATION instead, and rotation is not a
 * rule you can compute. The model changed four times:
 *
 *   - **block rotation, biennial core sets** (1995-2009) — two blocks plus the
 *     most recent core set, the core set rotating on its own two-year clock.
 *     Visible in the table as the lone-core-set drops: `2003-09-01` drops 7ED
 *     alone, `2005-08-20` drops 8ED alone, `2007-07-20` drops 9ED alone.
 *   - **block rotation, annual core sets** (2009-2015) — `2010-10-01` onward
 *     drops exactly four sets each autumn: a three-set block plus a core set.
 *   - **the 2016 two-block experiment** — rotation twice a year, abandoned
 *     mid-flight. It is the single most misremembered boundary in Magic and the
 *     reason this module transcribes rather than derives: the April 2016
 *     rotation dropped KTK, FRF and UGF and **left DTK and ORI in**, which did
 *     not rotate until Kaladesh that September. Then the reversion held BFZ and
 *     SOI blocks until autumn 2017, so `2016-09-30` is a rotation and
 *     `2017-01-20`/`2017-04-28` are not.
 *   - **the 2023 three-year extension** — there is **no rotation in 2023 at
 *     all**. `2022-09-09` drops ZNR/KHM/STX/AFR, and the next drop is
 *     `2024-08-02`, which is Bloomburrow and not the autumn set.
 *
 * Every boundary above is a row in `standard-history.generated.ts` naming the
 * Forge file it came from. Nothing here is recalled.
 *
 * ## Refusing is a supported answer
 *
 * A format that is silently wrong by one set is worse than one that will not
 * answer, so `standardFormatAt` returns its refusals as values — the same
 * contract `resolve.ts` uses, and for the same reason. A date before Standard
 * existed, a malformed date, and a date past the end of the transcribed history
 * are three different refusals and say so.
 *
 * The last row is the one place a guess could hide: Forge's data stops at a
 * date, and whether a rotation has happened since is unknowable from here. So a
 * date after the last row refuses by default, and answering it at all requires
 * `allowProvisional: true` — which marks the result `provisional` rather than
 * quietly widening the table.
 *
 * ## The corpus is an argument, never a path
 *
 * Nothing in this file reads a file. `packages/carddata/data/cards.jsonl` is
 * 183 MB, gitignored and absent in CI, and a test that needs it is a test that
 * does not run (`resolve.test.ts:16` says so first). `buildPrintingIndex` takes
 * an iterable of already-projected cards, so the unit tests hand it a dozen
 * real ones and the corpus-scale measurement lives in a committed report,
 * `standard-pool.json`.
 */

import type { GameplayCard } from '../scryfall/project.ts';
import { normaliseName, foldName } from '../resolve.ts';
import { STANDARD_HISTORY, SANCTIONED_MATCHES_NEWEST } from './standard-history.generated.ts';
import type { StandardSnapshot } from './standard-history.generated.ts';

export { STANDARD_HISTORY, SANCTIONED_MATCHES_NEWEST };
export type { StandardSnapshot };

/** The earliest date the transcribed history can answer for. */
export const FIRST_EFFECTIVE: string = STANDARD_HISTORY[0].effective;
/** The latest date the transcribed history can answer for without guessing. */
export const LAST_EFFECTIVE: string = STANDARD_HISTORY[STANDARD_HISTORY.length - 1].effective;

/** Why a date could not be answered. Each is a different bug on the caller's side. */
export type UnsupportedReason =
  /** Not a `YYYY-MM-DD` date, or not a real calendar day. */
  | 'malformed-date'
  /** Before the first snapshot: Standard did not exist, or predates the table. */
  | 'before-standard-existed'
  /** After the last snapshot: a rotation may have happened and we cannot know. */
  | 'after-known-history';

export interface StandardUnsupported {
  readonly ok: false;
  readonly reason: UnsupportedReason;
  /** The date as asked, unchanged. */
  readonly date: string;
  /** The range the table can answer for, so a caller can say so. */
  readonly supported: { readonly from: string; readonly to: string };
}

export interface StandardFormat {
  readonly ok: true;
  /** The date this format took effect, i.e. the snapshot that was in force. */
  readonly effective: string;
  /** The date it stopped being in force, or `null` for the newest snapshot. */
  readonly supersededBy: string | null;
  /** Forge's own name, e.g. `Standard (ELD)`. */
  readonly name: string;
  /** Legal sets as upper-cased Scryfall codes, in Forge's order. */
  readonly setList: readonly string[];
  /** The same, as a set, for membership tests. */
  readonly sets: ReadonlySet<string>;
  /** Banned card names exactly as Forge writes them. */
  readonly banned: readonly string[];
  /** Restricted card names (the 1995-2003 Type 2 rule). */
  readonly restricted: readonly string[];
  /** One of each legendary per deck — Forge's `RestrictedLegendary:true`. */
  readonly restrictedLegendary: boolean;
  /** The Forge file this answer came out of. Cite it, don't trust this. */
  readonly source: string;
  /**
   * True when the date is past the end of the transcribed history and the
   * caller opted in with `allowProvisional`. A rotation may have happened.
   */
  readonly provisional: boolean;
}

export interface StandardFormatOptions {
  /**
   * Answer dates after `LAST_EFFECTIVE` by assuming the newest snapshot is
   * still in force, marking the result `provisional: true`. Off by default:
   * the newest snapshot is current only as long as the vendored Forge data is.
   */
  readonly allowProvisional?: boolean;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar day in `YYYY-MM-DD`, or `null`. Rejects `2019-02-30`. */
function validIsoDate(date: string): string | null {
  if (!ISO_DATE.test(date)) return null;
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  // `new Date('2019-02-30')` rolls over to March 2nd rather than failing, so
  // round-tripping is what actually rejects an impossible day.
  return parsed.toISOString().slice(0, 10) === date ? date : null;
}

function unsupported(date: string, reason: UnsupportedReason): StandardUnsupported {
  return { ok: false, reason, date, supported: { from: FIRST_EFFECTIVE, to: LAST_EFFECTIVE } };
}

function toFormat(index: number, provisional: boolean): StandardFormat {
  const snapshot = STANDARD_HISTORY[index];
  const next = STANDARD_HISTORY[index + 1];
  return {
    ok: true,
    effective: snapshot.effective,
    supersededBy: next === undefined ? null : next.effective,
    name: snapshot.name,
    setList: snapshot.sets,
    sets: new Set(snapshot.sets),
    banned: snapshot.banned,
    restricted: snapshot.restricted,
    restrictedLegendary: snapshot.restrictedLegendary,
    source: snapshot.source,
    provisional,
  };
}

/**
 * The Standard format in force on `date`, or an explicit refusal.
 *
 * Snapshots are effective-dated and inclusive: the row effective `2019-08-30`
 * answers for every day from the 30th up to the day before the next row.
 */
export function standardFormatAt(
  date: string,
  options: StandardFormatOptions = {},
): StandardFormat | StandardUnsupported {
  const iso = validIsoDate(date);
  if (iso === null) return unsupported(date, 'malformed-date');
  if (iso < FIRST_EFFECTIVE) return unsupported(date, 'before-standard-existed');
  if (iso > LAST_EFFECTIVE) {
    if (options.allowProvisional !== true) return unsupported(date, 'after-known-history');
    return toFormat(STANDARD_HISTORY.length - 1, true);
  }
  // Binary search for the last snapshot whose effective date is <= iso. A
  // linear scan would be fine at 154 rows; this is written to be obviously
  // correct at the boundary, which is the part that has to be right.
  let lo = 0;
  let hi = STANDARD_HISTORY.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (STANDARD_HISTORY[mid].effective <= iso) lo = mid;
    else hi = mid - 1;
  }
  return toFormat(lo, false);
}

/** A set leaving or entering Standard, derived by diffing adjacent snapshots. */
export interface Rotation {
  /** The date the change took effect. */
  readonly date: string;
  /** Forge's name for the snapshot that introduced it. */
  readonly name: string;
  /** Scryfall codes that were legal the day before and are not now. */
  readonly dropped: readonly string[];
  /** Scryfall codes that are legal now and were not the day before. */
  readonly added: readonly string[];
  /** How many sets the format holds after the change. */
  readonly size: number;
  /** The Forge file the new snapshot came from. */
  readonly source: string;
}

/**
 * Every snapshot-to-snapshot set change, oldest first.
 *
 * Derived rather than transcribed on purpose: a rotation is a *diff*, and
 * computing it from the table means the table cannot disagree with it. A
 * rotation is any change that DROPPED a set; a snapshot that only adds one is
 * a new set releasing, and both kinds appear here with `dropped` telling them
 * apart.
 */
export function standardRotations(): readonly Rotation[] {
  const out: Rotation[] = [];
  for (let i = 1; i < STANDARD_HISTORY.length; i++) {
    const prev = new Set(STANDARD_HISTORY[i - 1].sets);
    const now = STANDARD_HISTORY[i].sets;
    const nowSet = new Set(now);
    const dropped = STANDARD_HISTORY[i - 1].sets.filter((s) => !nowSet.has(s));
    const added = now.filter((s) => !prev.has(s));
    if (dropped.length === 0 && added.length === 0) continue;
    out.push({
      date: STANDARD_HISTORY[i].effective,
      name: STANDARD_HISTORY[i].name,
      dropped,
      added,
      size: now.length,
      source: STANDARD_HISTORY[i].source,
    });
  }
  return out;
}

/**
 * Printings grouped by set code, plus the name keys needed to match a ban list.
 *
 * Built from an iterable so the caller owns the I/O. `buildCardIndex` in
 * `resolve.ts` has the same shape and the same reason.
 */
export interface PrintingIndex {
  /** Upper-cased Scryfall set code to its printings, insertion-ordered. */
  readonly bySet: ReadonlyMap<string, readonly GameplayCard[]>;
  /** How many printings were indexed. */
  readonly printings: number;
  /** How many were skipped, and why. */
  readonly skipped: Readonly<Record<string, number>>;
}

/**
 * Layouts that are not deck-legal cards. Same list and same reason as
 * `resolve.ts`: a `token` named "Goblin" shares its name with real cards, and a
 * pool that contains one has a blank card in it.
 */
const NON_GAMEPLAY_LAYOUTS = new Set(['token', 'double_faced_token', 'emblem', 'art_series']);

/** Only English printings. Forge's ban lists are English and so are its sets. */
const INDEX_LANG = 'en';

export interface PrintingIndexOptions {
  /**
   * Keep `digital: true` printings. Off by default, and that default was
   * changed after the corpus said so rather than reasoned about first: with
   * digital printings in, `standardPoolAt('2019-09-01', …)` returned
   * `A-Teferi, Time Raveler` and `A-Sorin, Imperious Bloodlord`. Those are
   * Arena's rebalanced cards, which Scryfall files under the paper set (`WAR`,
   * `M20`) because that is where they were rebalanced from. They are Alchemy
   * cards and were never legal in Standard. Six more sit inside today's
   * Standard sets the same way — `A-Heartfire Hero` in BLB, `A-Vivi Ornitier`
   * in FIN, `A-Cori-Steel Cutter` in TDM, `A-Leyline of Resonance` and
   * `A-Kona, Rescue Beastie` in DSK, `A-Geological Appraiser` in LCI — and with
   * them in, Scryfall's own `legalities.standard` disagrees with Forge's set
   * list on five sets. With them out the two sources agree exactly, on all 19.
   */
  readonly includeDigital?: boolean;
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
 * Every spelling a ban list might use for this card.
 *
 * Forge bans `Fable of the Mirror-Breaker`; Scryfall's `name` for that card is
 * `Fable of the Mirror-Breaker // Reflection of Kiki-Jiki`. This repo has been
 * here before — 942 cube references write the front face alone, and without
 * front-face matching only 12 of 95 cubes resolved. A ban list is the same
 * problem with much worse consequences, because a missed ban is a banned card
 * sitting legally in a pool.
 */
function nameKeysFor(card: GameplayCard, name: string): string[] {
  const keys = new Set<string>([normaliseName(name), foldName(name)]);
  const front = frontFaceName(card);
  if (front !== null) {
    keys.add(normaliseName(front));
    keys.add(foldName(front));
  }
  return [...keys];
}

/**
 * Group already-projected cards by set.
 *
 * Skips tokens, non-English printings and digital-only printings. Each skip is
 * counted, because a pool that is quietly short is the failure mode this whole
 * module is built against.
 */
export function buildPrintingIndex(
  cards: Iterable<GameplayCard>,
  options: PrintingIndexOptions = {},
): PrintingIndex {
  const bySet = new Map<string, GameplayCard[]>();
  const skipped: Record<string, number> = {
    'non-english': 0,
    'non-gameplay-layout': 0,
    digital: 0,
    'no-name': 0,
    'no-set': 0,
  };
  let printings = 0;

  for (const card of cards) {
    const lang = str(card, 'lang');
    if (lang !== null && lang !== INDEX_LANG) {
      skipped['non-english']++;
      continue;
    }
    if (card['digital'] === true && options.includeDigital !== true) {
      skipped['digital']++;
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
    const set = str(card, 'set');
    if (set === null || set.length === 0) {
      skipped['no-set']++;
      continue;
    }
    const key = set.toUpperCase();
    const bucket = bySet.get(key);
    if (bucket === undefined) bySet.set(key, [card]);
    else bucket.push(card);
    printings++;
  }

  return { bySet, printings, skipped };
}

/** One distinct card in a format's pool, with the printings that make it legal. */
export interface PoolCard {
  /** Scryfall's top-level `name`, i.e. `Front // Back` for a two-faced card. */
  readonly name: string;
  /** Scryfall's `oracle_id`, or `null` if the projection had none. */
  readonly oracleId: string | null;
  /** Upper-cased set codes in the format that print this card. */
  readonly sets: readonly string[];
  /** One representative printing — the first seen, in `setList` order. */
  readonly printing: GameplayCard;
}

export interface StandardPool {
  readonly ok: true;
  readonly format: StandardFormat;
  /** Distinct legal cards, name-ordered so two runs produce the same report. */
  readonly cards: readonly PoolCard[];
  /** Set codes the format names that the index had no printing for. */
  readonly missingSets: readonly string[];
  /** Banned names the index could not find a card for. Non-empty is a defect. */
  readonly unmatchedBans: readonly string[];
  readonly counts: {
    /** Sets in the format. */
    readonly sets: number;
    /** Printings across those sets, before de-duplication. */
    readonly printings: number;
    /** Distinct legal cards after de-duplication and after bans are removed. */
    readonly cards: number;
    /** Distinct cards removed by the ban list. */
    readonly banned: number;
  };
}

export interface StandardPoolOptions extends StandardFormatOptions {
  /**
   * Keep banned cards in the pool and report the count anyway. Off by default:
   * "the Standard pool" means the cards you may play.
   */
  readonly includeBanned?: boolean;
}

/**
 * The card pool of the Standard format in force on `date`, or a refusal.
 *
 * A card is in the pool when at least one of its printings is in a legal set —
 * legality is a property of the CARD, not the printing, which is exactly what
 * `legalities.standard` gets right and the set list gets wrong if you forget
 * it. De-duplication is by `oracle_id` where the projection kept one and by
 * normalised name otherwise, so a card reprinted three times inside one format
 * is one pool entry.
 */
export function standardPoolAt(
  date: string,
  index: PrintingIndex,
  options: StandardPoolOptions = {},
): StandardPool | StandardUnsupported {
  const format = standardFormatAt(date, options);
  if (!format.ok) return format;

  const missingSets: string[] = [];
  const byIdentity = new Map<string, { card: PoolCard; sets: string[] }>();
  // Every name key any printing in the format answers to, so the ban list can
  // be matched against front faces and folded spellings as well as `name`.
  const byNameKey = new Map<string, Set<string>>();
  let printings = 0;

  for (const setCode of format.setList) {
    const bucket = index.bySet.get(setCode);
    if (bucket === undefined || bucket.length === 0) {
      missingSets.push(setCode);
      continue;
    }
    for (const card of bucket) {
      printings++;
      const name = str(card, 'name');
      if (name === null) continue;
      const oracleId = str(card, 'oracle_id');
      const identity = oracleId ?? `name:${normaliseName(name)}`;
      const existing = byIdentity.get(identity);
      if (existing === undefined) {
        byIdentity.set(identity, {
          card: { name, oracleId, sets: [], printing: card },
          sets: [setCode],
        });
      } else if (!existing.sets.includes(setCode)) {
        existing.sets.push(setCode);
      }
      for (const key of nameKeysFor(card, name)) {
        const ids = byNameKey.get(key);
        if (ids === undefined) byNameKey.set(key, new Set([identity]));
        else ids.add(identity);
      }
    }
  }

  const bannedIdentities = new Set<string>();
  const unmatchedBans: string[] = [];
  for (const ban of format.banned) {
    const ids = byNameKey.get(normaliseName(ban)) ?? byNameKey.get(foldName(ban));
    if (ids === undefined) {
      unmatchedBans.push(ban);
      continue;
    }
    for (const id of ids) bannedIdentities.add(id);
  }

  const cards: PoolCard[] = [];
  for (const [identity, entry] of byIdentity) {
    if (!(options.includeBanned === true) && bannedIdentities.has(identity)) continue;
    cards.push({ ...entry.card, sets: entry.sets });
  }
  cards.sort((a, b) => (a.name === b.name ? 0 : a.name < b.name ? -1 : 1));

  return {
    ok: true,
    format,
    cards,
    missingSets,
    unmatchedBans,
    counts: {
      sets: format.setList.length,
      printings,
      cards: cards.length,
      banned: bannedIdentities.size,
    },
  };
}

/** What `isStandardLegalAt` concluded, and why. Never a bare boolean. */
export type LegalityAnswer =
  | { readonly ok: true; readonly legal: true; readonly sets: readonly string[]; readonly format: StandardFormat }
  | {
      readonly ok: true;
      readonly legal: false;
      /** `not-in-pool` — no printing in a legal set. `banned` — it is banned. */
      readonly why: 'not-in-pool' | 'banned';
      readonly format: StandardFormat;
    }
  | StandardUnsupported;

/**
 * Whether a named card was Standard-legal on a date.
 *
 * The name is matched the way a ban list is: exact, front-face, and both folded
 * for diacritics. A miss returns `legal: false` with `why`, never `null` and
 * never a throw — "we could not find this card" and "this card was not legal"
 * are the same answer to a deck validator and different answers in a bug
 * report, which is why `why` is carried.
 */
export function isStandardLegalAt(
  name: string,
  date: string,
  index: PrintingIndex,
  options: StandardPoolOptions = {},
): LegalityAnswer {
  const pool = standardPoolAt(date, index, { ...options, includeBanned: true });
  if (!pool.ok) return pool;

  const wanted = new Set([normaliseName(name), foldName(name)]);
  for (const card of pool.cards) {
    const keys = nameKeysFor(card.printing, card.name);
    if (!keys.some((k) => wanted.has(k))) continue;
    const banned = pool.format.banned.some((b) => keys.includes(normaliseName(b)) || keys.includes(foldName(b)));
    return banned
      ? { ok: true, legal: false, why: 'banned', format: pool.format }
      : { ok: true, legal: true, sets: card.sets, format: pool.format };
  }
  return { ok: true, legal: false, why: 'not-in-pool', format: pool.format };
}
