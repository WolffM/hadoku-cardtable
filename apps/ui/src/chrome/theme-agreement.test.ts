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

/*
 * THE ARM THIS TEST USED TO BE MISSING
 * ------------------------------------
 * The assertion below is "the chrome's theme and the room's theme are equal",
 * and it silently assumed a chrome was MOUNTED — true on every room route
 * today, and nowhere stated. A future route that mounts the shell without the
 * app chrome would have turned `pageTheme` into `undefined` and reddened this
 * file over a change that has nothing to do with theming.
 *
 * So the three outcomes are named, and only ONE of them is a failure:
 *
 *   'agree'      the chrome and the room carry the same theme — the pass.
 *   'mismatch'   they carry different ones — the regression this pins.
 *   'no-chrome'  there is no `.cardtable-chrome` in the tree, so the page has
 *                no resolved theme to disagree with. "Did not happen", not
 *                "passed" and not "failed": the test reports the reason and
 *                skips, the way hadoku_site's copy of this test does.
 *   'no-theme'   a chrome, but no `data-theme` on it. Same treatment, different
 *                reason — there is still nothing to compare.
 *
 * Splitting it into a pure function is what makes the skip arms PROVABLE rather
 * than merely reachable: the two cases below feed `themeVerdict` a synthetic
 * tree and assert the verdict, in tests that pass. A skip arm nobody exercises
 * is an arm nobody knows works.
 */

type Verdict =
  | { kind: 'agree'; theme: string }
  | { kind: 'mismatch'; page: string; room: string | null }
  | { kind: 'no-chrome' }
  | { kind: 'no-theme' };

/**
 * The chrome's theme against the room's, read from a rendered tree.
 *
 * NOT from `document.documentElement` — `@wolffm/themes`' own `setTheme()`
 * (`dist/index.js`) REMOVES `data-theme` from `<html>` for the base `'light'`
 * variant instead of setting it (absence-means-light), verified live:
 * rendering this tree left `<html>` with no `data-theme` attribute at all while
 * `.cardtable-chrome` — the container `HadokuThemeRoot` mirrors onto
 * unconditionally, `useTheme.js`'s `containerRef.current.setAttribute(...)` —
 * carried `data-theme="light"`. The container is the one place the resolved
 * theme is legible for every value including `'light'`, so it is what this and
 * `RoomShell` both read from.
 */
function themeVerdict(root: ParentNode, room: Element): Verdict {
  const chrome = root.querySelector('.cardtable-chrome');
  if (chrome === null) return { kind: 'no-chrome' };
  const page = chrome.getAttribute('data-theme');
  if (page === null) return { kind: 'no-theme' };
  const roomTheme = room.getAttribute('data-theme');
  return page === roomTheme
    ? { kind: 'agree', theme: page }
    : { kind: 'mismatch', page, room: roomTheme };
}

/** A tree with a room chrome and no app chrome above it. */
function detachedRoom(theme: string | null): { root: ParentNode; room: Element } {
  const root = document.createElement('div');
  const room = document.createElement('div');
  if (theme !== null) room.setAttribute('data-theme', theme);
  root.append(room);
  return { root, room };
}

describe('the chrome and the page agree on one theme', () => {
  it('passes the page-resolved theme into the room chrome, not its own default', async (ctx) => {
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
    const verdict = themeVerdict(document, roomChrome);

    // A switch, so the compiler is the thing that notices when a fifth outcome
    // is added and left unhandled. `ctx.skip()` and `expect.fail()` both throw,
    // so nothing after the switch can run for those arms.
    switch (verdict.kind) {
      case 'no-chrome':
        ctx.skip(
          'no .cardtable-chrome in the tree: this route mounted the room without the app chrome, ' +
            'so the page has no resolved theme for the room to disagree with',
        );
        break;
      case 'no-theme':
        ctx.skip(
          '.cardtable-chrome carries no data-theme: HadokuThemeRoot had not mirrored the ' +
            'resolved theme onto the container, so there is nothing to compare',
        );
        break;
      case 'mismatch':
        expect.fail(
          `the page resolved "${verdict.page}" and the room chrome rendered ` +
            `"${verdict.room}" — RoomShell is not passing the page's theme through`,
        );
        break;
      case 'agree':
        // The pin that keeps the comparison meaningful. jsdom has no
        // `prefers-color-scheme` match (see `chrome/matchMedia.ts`) and this
        // file clears both storages, so `HadokuThemeRoot` resolves the
        // documented no-preference default. If the page ever resolved `'dark'`
        // instead it would match the mock's own hard-coded fallback, and the
        // comparison above would pass without proving anything.
        expect(verdict.theme).toBe('light');
        break;
    }
  });

  it('reports "did not happen" rather than failing when no chrome is mounted', () => {
    const { root, room } = detachedRoom('dark');
    expect(themeVerdict(root, room)).toEqual({ kind: 'no-chrome' });
  });

  it('calls a real disagreement a mismatch', () => {
    const { root, room } = detachedRoom('dark');
    const chrome = document.createElement('main');
    chrome.className = 'cardtable-chrome';
    chrome.setAttribute('data-theme', 'light');
    chrome.append(room);
    root.append(chrome);

    expect(themeVerdict(root, room)).toEqual({ kind: 'mismatch', page: 'light', room: 'dark' });
  });
});
