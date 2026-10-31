/*
 * The front cards' manual gallery (`./Gallery.tsx`): pages the reader flips with the arrows, the
 * dots or a swipe, and never on a timer. The pure steps, so they are tested without mounting it.
 */

/** How far a sideways drag must travel to turn the page. */
export const SWIPE_PX = 40;

/** One page on from `index` (`delta` ±1), wrapping at both ends. */
export function stepPage(index: number, delta: number, count: number): number {
  if (count <= 1) return 0;
  return (((index + delta) % count) + count) % count;
}

/** A drag of `dx`×`dy` px as a page step: ±1 past the threshold, 0 for a short or mostly vertical one (scrolling a list). */
export function swipeStep(dx: number, dy: number): -1 | 0 | 1 {
  if (Math.abs(dx) < SWIPE_PX || Math.abs(dy) > Math.abs(dx)) return 0;
  return dx < 0 ? 1 : -1;
}

/** Where the reader is once the pages change: the page they were on (`key`), else `fallback`. */
export function keepPage(keys: readonly string[], key: string | null, fallback: number): number {
  const at = key === null ? -1 : keys.indexOf(key);
  if (at >= 0) return at;
  return keys.length === 0 ? 0 : Math.min(fallback, keys.length - 1);
}
