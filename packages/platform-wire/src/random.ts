/**
 * A uniform [0,1) from `crypto`, never `Math.random`: one rule, one place, for
 * every draw the UI or the server makes (a Random deck, an All Random room's
 * era and decks). `globalThis.crypto` is the Web Crypto API in a browser and
 * in Node alike.
 */
export function secureRandom(): number {
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return buf[0] / 2 ** 32;
}

/**
 * One of `items`, or undefined when there are none.
 *
 * `rand` is injectable so a draw can be asserted against a pinned source
 * rather than sampled and hoped about.
 */
export function pickRandom<T>(items: readonly T[], rand: () => number = secureRandom): T | undefined {
  if (items.length === 0) return undefined;
  return items[Math.min(items.length - 1, Math.floor(rand() * items.length))];
}
