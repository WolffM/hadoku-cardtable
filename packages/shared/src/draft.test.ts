/*
 * The deck HTTP contract — `GET/PUT /api/drafts/:podId/...`.
 *
 * `DraftViewSchema` already has its own suite (`wire.test.ts`,
 * `hiddenInfo`-adjacent checks elsewhere); this file is the four schemas added
 * for the deck routes, which are new. `issues` is asserted as a flat
 * `string[]`, not `WireIssue[]` — that is the one property worth pinning,
 * since a server-side refactor that widened it back to objects would parse
 * clean here and only fail the moment the UI tried to render one as a string.
 */

import { describe, expect, it } from 'vitest';

import {
  DraftCardSchema,
  DraftMineSchema,
  SaveDraftDeckBodySchema,
  SaveDraftDeckRefusalSchema,
  SaveDraftDeckResponseSchema,
} from './draft.ts';

const CARD: unknown = {
  cardId: 'c1',
  name: 'Test Card',
  manaCost: ['1', 'W'],
  manaValue: 2,
  colors: ['W'],
  typeLine: 'Creature — Test',
  oracleText: '',
  setCode: 'TST',
  collectorNumber: '1',
  rarity: 'common',
};

describe('DraftCardSchema.foil', () => {
  it('a card with no foil field parses — absent means not foil', () => {
    const result = DraftCardSchema.safeParse(CARD);
    expect(result.success).toBe(true);
    expect(result.success && result.data.foil).toBeUndefined();
  });

  it('foil: true parses and round-trips', () => {
    const result = DraftCardSchema.safeParse({ ...(CARD as Record<string, unknown>), foil: true });
    expect(result.success).toBe(true);
    expect(result.success && result.data.foil).toBe(true);
  });

  it('a non-boolean foil is refused', () => {
    expect(DraftCardSchema.safeParse({ ...(CARD as Record<string, unknown>), foil: 'yes' }).success).toBe(false);
  });
});

describe('DraftMineSchema', () => {
  it('parses a pool with no saved build yet', () => {
    expect(DraftCardSchema.safeParse(CARD).success).toBe(true);
    const result = DraftMineSchema.safeParse({ pool: [CARD], deck: null });
    expect(result.success).toBe(true);
  });

  it('parses a pool with a saved build', () => {
    const result = DraftMineSchema.safeParse({ pool: [CARD], deck: '[metadata]\nName=Draft deck\n[main]\n1 Test Card\n' });
    expect(result.success).toBe(true);
  });

  it('refuses a missing deck field — null is explicit, not absent', () => {
    expect(DraftMineSchema.safeParse({ pool: [CARD] }).success).toBe(false);
  });
});

describe('SaveDraftDeckBodySchema', () => {
  it('is exactly { dck }', () => {
    expect(SaveDraftDeckBodySchema.safeParse({ dck: '[metadata]\n' }).success).toBe(true);
  });

  it('refuses an empty dck and a missing one', () => {
    expect(SaveDraftDeckBodySchema.safeParse({ dck: '' }).success).toBe(false);
    expect(SaveDraftDeckBodySchema.safeParse({}).success).toBe(false);
  });

  it('refuses the shape the gate elsewhere accepts for a library deck — this route has no library arm', () => {
    expect(SaveDraftDeckBodySchema.safeParse({ library: 'some-id' }).success).toBe(false);
  });
});

describe('SaveDraftDeckResponseSchema', () => {
  it('is the saved .dck text, byte for byte', () => {
    expect(SaveDraftDeckResponseSchema.safeParse({ deck: '[metadata]\n' }).success).toBe(true);
  });
});

describe('SaveDraftDeckRefusalSchema', () => {
  it('is a flat array of messages, not WireIssue objects', () => {
    const result = SaveDraftDeckRefusalSchema.safeParse({ issues: ['plays 2x Island but drafted 0'] });
    expect(result.success).toBe(true);
  });

  it('refuses an issues array of objects — the server sends messages, not WireIssue shapes', () => {
    const result = SaveDraftDeckRefusalSchema.safeParse({
      issues: [{ kind: 'pool-limit', message: 'plays 2x Island but drafted 0', cardName: 'Island', count: 2, limit: 0 }],
    });
    expect(result.success).toBe(false);
  });
});
