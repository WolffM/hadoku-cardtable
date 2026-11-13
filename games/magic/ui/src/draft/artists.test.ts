// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const TABLE = { version: 1, note: '', names: ['Lie Setiawan'], ids: { 'art-1': 0 } };

/** A fresh `artists.ts` whose table import fails `failures` times, then loads `TABLE`. */
async function artistsFailing(failures: number) {
  let attempts = 0;
  vi.resetModules();
  vi.doMock('./art-artists.json', () => {
    attempts += 1;
    if (attempts <= failures) throw new Error(`chunk load failed (attempt ${attempts})`);
    return { default: TABLE };
  });
  const module = await import('./artists.ts');
  return { ...module, attempts: () => attempts };
}

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};

afterEach(() => {
  cleanup();
  process.off('unhandledRejection', onUnhandled);
  unhandled.length = 0;
  vi.doUnmock('./art-artists.json');
  vi.restoreAllMocks();
});

describe('the lazy artist table', () => {
  it('a failed load reaches every waiting credit as one handled outcome, and the next credit retries it', async () => {
    process.on('unhandledRejection', onUnhandled);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { useArtist, attempts } = await artistsFailing(1);

    // Two credits waiting on the same attempt, which fails.
    const first = renderHook(() => useArtist('art-1'));
    const second = renderHook(() => useArtist('art-1'));
    await waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(attempts()).toBe(1);
    expect(first.result.current, 'no credit while the table is missing').toBeUndefined();
    expect(second.result.current).toBeUndefined();

    // The failure was not kept: the next credit to ask loads again, and gets its artist.
    const third = renderHook(() => useArtist('art-1'));
    await waitFor(() => expect(third.result.current).toBe('Lie Setiawan'));
    expect(attempts()).toBe(2);
    // Read last: the retry's waits have let any rejection of the first attempt surface by now.
    expect(unhandled).toEqual([]);
  });

  it('a loaded table is loaded once', async () => {
    const { useArtist, attempts } = await artistsFailing(0);
    const first = renderHook(() => useArtist('art-1'));
    await waitFor(() => expect(first.result.current).toBe('Lie Setiawan'));
    const second = renderHook(() => useArtist('art-2'));
    expect(second.result.current, 'an id with no artist on record').toBeNull();
    expect(attempts()).toBe(1);
  });
});
