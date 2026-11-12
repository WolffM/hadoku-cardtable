import { describe, expect, it } from 'vitest';

import { mirrorLine, parseMirrorLog } from './mirror.ts';

const KEY = `${'a'.repeat(64)}.jpg`;
const LATER = `${'b'.repeat(64)}.jpg`;

describe('the art mirror log', () => {
  it('reads every line back, a later line for the same id winning, and skips what the resolver would refuse', () => {
    const text = [
      mirrorLine({ id: 'x', key: KEY }),
      mirrorLine({ id: 'x', key: LATER }),
      mirrorLine({ id: 'y', key: 'not-a-key' }),
      '{"id":"z","key":',
    ].join('');
    const { keys, skipped } = parseMirrorLog(text);
    expect([...keys]).toEqual([['x', LATER]]);
    expect(skipped).toBe(2);
  });
});
