// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { startUsage, targetName, type UsageBatch } from './index.ts';

describe('targetName', () => {
  it.each([
    ['room-card', 'room-card'],
    ['seat-3', 'seat'],
    ['room-card-r-1a2b3c4d', 'room-card'],
    ['table-m-9f8e7d6c5b-concede', 'table-concede'],
    ['deck-0f8fad5b-d9cb-469f-a165-70867728950e-open', 'deck-open'],
    ['Lobby.NewRoom', 'lobby.newroom'],
    ['pick-12', 'pick'],
  ])('%s → %s', (testid, name) => {
    expect(targetName(testid)).toBe(name);
  });

  it('refuses what is left when it is not a name', () => {
    expect(targetName('42')).toBeNull();
    expect(targetName('a b')).toBeNull();
  });
});

describe('startUsage', () => {
  let stop: (() => void) | null = null;
  afterEach(() => {
    stop?.();
    stop = null;
    document.body.innerHTML = '';
    window.location.hash = '';
  });

  it('counts views and named presses by the caller’s own screenOf, stamped with the page clock, and posts to the caller’s own url', () => {
    const sent: { url: string; batch: UsageBatch }[] = [];
    let t = 1_000;
    const screenOf = ({ hash }: { pathname: string; hash: string }): string => (hash === '' ? 'lobby' : 'room');
    stop = startUsage({ url: '/game/api/usage', screenOf, batchMax: 200, now: () => t, send: (url, batch) => sent.push({ url, batch }) });
    document.body.innerHTML = '<button data-testid="seat-2"><span id="inner">Sit</span></button><p id="plain">text</p>';
    t = 2_000;
    document.getElementById('inner')!.click();
    document.getElementById('plain')!.click();
    t = 3_000;
    window.location.hash = '#/room/r-1';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    t = 4_000;
    window.dispatchEvent(new Event('pagehide'));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('/game/api/usage');
    expect(sent[0]!.batch).toEqual({
      sentAt: 4_000,
      entries: [
        { kind: 'view', screen: 'lobby', at: 1_000 },
        { kind: 'click', screen: 'lobby', target: 'seat', at: 2_000 },
        { kind: 'view', screen: 'room', at: 3_000 },
      ],
    });
  });

  it('reads the screen from the path too: a pushState route counts the press on the screen it was made on, and opens its new screen right after', () => {
    const sent: UsageBatch[] = [];
    const screenOf = ({ pathname }: { pathname: string; hash: string }): string => (pathname.startsWith('/room/') ? 'room' : 'lobby');
    history.replaceState(null, '', '/');
    stop = startUsage({ url: '/x', screenOf, batchMax: 200, send: (_url, batch) => sent.push(batch) });
    document.body.innerHTML = '<button data-testid="room-enter"></button><button data-testid="pick-3"></button>';
    const enter = document.querySelector('[data-testid="room-enter"]')!;
    enter.addEventListener('click', () => history.pushState(null, '', '/room/r-1'));
    enter.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    document.querySelector('[data-testid="pick-3"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    // The browser's Back: the address changes, then `popstate`.
    history.replaceState(null, '', '/');
    window.dispatchEvent(new PopStateEvent('popstate'));
    window.dispatchEvent(new Event('pagehide'));
    expect(sent.flatMap((b) => b.entries).map(({ kind, screen, target }) => [kind, screen, target])).toEqual([
      ['view', 'lobby', undefined],
      ['click', 'lobby', 'room-enter'],
      ['view', 'room', undefined],
      ['click', 'room', 'pick'],
      ['view', 'lobby', undefined],
    ]);
    history.replaceState(null, '', '/');
  });

  it('opens the screen a press navigated to right after the press, with no further press or event', () => {
    vi.useFakeTimers();
    try {
      const sent: UsageBatch[] = [];
      history.replaceState(null, '', '/');
      stop = startUsage({ url: '/x', screenOf: ({ pathname }) => (pathname === '/' ? 'lobby' : 'room'), batchMax: 200, send: (_url, batch) => sent.push(batch) });
      document.body.innerHTML = '<button data-testid="room-enter"></button>';
      const enter = document.querySelector('[data-testid="room-enter"]')!;
      enter.addEventListener('click', () => history.pushState(null, '', '/room/r-1'));
      enter.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      vi.advanceTimersByTime(0);
      window.dispatchEvent(new Event('pagehide'));
      expect(sent.flatMap((b) => b.entries).map(({ kind, screen }) => `${kind} ${screen}`)).toEqual(['view lobby', 'click lobby', 'view room']);
      history.replaceState(null, '', '/');
    } finally {
      vi.useRealTimers();
    }
  });

  it('flushes early once a batch reaches batchMax', () => {
    const sent: UsageBatch[] = [];
    stop = startUsage({ url: '/x', screenOf: () => 'lobby', batchMax: 2, send: (_url, batch) => sent.push(batch) });
    document.body.innerHTML = '<button data-testid="go"></button>';
    document.querySelector('[data-testid="go"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    // One view at start + one click = 2, which is batchMax: an early flush already happened.
    expect(sent).toHaveLength(1);
    expect(sent[0]!.entries).toHaveLength(2);
  });
});
