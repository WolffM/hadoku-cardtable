import { describe, expect, it } from 'vitest';

import { storedCandidate } from './tab-id.ts';

describe('storedCandidate', () => {
  it('keeps the stored id across a reload of the same tab', () => {
    expect(storedCandidate('reload', 'stored-000000000')).toBe('stored-000000000');
  });

  it('keeps nothing for anything that is not a reload — a duplicated tab carries a copy of the original’s storage', () => {
    for (const how of ['navigate', 'back_forward', 'prerender', 'unknown']) expect(storedCandidate(how, 'stored-000000000'), how).toBeNull();
  });

  it('keeps nothing when nothing usable is stored', () => {
    expect(storedCandidate('reload', null)).toBeNull();
    expect(storedCandidate('reload', 'bad id!')).toBeNull();
  });
});
