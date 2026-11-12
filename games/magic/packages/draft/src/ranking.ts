/*
 * Where a card sits in Forge's cube pick order (`cube-rankings.generated.ts`).
 *
 * Names are matched loosely: case, accents and spacing are ignored, so `Nazgûl` and `Nazgul` are one
 * card. The list writes a split card whole (`Fire // Ice`) and a double-faced or adventure card by
 * its front face (`Fable of the Mirror-Breaker`), while a resolved card carries Scryfall's full
 * name (`Fable of the Mirror-Breaker // Reflection of Kiki-Jiki`). So the whole name is tried
 * first, then the front face.
 */

import { CUBE_RANKING } from './cube-rankings.generated.ts';

/** How many cards the order ranks; rank `CUBE_RANKING_SIZE` is the last. */
export const CUBE_RANKING_SIZE = CUBE_RANKING.length;

function rankingKey(name: string): string {
  return name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

let ranks: ReadonlyMap<string, number> | null = null;

/** Built on first use, so a bundle that never ranks a card never pays for the table. */
function rankTable(): ReadonlyMap<string, number> {
  if (ranks === null) {
    const table = new Map<string, number>();
    CUBE_RANKING.forEach((name, i) => {
      const key = rankingKey(name);
      if (!table.has(key)) table.set(key, i + 1);
    });
    ranks = table;
  }
  return ranks;
}

/** A card's 1-based rank (1 is the best card), or null when the order does not rank it. */
export function cubeRank(name: string): number | null {
  const table = rankTable();
  const whole = table.get(rankingKey(name));
  if (whole !== undefined) return whole;
  const split = name.indexOf(' // ');
  return split === -1 ? null : (table.get(rankingKey(name.slice(0, split))) ?? null);
}
