import { describe, expect, it } from 'vitest';

import { MATCH_REPORT_KINDS } from '@hadoku/shared';

import { stopFor, troubleEndsMatch } from './run-match.ts';

describe('troubleEndsMatch', () => {
  it('a board noting a slow or failed connect attempt plays on; everything else ends the match', () => {
    const ending = MATCH_REPORT_KINDS.filter(troubleEndsMatch);
    expect(ending).toEqual(['disconnected', 'snapshot-failed', 'no-snapshot', 'stale-build-reload']);
  });
});

describe('stopFor', () => {
  const opts = { turnCap: 60, turnStallMs: 300_000, matchTimeoutMs: 1_800_000, stopAt: Infinity };
  const at = (turn: number, turnFor: number, matchFor: number) => ({ now: 10_000_000, state: { turn, turnSince: 10_000_000 - turnFor, startedAt: 10_000_000 - matchFor } });

  it('plays on through a long game that keeps moving: 28 turns at 13 s a turn is not timed out', () => {
    const { state, now } = at(28, 13_000, 376_000);
    expect(stopFor(state, opts, now)).toBeNull();
  });

  it('a game at the turn cap stops as turn-cap, not as a time-out', () => {
    const { state, now } = at(61, 1_000, 900_000);
    expect(stopFor(state, opts, now)).toBe('turn-cap');
  });

  it('one turn going on past the stall limit is the finding, however young the match', () => {
    const { state, now } = at(4, 300_001, 400_000);
    expect(stopFor(state, opts, now)).toBe('turn-stall');
  });

  it('the wall is only a backstop, and the run’s budget stops a match before either', () => {
    expect(stopFor(at(40, 1_000, 1_800_001).state, opts, 10_000_000)).toBe('wall');
    expect(stopFor(at(40, 1_000, 1_800_001).state, { ...opts, stopAt: 9_000_000 }, 10_000_000)).toBe('budget');
  });
});
