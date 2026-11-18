// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';

import { bindWatchpartyRoom, hostThemeValue, isDarkThemeName, ToRoom, useBoundRoom, type BindRoom } from './bound-room.tsx';

afterEach(cleanup);

const answering = (status: number, body: unknown) => {
  const asked: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (url: string, init?: RequestInit) => {
    asked.push({ url, ...(init === undefined ? {} : { init }) });
    return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  };
  return { asked, bind: bindWatchpartyRoom(fetchImpl) };
};

describe('bindWatchpartyRoom', () => {
  it('asks the game’s own server, same-origin, with the host’s room id', async () => {
    const { asked, bind } = answering(200, { id: 'wp-0123', name: 'x' });
    expect(await bind('movie-night')).toEqual({ ok: true, roomId: 'wp-0123' });
    expect(asked[0]!.url).toMatch(/api\/rooms\/watchparty$/);
    expect(asked[0]!.init?.method).toBe('POST');
    expect(asked[0]!.init?.credentials).toBe('same-origin');
    expect(JSON.parse(String(asked[0]!.init?.body))).toEqual({ room: 'movie-night' });
  });

  it('says why on a refusal, a bad answer, and no server at all — never throws', async () => {
    expect(await answering(403, { error: 'members only' }).bind('r')).toEqual({ ok: false, message: 'Could not open this room’s table: members only.' });
    expect(await answering(200, { id: 'NOT A ROOM' }).bind('r')).toMatchObject({ ok: false });
    const down = bindWatchpartyRoom(() => Promise.reject(new Error('offline')));
    expect(await down('r')).toEqual({ ok: false, message: 'Could not reach the server.' });
  });
});

function Probe({ bind, skip, hostRoom = 'h' }: { bind: BindRoom; skip?: boolean; hostRoom?: string }) {
  const binding = useBoundRoom(hostRoom, bind, skip);
  return createElement('p', { 'data-testid': 'b' }, binding.state === 'bound' ? `bound ${binding.roomId}` : binding.state === 'failed' ? `failed ${binding.message}` : 'binding');
}

describe('useBoundRoom', () => {
  it('binds, and says when it could not', async () => {
    render(createElement(Probe, { bind: () => Promise.resolve({ ok: true as const, roomId: 'r-1' }) }));
    expect(screen.getByTestId('b').textContent).toBe('binding');
    await waitFor(() => expect(screen.getByTestId('b').textContent).toBe('bound r-1'));
    cleanup();
    render(createElement(Probe, { bind: () => Promise.resolve({ ok: false as const, message: 'nope' }) }));
    await waitFor(() => expect(screen.getByTestId('b').textContent).toBe('failed nope'));
  });

  it('with skip, is the host’s room at once and asks nothing', () => {
    const asked: string[] = [];
    render(createElement(Probe, { hostRoom: 'r-host', skip: true, bind: (r) => (asked.push(r), Promise.resolve({ ok: true as const, roomId: 'x' })) }));
    expect(screen.getByTestId('b').textContent).toBe('bound r-host');
    expect(asked).toEqual([]);
  });
});

describe('ToRoom and the host’s theme', () => {
  it('goes to the bound room from an effect', () => {
    const went: string[] = [];
    const go = (id: string) => void went.push(id);
    render(createElement(ToRoom, { roomId: 'r-9', go }));
    expect(went).toEqual(['r-9']);
  });

  it('reads a dark theme from its name, and makes an inert context of it', () => {
    expect(isDarkThemeName('dark')).toBe(true);
    expect(isDarkThemeName('ocean-dark')).toBe(true);
    expect(isDarkThemeName('light')).toBe(false);
    const value = hostThemeValue('ocean-dark');
    expect(value).toMatchObject({ theme: 'ocean-dark', isDarkTheme: true, isThemeReady: true, isInitialThemeLoad: false });
    expect(() => value.setTheme('light')).not.toThrow();
  });
});
