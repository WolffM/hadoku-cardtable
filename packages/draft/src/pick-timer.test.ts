/*
 * The draft rope's table (wave 83 D3): MTR Appendix B by cards left, and the
 * room's speed multiplier over it.
 */

import { describe, expect, it } from 'vitest';
import type { DraftCard } from '@hadoku/shared';
import { createDraft, packOf } from './engine.ts';
import { pickSeconds, pickTimeMs, timeoutPick } from './pick-timer.ts';

function card(i: number): DraftCard {
  return {
    cardId: `c${i}`,
    name: `Card ${i}`,
    manaCost: [],
    manaValue: i % 6,
    colors: [],
    typeLine: 'Creature — Test',
    oracleText: '',
    setCode: 'TST',
    collectorNumber: String(i),
    rarity: 'common',
  };
}

describe('pickSeconds — MTR Appendix B', () => {
  it('pins every row of the table', () => {
    const expected: Record<number, number | null> = {
      15: 40, 14: 40, 13: 35, 12: 30, 11: 25, 10: 25, 9: 20, 8: 20, 7: 15, 6: 10, 5: 10, 4: 5, 3: 5, 2: 5, 1: null,
    };
    for (const [left, seconds] of Object.entries(expected)) expect(pickSeconds(Number(left)), `${left} cards left`).toBe(seconds);
  });

  it('gives a bigger pack than 15 the first row, and nothing to an empty one', () => {
    expect(pickSeconds(20)).toBe(40);
    expect(pickSeconds(0)).toBeNull();
  });
});

describe('pickTimeMs — the speed multiplier', () => {
  it('is the table at speed 1', () => {
    expect(pickTimeMs(15, 1)).toBe(40_000);
    expect(pickTimeMs(7, 1)).toBe(15_000);
  });

  it('divides by the speed: 2 is twice as fast, 0.5 twice as long', () => {
    expect(pickTimeMs(13, 2)).toBe(17_500);
    expect(pickTimeMs(13, 0.5)).toBe(70_000);
    expect(pickTimeMs(4, 1.5)).toBe(3_333);
  });

  it('has no timer for the last card at any speed', () => {
    expect(pickTimeMs(1, 1)).toBeNull();
    expect(pickTimeMs(1, 4)).toBeNull();
  });
});

describe('timeoutPick — the draft bot picks for the seat', () => {
  const packs = [Array.from({ length: 2 }, (_, s) => Array.from({ length: 5 }, (_, i) => card(s * 10 + i)))];
  const human = { participantId: 'p-alice', displayName: 'alice', seat: 0 };

  it("takes one card from the seat's own pack and passes the rest", () => {
    const state = createDraft({ draftId: 'd', seed: 's', packs, seatCount: 2, packCount: 1, packSize: 5, humans: [human] });
    const result = timeoutPick(state, 0);
    expect(result?.ok).toBe(true);
    if (result === null || !result.ok) return;
    expect(result.state.pools[0]).toHaveLength(1);
    expect(packOf(state, 0).map((c) => c.cardId)).toContain(result.state.pools[0]![0]!.cardId);
  });

  it('is the same card whenever it runs: seeded per seat, pack and pick', () => {
    const a = createDraft({ draftId: 'd', seed: 's', packs, seatCount: 2, packCount: 1, packSize: 5, humans: [human] });
    const b = createDraft({ draftId: 'd', seed: 's', packs, seatCount: 2, packCount: 1, packSize: 5, humans: [human] });
    const pa = timeoutPick(a, 0);
    const pb = timeoutPick(b, 0);
    expect(pa?.ok && pb?.ok && pa.state.pools[0]![0]!.cardId === pb.state.pools[0]![0]!.cardId).toBe(true);
  });

  it('is null for a seat with no pack', () => {
    const state = createDraft({ draftId: 'd', seed: 's', packs: [[packs[0]![0]!, []]], seatCount: 2, packCount: 1, packSize: 5, humans: [human] });
    expect(timeoutPick(state, 1)).toBeNull();
  });
});
