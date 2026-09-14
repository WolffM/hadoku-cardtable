/*
 * The pool → deck model.
 *
 * A draft ends with a pile of cards and a decision: which 40-odd of them are
 * you actually playing. That is all this file models — a `Deck` is a partition
 * of the drafted pool into a maindeck and a sideboard, plus basic lands, which
 * come from outside the pool and are unlimited.
 *
 * There is deliberately NO format legality engine here. Forge has one
 * (`DeckFormat`, forge-core/src/main/java/forge/deck/DeckFormat.java) with
 * colour identity, singleton rules, banned lists and a max-four-copies check,
 * and every one of those is the wrong question for a cube deck. Forge's own
 * answer for limited play is one line:
 *
 *   Limited ( Range.of(40, Integer.MAX_VALUE), null, Integer.MAX_VALUE )
 *     -- DeckFormat.java:47
 *
 * Read left to right: the maindeck must be at least 40 cards, the sideboard is
 * unrestricted (`null` where the other formats carry a 0–15 range), and there
 * is no cap on distinct non-basic cards. `deckProblems` below implements
 * exactly that and nothing else. The real constraint — that you may only play
 * what you drafted — is structural: `newDeck` puts the whole pool in the
 * sideboard and the move functions only ever shuffle cards between the two
 * piles, so a card that was never in the pool has no way in.
 */

import {
  DEFAULT_ART_INDEX,
  type CardRequest,
  type DeckEntry,
  type DeckFile,
} from '@hadoku/carddata';

/**
 * Forge: `MagicColor.Constant.BASIC_LANDS` (MagicColor.java:138). Five names,
 * and notably not `Wastes` — Forge treats that one as a normal card.
 */
export const BASIC_LAND_NAMES: readonly string[] = [
  'Plains',
  'Island',
  'Swamp',
  'Mountain',
  'Forest',
];

const BASIC_LAND_SET = new Set(BASIC_LAND_NAMES);

/**
 * Forge: `DeckFormat.Limited`'s main-deck range starts at 40
 * (DeckFormat.java:47). This is the only size rule a cube deck has.
 */
export const LIMITED_MIN_MAIN_DECK_SIZE = 40;

/**
 * A drafted deck under construction.
 *
 * `main` and `sideboard` together are the drafted pool, always. `basics` is
 * separate because basic lands are supplied by the table rather than drafted,
 * so they are not subject to pool accounting and can be changed freely. They
 * are merged into the main section on export.
 */
export interface Deck {
  readonly name: string;
  readonly main: readonly DeckEntry[];
  readonly sideboard: readonly DeckEntry[];
  readonly basics: readonly DeckEntry[];
}

/**
 * Identity of a card reference, for pool accounting.
 *
 * Forge: `PaperCard.equals` (PaperCard.java:272) compares name, edition,
 * collector number, art index, foil and flags — so two printings of the same
 * card are two different cards, which is what a draft pool needs. `backFace` is
 * ours rather than Forge's (it lives on the image key there, ImageKeys.java:39)
 * and is included so a request survives a round trip through this model.
 */
export function cardKey(card: CardRequest): string {
  // Flag order is not meaningful — `parseRequestFlags` builds a map
  // (CardDb.java:289) — so sort by key to make the comparison order-independent.
  const flags =
    card.flags === null
      ? null
      : Object.entries(card.flags).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  // JSON rather than a delimiter join: a set code or collector number can hold
  // anything the format allows, and a separator that could also appear inside a
  // field would make two different cards share a key.
  return JSON.stringify([
    card.name,
    card.set,
    card.artIndex,
    card.collectorNumber,
    card.foil,
    card.backFace,
    flags,
  ]);
}

/** Total cards across a list of entries, summing the per-line counts. */
export function totalCards(entries: readonly DeckEntry[]): number {
  let total = 0;
  for (const entry of entries) total += entry.count;
  return total;
}

/** Cards in the maindeck as it would be exported — picks plus basic lands. */
export function mainDeckSize(deck: Deck): number {
  return totalCards(deck.main) + totalCards(deck.basics);
}

/** Cards left in the sideboard. */
export function sideboardSize(deck: Deck): number {
  return totalCards(deck.sideboard);
}

/** True when this reference names one of Forge's five basic lands. */
export function isBasicLand(card: CardRequest): boolean {
  return BASIC_LAND_SET.has(card.name);
}

/**
 * Start a deck from a drafted pool: everything sideboarded, nothing played.
 *
 * That is how Forge's limited deck editor opens too — the pool is the
 * sideboard and you promote cards out of it.
 */
export function newDeck(name: string, pool: readonly DeckEntry[]): Deck {
  return { name, main: [], sideboard: mergeEntries(pool), basics: [] };
}

/**
 * The drafted pool a deck was built from: maindeck plus sideboard, basics
 * excluded. Invariant under every move, which is what makes "you may only play
 * what you drafted" hold without a validator.
 */
export function poolOf(deck: Deck): DeckEntry[] {
  return mergeEntries([...deck.main, ...deck.sideboard]);
}

/** Read one section of a parsed `.dck` as a draft pool. */
export function poolFromDeckFile(file: DeckFile, section = 'main'): readonly DeckEntry[] {
  return file.sections.get(section) ?? [];
}

/** Move copies from the sideboard into the maindeck. */
export function moveToMain(deck: Deck, card: CardRequest, count = 1): Deck {
  const [sideboard, main] = transfer(deck.sideboard, deck.main, card, count, 'sideboard');
  return { ...deck, main, sideboard };
}

/** Move copies from the maindeck back to the sideboard. */
export function moveToSideboard(deck: Deck, card: CardRequest, count = 1): Deck {
  const [main, sideboard] = transfer(deck.main, deck.sideboard, card, count, 'maindeck');
  return { ...deck, main, sideboard };
}

/**
 * Set how many copies of a basic land the deck plays. `count` of 0 removes it.
 *
 * Basics are not drawn from the pool, so this is a set rather than a move, and
 * the count is unbounded — Forge exempts them from every copy limit
 * (`DeckFormat.canHaveAnyNumberOf`, DeckFormat.java:529).
 */
export function setBasicLand(deck: Deck, card: CardRequest, count: number): Deck {
  if (!isBasicLand(card)) {
    throw new Error(`${card.name} is not a basic land; use moveToMain for drafted cards`);
  }
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`basic land count must be a non-negative integer, got ${count}`);
  }
  const key = cardKey(card);
  const basics = deck.basics.filter((e) => cardKey(e.card) !== key);
  if (count > 0) basics.push({ count, card });
  return { ...deck, basics };
}

/**
 * Everything wrong with this deck, as human-readable strings. Empty means
 * playable.
 *
 * The whole list, so there is no doubt about what is NOT checked: deck size
 * against `DeckFormat.Limited`'s floor, that the basics bucket holds only basic
 * lands, and — when you pass the pool the deck was drafted from — that every
 * card played was actually in it. No colours, no singleton rule, no four-copy
 * limit, no banned list. Forge's `DeckFormat.Limited` imposes none of those
 * either (DeckFormat.java:47).
 */
export function deckProblems(deck: Deck, pool?: readonly DeckEntry[]): string[] {
  const problems: string[] = [];

  const size = mainDeckSize(deck);
  if (size < LIMITED_MIN_MAIN_DECK_SIZE) {
    problems.push(`maindeck has ${size} cards, needs at least ${LIMITED_MIN_MAIN_DECK_SIZE}`);
  }

  for (const entry of deck.basics) {
    if (!isBasicLand(entry.card)) {
      problems.push(`${entry.card.name} is in the basics pile but is not a basic land`);
    }
  }

  if (pool !== undefined) {
    const available = new Map<string, number>();
    for (const entry of mergeEntries(pool)) available.set(cardKey(entry.card), entry.count);
    for (const entry of poolOf(deck)) {
      const have = available.get(cardKey(entry.card)) ?? 0;
      if (entry.count > have) {
        problems.push(`plays ${entry.count}x ${entry.card.name} but drafted ${have}`);
      }
    }
  }

  return problems;
}

/**
 * Render a deck as a `DeckFile`, ready for `writeDck`.
 *
 * Basics are merged into the main section — they are maindeck cards, they just
 * did not come from the pool. An empty sideboard is left out entirely, matching
 * `DeckSerializer.serializeDeck`'s skip of empty sections (DeckSerializer.java:79).
 */
export function toDeckFile(deck: Deck): DeckFile {
  const sections = new Map<string, readonly DeckEntry[]>();
  const main = mergeEntries([...deck.main, ...deck.basics]);
  if (main.length > 0) sections.set('main', main);
  if (deck.sideboard.length > 0) sections.set('sideboard', mergeEntries(deck.sideboard));

  return {
    name: deck.name,
    metadata: new Map([['name', deck.name]]),
    sections,
  };
}

/**
 * A basic land reference with no printing pinned — `Forest` rather than
 * `Forest|LEA`. Forge accepts a bare name and picks a printing itself
 * (`CardDb.CardRequest.fromString` with no set code, CardDb.java:237), which is
 * the right default for lands the table supplies.
 */
export function basicLand(name: string, set: string | null = null): CardRequest {
  if (!BASIC_LAND_SET.has(name)) {
    throw new Error(`${name} is not one of Forge's basic lands: ${BASIC_LAND_NAMES.join(', ')}`);
  }
  return {
    name,
    set,
    artIndex: DEFAULT_ART_INDEX,
    collectorNumber: null,
    foil: false,
    backFace: false,
    flags: null,
  };
}

/** Collapse repeated references to the same card into one entry, keeping order. */
function mergeEntries(entries: readonly DeckEntry[]): DeckEntry[] {
  const out: DeckEntry[] = [];
  const at = new Map<string, number>();
  for (const entry of entries) {
    if (entry.count <= 0) continue;
    const key = cardKey(entry.card);
    const index = at.get(key);
    if (index === undefined) {
      at.set(key, out.length);
      out.push({ count: entry.count, card: entry.card });
    } else {
      out[index] = { count: out[index].count + entry.count, card: out[index].card };
    }
  }
  return out;
}

/** Move `count` copies of `card` from one pile to another, or refuse. */
function transfer(
  from: readonly DeckEntry[],
  to: readonly DeckEntry[],
  card: CardRequest,
  count: number,
  fromName: string,
): [DeckEntry[], DeckEntry[]] {
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error(`move count must be a positive integer, got ${count}`);
  }
  const key = cardKey(card);
  const source = from.find((e) => cardKey(e.card) === key);
  if (source === undefined || source.count < count) {
    throw new Error(
      `cannot move ${count}x ${card.name}: the ${fromName} has ${source?.count ?? 0}`,
    );
  }

  const nextFrom: DeckEntry[] = [];
  for (const entry of from) {
    if (cardKey(entry.card) !== key) nextFrom.push(entry);
    else if (entry.count > count) nextFrom.push({ count: entry.count - count, card: entry.card });
  }
  // Keep the moved card's own reference, not the destination's: they compare
  // equal under `cardKey`, so either would do, and this one is what the caller
  // asked for.
  return [nextFrom, mergeEntries([...to, { count, card: source.card }])];
}
