import { describe, expect, it } from 'vitest';

import { clampOffset, clearOffset, offsetToPoint, offsetToSpot, readSpot, SPOT_KEY, spotOf, writeSpot } from './movable.tsx';

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

describe('offsetToPoint: an ask opens at the press that opened it', () => {
  // sheet: 160 × 100, centred at (680, 350).
  it('centres the box on the press', () => {
    expect(offsetToPoint({ x: 300, y: 200 }, sheet, board)).toEqual({ x: 300 - 680, y: 200 - 350 });
  });

  it('stands it whole on the board for a press by an edge', () => {
    expect(offsetToPoint({ x: 2, y: 798 }, sheet, board)).toEqual({ x: 4 - 600, y: 800 - 4 - 400 });
    expect(offsetToPoint({ x: 999, y: 1 }, sheet, board)).toEqual({ x: 1000 - 4 - 760, y: 4 - 300 });
  });

  it('for a finger, centres it across the press and stands it just above, never under it', () => {
    expect(offsetToPoint({ x: 300, y: 700 }, sheet, board, 16)).toEqual({ x: 300 - 680, y: 700 - 16 - 400 });
  });
});

describe('clearOffset: a pick is never drawn over the board cards it offers', () => {
  const board = { left: 0, top: 0, right: 1600, bottom: 1000 };
  // stack-drag-shared's red: the target pick's pop-up (331×438 at 743,304) stood over the Illusionist it offered.
  const sheet = { left: 743, top: 304, right: 1074, bottom: 742 };
  const illusionist = { left: 820, top: 560, right: 936, bottom: 721 };

  it('leaves a pop-up that covers none of them where it is', () => {
    expect(clearOffset({ x: 0, y: 0 }, sheet, board, [{ left: 100, top: 100, right: 200, bottom: 250 }])).toEqual({ x: 0, y: 0 });
  });

  it('moves one that covers a card to the nearest place beside it, on the board, covering none', () => {
    const o = clearOffset({ x: 0, y: 0 }, sheet, board, [illusionist]);
    const moved = { left: sheet.left + o.x, top: sheet.top + o.y, right: sheet.right + o.x, bottom: sheet.bottom + o.y };
    const overlaps = moved.left < illusionist.right && illusionist.left < moved.right && moved.top < illusionist.bottom && illusionist.top < moved.bottom;
    expect(overlaps, 'clear of the card').toBe(false);
    expect(moved.left >= 0 && moved.right <= 1600 && moved.top >= 0 && moved.bottom <= 1000, 'on the board').toBe(true);
    // Nearest: above the card is 260 px up; the other sides are further.
    expect(o).toEqual({ x: 0, y: illusionist.top - 4 - 438 - sheet.top });
  });

  it('clears every card it offers, not just the first', () => {
    const nomads = { left: 700, top: 150, right: 816, bottom: 311 };
    const o = clearOffset({ x: 0, y: 0 }, sheet, board, [illusionist, nomads]);
    const moved = { left: sheet.left + o.x, top: sheet.top + o.y, right: sheet.right + o.x, bottom: sheet.bottom + o.y };
    for (const c of [illusionist, nomads]) expect(moved.left < c.right && c.left < moved.right && moved.top < c.bottom && c.top < moved.bottom).toBe(false);
  });

  it('stays where it is when no place on the board clears them all', () => {
    const wall = { left: 0, top: 0, right: 1600, bottom: 1000 };
    expect(clearOffset({ x: 5, y: 6 }, sheet, board, [wall])).toEqual({ x: 5, y: 6 });
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
