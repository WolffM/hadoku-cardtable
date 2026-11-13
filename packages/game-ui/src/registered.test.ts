import { describe, expect, it } from 'vitest';

import { registered } from './registered.ts';

describe('registered', () => {
  it('throws, naming the part, when read before anything registered it', () => {
    expect(() => registered<() => void>('player mark').get()).toThrow(/player mark was never registered/);
  });

  it('reads back what was registered', () => {
    const part = registered<{ n: number }>('part');
    const value = { n: 1 };
    part.set(value);
    expect(part.get()).toBe(value);
  });
});
