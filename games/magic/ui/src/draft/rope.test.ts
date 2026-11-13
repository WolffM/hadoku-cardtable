import { describe, expect, it } from 'vitest';

import { burnElapsedAt, burnMs, fuseKeyframes, fuseLeft, ROPE_URGENT_MS, ropeClock, ropeState } from './rope.ts';

describe('the rope clock', () => {
  it('anchors the deadline on the arrival of the envelope, not on anything earlier', () => {
    // A pick of 30 s; the envelope says 18 s left, and lands at 12 s on the page's clock.
    const clock = ropeClock({ totalMs: 30_000, msLeft: 18_000 }, 12_000);
    expect(clock.endsAt).toBe(30_000);
    // A later envelope for the same pick says the same deadline: re-anchoring moves nothing.
    expect(ropeClock({ totalMs: 30_000, msLeft: 8_000 }, 22_000).endsAt).toBe(clock.endsAt);
  });

  it('waits, burns for the last third, turns urgent for the last seconds, and is out at the deadline', () => {
    const clock = ropeClock({ totalMs: 30_000, msLeft: 30_000 }, 0);
    expect(burnMs(clock)).toBe(10_000);
    expect(ropeState(clock, 0)).toBe('waiting');
    expect(ropeState(clock, 19_999)).toBe('waiting');
    expect(ropeState(clock, 20_000)).toBe('burning');
    expect(ropeState(clock, 30_000 - ROPE_URGENT_MS - 1)).toBe('burning');
    expect(ropeState(clock, 30_000 - ROPE_URGENT_MS)).toBe('urgent');
    expect(ropeState(clock, 29_999)).toBe('urgent');
    expect(ropeState(clock, 30_000)).toBe('out');
  });

  it('turns urgent no earlier than its burn on a pick shorter than the urgent stretch', () => {
    // 5 s at 4×: a 1.25 s pick burns for its last ~417 ms, all of it urgent.
    const clock = ropeClock({ totalMs: 1_250, msLeft: 1_250 }, 0);
    expect(ropeState(clock, 0)).toBe('waiting');
    expect(ropeState(clock, 1_250 - burnMs(clock))).toBe('urgent');
  });

  it('seeks the burn so it ends exactly at the deadline', () => {
    const clock = ropeClock({ totalMs: 30_000, msLeft: 18_000 }, 12_000);
    // The burn's own time at the deadline is its whole length: empty then, not before.
    expect(burnElapsedAt(clock, clock.endsAt)).toBe(burnMs(clock));
    expect(burnElapsedAt(clock, 20_000)).toBe(0);
    expect(burnElapsedAt(clock, 12_000)).toBe(-8_000);
  });
});

describe('the fuse curve', () => {
  it('is whole at the start of the burn and empty exactly at the deadline', () => {
    expect(fuseLeft(1)).toBe(1);
    expect(fuseLeft(0)).toBe(0);
    expect(fuseLeft(1e-6)).toBeGreaterThan(0);
  });

  it('never gains, and slows toward zero: the last tenth of the burn moves less of the fuse than the first', () => {
    const samples = Array.from({ length: 101 }, (_, i) => fuseLeft(1 - i / 100));
    for (let i = 1; i < samples.length; i++) expect(samples[i]!).toBeLessThanOrEqual(samples[i - 1]!);
    const first = samples[0]! - samples[10]!;
    const last = samples[90]! - samples[100]!;
    expect(last).toBeLessThan(first / 4);
  });

  it('draws a straight line at power 1', () => {
    expect(fuseLeft(0.25, 1)).toBe(0.25);
  });

  it('keyframes follow the curve from whole to empty', () => {
    const frames = fuseKeyframes();
    expect(frames[0]).toEqual({ offset: 0, width: '100.000%' });
    expect(frames.at(-1)).toEqual({ offset: 1, width: '0.000%' });
    const mid = frames[frames.length >> 1]!;
    expect(mid.offset).toBe(0.5);
    expect(mid.width).toBe(`${(fuseLeft(0.5) * 100).toFixed(3)}%`);
  });
});
