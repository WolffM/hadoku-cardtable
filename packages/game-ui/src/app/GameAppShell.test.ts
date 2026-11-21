// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';

const { asked } = vi.hoisted(() => ({ asked: { count: 0 } }));

vi.mock('@wolffm/prefs-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@wolffm/prefs-client')>()),
  whoami: () => {
    asked.count += 1;
    return Promise.resolve({ userId: 'u-1', userType: 'member' as const, name: 'Pat' });
  },
}));
vi.mock('@wolffm/task-ui-components', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@wolffm/task-ui-components')>()),
  AppHeader: ({ title, settingsProps, children, appTabs }: { title: string; settingsProps?: { userType: string; name: string | null }; children?: unknown; appTabs?: { id: string; render: () => unknown }[] }) =>
    createElement(
      'header',
      { 'data-testid': 'header', 'data-settings': JSON.stringify(settingsProps ?? null), 'data-app-tab': children ? 'yes' : 'no' },
      title,
      // Each tab's content, so a test can see what a tab holds.
      appTabs?.map((t) => createElement('section', { key: t.id, 'data-testid': `tab-${t.id}` }, t.render() as never)),
    ),
}));
vi.mock('@wolffm/themes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@wolffm/themes')>()),
  usePlatform: () => ({ narrow: true, touchFirst: false }),
}));

import { GameAppShell, GameHeader, SOUND_TAB_ID } from './GameAppShell.tsx';
import { registerWhoamiTier, tierOfWhoami, useWhoami } from '../room/whoami.ts';

globalThis.matchMedia ??= (() => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof matchMedia;

afterEach(() => {
  cleanup();
  asked.count = 0;
});

function Reader() {
  const who = useWhoami();
  return createElement('p', { 'data-testid': 'reader' }, who === 'pending' || who === null ? 'nobody' : who.name);
}

describe('GameAppShell', () => {
  it('frames the page once: the game’s class, the platform’s attributes, one whoami for everyone below', async () => {
    render(
      createElement(GameAppShell, {
        className: 'game-container',
        children: ({ who, narrow }) => [
          createElement(GameHeader, { key: 'h', title: 'Game' }),
          createElement('p', { key: 'n', 'data-testid': 'narrow' }, `${narrow} ${who?.name ?? '-'}`),
          createElement(Reader, { key: 'r' }),
        ],
      }),
    );
    await waitFor(() => expect(screen.getByTestId('narrow').textContent).toBe('true Pat'));
    const main = document.querySelector('main')!;
    expect(main.className).toBe('game-container');
    expect(main.hasAttribute('data-narrow')).toBe(true);
    expect(main.hasAttribute('data-touch-first')).toBe(false);
    expect(main.dataset.darkTheme).toMatch(/^(true|false)$/);
    expect(screen.getByTestId('reader').textContent).toBe('Pat');
    expect(JSON.parse(screen.getByTestId('header').dataset.settings!)).toEqual({ userType: 'member', name: 'Pat' });
    expect(screen.getByTestId('header').dataset.appTab, 'the room chat\'s sound switch is in the App tab').toBe('yes');
    expect(asked.count, 'the header and the reader asked nothing of their own').toBe(1);
  });

  it('puts the room chat\'s sound switch in the game\'s Sound tab when it has one, and then draws no App tab', async () => {
    const tabs = [
      { id: 'game', label: 'Game', render: () => createElement('p', null, 'game') },
      { id: SOUND_TAB_ID, label: 'Sound', render: () => createElement('p', { 'data-testid': 'game-sound' }, 'sound') },
    ];
    render(createElement(GameAppShell, { className: 'c', children: () => createElement(GameHeader, { title: 'Game', appTabs: tabs }) }));
    await waitFor(() => expect(screen.getByTestId('header').dataset.appTab).toBe('no'));
    expect(screen.getByTestId('tab-sound').querySelector('[data-testid="game-sound"]'), 'the game\'s own sound settings stay').not.toBeNull();
    await waitFor(() => expect(within(screen.getByTestId('tab-sound')).getByRole('radiogroup', { name: 'Chat sound' })).toBeTruthy());
    expect(within(screen.getByTestId('tab-game')).queryByRole('radiogroup', { name: 'Chat sound' })).toBeNull();
  });

  it('reads the tier as the fleet answered it, unless the game registers its own reading', async () => {
    registerWhoamiTier(tierOfWhoami);
    render(createElement(GameAppShell, { className: 'c', children: () => createElement(GameHeader, { title: 'Game' }) }));
    await waitFor(() => expect(JSON.parse(screen.getByTestId('header').dataset.settings!)).toEqual({ userType: 'friend', name: 'Pat' }));
  });
});
