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
}));

import { App } from '../App.tsx';
import { AppHeader } from '@wolffm/task-ui-components';
import { AppChrome } from './AppChrome.tsx';
import { HeaderSettingsPortal } from './HeaderSettings.tsx';

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

/*
 * Wave 32 Q15 — the gear's popout has a slot a screen can draw its own settings
 * into, and `App.tsx` did not have to author it.
 */
describe('the header gear carries a screen’s own settings', () => {
  it('slots a host into the popout, which exists only while the gear is open', () => {
    render(createElement(App));
    expect(screen.queryByTestId('header-app-settings')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'User settings' }));
    const host = screen.getByTestId('header-app-settings');
    expect(host.closest('.settings-popout__panel'), 'inside the fleet’s own popout').not.toBeNull();
  });

  it('draws a screen’s portal into the popout while open, and nothing while closed', () => {
    // The portal is rendered from a child of the chrome, exactly as `LiveBoard`
    // does it, under a header authored outside the chrome as `App` does.
    render(
      createElement(
        AppChrome,
        {
          header: createElement(AppHeader, { title: 'T', settingsProps: { userType: 'friend', name: 'Test' } }),
          children: createElement(HeaderSettingsPortal, null, createElement('p', { 'data-testid': 'probe' }, 'mine')),
        },
      ),
    );
    expect(screen.queryByTestId('probe')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'User settings' }));
    expect(screen.getByTestId('header-app-settings').contains(screen.getByTestId('probe'))).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'User settings' }));
    expect(screen.queryByTestId('probe')).toBeNull();
  });
});
