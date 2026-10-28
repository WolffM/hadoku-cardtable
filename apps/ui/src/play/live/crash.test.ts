// @vitest-environment jsdom
/*
 * A ram's crash (`crash.ts`): rocks and a shake as heavy as the damage, and a crash that cleans up.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { damagePower } from '../motion.ts';
import { crash, CRASH_MS, rocks, shakeOf } from './crash.ts';
import { claimParticles, PARTICLE_BUDGET } from './effect-budget.ts';
import { impact } from './projectile.ts';

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('rocks', () => {
  it('a heavier blow throws more rocks, bigger and further, and they all come down', () => {
    const light = rocks('k', damagePower(1));
    const heavy = rocks('k', damagePower(20));
    expect(heavy.length).toBeGreaterThan(light.length);
    const furthest = (rs: typeof light): number => Math.max(...rs.map((r) => Math.hypot(r.dx, r.dy)));
    expect(furthest(heavy)).toBeGreaterThan(furthest(light));
    expect(Math.max(...heavy.map((r) => r.size))).toBeGreaterThan(Math.max(...light.map((r) => r.size)));
    expect(rocks('k', 0.5), 'the same blow throws the same rocks').toEqual(rocks('k', 0.5));
  });

  it('a share of a beat’s budget throws fewer, never none (`effect-budget.ts`)', () => {
    const full = rocks('k', 1).length;
    expect(rocks('k', 1, 0.5).length).toBe(Math.floor(full / 2));
    expect(rocks('k', 1, 0.01).length).toBeGreaterThan(0);
  });
});

describe('shakeOf', () => {
  it('barely at five, the full shake at seven, never for a point; further and longer the heavier', () => {
    expect(shakeOf(1)).toEqual({ px: 0, ms: 0 });
    expect(shakeOf(5).px).toBeLessThan(3);
    expect(shakeOf(7).px).toBe(7);
    for (let a = 2; a < 20; a++) expect(shakeOf(a + 1).px, `${a + 1} over ${a}`).toBeGreaterThan(shakeOf(a).px);
    expect(shakeOf(25), 'capped at twenty').toEqual(shakeOf(20));
  });
});

describe('crash', () => {
  it('draws a ring, dust and rocks where it lands, and is gone once they have flown', () => {
    vi.useFakeTimers();
    const root = document.createElement('div');
    document.body.append(root);
    const el = crash(root, { x: 120, y: 80 }, damagePower(3), 'c');
    expect([el.style.left, el.style.top]).toEqual(['120px', '80px']);
    expect(el.querySelectorAll('.effect-crash__ring')).toHaveLength(1);
    expect(el.querySelectorAll('.effect-crash__rock')).toHaveLength(rocks('c', damagePower(3)).length);
    vi.advanceTimersByTime(CRASH_MS + 50);
    expect(root.querySelector('.effect-crash')).toBeNull();
  });

  it('a crash and an impact on a board already full of particles throw only their floors (`effect-budget.ts`)', () => {
    vi.useFakeTimers();
    const root = document.createElement('div');
    document.body.append(root);
    claimParticles(root, PARTICLE_BUDGET, 6, Date.now(), Date.now() + 5000);
    const el = crash(root, { x: 0, y: 0 }, 1, 'c');
    expect([el.querySelectorAll('.effect-crash__rock').length, el.querySelectorAll('.effect-crash__dust').length]).toEqual([4, 2]);
    expect(impact(root, { x: 0, y: 0 }, 'bolt', 'i', 'R', 1).querySelectorAll('.effect-blast__spark')).toHaveLength(3);
  });
});
