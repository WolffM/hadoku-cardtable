// @vitest-environment jsdom
/*
 * The watchparty embed (D21), as far as a DOM without layout can prove it:
 * the binding, the in-memory route, the chromeless frame, the theme, and the
 * shadow-boundary helpers it relies on. The real bundle on a real page — the
 * styles, the fonts, the leak counts, a match — is `e2e/embed.spec.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';

import { toShadowSelector, withHostTheme } from '../../vite.embed.config.ts';
import { eventTarget, hitAt, scopeOf } from '../dom.ts';
import { watchpartyPrefsCacheKey } from '../room/avatar.ts';
import { AVATAR_POLL_MS } from '../room/avatarWatch.ts';
import type { RoomBindClient, RoomIdentityClient, RoomOutcome, RoomView } from '../rooms/api.ts';
import { appLocation, navigate, routeInMemory } from '../screens/route.ts';
import type { GameBundleContext } from './contract.ts';
import { EmbedApp } from './EmbedApp.tsx';

globalThis.Element.prototype.scrollTo ??= function scrollTo() {};

// The fleet's identity, as the edge answers it: NOT the `u` the host context
// carries, so an avatar asserted under `u-test` proves which path it came by.
vi.mock('@wolffm/prefs-client', () => ({
  whoami: () => Promise.resolve({ userId: 'u-test', userType: 'friend' as const, name: 'Test Friend' }),
  // A client with nothing saved: the embed reads the UI scale from it on mount.
  createPrefsClient: () => ({ read: () => Promise.resolve({}), subscribe: () => () => undefined, save: () => Promise.resolve() }),
}));

const ROOM: RoomView = {
  id: 'wp-0123456789abcdef0123',
  name: 'Watchparty table',
  creator: 'fk:alice',
  leader: 'fk:alice',
  gameType: 'constructed-1v1',
  format: 'unavailable',
  settings: { handSmoothing: true, matchLength: 'bo1', sideboarding: false },
  mode: null,
  modeOptions: null,
  you: { id: 'http-a', leader: true, ready: false },
  clientMode: 'builtin',
  locked: false,
  members: [],
  matchId: null,
  draftStartedAt: null,
  createdAt: '',
  tables: [],
  pod: null,
};

function ctx(over: Partial<GameBundleContext> = {}): GameBundleContext {
  return {
    roomKey: 'movie-night',
    identity: { userId: 'u', userType: 'friend', name: null },
    theme: 'ocean-dark',
    isLeader: false,
    close: () => undefined,
    ...over,
  };
}

function binder(outcome: RoomOutcome = { ok: true, room: ROOM }): RoomBindClient & RoomIdentityClient & { asked: string[]; worn: [string, string | null][] } {
  const asked: string[] = [];
  const worn: [string, string | null][] = [];
  return {
    asked,
    worn,
    bindWatchparty: (room) => {
      asked.push(room);
      return Promise.resolve(outcome);
    },
    setAvatar: (roomId, avatarId) => {
      worn.push([roomId, avatarId]);
      return Promise.resolve({ ok: true, room: ROOM });
    },
  };
}

let releaseRoute: () => void = () => undefined;

beforeEach(() => {
  globalThis.location.hash = '#/host-route';
  releaseRoute = routeInMemory({ kind: 'lobby' });
  // The room screen behind the binding asks the server things; nobody answers here.
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } }))));
});

afterEach(() => {
  cleanup();
  releaseRoute();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  globalThis.localStorage.clear();
});

describe('EmbedApp', () => {
  it('binds the watchparty room, lands on its table, and never touches the page’s hash', async () => {
    const rooms = binder();
    render(createElement(EmbedApp, { ctx: ctx(), rooms }));
    const frame = screen.getByTestId('cardtable-embed');
    await waitFor(() => expect(frame.getAttribute('data-bound-room')).toBe(ROOM.id));
    expect(rooms.asked).toEqual(['movie-night']);
    await waitFor(() => expect(screen.getByTestId('constructed')).toBeTruthy());
    expect(globalThis.location.hash).toBe('#/host-route');
    expect(document.querySelector('.app-header')).toBeNull();
  });

  it('sends a route that is not a table back to the bound one', async () => {
    render(createElement(EmbedApp, { ctx: ctx(), rooms: binder() }));
    await waitFor(() => expect(screen.getByTestId('constructed')).toBeTruthy());
    act(() => navigate({ kind: 'lobby' }));
    await waitFor(() => expect(screen.getByTestId('constructed')).toBeTruthy());
    expect(screen.queryByTestId('rooms')).toBeNull();
  });

  it('sends the stats route back to the bound room, with no lobby under it', async () => {
    render(createElement(EmbedApp, { ctx: ctx(), rooms: binder() }));
    await waitFor(() => expect(screen.getByTestId('constructed')).toBeTruthy());
    act(() => navigate({ kind: 'stats', player: 'bob' }));
    await waitFor(() => expect(screen.getByTestId('constructed')).toBeTruthy());
    expect(screen.queryByTestId('lobby')).toBeNull();
    expect(screen.queryByTestId('rooms')).toBeNull();
    expect(screen.queryByTestId('stats')).toBeNull();
  });

  /*
   * The hop a watchparty member's character takes onto their row in OUR room
   * (`room/avatarAssert.ts`). The standalone app mounts it in `RoomShell`; the
   * embed renders no shell, and until 2026-10-12 asserted nothing — so every
   * member of a watchparty room wore the pool's pick ("it assigned default ones").
   */
  it('tells the bound room which watchparty character the viewer wears, under the edge’s identity', async () => {
    globalThis.localStorage.setItem(watchpartyPrefsCacheKey('u-test'), JSON.stringify({ blob: { sprite: 'wanderer' }, userVersion: 1, deviceVersion: 0 }));
    const rooms = binder();
    render(createElement(EmbedApp, { ctx: ctx(), rooms }));
    await waitFor(() => expect(rooms.worn).toEqual([[ROOM.id, 'wanderer']]));
  });

  it('says nothing about an avatar while the viewer has none saved, and the pick made later in watchparty’s chrome', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const rooms = binder();
    render(createElement(EmbedApp, { ctx: ctx(), rooms }));
    await waitFor(() => expect(screen.getByTestId('constructed')).toBeTruthy());
    // The watcher is polling once it is installed; a tick with no row sends nothing.
    globalThis.localStorage.setItem(watchpartyPrefsCacheKey('u-test'), JSON.stringify({ blob: { sprite: 'rogue' }, userVersion: 1, deviceVersion: 0 }));
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(AVATAR_POLL_MS);
      expect(rooms.worn).toEqual([[ROOM.id, 'rogue']]);
    });
  });

  it('says why when the table cannot be opened', async () => {
    render(createElement(EmbedApp, { ctx: ctx(), rooms: binder({ ok: false, message: 'Could not open this room’s table: nope.' }) }));
    await waitFor(() => expect(screen.getByTestId('embed-error').textContent).toContain('nope'));
  });

  it('wears the context’s theme, and follows it', async () => {
    const view = render(createElement(EmbedApp, { ctx: ctx(), rooms: binder() }));
    const frame = screen.getByTestId('cardtable-embed');
    expect(frame.getAttribute('data-theme')).toBe('ocean-dark');
    expect(frame.getAttribute('data-dark-theme')).toBe('true');
    view.rerender(createElement(EmbedApp, { ctx: ctx({ theme: 'light' }), rooms: binder() }));
    expect(frame.getAttribute('data-theme')).toBe('light');
    expect(frame.getAttribute('data-dark-theme')).toBe('false');
    await waitFor(() => expect(frame.getAttribute('data-bound-room')).toBe(ROOM.id));
  });
});

describe('routeInMemory', () => {
  it('builds invite links on the standalone app, not on the host page', () => {
    expect(appLocation()).toEqual({ origin: globalThis.location.origin, pathname: import.meta.env.BASE_URL });
  });

  it('gives the address bar back', () => {
    releaseRoute();
    navigate({ kind: 'stats' });
    expect(globalThis.location.hash).toBe('#/stats');
  });
});

describe('across a shadow boundary', () => {
  it('reads the real target off the composed path, where window only sees the host', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const button = document.createElement('button');
    shadow.append(button);
    const seen: { target: EventTarget | null; real: EventTarget | null }[] = [];
    const listener = (event: Event): void => {
      seen.push({ target: event.target, real: eventTarget(event) });
    };
    window.addEventListener('click', listener);
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    window.removeEventListener('click', listener);
    host.remove();
    expect(seen).toEqual([{ target: host, real: button }]);
    expect(scopeOf(button)).toBe(shadow);
  });

  it('answers no hit where there is no layout', () => {
    expect(hitAt(document, 1, 1)).toBeNull();
  });
});

describe('the embed stylesheet’s selectors', () => {
  it('turns the document roots into the shadow host and leaves look-alikes alone', () => {
    expect(toShadowSelector(':root')).toBe(':host');
    expect(toShadowSelector(':root, [data-theme]')).toBe(':host, [data-theme]');
    expect(toShadowSelector('body')).toBe(':host');
    expect(toShadowSelector('body > .x')).toBe(':host > .x');
    expect(toShadowSelector('.prompt__body')).toBe('.prompt__body');
    expect(toShadowSelector('.body-row, tbody')).toBe('.body-row, tbody');
  });

  it('lets every bare theme selector theme the host too, once', () => {
    expect(withHostTheme(['[data-theme=dark]'])).toEqual(['[data-theme=dark]', ':host([data-theme=dark])']);
    expect(withHostTheme([':host', '[data-theme]', '.cardtable-chrome'])).toEqual([':host', '[data-theme]', ':host([data-theme])', '.cardtable-chrome']);
    expect(withHostTheme(['[data-theme=dark] .x', '.a[data-theme=dark]'])).toEqual(['[data-theme=dark] .x', '.a[data-theme=dark]']);
    const once = withHostTheme(['[data-theme=light]']);
    expect(withHostTheme(once), 'postcss revisits a changed rule').toEqual(once);
  });
});
