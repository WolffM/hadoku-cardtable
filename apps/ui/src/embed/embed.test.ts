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

import { toShadowSelector } from '../../vite.embed.config.ts';
import { eventTarget, hitAt, scopeOf } from '../dom.ts';
import type { RoomBindClient, RoomOutcome, RoomView } from '../rooms/api.ts';
import { appLocation, navigate, routeInMemory } from '../screens/route.ts';
import type { GameBundleContext } from './contract.ts';
import { EmbedApp } from './EmbedApp.tsx';

globalThis.Element.prototype.scrollTo ??= function scrollTo() {};

const ROOM: RoomView = {
  id: 'wp-0123456789abcdef0123',
  name: 'Watchparty table',
  creator: 'fk:alice',
  leader: 'fk:alice',
  gameType: 'constructed-1v1',
  format: 'unavailable',
  you: { leader: true, ready: false },
  clientMode: 'builtin',
  locked: false,
  members: [],
  matchId: null,
  draftStartedAt: null,
  createdAt: '',
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

function binder(outcome: RoomOutcome = { ok: true, room: ROOM }): RoomBindClient & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    bindWatchparty: (room) => {
      asked.push(room);
      return Promise.resolve(outcome);
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
});
