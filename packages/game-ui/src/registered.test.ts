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

  it('builds its fallback once, on first read, when nothing registered it', () => {
    let built = 0;
    const part = registered<{ n: number }>('part', () => ({ n: ++built }));
    expect(built).toBe(0);
    expect(part.get()).toEqual({ n: 1 });
    expect(part.get()).toEqual({ n: 1 });
    expect(built).toBe(1);
  });

  it('prefers what was registered over its fallback', () => {
    const part = registered<{ n: number }>('part', () => ({ n: 0 }));
    part.set({ n: 2 });
    expect(part.get()).toEqual({ n: 2 });
  });
});
