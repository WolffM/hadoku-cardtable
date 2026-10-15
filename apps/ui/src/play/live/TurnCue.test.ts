// @vitest-environment jsdom
/*
 * The operator, 2026-10-14: *"'your turn' pop up on the screen"*. The cue is for a turn this screen
 * saw begin, and only for the viewer's own.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BoardView } from '../adapter.ts';
import { TURN_CUE_MS, useYourTurnCue } from './TurnCue.tsx';

const view = (turn: number, active: number): BoardView =>
  ({
    turn,
    activePlayerId: active,
    players: [
      { id: 0, isViewer: true },
      { id: 1, isViewer: false },
    ],
  }) as unknown as BoardView;

describe('useYourTurnCue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const mount = (first: BoardView | null, enabled = true) =>
    renderHook(({ v, on }: { v: BoardView | null; on: boolean }) => useYourTurnCue(v, on), { initialProps: { v: first, on: enabled } });

  it('cues your turn as it begins, then clears by itself', () => {
    const hook = mount(view(1, 1));
    expect(hook.result.current).toBeNull();
    hook.rerender({ v: view(2, 0), on: true });
    expect(hook.result.current).toBe(2);
    act(() => {
      vi.advanceTimersByTime(TURN_CUE_MS);
    });
    expect(hook.result.current).toBeNull();
  });

  it('the pregame to turn 1 is a start', () => {
    const hook = mount(view(0, 0));
    hook.rerender({ v: view(1, 0), on: true });
    expect(hook.result.current).toBe(1);
  });

  it('never the first turn the screen sees — a reload mid-turn announces nothing', () => {
    expect(mount(view(5, 0)).result.current).toBeNull();
  });

  it('never the opponent’s turn', () => {
    const hook = mount(view(1, 0));
    hook.rerender({ v: view(2, 1), on: true });
    expect(hook.result.current).toBeNull();
  });

  it('the turn number and the active player arriving apart still cue once', () => {
    const hook = mount(view(1, 1));
    hook.rerender({ v: view(2, 1), on: true });
    expect(hook.result.current).toBeNull();
    hook.rerender({ v: view(2, 0), on: true });
    expect(hook.result.current).toBe(2);
    act(() => {
      vi.advanceTimersByTime(TURN_CUE_MS);
    });
    hook.rerender({ v: { ...view(2, 0) }, on: true });
    expect(hook.result.current, 'and not again for the same turn').toBeNull();
  });

  it('a watcher’s screen is never cued', () => {
    const hook = mount(view(1, 1), false);
    hook.rerender({ v: view(2, 0), on: false });
    expect(hook.result.current).toBeNull();
  });
});
