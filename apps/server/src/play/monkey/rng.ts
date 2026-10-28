/*
 * A seeded PRNG for the monkey seat, and the sampling helpers its decisions
 * are built from. Mulberry32: small, fast, and deterministic across Node
 * versions (no reliance on `Math.random`'s engine-specific sequence) — the
 * whole point is that a run's seed, printed once at the top of its report,
 * reproduces it exactly.
 */

export interface Rng {
  /** A float in [0, 1). */
  next(): number;
  /** An integer in [min, max], inclusive both ends. `max < min` throws. */
  int(min: number, max: number): number;
  /** True with probability `p` (default 0.5). */
  bool(p?: number): boolean;
  /** One element of `items`, or undefined for an empty array. */
  pick<T>(items: readonly T[]): T | undefined;
  /** `items` in a random order (Fisher-Yates; does not mutate `items`). */
  shuffle<T>(items: readonly T[]): T[];
  /** `count` distinct elements of `items`, in a random order. Clamped to `items.length`. */
  sample<T>(items: readonly T[], count: number): T[];
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A seed string (anything) hashed down to mulberry32's 32-bit input — so a run can seed from a readable label too. */
export function seedFrom(input: number | string): number {
  if (typeof input === 'number') return input >>> 0;
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function makeRng(seed: number | string): Rng {
  const next = mulberry32(seedFrom(seed));
  const self: Rng = {
    next,
    int(min, max) {
      if (max < min) throw new Error(`rng.int: max ${max} < min ${min}`);
      return min + Math.floor(next() * (max - min + 1));
    },
    bool(p = 0.5) {
      return next() < p;
    },
    pick(items) {
      return items.length === 0 ? undefined : items[self.int(0, items.length - 1)];
    },
    shuffle(items) {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i -= 1) {
        const j = self.int(0, i);
        [out[i], out[j]] = [out[j]!, out[i]!];
      }
      return out;
    },
    sample(items, count) {
      const n = Math.max(0, Math.min(count, items.length));
      return self.shuffle(items).slice(0, n);
    },
  };
  return self;
}
