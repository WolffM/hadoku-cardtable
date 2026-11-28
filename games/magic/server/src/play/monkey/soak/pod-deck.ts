/*
 * A drafter's deck from their own pod pool, for the soak's matches: Sunday's decks are drafted BLB
 * 40s, and the engine's cost is the deck's. Built with the deck screen's own writer (`deckFromPool`,
 * `dckTextOf`), so the match gate checks it against the pool exactly as it checks a player's.
 */
import type { DraftCard, ManaColor } from '@hadoku/shared';
import { basicLand, cardRequestOf, moveToMain, setBasicLand } from '@hadoku/deck';

import { dckTextOf, deckFromPool } from '../../../../../ui/src/draft/deckFromPool.ts';

const BASIC: Record<string, string> = { W: 'Plains', U: 'Island', B: 'Swamp', R: 'Mountain', G: 'Forest' };

/**
 * The two colours the pool is deepest in, its 23 cheapest playables of those colours (colourless
 * ones too), and 17 basics split by the colours' share. A person builds better; the engine's cost
 * is the same.
 */
export function buildDeck(pool: readonly DraftCard[], name: string): string {
  const spells = pool.filter((c) => !c.typeLine.includes('Land'));
  const depth = new Map<ManaColor, number>();
  for (const c of spells) for (const col of c.colors) depth.set(col, (depth.get(col) ?? 0) + 1);
  const colours = [...depth.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([c]) => c);
  const picked = spells.filter((c) => c.colors.every((col) => colours.includes(col))).sort((a, b) => a.manaValue - b.manaValue).slice(0, 23);

  let deck = deckFromPool(name, pool, name);
  for (const c of picked) deck = moveToMain(deck, cardRequestOf(c));
  const share = colours.map((col) => picked.filter((c) => c.colors.includes(col)).length);
  const total = share.reduce((a, b) => a + b, 0) || 1;
  const lands = 40 - picked.length;
  const [first, second] = colours;
  const firstCount = second === undefined ? lands : Math.round((lands * (share[0] ?? 1)) / total);
  if (first !== undefined) deck = setBasicLand(deck, basicLand(BASIC[first] ?? 'Wastes'), firstCount);
  if (second !== undefined && lands - firstCount > 0) deck = setBasicLand(deck, basicLand(BASIC[second] ?? 'Wastes'), lands - firstCount);
  return dckTextOf(deck);
}
