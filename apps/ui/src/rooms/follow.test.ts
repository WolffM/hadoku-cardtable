/*
 * When a following screen reads. The socket under it is the rooms core's (`@wolffm/rooms-client`,
 * tested there); the server half is `apps/server/src/room/watching.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import type { PageVisibility } from '../visible.ts';
import { createRoomFeed, FALLBACK_MS, type FeedTarget, type PingReason, type PingSource } from './follow.ts';

/** A page whose visibility a test flips, telling every listener as a browser does. */
function page(): PageVisibility & { setHidden(hidden: boolean): void } {
  let hidden = false;
  const listeners = new Set<() => void>();
  return {
    hidden: () => hidden,
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setHidden: (h) => {
      hidden = h;
      for (const l of [...listeners]) l();
    },
  };
}

/** Pings a test sends by hand. */
function pings(): PingSource & { ping(): void; count(): number } {
  const subs = new Set<(why: PingReason) => void>();
  return {
    subscribe: (_target, onPing) => {
      subs.add(onPing);
      return () => subs.delete(onPing);
    },
    ping: () => {
      for (const s of [...subs]) s('changed');
    },
    count: () => subs.size,
  };
}

/** A clock whose intervals a test fires by hand. */
function clock() {
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let next = 0;
  return {
    setInterval: (fn: () => void, ms: number) => {
      timers.set((next += 1), { fn, ms });
      return next;
    },
    clearInterval: (h: unknown) => {
      timers.delete(h as number);
    },
    tick: () => {
      for (const t of [...timers.values()]) t.fn();
    },
    periods: () => [...timers.values()].map((t) => t.ms),
  };
}

function follow(target: FeedTarget = { room: 'r-1' }) {
  const p = page();
  const source = pings();
  const c = clock();
  const feed = createRoomFeed(source, { page: p, setInterval: c.setInterval, clearInterval: c.clearInterval });
  let reads = 0;
  const stop = feed.follow(target, () => {
    reads += 1;
  });
  return { p, source, c, stop, reads: () => reads };
}

describe('a screen following a room', () => {
  it('reads once at the start, then only when the server says the room changed', () => {
    const f = follow();
    expect(f.reads()).toBe(1);
    f.source.ping();
    expect(f.reads()).toBe(2);
    f.source.ping();
    expect(f.reads()).toBe(3);
  });

  it('keeps one slow resilience read while visible, and no fast one', () => {
    const f = follow();
    expect(f.c.periods()).toEqual([FALLBACK_MS]);
    expect(FALLBACK_MS).toBeGreaterThanOrEqual(30_000);
    f.c.tick();
    expect(f.reads()).toBe(2);
  });

  it('a hidden tab reads nothing — no ping, no resilience read — and reads once when shown again', () => {
    const f = follow();
    f.p.setHidden(true);
    f.source.ping();
    f.source.ping();
    f.c.tick();
    expect(f.reads(), 'hidden: only the read it started with').toBe(1);
    f.p.setHidden(false);
    expect(f.reads(), 'shown: one read').toBe(2);
  });

  it('a screen that starts hidden reads nothing until it is shown', () => {
    const p = page();
    p.setHidden(true);
    const source = pings();
    const c = clock();
    let reads = 0;
    createRoomFeed(source, { page: p, setInterval: c.setInterval, clearInterval: c.clearInterval }).follow({ room: 'r-1' }, () => {
      reads += 1;
    });
    source.ping();
    expect(reads).toBe(0);
    p.setHidden(false);
    expect(reads).toBe(1);
  });

  it('stopping lets go of the pings, the timer and the visibility listener', () => {
    const f = follow();
    f.stop();
    expect(f.source.count()).toBe(0);
    expect(f.c.periods()).toEqual([]);
    f.p.setHidden(true);
    f.p.setHidden(false);
    expect(f.reads()).toBe(1);
  });
});
