/**
 * `CubeSummarySchema`'s `artId` (AF305 §B, cube art): a scryfallId or
 * `null`, strictly — never a URL, and never an absent field (the schema is
 * `strictObject`, so every producer must say).
 */
import { describe, expect, it } from 'vitest';

import type { DraftCard } from './draft.ts';
import { CubeSummarySchema, planDisplayName, sampleArt, type DraftPlan } from './pool.ts';

const base = {
  id: 'a-cube',
  name: 'A cube',
  size: 1,
  origin: 'shortlist' as const,
  cubeCobraId: null,
  importedBy: null,
  importedAt: null,
  refreshedAt: null,
  verdict: null,
};

describe('CubeSummarySchema', () => {
  it('accepts a scryfallId or null for artId', () => {
    expect(CubeSummarySchema.safeParse({ ...base, artId: '4a2e428c-dd25-484c-bbc8-2d6ce10ef42c' }).success).toBe(true);
    expect(CubeSummarySchema.safeParse({ ...base, artId: null }).success).toBe(true);
  });

  it('refuses a summary with no artId field at all — every producer must resolve or decline it', () => {
    expect(CubeSummarySchema.safeParse(base).success).toBe(false);
  });

  it('refuses a URL in artId’s place — the field is a scryfall uuid, never a URL', () => {
    expect(CubeSummarySchema.safeParse({ ...base, artId: 'https://cards.scryfall.io/art_crop/x.jpg' }).success).toBe(false);
  });
});

describe('planDisplayName', () => {
  const ala = { kind: 'set', code: 'ALA', style: 'realistic' } as const;
  const arb = { kind: 'set', code: 'ARB', style: 'realistic' } as const;

  it('three equal rounds give that source’s label: a cube’s name, a set’s name with its style', () => {
    const cube = { kind: 'cube', cubeId: 'vintage' } as const;
    expect(planDisplayName({ rounds: [cube, cube, cube] }, ['Vintage Cube', 'Vintage Cube', 'Vintage Cube'])).toBe('Vintage Cube');
    expect(planDisplayName({ rounds: [ala, ala, ala] }, ['Shards of Alara', 'Shards of Alara', 'Shards of Alara'])).toBe('Shards of Alara · Realistic');
  });

  it('otherwise joins the three labels, each with its own style', () => {
    const plan: DraftPlan = { rounds: [ala, ala, { ...arb, style: 'set-cube' }] };
    expect(planDisplayName(plan, ['Shards of Alara', 'Shards of Alara', 'Alara Reborn'])).toBe(
      'Shards of Alara · Realistic / Shards of Alara · Realistic / Alara Reborn · Set-cube',
    );
  });

  it('the same set in two styles is two sources', () => {
    expect(planDisplayName({ rounds: [ala, ala, { ...ala, style: 'set-cube' }] }, ['ALA', 'ALA', 'ALA'])).toBe('ALA · Realistic / ALA · Realistic / ALA · Set-cube');
  });
});

describe('sampleArt', () => {
  const card = (id: string | undefined, n: number): DraftCard => ({ cardId: `k${String(n)}`, name: `Card ${String(n)}`, ...(id === undefined ? {} : { scryfallId: id }) }) as DraftCard;

  it('draws distinct art ids, skipping cards with none, never more than asked', () => {
    const cards = [card('a', 1), card('a', 2), card(undefined, 3), card('b', 4), card('c', 5), card('d', 6)];
    const drawn = sampleArt(cards, 3, () => 0);
    expect(drawn).toEqual(['a', 'b', 'c']);
    expect(sampleArt(cards.slice(0, 3), 3)).toEqual(['a']);
  });
});
