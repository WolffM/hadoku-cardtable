// @vitest-environment jsdom
import { UsageBatchSchema, type UsageBatch } from '@hadoku/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { screenOf, startUsage, targetName } from './usage.ts';

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

describe('screenOf', () => {
  it('names a screen by its route, and a room table apart from its room', () => {
    expect(screenOf('')).toBe('lobby');
    expect(screenOf('#/room/r-1a2b3c')).toBe('room');
    expect(screenOf('#/room/r-1a2b3c/table/t-9')).toBe('room/table');
    expect(screenOf('#/match/m-1')).toBe('match');
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

  it('counts views and named presses, and flushes a batch the server schema accepts when the page hides', () => {
    const sent: UsageBatch[] = [];
    stop = startUsage({ send: (_url, batch) => sent.push(batch) });
    document.body.innerHTML = '<button data-testid="seat-2"><span id="inner">Sit</span></button><p id="plain">text</p>';
    document.getElementById('inner')!.click();
    document.getElementById('plain')!.click();
    window.location.hash = '#/room/r-1a2b3c';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    window.dispatchEvent(new Event('pagehide'));

    expect(sent).toHaveLength(1);
    expect(sent[0].entries).toEqual([
      { kind: 'view', screen: 'lobby' },
      { kind: 'click', screen: 'lobby', target: 'seat' },
      { kind: 'view', screen: 'room' },
    ]);
    expect(UsageBatchSchema.safeParse(sent[0]).success).toBe(true);
  });
});
