/**
 * How many particles one beat's effects throw in all, shared out across whatever lands at once: four deaths
 * together look about as busy as two (2026-10-23: four creatures dying ran 232 animations at 40 fps).
 */

/** The particles one beat may throw: about one shatter's or one big crash's worth, and a little more. */
export const PARTICLE_BUDGET = 60;

/** The share of its full count each effect of a beat throws, when together they would throw `wanted`. */
export function particleShare(wanted: number, budget: number = PARTICLE_BUDGET): number {
  return wanted <= budget ? 1 : budget / wanted;
}

/** `full` particles at `share`, rounded down so a beat stays inside its budget, never fewer than `floor` (or `full`, if that is fewer): an effect never vanishes. */
export function shared(full: number, share: number, floor: number): number {
  return Math.max(Math.min(full, floor), Math.floor(full * share));
}

/** What each board's overlay has drawn or scheduled: how many particles, on screen from when until when (epoch ms). */
const pools = new WeakMap<Element, { from: number; until: number; count: number }[]>();

/**
 * The particles one effect on `root` may throw between `fromMs` and `untilMs`: what is left of the budget once
 * every other effect on screen then took its own, whatever its kind and whenever it asked (2026-10-25: a
 * thirteen-creature wipe, each kind inside its own budget, ran at 34 fps). First come, first served; never fewer
 * than `floor` (or `want`, if that is fewer).
 */
export function claimParticles(root: Element, want: number, floor: number, fromMs: number, untilMs: number, budget: number = PARTICLE_BUDGET): number {
  const now = Date.now();
  const pool = (pools.get(root) ?? []).filter((e) => e.until > now);
  const busy = pool.reduce((n, e) => (e.from < untilMs && e.until > fromMs ? n + e.count : n), 0);
  const granted = Math.max(Math.min(want, floor), Math.min(want, budget - busy));
  pool.push({ from: fromMs, until: untilMs, count: granted });
  pools.set(root, pool);
  return granted;
}

/** One board's pool, as a context hands it to an effect. */
export type ParticlePool = (want: number, floor: number, fromMs: number, untilMs: number) => number;

export const particlePool = (root: Element, budget = PARTICLE_BUDGET): ParticlePool => (want, floor, from, until) => claimParticles(root, want, floor, from, until, budget);
