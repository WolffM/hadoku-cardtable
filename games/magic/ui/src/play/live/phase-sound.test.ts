import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PHASE_SETTLE_MS, phaseSoundGate } from './phase-sound.ts';

describe('the phase sound plays for a phase the game stops in', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const gate = () => {
    const played: string[] = [];
    return { played, g: phaseSoundGate((_e, key, how) => played.push(`${key}:${how}`)) };
  };
  const phase = { role: 'g.phase', seat: 'me' as const };

  it('steps passed straight through make no sound; the one the game lands in does', () => {
    const { played, g } = gate();
    for (const step of ['COMBAT_BEGIN', 'COMBAT_DECLARE_ATTACKERS', 'COMBAT_END']) {
      g.enter(step, phase, []);
      vi.advanceTimersByTime(160);
    }
    g.enter('MAIN2', phase, []);
    expect(played).toEqual([]);
    vi.advanceTimersByTime(PHASE_SETTLE_MS);
    expect(played).toEqual(['MAIN2:settled']);
  });

  it('a window opening in the phase plays it at once, and only once', () => {
    const { played, g } = gate();
    const bar = {};
    g.enter('MAIN1', phase, []);
    vi.advanceTimersByTime(20);
    g.hold([bar]);
    g.hold([bar]);
    vi.advanceTimersByTime(PHASE_SETTLE_MS);
    expect(played).toEqual(['MAIN1:held']);
  });

  it('a window still open from the phase before is not this phase stopping', () => {
    const { played, g } = gate();
    const stale = {};
    g.enter('COMBAT_BEGIN', phase, [stale]);
    g.hold([stale]);
    vi.advanceTimersByTime(160);
    g.enter('COMBAT_END', phase, []);
    expect(played).toEqual([]);
  });

  it('a dropped phase never sounds', () => {
    const { played, g } = gate();
    g.enter('END_OF_TURN', phase, []);
    g.drop();
    g.hold([{}]);
    vi.advanceTimersByTime(PHASE_SETTLE_MS);
    expect(played).toEqual([]);
  });
});
