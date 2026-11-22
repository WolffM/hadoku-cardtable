// @vitest-environment jsdom
/*
 * Magic's side of the board's stage (`defaultStage`): which animations are beats by name, where it unlocks,
 * and how heavy a hit is. The stage itself is `@hadoku/ui-shell/motion`'s `Stage`, tested there.
 */
import { describe, expect, it } from 'vitest';

import { BEAT_ANIMATION_ID, damagePower, damageSize, defaultStage, MAX_DAMAGE, powerSize, UNLOCK_AT, unlockAfter } from './motion.ts';

describe('the board’s stage (`defaultStage`)', () => {
  it('its beats by name: its own id, a leaving card, a floating number, an effect, a resolution; not a banner or a glide', () => {
    const named = (name: { id?: string; animationName?: string; transitionProperty?: string }): boolean => defaultStage.isBeat({ id: '', ...name } as unknown as Animation);
    expect([BEAT_ANIMATION_ID].map((id) => named({ id }))).toEqual([true]);
    expect(['board-exit-crumble', 'board-number-rise', 'effect-crash', 'placed-resolve'].map((animationName) => named({ animationName }))).toEqual([true, true, true, true]);
    expect([named({ animationName: 'turn-cue' }), named({ transitionProperty: 'left' })]).toEqual([false, false]);
  });

  it('UNLOCK_AT is 90%, and a timed beat lets go that far through', () => {
    expect(UNLOCK_AT).toBe(0.9);
    expect(unlockAfter(1000)).toBe(900);
    expect(unlockAfter(600), 'an attack beat').toBe(540);
  });
});

describe('how heavy a hit is', () => {
  // AF420 (2026-10-27): the spell-damage preview put the cap back at twenty — the ten-point scale
  // (ledger AF149) left a spell's biggest hits all looking the same size — as one constant every
  // damage effect shares, creature combat blows included.
  it('a point is the lightest, TWENTY and anything above the heaviest, and the middle climbs fast', () => {
    expect(MAX_DAMAGE).toBe(20);
    expect(damagePower(1)).toBe(0);
    expect(damagePower(5)).toBeCloseTo(Math.sqrt(4 / 19), 5);
    expect(damagePower(10)).toBeCloseTo(Math.sqrt(9 / 19), 5);
    expect(damagePower(20)).toBe(1);
    expect(damagePower(30), 'damage above the cap is no heavier than the cap itself').toBe(damagePower(20));
    expect(damagePower(0)).toBe(0);
  });
  it('powerSize (a creature landing’s own curve, `entries.ts`) is four fifths for nothing and 1.9 times at full power — untouched by AF420’s bigger damage scale', () => {
    expect(powerSize(0)).toBeCloseTo(0.8, 5);
    expect(powerSize(1)).toBeCloseTo(1.9, 5);
  });
  it('damageSize (a spell’s ball and burst, a combat blow’s crash) is four fifths for a point and two and a half at twenty and beyond', () => {
    expect(damageSize(damagePower(1))).toBeCloseTo(0.8, 5);
    expect(damageSize(damagePower(5))).toBeCloseTo(0.8 + 1.7 * Math.sqrt(4 / 19), 5);
    expect(damageSize(damagePower(10))).toBeCloseTo(0.8 + 1.7 * Math.sqrt(9 / 19), 5);
    expect(damageSize(damagePower(20))).toBeCloseTo(2.5, 5);
    expect(damageSize(damagePower(30)), 'damage above the cap is no bigger than the cap itself').toBe(damageSize(damagePower(20)));
  });
});
