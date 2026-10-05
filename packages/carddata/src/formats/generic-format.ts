/*
 * The engine behind `standardFormatAt`/`standardPoolAt`'s shape, generalised
 * so Modern and Legacy — formats that do not rotate sets on a schedule, but
 * still change by ban and by new-set addition, dated file by dated file in
 * Forge's own archive — can answer the same two questions without re-deriving
 * the binary search and the pool-building logic `standard.ts` already has.
 *
 * `standard.ts` is deliberately NOT rewritten to call into this: wave 48 §T
 * requires `standardPoolAt` stay unchanged in BEHAVIOUR, and refactoring its
 * implementation to share this engine carries that regression risk for zero
 * benefit to Standard (which already has its own correct, tested version of
 * every function here). So the small amount of logic below — `str`,
 * `frontFaceName`, `nameKeysFor`, the pool-building loop — is a deliberate,
 * narrow duplication of `standard.ts`'s private helpers, not an oversight.
 *
 * `modern.ts` and `legacy.ts` are each a few lines of wiring over their own
 * generated history table and this module; `format-family.ts` dispatches
 * across all three by `FormatFamily`.
 */

import { normaliseName, foldName } from '../resolve.ts';
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

/** Why a date could not be answered — same three reasons `standard.ts` has. */
export type FormatUnsupportedReason = 'malformed-date' | 'before-format-existed' | 'after-known-history';

export interface FormatUnsupported {
  readonly ok: false;
  readonly reason: FormatUnsupportedReason;
  /** The date as asked, unchanged. */
  readonly date: string;
  /** The range the table can answer for. */
  readonly supported: { readonly from: string; readonly to: string };
}

/** A snapshot, resolved for a date. Same shape as `standard.ts`'s `StandardFormat`. */
export interface FormatAnswer {
  readonly ok: true;
  readonly effective: string;
  readonly supersededBy: string | null;
  readonly name: string;
  readonly setList: readonly string[];
  readonly sets: ReadonlySet<string>;
  readonly banned: readonly string[];
  readonly restricted: readonly string[];
  readonly restrictedLegendary: boolean;
  readonly source: string;
  readonly provisional: boolean;
}

export interface FormatAtOptions {
  /** Answer dates after the last transcribed row by assuming it still holds. */
  readonly allowProvisional?: boolean;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar day in `YYYY-MM-DD`, or `null`. Rejects `2019-02-30`. */
function validIsoDate(date: string): string | null {
  if (!ISO_DATE.test(date)) return null;
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
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
 * The format snapshot in force on `date`, from a history table, or a refusal.
 *
 * Same binary search and the same effective-dated, inclusive row semantics as
 * `standardFormatAt` — see that function's own comment for the argument.
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
  let lo = 0;
  let hi = history.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (history[mid].effective <= iso) lo = mid;
    else hi = mid - 1;
  }
  return toFormat(history, lo, false);
}

/* ── pool building — a narrow duplicate of standard.ts's private helpers ── */

function str(card: GameplayCard, field: string): string | null {
  const value = (card as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : null;
}

function frontFaceName(card: GameplayCard): string | null {
  const faces = (card as Record<string, unknown>)['card_faces'];
  if (!Array.isArray(faces) || faces.length === 0) return null;
  const first: unknown = faces[0];
  if (typeof first !== 'object' || first === null) return null;
  const name = (first as Record<string, unknown>)['name'];
  return typeof name === 'string' && name.length > 0 ? name : null;
}

function nameKeysFor(card: GameplayCard, name: string): string[] {
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
  readonly name: string;
  readonly oracleId: string | null;
  readonly sets: readonly string[];
  readonly printing: GameplayCard;
}

export interface GenericFormatPool {
  readonly ok: true;
  readonly format: FormatAnswer;
  readonly cards: readonly GenericPoolCard[];
  readonly missingSets: readonly string[];
  readonly unmatchedBans: readonly string[];
  readonly counts: {
    readonly sets: number;
    readonly printings: number;
    readonly cards: number;
    readonly banned: number;
  };
}

export interface GenericPoolAtOptions extends FormatAtOptions {
  readonly includeBanned?: boolean;
}

/**
 * The card pool of a snapshot in force on `date`, or a refusal. Identical
 * logic to `standardPoolAt`, generalised over the history table — see that
 * function's own comment for the argument (de-duplication by `oracle_id`,
 * ban matching by front face and folded name, and so on).
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
