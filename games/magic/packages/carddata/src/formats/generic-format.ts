/*
 * The format engine: a dated history table of Forge's format files, answered
 * for a date (`formatAt`) and turned into a card pool (`poolAt`).
 *
 * Standard, Modern and Legacy are each a generated history table plus a few
 * lines of wiring over this module. Standard rotates sets and the other two do
 * not, but all three change dated file by dated file in Forge's own archive,
 * so the binary search, the refusals and the pool-building loop are the same
 * code. `standard.ts` keeps Standard's own refusal name, its rotation diff and
 * the printing index; `format-family.ts` dispatches across all three by
 * `FormatFamily`.
 */

import { foldName, frontFaceName, normaliseName, str } from '../resolve.ts';
import type { GameplayCard } from '../scryfall/project.ts';
import type { PrintingIndex } from './standard.ts';

/** One dated snapshot of a non-rotating format: a ban-list / set-list change. */
export interface FormatSnapshot {
  /** ISO date this snapshot took effect, inclusive. */
  readonly effective: string;
  /** Forge's own name for the snapshot, e.g. `Modern (M13)`. */
  readonly name: string;
  /** Legal sets as Scryfall codes, upper-cased, in Forge's order. */
  readonly sets: readonly string[];
  /** The same sets as Forge writes them. */
  readonly forgeSets: readonly string[];
  /** Banned card names, exactly as Forge writes them. */
  readonly banned: readonly string[];
  /** Restricted card names. */
  readonly restricted: readonly string[];
  /** Forge's `RestrictedLegendary:true`. */
  readonly restrictedLegendary: boolean;
  /** The Forge file this row was read out of, relative to `res/formats/`. */
  readonly source: string;
}

/** Why a date could not be answered. Each is a different bug on the caller's side. */
export type FormatUnsupportedReason = 'malformed-date' | 'before-format-existed' | 'after-known-history';

export interface FormatUnsupported {
  readonly ok: false;
  readonly reason: FormatUnsupportedReason;
  /** The date as asked, unchanged. */
  readonly date: string;
  /** The range the table can answer for, so a caller can say so. */
  readonly supported: { readonly from: string; readonly to: string };
}

/** A snapshot, resolved for a date. */
export interface FormatAnswer {
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

export interface FormatAtOptions {
  /**
   * Answer dates after the last transcribed row by assuming the newest
   * snapshot is still in force, marking the result `provisional: true`. Off by
   * default: the newest snapshot is current only as long as the vendored Forge
   * data is.
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

function toFormat(history: readonly FormatSnapshot[], index: number, provisional: boolean): FormatAnswer {
  const snapshot = history[index];
  const next = history[index + 1];
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
 * The format snapshot in force on `date`, from a history table, or an explicit
 * refusal.
 *
 * Snapshots are effective-dated and inclusive: the row effective `2019-08-30`
 * answers for every day from the 30th up to the day before the next row.
 */
export function formatAt(
  history: readonly FormatSnapshot[],
  date: string,
  options: FormatAtOptions = {},
): FormatAnswer | FormatUnsupported {
  const first = history[0].effective;
  const last = history[history.length - 1].effective;
  const unsupported = (reason: FormatUnsupportedReason): FormatUnsupported => ({
    ok: false,
    reason,
    date,
    supported: { from: first, to: last },
  });

  const iso = validIsoDate(date);
  if (iso === null) return unsupported('malformed-date');
  if (iso < first) return unsupported('before-format-existed');
  if (iso > last) {
    if (options.allowProvisional !== true) return unsupported('after-known-history');
    return toFormat(history, history.length - 1, true);
  }
  // Binary search for the last snapshot whose effective date is <= iso,
  // written to be obviously correct at the boundary, which is the part that
  // has to be right.
  let lo = 0;
  let hi = history.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (history[mid].effective <= iso) lo = mid;
    else hi = mid - 1;
  }
  return toFormat(history, lo, false);
}

/* ── pool building ─────────────────────────────────────────────────────── */

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
export function nameKeysFor(card: GameplayCard, name: string): string[] {
  const keys = new Set<string>([normaliseName(name), foldName(name)]);
  const front = frontFaceName(card);
  if (front !== null) {
    keys.add(normaliseName(front));
    keys.add(foldName(front));
  }
  return [...keys];
}

/** One distinct card in a format's pool, with the printings that make it legal. */
export interface GenericPoolCard {
  /** Scryfall's top-level `name`, i.e. `Front // Back` for a two-faced card. */
  readonly name: string;
  /** Scryfall's `oracle_id`, or `null` if the projection had none. */
  readonly oracleId: string | null;
  /** Upper-cased set codes in the format that print this card. */
  readonly sets: readonly string[];
  /** One representative printing — the first seen, in `setList` order. */
  readonly printing: GameplayCard;
}

export interface GenericFormatPool {
  readonly ok: true;
  readonly format: FormatAnswer;
  /** Distinct legal cards, name-ordered so two runs produce the same report. */
  readonly cards: readonly GenericPoolCard[];
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

export interface GenericPoolAtOptions extends FormatAtOptions {
  /**
   * Keep banned cards in the pool and report the count anyway. Off by default:
   * a format's pool means the cards you may play.
   */
  readonly includeBanned?: boolean;
}

/**
 * The card pool of the snapshot in force on `date`, or a refusal.
 *
 * A card is in the pool when at least one of its printings is in a legal set —
 * legality is a property of the CARD, not the printing, which is exactly what
 * Scryfall's `legalities` gets right and the set list gets wrong if you forget
 * it. De-duplication is by `oracle_id` where the projection kept one and by
 * normalised name otherwise, so a card reprinted three times inside one format
 * is one pool entry.
 */
export function poolAt(
  history: readonly FormatSnapshot[],
  date: string,
  index: PrintingIndex,
  options: GenericPoolAtOptions = {},
): GenericFormatPool | FormatUnsupported {
  const format = formatAt(history, date, options);
  if (!format.ok) return format;

  const missingSets: string[] = [];
  const byIdentity = new Map<string, { card: GenericPoolCard; sets: string[] }>();
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

  const cards: GenericPoolCard[] = [];
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
