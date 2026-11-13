import { afterEach, describe, expect, it, vi } from 'vitest';
import { answerTabProbes, browserTabChannel } from '@wolffm/rooms-protocol';

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

describe('one id per page', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('a reload whose kept id a live duplicate also holds: every id the page hands out is the one its claim carries', async () => {
    const kept = 'a'.repeat(32);
    const stored = new Map([['cardtable:tab-id', kept]]);
    vi.stubGlobal('sessionStorage', { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => void stored.set(k, v) });
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([{ type: 'reload' } as unknown as PerformanceEntry]);
    // The duplicate: another live tab of the origin that goes by the kept id.
    const duplicate = browserTabChannel()!;
    const stop = answerTabProbes(duplicate, () => kept);
    try {
      const tabId = await import('./tab-id.ts');
      const handedOut: string[] = [];
      tabId.withSettledTabId((id) => handedOut.push(id));
      const claimed = await tabId.settledTabId();
      tabId.withSettledTabId((id) => handedOut.push(id));
      expect(claimed).not.toBe(kept);
      expect(handedOut).toEqual([claimed, claimed]);
    } finally {
      stop();
    }
  });
});
