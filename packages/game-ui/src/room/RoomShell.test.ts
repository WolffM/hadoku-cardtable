// @vitest-environment jsdom
/* RoomShell's options for a game other than cardtable: its fallback, its identified-viewer gate, its lazy chrome. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

const { viewer } = vi.hoisted(() => ({ viewer: { userId: 'u-1', answer: Promise.resolve() as Promise<void> } }));

vi.mock('@wolffm/prefs-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@wolffm/prefs-client')>()),
  whoami: async () => {
    await viewer.answer;
    return { userId: viewer.userId, userType: 'member' as const, name: 'Pat' };
  },
}));
vi.mock('@wolffm/watchparty-ui/room-chrome.css', () => ({}));
vi.mock('@wolffm/watchparty-ui/room-chrome', () => ({
  RoomChrome: ({ roomKey, children }: { roomKey: string; children: ReactNode }) =>
    createElement('div', { 'data-testid': 'room-chrome', 'data-key': roomKey }, createElement('div', { className: 'wp-room-chrome-frame__content' }, children)),
}));
vi.mock('@wolffm/themes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@wolffm/themes')>()),
  useHadokuTheme: () => ({ theme: 'light' }),
}));

import { ANON_USER_ID } from '@wolffm/prefs-client';
import { configureShell } from '@hadoku/ui-shell/app-id';
import { appOrigin, RoomShell } from './RoomShell.tsx';

configureShell({ appId: 'game' });

afterEach(() => {
  cleanup();
  viewer.userId = 'u-1';
  viewer.answer = Promise.resolve();
});

const content = createElement('p', { 'data-testid': 'content' }, 'the game');

describe('RoomShell for any game', () => {
  it('shows its fallback while it waits, then the content inside the chrome, keyed by the app', async () => {
    let answer!: () => void;
    viewer.answer = new Promise((resolve) => (answer = resolve));
    render(createElement(RoomShell, { roomId: 'r-1', fallback: createElement('p', { 'data-testid': 'cover' }), children: content }));
    expect(screen.getByTestId('cover')).toBeTruthy();
    expect(screen.queryByTestId('content')).toBeNull();
    answer();
    const chrome = await waitFor(() => screen.getByTestId('room-chrome'));
    expect(chrome.dataset.key).toBe('game-r-1');
    expect(chrome.contains(screen.getByTestId('content'))).toBe(true);
    expect(screen.queryByTestId('cover')).toBeNull();
  });

  it('draws no chrome for a viewer the fleet could not name, when asked not to', async () => {
    viewer.userId = ANON_USER_ID;
    render(createElement(RoomShell, { roomId: 'r-1', requireIdentified: true, children: content }));
    // The content shows only once whoami has answered (before, the room waits), and that answer is final.
    await waitFor(() => expect(screen.getByTestId('content')).toBeTruthy());
    expect(screen.queryByTestId('room-chrome')).toBeNull();
  });

  it('still draws it for that viewer by default', async () => {
    viewer.userId = ANON_USER_ID;
    render(createElement(RoomShell, { roomId: 'r-1', children: content }));
    await waitFor(() => expect(screen.getByTestId('room-chrome')).toBeTruthy());
  });

  it('takes no box of its own around the content, with no stylesheet loaded', async () => {
    render(createElement(RoomShell, { roomId: null, children: content }));
    const slots = [...document.querySelectorAll<HTMLElement>('.chrome-slot')];
    expect(slots.length).toBe(2);
    for (const slot of slots) expect(slot.style.display).toBe('contents');
  });

  it('is the app’s own origin under its base', () => {
    expect(appOrigin()).toBe(globalThis.location.origin);
  });
});
