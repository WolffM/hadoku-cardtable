// @vitest-environment jsdom
/*
 * The two things wave 21 §A promised about the header, driven rather than
 * described.
 *
 * 1. The title is the CATALOGUE's name for this app, not a literal in this
 *    repo. `__HADOKU_APP_NAME__` is a vite `define` filled from
 *    `@wolffm/catalogue` at config time (`app-name.ts`, mirrored in the root
 *    `vitest.config.ts` — without that mirror the constant is a bare
 *    ReferenceError and the header renders NOTHING, which surfaces as an
 *    unrelated-looking "unable to find element").
 * 2. It is a real LINK home. The operator, 2026-09-26: *"'Card Table' at the
 *    top should be clickable and bring you back to the entry page."* An
 *    `onClick` on a heading would satisfy a click and nothing else, so what is
 *    asserted is the anchor: queried BY ROLE, which is the same thing a
 *    keyboard or a screen reader resolves, and carrying `href="#/"`.
 *
 * `.test.ts`, not `.test.tsx`, and `createElement` instead of JSX — the root
 * vitest config globs `apps/*\/src/**\/*.test.ts` and a `.tsx` test is not
 * collected (`screens/lobby.test.ts` explains the same constraint). The
 * `@vitest-environment jsdom` pragma has to be line 1 or `environment` stays
 * `node` and every DOM call throws.
 *
 * This renders the REAL `App`, because the header is authored there — that is
 * the fleet's convention and the place its audit reads it
 * (`check-header-fleet.mjs`, `appHeaderTitle`). A test that mounted `AppChrome`
 * with a header of its own would prove nothing about what ships.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('@wolffm/prefs-client', () => ({
  whoami: () =>
    Promise.resolve({ userId: 'u-test', userType: 'friend' as const, name: 'Test Friend' }),
  // A client with nothing saved: the app connects its sound settings to it on mount.
  createPrefsClient: () => ({ read: () => Promise.resolve({}), subscribe: () => () => undefined, save: () => Promise.resolve() }),
}));
// The gear's game section reads the saved preferences; nothing here is about them.
vi.mock('@wolffm/prefs-client/react', () => ({
  usePrefs: () => ({ prefs: null, save: () => Promise.resolve(), loading: false, error: null }),
}));

import { App } from '../App.tsx';
import { DISCORD_INVITE_URL, GITHUB_REPO_URL } from './HeaderLinks.tsx';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the standard child-app header', () => {
  it('titles the app from the catalogue, not from a literal in this repo', () => {
    render(createElement(App));

    // The fallback `?? APP_ID` in `app-name.ts` is a lowercase id, visibly
    // wrong on purpose — a catalogue release that does not know this app yet.
    // If that is what we are rendering, the name is not coming from the
    // catalogue and this test has to say so rather than pass on a string match.
    expect(__HADOKU_APP_NAME__).not.toBe('cardtable');

    const title = screen.getByRole('link', { name: __HADOKU_APP_NAME__ });
    expect(title.textContent).toBe(__HADOKU_APP_NAME__);

    // Inside the fleet header's own title box, which is what `AppHeader` wraps a
    // node title in — so this is the header's title and not some other link
    // that happens to read the same.
    expect(title.closest('.app-header__title')).not.toBeNull();
  });

  it('makes the title a real link to the entry page', () => {
    render(createElement(App));

    const title = screen.getByRole('link', { name: __HADOKU_APP_NAME__ });
    expect(title.tagName).toBe('A');
    expect(title.getAttribute('href')).toBe('#/');

    // The heading stays INSIDE the link — the shape `AppHeader`'s node title is
    // documented for, and what keeps the page with an <h1> at all.
    expect(title.querySelector('h1')?.textContent).toBe(__HADOKU_APP_NAME__);
  });
});

describe('the Discord link', () => {
  it('sits in the header actions, before the theme picker, and opens the invite in a new tab', () => {
    render(createElement(App));

    const link = screen.getByRole('link', { name: 'Discord' });
    expect(link.getAttribute('href')).toBe(DISCORD_INVITE_URL);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    const actions = link.closest('.app-header__actions');
    expect(actions?.firstElementChild).toBe(link);
  });
});

describe('the GitHub link', () => {
  it('sits right after the Discord link and opens the repo in a new tab', () => {
    render(createElement(App));

    const link = screen.getByRole('link', { name: 'GitHub' });
    expect(link.getAttribute('href')).toBe(GITHUB_REPO_URL);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(link.previousElementSibling).toBe(screen.getByRole('link', { name: 'Discord' }));
  });
});

/*
 * 2026-10-10: the operator moved the game's settings out of the header — a
 * host's settings menu is not ours to fill. The fleet's gear holds the fleet's
 * settings; cardtable's are behind its own gear.
 */
describe('the game’s settings are its own, not the header’s', () => {
  it('leaves the fleet’s popout alone and opens its own from the corner gear', () => {
    render(createElement(App));
    fireEvent.click(screen.getByRole('button', { name: 'User settings' }));
    const popout = document.querySelector('.settings-popout__panel');
    expect(popout, 'the fleet’s popout opened').not.toBeNull();
    expect(popout!.querySelector('[data-testid="settings-sound"]')).toBeNull();

    fireEvent.click(screen.getByTestId('settings-gear'));
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    expect(dialog.querySelector('[data-testid="settings-sound"]')).not.toBeNull();
    expect(dialog.querySelector('[data-testid="live-settings-panel"]'), 'the game section, outside a match too').not.toBeNull();
  });
});
