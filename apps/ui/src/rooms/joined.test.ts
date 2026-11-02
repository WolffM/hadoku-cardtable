// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

import { clearJoined, isJoined, markJoined, useJoined } from './joined.ts';

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

describe('isJoined / markJoined / clearJoined', () => {
  it('starts false for a room never marked', () => {
    expect(isJoined('r-1')).toBe(false);
  });

  it('marking a room makes it read joined, including after a fresh read (sessionStorage, not memory)', () => {
    markJoined('r-1');
    expect(isJoined('r-1')).toBe(true);
    // A distinct read — not the same Set reference markJoined happened to hold.
    expect(isJoined('r-1')).toBe(true);
  });

  it('marking one room leaves another unmarked', () => {
    markJoined('r-1');
    expect(isJoined('r-2')).toBe(false);
  });

  it('clearing an unmarked room is a no-op', () => {
    clearJoined('r-1');
    expect(isJoined('r-1')).toBe(false);
  });

  it('clearing a marked room unmarks only it', () => {
    markJoined('r-1');
    markJoined('r-2');
    clearJoined('r-1');
    expect(isJoined('r-1')).toBe(false);
    expect(isJoined('r-2')).toBe(true);
  });

  it('survives being read back out of sessionStorage directly (the reload case)', () => {
    markJoined('r-1');
    const raw = sessionStorage.getItem('cardtable:joinedRooms');
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toContain('r-1');
  });

  it('a malformed sessionStorage value reads as nothing joined, not a throw', () => {
    sessionStorage.setItem('cardtable:joinedRooms', '{not json');
    expect(() => isJoined('r-1')).not.toThrow();
    expect(isJoined('r-1')).toBe(false);
  });
});

describe('useJoined', () => {
  it('is false for a null room id', () => {
    const { result } = renderHook(() => useJoined(null));
    expect(result.current).toBe(false);
  });

  it('reads sessionStorage synchronously on first render — a reload keeps the chat on first paint', () => {
    markJoined('r-1');
    const { result } = renderHook(() => useJoined('r-1'));
    expect(result.current).toBe(true);
  });

  it('re-renders a mounted consumer when the room is marked joined after mount', () => {
    const { result } = renderHook(() => useJoined('r-1'));
    expect(result.current).toBe(false);
    act(() => {
      markJoined('r-1');
    });
    expect(result.current).toBe(true);
  });

  it('re-renders a mounted consumer when the room is cleared', () => {
    markJoined('r-1');
    const { result } = renderHook(() => useJoined('r-1'));
    expect(result.current).toBe(true);
    act(() => {
      clearJoined('r-1');
    });
    expect(result.current).toBe(false);
  });

  it('does not flip for an unrelated room being marked or cleared', () => {
    const { result } = renderHook(() => useJoined('r-1'));
    act(() => {
      markJoined('r-2');
    });
    expect(result.current).toBe(false);
  });
});
