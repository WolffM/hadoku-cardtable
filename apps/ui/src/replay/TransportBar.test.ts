// @vitest-environment jsdom
/*
 * `TransportBar` against a real `ReplayClock` (`./player.ts`) — the
 * clock's own pacing and seek correctness is `./player.test.ts`'s
 * job; this proves the BUTTONS drive it, and that the clock's state is what
 * paints the pressed state and the time readout.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';

import { createReplayPlayer } from './player.ts';
import type { ReplayData } from './transport.ts';
import { TransportBar } from './TransportBar.tsx';

afterEach(() => cleanup());

const EMPTY: ReplayData = {
  header: { matchId: 'm-1', roomId: null, players: ['Alice', 'Bob'], ai: [false, false], decks: [], art: [], startedAt: '2026-10-27T00:00:00.000Z' },
  envs: [],
  presence: [],
  end: null,
};

/** A 10s recording (no frames needed — this file only drives the clock, not the board). */
function tenSecondClock() {
  const data: ReplayData = { ...EMPTY, envs: [{ at: 10_000, env: { matchId: 'm-1', cursor: { epoch: 'e1', seq: 1 }, frame: { kind: 'notify', method: 'openView', payload: { myPlayers: [0] } } } }] };
  const { clock } = createReplayPlayer(data);
  clock.play();
  return clock;
}

describe('TransportBar', () => {
  it('shows ▶/⏸ for the clock’s own playing state, and toggles it on click', () => {
    const clock = tenSecondClock();
    const { getByTestId } = render(createElement(TransportBar, { clock }));
    expect(getByTestId('replay-bar-play').textContent).toBe('⏸'); // playing, as the screen starts it once the board is ready

    fireEvent.click(getByTestId('replay-bar-play'));
    expect(clock.playing()).toBe(false);
    expect(getByTestId('replay-bar-play').textContent).toBe('▶');

    fireEvent.click(getByTestId('replay-bar-play'));
    expect(clock.playing()).toBe(true);

    clock.dispose();
  });

  it('a speed button sets the clock’s speed and shows pressed state', () => {
    const clock = tenSecondClock();
    const { getByTestId } = render(createElement(TransportBar, { clock }));
    expect(getByTestId('replay-bar-speed-1').getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(getByTestId('replay-bar-speed-4'));
    expect(clock.speed()).toBe(4);
    expect(getByTestId('replay-bar-speed-4').getAttribute('aria-pressed')).toBe('true');
    expect(getByTestId('replay-bar-speed-1').getAttribute('aria-pressed')).toBe('false');

    clock.dispose();
  });

  it('the scrubber seeks the clock, and the time readout follows', () => {
    vi.useFakeTimers();
    const clock = tenSecondClock();
    const { getByTestId } = render(createElement(TransportBar, { clock }));
    expect(getByTestId('replay-bar-scrub').getAttribute('max')).toBe('10000');

    fireEvent.change(getByTestId('replay-bar-scrub'), { target: { value: '5000' } });
    expect(clock.positionMs()).toBe(5000);

    vi.useRealTimers();
    clock.dispose();
  });

  it('shows ↺ once playback has ended, in place of ▶', () => {
    vi.useFakeTimers();
    const clock = tenSecondClock();
    const { getByTestId, rerender } = render(createElement(TransportBar, { clock }));
    vi.advanceTimersByTime(10_050);
    rerender(createElement(TransportBar, { clock }));
    expect(clock.ended()).toBe(true);
    expect(getByTestId('replay-bar-play').textContent).toBe('↺');

    vi.useRealTimers();
    clock.dispose();
  });
});
