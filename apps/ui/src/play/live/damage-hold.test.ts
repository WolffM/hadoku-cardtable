import { describe, expect, it } from 'vitest';

import { heldValues } from './damage-hold.ts';

describe('heldValues', () => {
  it("draws a card's damage from before a hit until that hit lands", () => {
    const holds = heldValues<number>();
    let changes = 0;
    holds.subscribe(() => (changes += 1));
    expect(holds.shown(7)).toBeUndefined();
    holds.hold(7, 0);
    expect(holds.shown(7)).toBe(0);
    holds.release(7);
    expect(holds.shown(7)).toBeUndefined();
    expect(changes).toBe(2);
  });

  it('a card hit twice keeps its damage from before the first until the last lands', () => {
    const holds = heldValues<number>();
    holds.hold(7, 1);
    holds.hold(7, 4);
    expect(holds.shown(7)).toBe(1);
    holds.release(7);
    expect(holds.shown(7), 'one hit still in the air').toBe(1);
    holds.release(7);
    expect(holds.shown(7)).toBeUndefined();
  });

  it('a release with nothing held, and a clear, change nothing they should not', () => {
    const holds = heldValues<number>();
    let changes = 0;
    holds.subscribe(() => (changes += 1));
    holds.release(3);
    holds.clear();
    expect(changes).toBe(0);
    holds.hold(3, 2);
    holds.hold(4, 0);
    holds.clear();
    expect([holds.shown(3), holds.shown(4)]).toEqual([undefined, undefined]);
    expect(changes).toBe(3);
  });
});
