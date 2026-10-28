import { describe, expect, it } from 'vitest';

import { chooseTabId } from './tab-id.ts';

describe('chooseTabId', () => {
  const fresh = () => 'fresh-0000000000';

  it('keeps the stored id across a reload of the same tab', () => {
    expect(chooseTabId('reload', 'stored-000000000', fresh)).toBe('stored-000000000');
  });

  it('mints a new one for anything that is not a reload — a duplicated tab carries a copy of the original’s storage', () => {
    for (const how of ['navigate', 'back_forward', 'prerender', 'unknown']) expect(chooseTabId(how, 'stored-000000000', fresh), how).toBe('fresh-0000000000');
  });

  it('mints a new one when nothing usable is stored', () => {
    expect(chooseTabId('reload', null, fresh)).toBe('fresh-0000000000');
    expect(chooseTabId('reload', 'bad id!', fresh)).toBe('fresh-0000000000');
  });
});
