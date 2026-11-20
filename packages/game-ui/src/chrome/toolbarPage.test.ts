// @vitest-environment jsdom
/* The page with no top bar: who decides it, when, and that its links are the top bar's own. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement, Fragment, type ReactNode } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

interface Toolbar {
  onHome?: () => void;
  settings?: unknown;
  extra?: readonly { id: string; label: string; href?: string; icon: ReactNode }[];
}
const { seen } = vi.hoisted(() => ({ seen: { toolbars: [] as (Toolbar | undefined)[] } }));

vi.mock('@wolffm/prefs-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@wolffm/prefs-client')>()),
  whoami: () => Promise.resolve({ userId: 'u-1', userType: 'member' as const, name: 'Pat' }),
}));
vi.mock('@wolffm/watchparty-ui/room-chrome.css', () => ({}));
vi.mock('@wolffm/watchparty-ui/room-chrome', () => ({
  RoomChrome: ({ toolbar, children }: { toolbar?: Toolbar; children: ReactNode }) => {
    seen.toolbars.push(toolbar);
    return createElement('div', { 'data-testid': 'room-chrome', 'data-toolbar': toolbar === undefined ? undefined : '' }, children);
  },
}));
vi.mock('@wolffm/themes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@wolffm/themes')>()),
  useHadokuTheme: () => ({ theme: 'light' }),
}));

import { configureShell } from '@hadoku/ui-shell/app-id';
import { RoomShell } from '../room/RoomShell.tsx';
import { currentRoute, navigate, type Route } from '../screens/route.ts';
import { HeaderLinks, PAGE_LINKS } from './HeaderLinks.tsx';
import { PAGE_TOOLBAR, toolbarPageOn, toolbarRoute, TopBar, useToolbarPage } from './toolbarPage.tsx';

configureShell({ appId: 'game' });

afterEach(() => {
  cleanup();
  seen.toolbars.length = 0;
});

function Screen({ on }: { on: boolean }) {
  useToolbarPage(on);
  return createElement('p', { 'data-testid': 'screen' });
}

const page = (roomId: string | null, screenNode: ReactNode, pending = false) =>
  createElement(
    Fragment,
    null,
    createElement(TopBar, null, createElement('header', { 'data-testid': 'top-bar' })),
    createElement(RoomShell, { roomId, toolbar: PAGE_TOOLBAR, pending, children: screenNode }),
  );

describe('the routes with no top bar', () => {
  it('are the game, a table’s full-screen step and the deck builder', () => {
    expect(toolbarRoute({ kind: 'match', matchId: 'm-1' })).toBe(true);
    expect(toolbarRoute({ kind: 'deck', draftId: 'r-1' })).toBe(true);
    expect(toolbarRoute({ kind: 'room', roomId: 'r-1', tableId: 't-1', step: 'sideboard' })).toBe(true);
  });

  it('are not the front page, a room, its table page, a saved deck, a replay or the tools', () => {
    const kept: Route[] = [
      { kind: 'lobby' },
      { kind: 'room', roomId: 'r-1' },
      { kind: 'room', roomId: 'r-1', tableId: 't-1' },
      { kind: 'decks' },
      { kind: 'decks', draftId: 'd-1' },
      { kind: 'replay', matchId: 'm-1' },
      { kind: 'play' },
      { kind: 'stats' },
      { kind: 'inventory' },
      { kind: 'sounds' },
    ];
    for (const route of kept) expect(toolbarRoute(route), JSON.stringify(route)).toBe(false);
  });
});

describe('a toolbar page', () => {
  it('needs a screen that asked and a chat to carry the toolbar', () => {
    expect(toolbarPageOn(0, false)).toBe(false);
    expect(toolbarPageOn(1, false)).toBe(true);
    expect(toolbarPageOn(2, false)).toBe(true);
    expect(toolbarPageOn(1, true)).toBe(false);
  });

  it('draws no top bar and hands the chat the toolbar, for as long as the screen that asked is drawn', async () => {
    const view = render(page('r-1', createElement(Screen, { on: true })));
    await waitFor(() => expect(screen.getByTestId('room-chrome').dataset.toolbar).toBe(''));
    expect(screen.queryByTestId('top-bar')).toBeNull();
    expect(seen.toolbars.at(-1)).toBe(PAGE_TOOLBAR);

    view.rerender(page('r-1', createElement(Screen, { on: false })));
    expect(screen.getByTestId('top-bar')).toBeTruthy();
    expect(screen.getByTestId('room-chrome').dataset.toolbar).toBeUndefined();

    view.rerender(page('r-1', createElement(Screen, { on: true })));
    expect(screen.queryByTestId('top-bar')).toBeNull();
    view.rerender(page('r-1', null));
    expect(screen.getByTestId('top-bar')).toBeTruthy();
  });

  it('is decided before the frame is shown: no render is committed with both, or with the bar after the screen asked', async () => {
    const view = render(page('r-1', null));
    await waitFor(() => expect(screen.getByTestId('room-chrome')).toBeTruthy());
    // `rerender` returns once React has committed and run layout effects, with nothing awaited.
    view.rerender(page('r-1', createElement(Screen, { on: true })));
    expect(screen.queryByTestId('top-bar')).toBeNull();
    expect(screen.getByTestId('room-chrome').dataset.toolbar).toBe('');
  });

  it('keeps the top bar where no chat can draw', async () => {
    render(page(null, createElement(Screen, { on: true })));
    expect(screen.getByTestId('screen')).toBeTruthy();
    expect(screen.getByTestId('top-bar')).toBeTruthy();
    expect(screen.queryByTestId('room-chrome')).toBeNull();
  });

  it('draws no top bar while the page is still asking which room it is in', async () => {
    const view = render(page(null, createElement(Screen, { on: true }), true));
    expect(screen.queryByTestId('top-bar')).toBeNull();
    // Answered: no room after all, so no chat, and the bar is the way to its controls.
    view.rerender(page(null, createElement(Screen, { on: true })));
    expect(screen.getByTestId('top-bar')).toBeTruthy();
  });

  it('leaves a page whose screen never asked exactly as it was', async () => {
    render(page('r-1', createElement(Screen, { on: false })));
    await waitFor(() => expect(screen.getByTestId('room-chrome')).toBeTruthy());
    expect(screen.getByTestId('top-bar')).toBeTruthy();
    expect(seen.toolbars.every((toolbar) => toolbar === undefined)).toBe(true);
  });
});

describe('what the toolbar carries', () => {
  it('is the top bar’s own links, from the one list', () => {
    expect(PAGE_TOOLBAR.extra).toBe(PAGE_LINKS);
    render(createElement(HeaderLinks));
    const drawn = screen.getAllByRole('link').map((a) => [a.getAttribute('aria-label'), a.getAttribute('href')]);
    expect(drawn).toEqual(PAGE_LINKS.map((link) => [link.label, link.href]));
    expect(drawn.map(([label]) => label)).toEqual(['Discord', 'GitHub']);
  });

  it('goes home as the top bar’s title does, and offers the settings with the game’s own section', () => {
    navigate({ kind: 'room', roomId: 'r-1' });
    PAGE_TOOLBAR.onHome?.();
    expect(currentRoute()).toEqual({ kind: 'lobby' });
    expect(typeof PAGE_TOOLBAR.settings).toBe('object');
    expect(PAGE_TOOLBAR.theme).toBeUndefined();
  });
});
