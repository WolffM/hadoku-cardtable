/*
 * Constructed legality: does this deck play cards from this format's pool, in
 * legal numbers?
 *
 * ## The pool is an argument, never an import
 *
 * A format here is `FormatPool` — a set of legal card names, optional banned
 * and restricted lists, and the numbers. Nothing in this file knows how such a
 * pool is built, where the set list came from, or which sets were in Standard
 * on a given date. That is a card-data problem and it lives in a card-data
 * package; this one takes the answer as a parameter. The two can then be
 * written, tested and changed independently, and a UI can validate against a
 * pool it fetched, a pool it invented for a custom format, or a pool built from
 * a cube list — all through one function.
 *
 * ## What Forge does, and where we deliberately differ
 *
 * Forge's equivalent is `DeckFormat.getDeckConformanceProblem`
 * (forge-core/src/main/java/forge/deck/DeckFormat.java:255). Every rule below
 * cites the line it came from. There is one structural difference and it is the
 * point of the file: Forge returns **one** `String` and stops at the first
 * failure, and we return every issue, each carrying the card and the numbers.
 * "Illegal" is not actionable; "you play 5 Lightning Bolt and 4 is the limit,
 * and Skullclamp is banned" is.
 *
 * The format numbers come from the `Constructed` row of Forge's enum, verbatim:
 *
 *   Constructed ( Range.of(60, Integer.MAX_VALUE), Range.of(0, 15), 4 )
 *     -- DeckFormat.java:45
 *
 * Read left to right: at least 60 maindeck cards with no ceiling, a sideboard
 * of 0 to 15, and at most 4 copies of a card. `CONSTRUCTED_LIMITS` is those
 * three and a `FormatPool` may override any of them, which is how a format with
 * a different shape (60-card singleton, say) is expressed without a new type.
 *
 * Forge is GPL-3.0-or-later and so is this repo; this file is a
 * reimplementation of its behaviour, and the citations are the point.
 */

import type { CardRequest, DeckEntry } from '@hadoku/carddata/dck';

import {
  isBasicLand,
  mainDeckSize,
  sideboardSize,
  type Deck,
  type DeckIssue,
} from './deck.ts';

/**
 * A format, reduced to what legality actually needs: which cards you may play
 * and how many of each.
 *
 * `legal`, `banned`, `restricted` and `anyNumberOf` are keyed by **card name**,
 * not by printing. That is Forge's own granularity — the copy limit groups the
 * pool by normalised name so "different editions of same card are really
 * counted as the same card" (DeckFormat.java:446-447) — and it is what a
 * historical format list is written in: Forge's own
 * `forge-gui/res/formats/Archived/Standard/1995-06-03.txt` carries
 * `Banned:Amulet of Quoz; Bronze Tablet; Rebirth; Tempest Efreet` and
 * `Restricted:Balance; Channel; Ivory Tower; Mind Twist`, names and nothing
 * else.
 *
 * Whoever builds the pool owns the spelling. This file compares
 * `CardRequest.name` to the set with `===` and normalises nothing, because a
 * normaliser that disagreed with the pool builder's would silently reject legal
 * cards — and the two-faced-card spelling problem (`Delver of Secrets` vs
 * `Delver of Secrets // Insectile Aberration`) is exactly where that would
 * happen.
 */
export interface FormatPool {
  /** Display name, used in every message: `Standard (ISD)`. */
  readonly name: string;
  /** Every card name legal in the format. */
  readonly legal: ReadonlySet<string>;
  /** Names that may not be played at all. Forge: the `Banned:` line. */
  readonly banned?: ReadonlySet<string>;
  /** Names limited to a single copy. Forge: the `Restricted:` line. */
  readonly restricted?: ReadonlySet<string>;
  /**
   * Names exempt from the copy limit besides basic lands — Relentless Rats,
   * Shadowborn Apostle, Rat Colony and friends. Forge reads this off the card's
   * own rules text (`canHaveAnyNumberOf`, DeckFormat.java:529, which tests
   * `isBasicLand()` or the keyword *"A deck can have any number of cards named
   * CARDNAME."*); we have no rules text here, so the pool builder supplies the
   * list.
   */
  readonly anyNumberOf?: ReadonlySet<string>;
  /**
   * Per-card copy limits that are neither 4 nor unlimited — Seven Dwarves at 7.
   * Forge reads the `DeckLimit` keyword (`canHaveSpecificNumberInDeck`,
   * DeckFormat.java:535).
   */
  readonly copyLimits?: ReadonlyMap<string, number>;
  /** Maindeck floor. Default {@link CONSTRUCTED_LIMITS}.minMainDeckSize. */
  readonly minMainDeckSize?: number;
  /** Maindeck ceiling, or `null` for none. Default none. */
  readonly maxMainDeckSize?: number | null;
  /** Sideboard ceiling, or `null` for no limit. Default 15. */
  readonly maxSideboardSize?: number | null;
  /** Copies of one card across maindeck and sideboard. Default 4. */
  readonly maxCopies?: number;
  /**
   * Whether basic lands are legal regardless of `legal`. Default **true**, and
   * this is ours rather than Forge's.
   *
   * Forge has no such exemption: it derives the pool from the format's set list
   * and a basic land is an ordinary card printed in one of those sets. Ours
   * exists because `deck.ts` already holds the same position for drafting —
   * *"basic lands are supplied by the table rather than drafted, so they are not
   * subject to pool accounting"* — and because the failure mode of the strict
   * reading is atrocious: one pool built from a set list that happens to print
   * no basics turns every deck in the format into twenty-four `not-in-pool`
   * issues. Set it `false` to get Forge's reading back.
   */
  readonly basicsAlwaysLegal?: boolean;
}

/** Forge's `Constructed` row (DeckFormat.java:45), as three numbers. */
export const CONSTRUCTED_LIMITS = {
  minMainDeckSize: 60,
  maxSideboardSize: 15,
  maxCopies: 4,
} as const;

/**
 * Every way this deck fails the format, in reporting order: deck size first,
 * then sideboard size, then one pass over the cards in the order the deck lists
 * them.
 *
 * Empty means legal. A card can raise more than one issue — an unknown card
 * played five times is both `not-in-pool` and `over-the-copy-limit` — because
 * fixing one does not fix the other and a UI that showed only the first would
 * make the deck look one edit away from legal when it is two.
 *
 * Copies are counted across maindeck **and** sideboard, as Forge does: *"Must
 * contain no more than 4 of the same card shared among the main deck and
 * sideboard"* (DeckFormat.java:440, implemented at :447 over
 * `getAllCardsInASinglePool`).
 */
export function formatIssues(deck: Deck, format: FormatPool): DeckIssue[] {
  const minMain = format.minMainDeckSize ?? CONSTRUCTED_LIMITS.minMainDeckSize;
  const maxMain = format.maxMainDeckSize ?? null;
  const maxSide =
    format.maxSideboardSize === undefined
      ? CONSTRUCTED_LIMITS.maxSideboardSize
      : format.maxSideboardSize;
  const maxCopies = format.maxCopies ?? CONSTRUCTED_LIMITS.maxCopies;
  const basicsLegal = format.basicsAlwaysLegal ?? true;

  const issues: DeckIssue[] = [];

  // DeckFormat.java:263-264 reads the range's ends; :401 and :405 compare the
  // maindeck count against them. `mainDeckSize` counts basics too, because
  // `toDeckFile` merges them into the main section — they are maindeck cards.
  const main = mainDeckSize(deck);
  if (main < minMain) {
    issues.push({
      kind: 'under-minimum-size',
      message: `maindeck has ${main} cards, ${format.name} needs at least ${minMain}`,
      card: null,
      cardName: null,
      count: main,
      limit: minMain,
    });
  } else if (maxMain !== null && main > maxMain) {
    issues.push({
      kind: 'over-maximum-size',
      message: `maindeck has ${main} cards, ${format.name} allows at most ${maxMain}`,
      card: null,
      cardName: null,
      count: main,
      limit: maxMain,
    });
  }

  // DeckFormat.java:476 — `sideboardSize > 0 && !sbRange.contains(...)`. An
  // empty sideboard is always fine, however tight the range; only a non-empty
  // one out of range is a problem.
  const side = sideboardSize(deck);
  if (maxSide !== null && side > maxSide) {
    issues.push({
      kind: 'sideboard-out-of-range',
      message: `sideboard has ${side} cards, ${format.name} allows at most ${maxSide}`,
      card: null,
      cardName: null,
      count: side,
      limit: maxSide,
    });
  }

  for (const card of cardsByName(deck)) {
    const name = card.name;
    const basic = isBasicLand(card.card);

    if (format.banned?.has(name) === true) {
      issues.push({
        kind: 'banned',
        message: `plays ${card.total}x ${name}, which ${format.name} bans`,
        card: card.card,
        cardName: name,
        count: card.total,
        limit: 0,
      });
    } else if (!format.legal.has(name) && !(basic && basicsLegal)) {
      // DeckFormat.java:410-423 collects every card the pool filter rejects and
      // lists them all, which is the one place Forge itself reports more than
      // one fault. We do it for every rule.
      issues.push({
        kind: 'not-in-pool',
        message: `plays ${card.total}x ${name}, which is not in ${format.name}`,
        card: card.card,
        cardName: name,
        count: card.total,
        limit: null,
      });
    }

    if (format.restricted?.has(name) === true) {
      if (card.total > 1) {
        issues.push({
          kind: 'restricted',
          message: `plays ${card.total}x ${name}, but ${format.name} restricts it to 1`,
          card: card.card,
          cardName: name,
          count: card.total,
          limit: 1,
        });
      }
      // A restricted card is capped at 1 and nothing below can cap it harder.
      continue;
    }

    if (basic || format.anyNumberOf?.has(name) === true) continue;

    const specific = format.copyLimits?.get(name);
    if (specific !== undefined) {
      // DeckFormat.java:464-467. Note the asymmetry, which is Forge's and not a
      // transcription slip: a `DeckLimit` card is checked against
      // `deck.getMain().countByName` — the **maindeck alone** — while the
      // generic limit two lines down uses the combined pool. Forge's own
      // comment at :442 spells out the consequence: *"Seven Dwarves can have 7
      // in the deck. More than 7 in deck + sb is ok in Limited"*.
      if (card.main > specific) {
        issues.push({
          kind: 'over-the-copy-limit',
          message: `maindeck plays ${card.main}x ${name}, but ${format.name} allows ${specific}`,
          card: card.card,
          cardName: name,
          count: card.main,
          limit: specific,
        });
      }
      continue;
    }

    if (card.total > maxCopies) {
      // DeckFormat.java:468-469.
      issues.push({
        kind: 'over-the-copy-limit',
        message: `plays ${card.total}x ${name}, but ${format.name} allows ${maxCopies}`,
        card: card.card,
        cardName: name,
        count: card.total,
        limit: maxCopies,
      });
    }
  }

  return issues;
}

/** True when the deck raises no issues against the format. */
export function isLegalIn(deck: Deck, format: FormatPool): boolean {
  return formatIssues(deck, format).length === 0;
}

/**
 * Build a format pool out of a card list — a `.dck` section, a cube, anything
 * that is already a list of card references.
 *
 * `sections` are merged, so a card pool split across `[main]` and `[sideboard]`
 * reads as one pool. Counts are ignored: a pool says which cards exist, not how
 * many.
 */
/**
 * Every name a pool entry answers to — the full name, and the front face.
 *
 * Scryfall names a double-faced card `Front // Back`. **Forge's `.dck` format,
 * and every decklist a human ever wrote, names the front face alone.** So a
 * pool frozen from Scryfall holds `Huntmaster of the Fells // Ravager of the
 * Fells` while the deck that plays it says `Huntmaster of the Fells`, and a
 * set-membership test on the full name alone calls it `not-in-pool`.
 *
 * That is not a hypothetical: it made **every** Innistrad-era deck illegal —
 * Delver of Secrets, Huntmaster, Garruk Relentless — and was found when the
 * first real Standard decks for that block were added (2026-09-18, PT Dark
 * Ascension). `packages/carddata`'s resolver has handled front faces since
 * Wave 2 (`nameKeysFor`, "951 references across the corpus"); the loss happens
 * when a pool is FROZEN into a fixture, which keeps `card.name` and nothing
 * else.
 *
 * Fixed here rather than in the fixture so the pool file stays a plain list of
 * canonical names and the card count keeps meaning what it says.
 */
export function poolNameKeys(name: string): string[] {
  const cut = name.indexOf(' // ');
  return cut === -1 ? [name] : [name, name.slice(0, cut)];
}

export function formatPoolFromEntries(
  name: string,
  entries: readonly DeckEntry[],
  rest: Omit<FormatPool, 'name' | 'legal'> = {},
): FormatPool {
  const legal = new Set<string>();
  for (const entry of entries) for (const k of poolNameKeys(entry.card.name)) legal.add(k);
  return { ...rest, name, legal };
}

interface NameGroup {
  readonly name: string;
  /** One representative printing, for a UI that wants to show the card. */
  readonly card: CardRequest;
  /** Copies in the maindeck, basics included. */
  readonly main: number;
  /** Copies across maindeck and sideboard. */
  readonly total: number;
}

/**
 * Group the deck's cards by name, in first-appearance order.
 *
 * By name and not by printing, because that is the unit every rule here works
 * in: Forge groups the pool with `getNormalizedName` before it counts copies
 * (DeckFormat.java:447), so four different printings of Lightning Bolt are four
 * Lightning Bolts, and a banned card is banned in every edition.
 */
function cardsByName(deck: Deck): NameGroup[] {
  const order: string[] = [];
  const main = new Map<string, number>();
  const total = new Map<string, number>();
  const representative = new Map<string, CardRequest>();

  const add = (entry: DeckEntry, inMain: boolean): void => {
    const name = entry.card.name;
    if (!representative.has(name)) {
      representative.set(name, entry.card);
      order.push(name);
    }
    if (inMain) main.set(name, (main.get(name) ?? 0) + entry.count);
    total.set(name, (total.get(name) ?? 0) + entry.count);
  };

  for (const entry of deck.main) add(entry, true);
  for (const entry of deck.basics) add(entry, true);
  for (const entry of deck.sideboard) add(entry, false);

  return order.map((name) => ({
    name,
    // Safe: `order` only ever gains a name at the same moment the maps do.
    card: representative.get(name) as CardRequest,
    main: main.get(name) ?? 0,
    total: total.get(name) ?? 0,
  }));
}
