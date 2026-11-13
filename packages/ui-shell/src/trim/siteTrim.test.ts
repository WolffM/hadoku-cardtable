// @vitest-environment jsdom
/*
 * This package builds no `/<app>/api/…` path itself: `configureSiteTrim` is the one call an app
 * makes, once, to say where its trim endpoint is (`packages/game-ui/src/settings/siteTrim.ts` is cardtable's
 * own one-line wiring, at `apiUrl('trim')`). These pin that it throws until configured, then reads
 * and writes exactly the endpoint it was given — nothing derived, nothing cardtable-specific.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

import { configureSiteTrim, knownTrim, resetSiteTrimForTests, saveSiteTrim, useSiteTrim } from './siteTrim.ts';

const ENDPOINT = '/some-game/api/trim';

describe('knownTrim', () => {
  it('drops a value that is not a plain record: null, an array, a primitive', () => {
    for (const v of [null, ['frame'], 'frame', 42]) expect(knownTrim(v)).toEqual({});
  });

  it('keeps only known families and options of a record', () => {
    expect(knownTrim({ frame: 'scoop', sparkle: 'on', ground: 'not-a-real-option' })).toEqual({ frame: 'scoop' });
  });
});

beforeEach(() => {
  resetSiteTrimForTests();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Page() {
  const { loaded, trim } = useSiteTrim();
  return createElement('div', { 'data-testid': 'page', 'data-loaded': loaded, 'data-frame': trim.frame ?? '' });
}

describe('configureSiteTrim', () => {
  it('throws until it is called, with the endpoint it names afterwards', async () => {
    // A fresh module, not the one the file's other tests already configured: the shared module-level
    // config would otherwise make "never configured" unreachable after the first test runs.
    vi.resetModules();
    const fresh = await import('./siteTrim.ts');
    const FreshPage = () => {
      const { loaded } = fresh.useSiteTrim();
      return createElement('div', { 'data-testid': 'page', 'data-loaded': loaded });
    };
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{}', { status: 404 }))));
    expect(() => render(createElement(FreshPage))).toThrow('ui-shell: configureSiteTrim was never called');
    cleanup();

    fresh.configureSiteTrim({ apiUrl: ENDPOINT });
    render(createElement(FreshPage));
    await waitFor(() => expect(screen.getByTestId('page').dataset.loaded).toBe('true'));
  });

  it('reads and writes exactly the endpoint it was given — never one this package builds itself', async () => {
    configureSiteTrim({ apiUrl: ENDPOINT });
    const requested: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        requested.push(url);
        if (init?.method === 'PUT') return Promise.resolve(new Response(String(init.body), { status: 200 }));
        return Promise.resolve(new Response(JSON.stringify({ trim: { frame: 'glint' }, canEdit: true }), { status: 200 }));
      }),
    );

    render(createElement(Page));
    await waitFor(() => expect(screen.getByTestId('page').dataset.frame).toBe('glint'));
    await saveSiteTrim({ frame: 'chamfer' });

    expect(requested).toEqual([ENDPOINT, ENDPOINT]);
  });

  it('draws the default when a 200 answers with a body that is not JSON (a proxy page)', async () => {
    configureSiteTrim({ apiUrl: ENDPOINT });
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('<html>not json</html>', { status: 200 }))));

    render(createElement(Page));
    await waitFor(() => expect(screen.getByTestId('page').dataset.loaded).toBe('true'));
    // `DEFAULT_TRIM` carries `frame: 'scoop'`; a parse failure must land here, not throw uncaught.
    expect(screen.getByTestId('page').dataset.frame).toBe('scoop');
  });
});
