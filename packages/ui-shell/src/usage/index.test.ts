// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

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

  it('counts views and named presses by the caller’s own screenOf, and posts to the caller’s own url', () => {
    const sent: { url: string; batch: UsageBatch }[] = [];
    const screenOf = (hash: string): string => (hash === '' ? 'lobby' : 'room');
    stop = startUsage({ url: '/game/api/usage', screenOf, batchMax: 200, send: (url, batch) => sent.push({ url, batch }) });
    document.body.innerHTML = '<button data-testid="seat-2"><span id="inner">Sit</span></button><p id="plain">text</p>';
    document.getElementById('inner')!.click();
    document.getElementById('plain')!.click();
    window.location.hash = '#/room/r-1';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    window.dispatchEvent(new Event('pagehide'));

    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('/game/api/usage');
    expect(sent[0]!.batch.entries).toEqual([
      { kind: 'view', screen: 'lobby' },
      { kind: 'click', screen: 'lobby', target: 'seat' },
      { kind: 'view', screen: 'room' },
    ]);
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
