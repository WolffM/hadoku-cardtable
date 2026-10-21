/*
 * The drafter's one build (`draftBuild`, `splitPicks`): picks are the deck in
 * progress and the drafter sideboards what they will not play (the operator,
 * 2026-10-21, Arena-style: "the deck builder opens with picks = main deck and
 * the dragged ones in the sideboard").
 */
import { describe, expect, it } from 'vitest';
import { cardKey, mainDeckSize, moveToSideboard, sideboardSize } from '@hadoku/deck';

import { cardRequestOf, dckTextOf, draftBuild, savedBuild, splitPicks } from './deckFromPool.ts';
import { loadFixtures } from './fixtures.ts';
import type { DraftCard } from './types.ts';

function picks(n: number): DraftCard[] {
  const out = new Map<string, DraftCard>();
  for (const view of loadFixtures()) {
    if (view.viewer.kind !== 'seat') continue;
    for (const card of [...view.viewer.pack, ...view.viewer.pool]) out.set(card.name, card);
  }
  const cards = [...out.values()];
  return Array.from({ length: n }, (_, i) => ({ ...cards[i % cards.length]!, cardId: `c${i}` }));
}

describe('a drafter’s build', () => {
  it('with nothing saved, every pick is in the main deck', () => {
    const pool = picks(45);
    const build = draftBuild('pod', pool, null);
    expect(mainDeckSize(build)).toBe(45);
    expect(sideboardSize(build)).toBe(0);
  });

  it('keeps a sideboarded pick in the sideboard, and later picks join the main deck', () => {
    const early = picks(10);
    const sided = moveToSideboard(draftBuild('pod', early, null), cardRequestOf(early[3]!));
    // Saved as the draft saves it: the sideboard only.
    const saved = savedBuild(dckTextOf({ ...sided, main: [] }), true);
    const later = picks(20);
    const build = draftBuild('pod', later, saved);
    expect(sideboardSize(build)).toBe(1);
    expect(mainDeckSize(build)).toBe(19);
    expect(build.sideboard.map((e) => e.card.name)).toEqual([early[3]!.name]);
  });

  it('never counts a card twice, and drops what the pool does not hold', () => {
    const pool = picks(5);
    const sided = moveToSideboard(draftBuild('pod', pool, null), cardRequestOf(pool[0]!));
    const doubled = { ...sided, sideboard: sided.sideboard.map((e) => ({ ...e, count: 9 })) };
    const build = draftBuild('pod', pool, doubled);
    const copies = pool.filter((c) => cardKey(cardRequestOf(c)) === cardKey(cardRequestOf(pool[0]!))).length;
    expect(sideboardSize(build)).toBe(copies);
    expect(mainDeckSize(build) + sideboardSize(build)).toBe(5);
    expect(mainDeckSize(draftBuild('pod', [], sided)) + sideboardSize(draftBuild('pod', [], sided))).toBe(0);
  });

  it('splits the picks card by card, in pick order', () => {
    const pool = picks(8);
    const build = moveToSideboard(draftBuild('pod', pool, null), cardRequestOf(pool[2]!));
    const { main, side } = splitPicks(pool, build);
    expect(side.map((c) => c.cardId)).toEqual(['c2']);
    expect(main).toHaveLength(7);
  });
});
