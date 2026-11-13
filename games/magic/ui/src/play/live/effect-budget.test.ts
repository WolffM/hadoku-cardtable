// @vitest-environment jsdom
/*
 * The board's one particle pool (`effect-budget.ts`): every kind of particle, whenever it was asked for,
 * out of one budget for the time it is on screen.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { claimParticles, PARTICLE_BUDGET } from './effect-budget.ts';

afterEach(() => {
  vi.useRealTimers();
});

describe('claimParticles', () => {
  it('an effect alone gets all it asks for', () => {
    const root = document.createElement('div');
    expect(claimParticles(root, 20, 4, 0, 700)).toBe(20);
  });

  it('effects on screen together share one budget, whatever their kind; the last never gets less than its floor', () => {
    vi.useFakeTimers();
    const root = document.createElement('div');
    const now = Date.now();
    expect(claimParticles(root, 45, 6, now, now + 900), 'a wipe’s specks').toBe(45);
    expect(claimParticles(root, 20, 4, now + 300, now + 1000), 'a crash while they fall: what is left').toBe(PARTICLE_BUDGET - 45);
    expect(claimParticles(root, 12, 2, now + 400, now + 820), 'an impact on top: its floor').toBe(2);
  });

  it('an effect after the others are gone has the whole budget again, and each board has a pool of its own', () => {
    vi.useFakeTimers();
    const root = document.createElement('div');
    const now = Date.now();
    claimParticles(root, PARTICLE_BUDGET, 6, now, now + 700);
    expect(claimParticles(root, 20, 4, now + 700, now + 1400), 'starts as the first ends').toBe(20);
    expect(claimParticles(document.createElement('div'), 20, 4, now, now + 700), 'another board').toBe(20);
    vi.advanceTimersByTime(2000);
    expect(claimParticles(root, PARTICLE_BUDGET, 6, Date.now(), Date.now() + 700), 'all of it over').toBe(PARTICLE_BUDGET);
  });
});
