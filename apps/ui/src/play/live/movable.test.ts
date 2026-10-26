import { describe, expect, it } from 'vitest';

import { clampOffset, offsetToSpot, readSpot, SPOT_KEY, spotOf, writeSpot } from './movable.tsx';

const board = { left: 0, top: 0, right: 1000, bottom: 800 };
const sheet = { left: 600, top: 300, right: 760, bottom: 400 };

describe('clampOffset', () => {
  it('keeps a dragged dialog inside the board, nearest to where it was dragged', () => {
    expect(clampOffset({ x: -50, y: 20 }, sheet, board)).toEqual({ x: -50, y: 20 });
    expect(clampOffset({ x: -2000, y: 2000 }, sheet, board)).toEqual({ x: 4 - 600, y: 800 - 4 - 400 });
    expect(clampOffset({ x: 2000, y: -2000 }, sheet, board)).toEqual({ x: 1000 - 4 - 760, y: 4 - 300 });
  });

  it('keeps the top-left corner of a dialog bigger than the board on the board', () => {
    expect(clampOffset({ x: 300, y: 300 }, { left: 0, top: 0, right: 1200, bottom: 900 }, board)).toEqual({ x: 4, y: 4 });
  });
});

describe('the remembered spot', () => {
  it('opens a dialog that fits there at the spot', () => {
    const spot = spotOf({ left: 200, top: 400, right: 360, bottom: 500 }, board);
    expect(spot).toEqual({ x: 0.2, y: 0.5 });
    expect(offsetToSpot(spot, sheet, board)).toEqual({ x: 200 - 600, y: 400 - 300 });
  });

  it('leaves a dialog that needs more room than the spot allows at its own default', () => {
    expect(offsetToSpot({ x: 0.9, y: 0.1 }, sheet, board), 'too wide for the room to the right of the spot').toBeNull();
    expect(offsetToSpot({ x: 0.1, y: 0.95 }, sheet, board), 'too tall for the room under the spot').toBeNull();
  });

  it('is kept in storage, and storage that throws or holds something else keeps nothing and breaks nothing', () => {
    const kept = new Map<string, string>();
    const storage = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v) };
    expect(readSpot(storage)).toBeNull();
    expect(writeSpot({ x: 0.25, y: 0.5 }, storage)).toBe(true);
    expect(readSpot(storage)).toEqual({ x: 0.25, y: 0.5 });

    const throwing = {
      getItem: (): string => {
        throw new Error('denied');
      },
      setItem: (): void => {
        throw new Error('quota');
      },
    };
    expect(writeSpot({ x: 0.25, y: 0.5 }, throwing)).toBe(false);
    expect(readSpot(throwing)).toBeNull();

    for (const junk of ['not json', '{"x":2,"y":0.5}', '{"x":"a"}', 'null']) {
      kept.set(SPOT_KEY, junk);
      expect(readSpot(storage), junk).toBeNull();
    }
  });
});
