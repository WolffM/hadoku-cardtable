/**
 * Which card's art stands for a deck in the chooser, and how a page of decks
 * avoids showing the same card twice.
 *
 * A deck has no art of its own, so a rule has to be chosen and written down.
 * The operator, 2026-10-11: no repeats on the page — the deck further down gets
 * its second most iconic card — and a mythic legendary creature is a good pick,
 * especially as a four-of. So a card is scored on what makes it the face of a
 * deck rather than on cost alone:
 *
 * - **rarity** — mythic 4, rare 2, uncommon 1: the build-around is rarely common;
 * - **legendary** +3 — a legend is a named character, the card a deck is called by;
 * - **creature or planeswalker** +2 — a face has a figure in it;
 * - **copies** — a four-of +2, a three-of +1: the deck's plan rather than a single;
 * - **mana value** +0.4 a mana, up to six — the expensive card is usually the
 *   payoff, so a big rare beats the two-drop that ramps into it.
 *
 * Ties go to copies, then name, so the order is total and a re-render cannot
 * flicker.
 *
 * **A card with no mana cost is not a candidate**, which is how a land is
 * excluded without a type line: `LIBRARY_CARD_COSTS` has no land in it, and a
 * drafted land's `manaCost` is empty. The callers drop those before they get here.
 */

/** A maindeck card the art rule may choose between. */
export interface ArtCandidate {
  name: string;
  count: number;
  manaValue: number;
  /** `<rarity>[L][C][P]` — see `scripts/art/build-deck-art-traits.ts`. */
  traits: string;
  scryfallId?: string | undefined;
}

/** One card a deck could show, in the deck's own order of preference. */
export interface DeckArtChoice {
  name: string;
  artId: string;
}

const RARITY_SCORE: Record<string, number> = { m: 4, r: 2, u: 1 };

/** How well one card stands for its deck. Higher is better. */
export function artScore(card: ArtCandidate): number {
  const t = card.traits;
  return (
    (RARITY_SCORE[t.charAt(0)] ?? 0) +
    (t.includes('L') ? 3 : 0) +
    (t.includes('C') || t.includes('P') ? 2 : 0) +
    (card.count >= 4 ? 2 : card.count === 3 ? 1 : 0) +
    Math.min(card.manaValue, 6) * 0.4
  );
}

/** The deck's cards with art, best face first. */
export function rankDeckArt(candidates: readonly ArtCandidate[]): DeckArtChoice[] {
  return candidates
    .filter((c): c is ArtCandidate & { scryfallId: string } => c.scryfallId !== undefined)
    .map((c) => ({ c, score: artScore(c) }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.c.count - a.c.count ||
        (a.c.name < b.c.name ? -1 : a.c.name > b.c.name ? 1 : 0),
    )
    .map(({ c }) => ({ name: c.name, artId: c.scryfallId }));
}

/** `DraftCard`'s rarity and type line, as the same trait string the library table holds. */
export function traitsOfDraftCard(rarity: string, typeLine: string): string {
  const front = new Set((typeLine.split(' // ')[0] ?? '').split(/[\s—-]+/));
  return (
    rarity.charAt(0) +
    (front.has('Legendary') ? 'L' : '') +
    (front.has('Creature') ? 'C' : '') +
    (front.has('Planeswalker') ? 'P' : '')
  );
}

/**
 * One art id per deck, for decks shown together in this order: each takes its
 * best card that no deck above it has taken. A deck whose every card is taken
 * keeps its own first choice — a repeat is better than a blank tile.
 */
export function assignDeckArt(rankings: readonly (readonly DeckArtChoice[])[]): (string | undefined)[] {
  const taken = new Set<string>();
  return rankings.map((choices) => {
    const pick = choices.find((c) => !taken.has(c.name)) ?? choices[0];
    if (pick === undefined) return undefined;
    taken.add(pick.name);
    return pick.artId;
  });
}
