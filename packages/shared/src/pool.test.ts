/**
 * `CubeSummarySchema`'s `artId` (AF305 §B, cube art): a scryfallId or
 * `null`, strictly — never a URL, and never an absent field (the schema is
 * `strictObject`, so every producer must say).
 */
import { describe, expect, it } from 'vitest';

import { CubeSummarySchema } from './pool.ts';

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
