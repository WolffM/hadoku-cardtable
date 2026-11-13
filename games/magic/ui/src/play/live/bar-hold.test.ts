import { describe, expect, it } from 'vitest';

import { barStuck, pressableBar } from './bar-hold.ts';
import { HOLD_MAX_MS, holdStands } from './timed-hold.ts';

const live = { label1: 'OK', label2: 'End Turn', enable1: true, enable2: true };
const dead = { ...live, enable1: false, enable2: false };

describe('the bar invariant: a live server bar is pressable unless a hold stands, and a hold never outlives HOLD_MAX_MS', () => {
  it('no hold: the server bar, untouched', () => {
    expect(pressableBar(live, null, 0)).toBe(live);
    expect(pressableBar(null, null, 0)).toBeNull();
  });

  it('a standing hold takes both buttons off', () => {
    const hold = { reason: 'pressed-ok', since: 1_000 };
    expect(pressableBar(live, hold, 1_000)).toEqual(dead);
    expect(pressableBar(live, hold, 1_000 + HOLD_MAX_MS - 1)).toEqual(dead);
  });

  it('every hold lapses at HOLD_MAX_MS, whatever its reason', () => {
    for (const reason of ['pressed-ok', 'pressed-cancel', 'anything']) {
      const hold = { reason, since: 1_000 };
      expect(holdStands(hold, 1_000 + HOLD_MAX_MS)).toBe(false);
      expect(pressableBar(live, hold, 1_000 + HOLD_MAX_MS)).toBe(live);
    }
  });
});

describe('barStuck: a live server bar with nothing on the screen to press', () => {
  const none = { nextPhase: false, endTurn: false, decisionOk: false, ask: false };

  it('stuck when the server bar is live and no surface takes input', () => {
    expect(barStuck(live, false, none)).toBe(true);
    expect(barStuck({ ...dead, enable2: true }, false, none)).toBe(true);
  });

  it('not stuck when any one surface takes input', () => {
    for (const key of Object.keys(none)) expect(barStuck(live, false, { ...none, [key]: true })).toBe(false);
  });

  it('not stuck when the server bar is dead or absent, or the seat is yielding', () => {
    expect(barStuck(dead, false, none)).toBe(false);
    expect(barStuck(null, false, none)).toBe(false);
    expect(barStuck(live, true, none)).toBe(false);
  });
});
