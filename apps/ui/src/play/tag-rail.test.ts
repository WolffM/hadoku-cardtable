import { describe, expect, it } from 'vitest';

import { railFit } from './tag-rail.ts';

describe('railFit: how much of a one-row tag rail a card holds', () => {
  it('draws every chip when the row fits, to the half pixel', () => {
    expect(railFit([15, 15, 15], 49, 18)).toBeNull();
    expect(railFit([15, 15, 15], 48.5, 18)).toBeNull();
  });

  it('keeps as many as fit beside the +N chip', () => {
    // 15 + 2 + 15 + 2 + 18 = 52
    expect(railFit([15, 15, 15, 15], 52, 18)).toBe(2);
    expect(railFit([15, 15, 15, 15], 51, 18)).toBe(1);
  });

  it('reads each tag’s own width, a wide word tag included', () => {
    expect(railFit([40, 15, 15], 60, 18)).toBe(1);
  });

  it('draws only the +N chip when not even one tag fits beside it', () => {
    expect(railFit([15, 15], 20, 18)).toBe(0);
  });

  it('draws nothing when not even the +N chip fits', () => {
    expect(railFit([15, 15], 10, 18)).toBe(-1);
  });
});
