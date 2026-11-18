// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

const { asked } = vi.hoisted(() => ({ asked: { count: 0 } }));

vi.mock('@wolffm/prefs-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@wolffm/prefs-client')>()),
  whoami: () => {
    asked.count += 1;
    return Promise.resolve({ userId: 'u-1', userType: 'member' as const, verified: true, name: 'Pat' });
  },
}));
vi.mock('@wolffm/task-ui-components', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@wolffm/task-ui-components')>()),
  AppHeader: ({ title, settingsProps }: { title: string; settingsProps?: { userType: string; name: string | null } }) =>
    createElement('header', { 'data-testid': 'header', 'data-settings': JSON.stringify(settingsProps ?? null) }, title),
}));
vi.mock('@wolffm/themes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@wolffm/themes')>()),
  usePlatform: () => ({ narrow: true, touchFirst: false }),
}));

import { GameAppShell, GameHeader } from './GameAppShell.tsx';
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
    expect(asked.count, 'the header and the reader asked nothing of their own').toBe(1);
  });

  it('reads the tier as the fleet answered it, unless the game registers its own reading', async () => {
    registerWhoamiTier(tierOfWhoami);
    render(createElement(GameAppShell, { className: 'c', children: () => createElement(GameHeader, { title: 'Game' }) }));
    await waitFor(() => expect(JSON.parse(screen.getByTestId('header').dataset.settings!)).toEqual({ userType: 'friend', name: 'Pat' }));
  });
});
