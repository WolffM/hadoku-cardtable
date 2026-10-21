// @vitest-environment jsdom
/*
 * The switch back to walking the whole board (`MARK_SCAN_KEY`). The marks themselves,
 * both ways, are `gestures.test.ts`'s §B.1, against a real board.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { MARK_SCAN_KEY, markScanWanted } from './intent.ts';

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('markScanWanted', () => {
  it('is off unless this browser set the key to 1', () => {
    expect(markScanWanted()).toBe(false);
    localStorage.setItem(MARK_SCAN_KEY, '0');
    expect(markScanWanted()).toBe(false);
    localStorage.setItem(MARK_SCAN_KEY, '1');
    expect(markScanWanted()).toBe(true);
  });

  it('is off when the storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(markScanWanted()).toBe(false);
  });
});
