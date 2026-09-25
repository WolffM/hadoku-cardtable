// @vitest-environment jsdom
/*
 * The pin for w20 §E item 2: the chrome and the page must not be able to
 * disagree about the theme.
 *
 * `.test.ts`, not `.test.tsx`, and `createElement` instead of JSX — the root
 * vitest config globs `apps/*\/src/**\/*.test.ts` and a `.tsx` test is not
 * collected (see `screens/lobby.test.ts`, which explains the same constraint).
 *
 * THE DIVERGENCE THIS FORCES
 * ---------------------------
 * Diagnosed live before this fix, not assumed: a stub-`whoami` build served
 * locally at `#/match/…` with no saved theme in either storage resolved
 * `data-theme="light"` on `.cardtable-chrome` while `.wp-room-chrome` sat at
 * `data-theme="dark"`. The `dark` side is `@wolffm/watchparty-ui`'s OWN
 * default — `Do()` in its shipped `dist/room-chrome.js` returns the caller's
 * `theme` prop if given, else its own store's cached theme if one loaded,
 * else hard-codes `'dark'`. `RoomChrome` is mocked below to reproduce exactly
 * that fallback (`theme ?? 'dark'`) rather than the real component, so this
 * test exercises OUR wiring — does `RoomShell` pass the page's theme through —
 * without needing watchparty's socket or store.
 *
 * jsdom has no `prefers-color-scheme` match (see `chrome/matchMedia.ts`), and
 * this file's jsdom instance starts with empty storage, so `HadokuThemeRoot`
 * resolves the page to its documented no-preference default, `'light'`. A
 * revert of the `theme={...}` line this test pins would leave the mock at its
 * `'dark'` fallback while the page stays `'light'` — the exact mismatch this
 * asserts is gone.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

vi.mock('@wolffm/prefs-client', () => ({
  whoami: () =>
    Promise.resolve({ userId: 'u-test', userType: 'friend' as const, name: 'Test Friend' }),
}));

vi.mock('@wolffm/watchparty-ui/room-chrome.css', () => ({}));

vi.mock('@wolffm/watchparty-ui/room-chrome', () => ({
  // Stands in for the real component; see the file header for why its
  // fallback mirrors the shipped one instead of testing watchparty's code.
  RoomChrome: ({ theme, children }: { theme?: string; children: ReactNode }) =>
    createElement('div', { 'data-testid': 'room-chrome', 'data-theme': theme ?? 'dark' }, children),
}));

// vi.mock calls above are hoisted above these imports by vitest's transform,
// so the mocked modules are in place before AppChrome/RoomShell load them.
import { AppChrome } from './AppChrome.tsx';
import { RoomShell } from '../room/RoomShell.tsx';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the chrome and the page agree on one theme', () => {
  it('passes the page-resolved theme into the room chrome, not its own default', async () => {
    render(
      createElement(AppChrome, {
        header: createElement('div', null, 'header'),
        children: createElement(RoomShell, {
          roomId: 'm-test',
          children: createElement('div', null, 'content'),
        }),
      }),
    );

    const roomChrome = await waitFor(() => screen.getByTestId('room-chrome'));

    // NOT `document.documentElement` — `@wolffm/themes`' own `setTheme()`
    // (`dist/index.js`) REMOVES `data-theme` from `<html>` for the base
    // `'light'` variant instead of setting it (absence-means-light), verified
    // live: rendering this tree left `<html>` with no `data-theme` attribute
    // at all while `.cardtable-chrome` — the container `HadokuThemeRoot`
    // mirrors onto unconditionally, `useTheme.js`'s `containerRef.current.
    // setAttribute(...)` — carried `data-theme="light"`. The container is the
    // one place the resolved theme is legible for every value including
    // `'light'`, so it is what this test and `RoomShell` both read from.
    const pageTheme = document.querySelector('.cardtable-chrome')?.getAttribute('data-theme');
    expect(pageTheme).toBe('light');

    expect(roomChrome.getAttribute('data-theme')).toBe(pageTheme);
  });
});
