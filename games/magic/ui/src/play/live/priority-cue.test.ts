import { describe, expect, it } from 'vitest';

import { NO_PRIORITY_CUE, nextPriorityCue, type PriorityCue } from './priority-cue.ts';

/** Run renders through the reducer and return which of them sounded. */
function run(renders: readonly { turn: number; mine: boolean; live: boolean }[]): boolean[] {
  let cue: PriorityCue = NO_PRIORITY_CUE;
  return renders.map((now) => {
    const next = nextPriorityCue(cue, now);
    cue = next.cue;
    return next.sound;
  });
}

describe('the priority cue', () => {
  it('is silent on the first window of the seat’s own turn and sounds on each later one', () => {
    expect(
      run([
        { turn: 3, mine: true, live: true }, // Main 1: the turn's own sound says so
        { turn: 3, mine: true, live: true }, // the same window, re-rendered
        { turn: 3, mine: true, live: false }, // cast: the bar is gone
        { turn: 3, mine: true, live: true }, // back after it resolved
        { turn: 3, mine: true, live: false },
        { turn: 3, mine: true, live: true }, // Main 2
      ]),
    ).toEqual([false, false, false, true, false, true]);
  });

  it('sounds on every window of the other seat’s turn, the first one included', () => {
    expect(
      run([
        { turn: 4, mine: false, live: true }, // held in their combat
        { turn: 4, mine: false, live: false },
        { turn: 4, mine: false, live: true }, // their End step
      ]),
    ).toEqual([true, false, true]);
  });

  it('starts counting again on a new turn, and never sounds with no window open', () => {
    expect(
      run([
        { turn: 5, mine: true, live: true },
        { turn: 5, mine: true, live: false },
        { turn: 6, mine: false, live: false },
        { turn: 7, mine: true, live: true },
      ]),
    ).toEqual([false, false, false, false]);
  });
});
