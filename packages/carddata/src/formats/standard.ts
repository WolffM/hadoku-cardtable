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
import { normaliseName, foldName, str } from '../resolve.ts';
import {
  formatAt,
  nameKeysFor,
  poolAt,
  type FormatAnswer,
  type FormatAtOptions,
  type FormatUnsupported,
  type GenericFormatPool,
  type GenericPoolAtOptions,
  type GenericPoolCard,
} from './generic-format.ts';
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

export type StandardUnsupported = Omit<FormatUnsupported, 'reason'> & { readonly reason: UnsupportedReason };

export type StandardFormat = FormatAnswer;

export type StandardFormatOptions = FormatAtOptions;

/** The generic engine's refusal, with Standard's own name for a date before the table. */
function asStandard<T extends { readonly ok: true }>(answer: T | FormatUnsupported): T | StandardUnsupported {
  if (answer.ok) return answer;
  const { reason, ...rest } = answer;
  return { ...rest, reason: reason === 'before-format-existed' ? 'before-standard-existed' : reason };
}

/** The Standard format in force on `date`, or an explicit refusal — `generic-format.ts`'s `formatAt`. */
export function standardFormatAt(
  date: string,
  options: StandardFormatOptions = {},
): StandardFormat | StandardUnsupported {
  return asStandard(formatAt(STANDARD_HISTORY, date, options));
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

export type PoolCard = GenericPoolCard;

export type StandardPool = GenericFormatPool;

export type StandardPoolOptions = GenericPoolAtOptions;

/** The card pool of the Standard format in force on `date`, or a refusal — `generic-format.ts`'s `poolAt`. */
export function standardPoolAt(
  date: string,
  index: PrintingIndex,
  options: StandardPoolOptions = {},
): StandardPool | StandardUnsupported {
  return asStandard(poolAt(STANDARD_HISTORY, date, index, options));
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
