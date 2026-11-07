// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { prefersReducedMotion } from './index.ts';

describe('prefersReducedMotion', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads the media query, and is false where there is none', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce') }));
    expect(prefersReducedMotion()).toBe(true);
  });

  it('is false when matchMedia is not a function', () => {
    vi.stubGlobal('matchMedia', undefined);
    expect(prefersReducedMotion()).toBe(false);
  });
});
