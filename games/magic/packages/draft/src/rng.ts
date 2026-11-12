/*
 * Seeded randomness.
 *
 * `Math.random` is banned in this package. Replay is the entire test strategy —
 * "the same seed twice produces a byte-identical pick log" is the engine's
 * headline guarantee — and it is also what lets a draft be reproduced from a
 * bug report, or restored after a restart without storing every shuffled pack.
 *
 * mulberry32: 32-bit state, one multiply-xorshift round. Not cryptographic and
 * not trying to be; what matters here is that it is deterministic, portable,
 * and identical in Node and the browser, since the engine runs in both.
 */

/** A deterministic source of numbers in [0, 1). */
export interface Rng {
  next(): number;
  /** Integer in [0, maxExclusive). */
  int(maxExclusive: number): number;
}

/**
 * Hash a string seed to a 32-bit integer (FNV-1a).
 *
 * Seeds are strings because they are user-facing — a draft is reproduced by
 * typing the seed back in, and `"friday-cube"` is a better thing to type than
 * `2654435761`.
 */
export function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A generator from a numeric state. */
export function mulberry32(state: number): Rng {
  let a = state >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int(maxExclusive: number): number {
      if (maxExclusive <= 0) return 0;
      return Math.floor(next() * maxExclusive);
    },
  };
}

/** A generator from a string seed. */
export function rngFromSeed(seed: string): Rng {
  return mulberry32(hashSeed(seed));
}

/**
 * Fisher-Yates, returning a new array.
 *
 * Copies rather than shuffling in place so the caller's cube list — which is
 * parsed data shared between drafts — is never mutated.
 */
export function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    const a = out[i] as T;
    const b = out[j] as T;
    out[i] = b;
    out[j] = a;
  }
  return out;
}

/**
 * A sub-generator keyed by a label.
 *
 * Bot picks use one of these per (seat, pack, pick) so a bot's choice depends
 * only on the draft's seed and where it is in the draft — never on how many
 * times anything else has drawn from a shared stream. Without this, a human
 * picking in a different order would silently change what the bots do, and the
 * replay guarantee would hold only when the humans replayed identically too.
 */
export function derive(seed: string, ...parts: Array<string | number>): Rng {
  return rngFromSeed(`${seed}::${parts.join(':')}`);
}
