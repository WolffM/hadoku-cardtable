// @vitest-environment jsdom
/*
 * The room wrapper's refusals, and the one thing it must NOT refuse.
 *
 * The interesting cases are all the ones where the room does NOT appear: a
 * table that will not draw because chat is unavailable is an outage, and a
 * room key we guessed is two unrelated groups sharing a chat.
 *
 * The exception is the theme (w22 §G). There, dropping a value is the bug:
 * `RoomChrome` reads a falsy `theme` prop as "consult my own store, then
 * hard-code `dark`", so a name we refuse to forward becomes an actively wrong
 * `dark` chrome beside a light page — the split-theme bug the operator
 * reported. See `RoomShell.tsx`'s comment on `watchpartyTheme` for the shipped
 * `Do()` that makes that true.
 *
 * `.test.ts`, not `.test.tsx`, and `createElement` instead of JSX — the root
 * vitest config globs `apps/*\/src/**\/*.test.ts` and a `.tsx` test is not
 * collected (see `chrome/theme-agreement.test.ts` and `screens/lobby.test.ts`,
 * which explain the same constraint). jsdom, because the second theme arm
 * renders.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

/*
 * A theme name this install's `Theme` union does not contain.
 *
 * The scenario it stands in for is real and not hypothetical: `watchparty-ui`
 * takes `@wolffm/themes` as a plain dependency (`^5.8.5`), not a peer, so a
 * host outside that range resolves a second nested copy and two distinct
 * unions exist. `THEMES` is asserted below rather than eyeballed, so this stays
 * honest if a future `@wolffm/themes` ships an `aurora` family.
 *
 * `vi.hoisted`, because `vi.mock` factories are hoisted above every import and
 * a plain `const` would be out of scope inside one.
 */
const { UNKNOWN_THEME } = vi.hoisted(() => ({ UNKNOWN_THEME: 'aurora-dusk' }));

vi.mock('@wolffm/prefs-client', () => ({
  whoami: () =>
    Promise.resolve({ userId: 'u-test', userType: 'friend' as const, name: 'Test Friend' }),
}));

vi.mock('@wolffm/watchparty-ui/room-chrome.css', () => ({}));

vi.mock('@wolffm/watchparty-ui/room-chrome', () => ({
  /*
   * Stands in for the real component, reproducing its shipped fallback rather
   * than testing watchparty's code. `Do()` in `dist/room-chrome.js` (0.39.5) is
   * `if (e) return e; const t = ze().theme; return t && tn.includes(t) ? t :
   * "dark";` — so a truthy prop is honoured VERBATIM and unvalidated, and only
   * a FALSY one reaches the store-then-`dark` path. `theme || 'dark'` is that
   * branch exactly; `theme ?? 'dark'` would not be, because it would let `''`
   * through as a theme the real chrome would reject.
   */
  RoomChrome: ({ theme, children }: { theme?: string; children: ReactNode }) =>
    createElement('div', { 'data-testid': 'room-chrome', 'data-theme': theme || 'dark' }, children),
}));

/*
 * The page's theme, forced to a name outside the union. Spreads the real module
 * so `THEMES` below is the shipped list and not a fixture — the assertion that
 * `UNKNOWN_THEME` is genuinely unknown has to be made against the real union to
 * mean anything.
 */
vi.mock('@wolffm/themes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@wolffm/themes')>()),
  useHadokuTheme: () => ({ theme: UNKNOWN_THEME }),
}));

// The vi.mock calls above are hoisted above these imports by vitest's
// transform, so the mocked modules are in place before RoomShell loads them.
import { THEMES } from '@wolffm/themes';

import { RoomShell, roomKeyFor, watchpartyTheme } from './RoomShell.tsx';

afterEach(() => {
  cleanup();
});

describe('the room key for a pod or match', () => {
  it('prefixes ids watchparty will accept without provisioning', () => {
    expect(roomKeyFor('m-090bf01ba811')).toBe('cardtable-m-090bf01ba811');
    expect(roomKeyFor('e2e-two-friends')).toBe('cardtable-e2e-two-friends');
  });

  it('refuses rather than coerces, so two ids cannot collapse into one room', () => {
    // Uppercase is the live hazard: lowercasing "AB" and "ab" would put two
    // unrelated groups in one room, each reading the other's chat.
    expect(roomKeyFor('M-090BF01BA811')).toBeNull();
    expect(roomKeyFor('pod_1')).toBeNull();
    expect(roomKeyFor('pod 1')).toBeNull();
    expect(roomKeyFor('')).toBeNull();
  });

  it('refuses an id past watchparty\'s 40-character bound', () => {
    expect(roomKeyFor('a'.repeat(40))).toBe(`cardtable-${'a'.repeat(40)}`);
    expect(roomKeyFor('a'.repeat(41))).toBeNull();
  });
});

/*
 * The runtime half of w22 §G. The compile-time half is `watchpartyTheme`'s
 * `Theme` return type, with no `| undefined`: a re-added `?? undefined` body
 * stops typechecking. But `Theme` is erased at runtime, so nothing in the types
 * says the function does not *also* drop the value some other way — a re-added
 * `THEMES.includes(...)` filter that returned `'dark'` instead of `undefined`
 * would compile happily and reinstate the bug. These two assert the behaviour.
 *
 * Why the neighbouring `chrome/theme-agreement.test.ts` does not cover this:
 * it pins the page theme at `'light'`, which IS in `THEMES`, so the old filter
 * returned `'light'` too. That file is green either way and pins w20 §E, not
 * this.
 */
describe('a host theme outside the chrome union still reaches the chrome', () => {
  it('returns an unrecognised theme name rather than dropping it', () => {
    // The premise, asserted rather than assumed: this name really is outside
    // the union `watchpartyTheme` claims to return.
    expect(THEMES as readonly string[]).not.toContain(UNKNOWN_THEME);

    const passed = watchpartyTheme(UNKNOWN_THEME);

    expect(passed).toBe(UNKNOWN_THEME);
    // Named separately because `undefined` is the one value that cannot be
    // ignored downstream: it is what sends the chrome to its own `dark`.
    expect(passed).not.toBeUndefined();
    // And not silently substituted either — a filter that fell back to a
    // *valid* theme would satisfy the type and still be the bug.
    expect(THEMES as readonly string[]).not.toContain(passed);
  });

  it('renders the chrome with that name on data-theme, not its own dark default', async () => {
    render(
      createElement(RoomShell, {
        roomId: 'm-test',
        children: createElement('div', null, 'content'),
      }),
    );

    // whoami is a promise, so the chrome appears on a later tick.
    const roomChrome = await waitFor(() => screen.getByTestId('room-chrome'));

    expect(roomChrome.getAttribute('data-theme')).toBe(UNKNOWN_THEME);
    // Spelled out because `dark` is the specific wrong answer the shipped
    // chrome produces for a falsy prop, and the split-theme bug the operator
    // saw was exactly a `dark` chrome beside a light page.
    expect(roomChrome.getAttribute('data-theme')).not.toBe('dark');
  });
});
