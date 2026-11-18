/*
 * The front cards' manual gallery (`./Gallery.tsx`): pages the reader flips with the arrows, the
 * dots, and never on a timer. The pure steps, so they are tested without mounting it.
 */

/** One page on from `index` (`delta` ±1), wrapping at both ends. */
export function stepPage(index: number, delta: number, count: number): number {
  if (count <= 1) return 0;
  return (((index + delta) % count) + count) % count;
}

/**
 * The Upcoming card's page as the front page opens: Polls when it has something and Calendar has
 * nothing (the operator, 2026-11-04), else Calendar.
 */
export function upcomingOpensOn(calendar: number, polls: number): 'calendar' | 'polls' {
  return calendar === 0 && polls > 0 ? 'polls' : 'calendar';
}

/** Where the reader is once the pages change: the page they were on (`key`), else `fallback`. */
export function keepPage(keys: readonly string[], key: string | null, fallback: number): number {
  const at = key === null ? -1 : keys.indexOf(key);
  if (at >= 0) return at;
  return keys.length === 0 ? 0 : Math.min(fallback, keys.length - 1);
}
