// @vitest-environment jsdom
// jsdom, for React's hooks and `localStorage` (`./shape.ts` round-trips through it).
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';

import { HOLD_MS, usePartShown, useFrontGateState } from './gate.ts';
import { LobbyShell } from './LobbyShell.tsx';
import { FIRST_VISIT, MAX_ROOM_GHOSTS, loadFrontShape, parseFrontShape, saveFrontShape } from './shape.ts';

describe('the front page gate', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('stays shut until every part has settled, then opens at once', () => {
    const { result } = renderHook(() => useFrontGateState());
    for (const part of ['rooms', 'live', 'upcoming', 'wildcard'] as const) {
      act(() => result.current.settle(part));
      expect(result.current.revealed).toBe(false);
    }
    act(() => result.current.settle('trim'));
    expect(result.current.revealed).toBe(true);
  });

  it('opens after HOLD_MS with a part still waiting', () => {
    const { result } = renderHook(() => useFrontGateState());
    act(() => result.current.settle('rooms'));
    act(() => vi.advanceTimersByTime(HOLD_MS - 1));
    expect(result.current.revealed).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.revealed).toBe(true);
  });
});

/** A room list that has its answer: shown once the page lets it. */
function Rooms() {
  const shown = usePartShown('rooms', true);
  return createElement('p', { 'data-testid': 'rooms-shown' }, shown ? 'shown' : 'waiting');
}

describe('a front page with fewer parts', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  // Bomberman's front page draws the room list and the trim, and nothing else: before the gate took
  // a page's own parts it sat out the whole HOLD_MS on the three it never draws (measured on
  // production: the list drawn ~2 s after its data).
  it('opens as soon as the parts it declares have settled, without waiting out the hold', () => {
    const { result } = renderHook(() => useFrontGateState(HOLD_MS, ['rooms', 'trim']));
    act(() => result.current.settle('rooms'));
    expect(result.current.revealed).toBe(false);
    act(() => result.current.settle('trim'));
    expect(result.current.revealed).toBe(true);
  });

  it('LobbyShell hands its parts to the gate: a page of rooms alone shows once the rooms are in', () => {
    render(createElement(LobbyShell, { parts: ['rooms'], children: createElement(Rooms) }));
    expect(screen.getByTestId('rooms-shown').textContent).toBe('shown');
    expect(screen.getByRole('main').getAttribute('aria-busy')).toBe('false');
  });

  it('LobbyShell with no parts named still waits on every part, as cardtable’s page does', () => {
    render(createElement(LobbyShell, { children: createElement(Rooms) }));
    expect(screen.getByTestId('rooms-shown').textContent).toBe('waiting');
    act(() => vi.advanceTimersByTime(HOLD_MS));
    expect(screen.getByTestId('rooms-shown').textContent).toBe('shown');
  });
});

describe('the front page shape', () => {
  beforeEach(() => localStorage.clear());

  it('is the first visit’s until something is remembered, then what was remembered', () => {
    expect(loadFrontShape()).toEqual(FIRST_VISIT);
    saveFrontShape({ live: false, rooms: 4, events: 0 });
    expect(loadFrontShape()).toEqual({ live: false, rooms: 4, events: 0 });
  });

  it('remembers through the gate, field by field', () => {
    const { result } = renderHook(() => useFrontGateState());
    act(() => result.current.remember({ rooms: 2 }));
    act(() => result.current.remember({ live: false }));
    expect(loadFrontShape()).toEqual({ ...FIRST_VISIT, rooms: 2, live: false });
  });

  it('reads anything else as the first visit, and caps what it draws', () => {
    expect(parseFrontShape('not json')).toEqual(FIRST_VISIT);
    expect(parseFrontShape('null')).toEqual(FIRST_VISIT);
    expect(parseFrontShape(JSON.stringify({ live: 'yes', rooms: -1, events: 2.5 }))).toEqual(FIRST_VISIT);
    expect(parseFrontShape(JSON.stringify({ live: true, rooms: 400, events: 9 }))).toEqual({ live: true, rooms: MAX_ROOM_GHOSTS, events: 3 });
  });
});
