import { describe, expect, it } from 'vitest';

import { rereadWhileVisible, type PageVisibility } from './visible.ts';

function harness(hidden: boolean) {
  const listeners = new Set<() => void>();
  const page: PageVisibility & { set(hidden: boolean): void } = {
    hidden: () => hidden,
    onChange: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    set(next) {
      hidden = next;
      for (const l of listeners) l();
    },
  };
  const ticks: (() => void)[] = [];
  let reads = 0;
  const stop = rereadWhileVisible(() => (reads += 1), 60_000, {
    page,
    setInterval: (fn) => ticks.push(fn),
    clearInterval: () => ticks.splice(0),
  });
  return { page, tick: () => ticks.forEach((t) => t()), reads: () => reads, stop, listeners };
}

describe('rereadWhileVisible', () => {
  it('reads at once and on every tick while shown', () => {
    const h = harness(false);
    expect(h.reads()).toBe(1);
    h.tick();
    h.tick();
    expect(h.reads()).toBe(3);
  });

  it('a hidden tab reads nothing until it is shown, then reads once', () => {
    const h = harness(true);
    h.tick();
    h.tick();
    expect(h.reads()).toBe(0);
    h.page.set(false);
    expect(h.reads()).toBe(1);
    h.page.set(true);
    expect(h.reads()).toBe(1);
  });

  it('stopping clears the timer and the visibility listener', () => {
    const h = harness(false);
    h.stop();
    h.tick();
    expect(h.listeners.size).toBe(0);
    expect(h.reads()).toBe(1);
  });
});
