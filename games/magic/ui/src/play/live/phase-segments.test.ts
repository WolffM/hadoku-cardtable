/*
 * Wave 89 §B, red-first: the pure grouping behind the portrait phase bar.
 * `LiveBoard.test.ts` covers the rendered `.live__phases` markup; this file is
 * the function alone, with no DOM and no view.
 */
import { describe, expect, it } from 'vitest';

import { phaseSegmentsOf, PHASE_ORDER } from './phase-segments.ts';

/** Stands in for `LiveBoard.tsx`'s `rowLabel`, which this file must never duplicate. */
const label = (phase: string): string => `label:${phase}`;

describe('phaseSegmentsOf', () => {
  it('always returns exactly 5 segments, Begin through End, in turn order', () => {
    const segments = phaseSegmentsOf(null, label);
    expect(segments.map((s) => s.group)).toEqual(['begin', 'main1', 'combat', 'main2', 'end']);
    expect(segments.map((s) => s.label)).toEqual(['Begin', 'Main', 'Combat', 'Main 2', 'End']);
  });

  it('accounts for every one of PHASE_ORDER\'s 13 steps, once each, across the 5 segments', () => {
    const segments = phaseSegmentsOf(null, label);
    const allSteps = segments.flatMap((s) => s.steps);
    expect(allSteps).toEqual(PHASE_ORDER.map((p) => p.phase));
    expect(segments.map((s) => s.tickCount)).toEqual([3, 1, 6, 1, 2]);
  });

  it('marks no segment current for a phase that is not in PHASE_ORDER, or no phase at all', () => {
    for (const phase of [null, 'NOT_A_REAL_PHASE']) {
      const segments = phaseSegmentsOf(phase, label);
      expect(segments.every((s) => !s.current)).toBe(true);
      expect(segments.every((s) => s.stepLabel === null)).toBe(true);
      expect(segments.every((s) => s.tickIndex === -1)).toBe(true);
    }
  });

  it('marks exactly the one segment holding the current phase, with its own step label', () => {
    const segments = phaseSegmentsOf('UPKEEP', label);
    const current = segments.filter((s) => s.current);
    expect(current).toHaveLength(1);
    expect(current[0]!.group).toBe('begin');
    expect(current[0]!.stepLabel).toBe('label:UPKEEP');
    // UPKEEP is the second of begin's 3 steps (UNTAP, UPKEEP, DRAW).
    expect(current[0]!.tickIndex).toBe(1);
  });

  it('a single-step segment (Main 1, Main 2) still carries its own tick count and index', () => {
    const segments = phaseSegmentsOf('MAIN2', label);
    const main2 = segments.find((s) => s.group === 'main2')!;
    expect(main2.current).toBe(true);
    expect(main2.tickCount).toBe(1);
    expect(main2.tickIndex).toBe(0);
    expect(main2.stepLabel).toBe('label:MAIN2');
    // Every other segment stays uncurrent.
    expect(segments.filter((s) => s.current)).toHaveLength(1);
  });

  it('combat\'s 6 steps all land in the one combat segment, wherever combat is', () => {
    for (const phase of ['COMBAT_BEGIN', 'COMBAT_DECLARE_ATTACKERS', 'COMBAT_DECLARE_BLOCKERS', 'COMBAT_FIRST_STRIKE_DAMAGE', 'COMBAT_DAMAGE', 'COMBAT_END']) {
      const segments = phaseSegmentsOf(phase, label);
      const combat = segments.find((s) => s.group === 'combat')!;
      expect(combat.current).toBe(true);
      expect(combat.tickCount).toBe(6);
      expect(combat.tickIndex).toBe(PHASE_ORDER.filter((p) => p.group === 'combat').findIndex((p) => p.phase === phase));
    }
  });
});
