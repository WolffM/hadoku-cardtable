import { describe, expect, it } from 'vitest';
import { loadCube } from '@hadoku/carddata';
import { CUBE_RANKING_SIZE, cubeRank } from './ranking.ts';

describe('cubeRank — a card name to its place in Forge’s cube pick order', () => {
  it('ranks the order as written: Black Lotus first, 4000 cards in all', () => {
    expect(cubeRank('Black Lotus')).toBe(1);
    expect(cubeRank('Lightning Bolt')).toBe(91);
    expect(CUBE_RANKING_SIZE).toBe(4000);
  });

  it('ignores case, accents and spacing', () => {
    expect(cubeRank('Nazgûl')).toBe(108);
    expect(cubeRank('nazgul')).toBe(108);
    expect(cubeRank('  lightning   BOLT ')).toBe(91);
  });

  it('finds a split card whole and a double-faced or adventure card by its front face', () => {
    expect(cubeRank('Fire // Ice')).toBe(2309);
    expect(cubeRank('Fable of the Mirror-Breaker // Reflection of Kiki-Jiki')).toBe(44);
    expect(cubeRank('Fable of the Mirror-Breaker')).toBe(44);
  });

  it('is null for a card the order does not rank', () => {
    expect(cubeRank('Grizzly Bears')).toBeNull();
    expect(cubeRank('Grizzly Bears // Nothing')).toBeNull();
  });
});

describe('the order against a real cube list', () => {
  it('ranks most of a current vintage cube, so the bots are reading the list and not the rarity fallback', async () => {
    const cube = await loadCube('MTGO Vintage Cube 2025-12.dck');
    const names = (cube.sections.get('main') ?? []).map((e) => e.card.name);
    const ranked = names.filter((n) => cubeRank(n) !== null).length;
    expect(names.length).toBe(540);
    expect(ranked / names.length).toBeGreaterThan(0.75);
  });
});
