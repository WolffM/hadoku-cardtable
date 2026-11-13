// @vitest-environment jsdom
/* A struck avatar's recoil (`recoil.ts`): pushed on the blow, held while its attacker holds, sprung back. */
import { describe, expect, it } from 'vitest';

import { entryPower } from './entries.ts';
import { homeOf } from './ram.ts';
import { recoilFrames, recoilOf } from './recoil.ts';

const push = (f: Keyframe): number => {
  const m = /(-?[\d.]+)px (-?[\d.]+)px/.exec(String(f.translate))!;
  return Math.hypot(Number(m[1]), Number(m[2])) * Math.sign(Number(m[1]) || Number(m[2]));
};

describe('recoilOf / recoilFrames', () => {
  it.each([1, 4, 10, 18])('a %i-damage blow: out on the blow, still out while its attacker holds, then sprung back past rest and settled', (damage) => {
    const r = recoilOf(damage);
    expect(r.holdMs, 'held as long as the attacker holds').toBe(homeOf(entryPower(damage)).holdMs);
    expect(r.ms).toBe(r.snapMs + r.holdMs + r.backMs);
    const frames = recoilFrames(1, 0, r);
    const peak = frames.find((f) => f.offset === Number((r.snapMs / r.ms).toFixed(4)))!;
    const letGo = frames.find((f) => f.offset === Number(((r.snapMs + r.holdMs) / r.ms).toFixed(4)))!;
    expect(push(peak)).toBeCloseTo(r.px, 0);
    expect(push(letGo), 'still pushed when the attacker lets go').toBeGreaterThanOrEqual(0.8 * r.px);
    expect(Math.min(...frames.map(push)), 'springs back past where it stood').toBeLessThan(0);
    expect(push(frames.at(-1)!), 'settled').toBe(0);
  });

  it('a poke barely nudges, a heavy blow shoves further and longer, never more than 12px', () => {
    expect(recoilOf(1).px).toBeLessThan(3);
    expect(recoilOf(18).px).toBeGreaterThan(3 * recoilOf(1).px);
    expect(recoilOf(99).px).toBeLessThanOrEqual(12);
    expect(recoilOf(18).ms).toBeGreaterThan(recoilOf(1).ms);
  });
});
