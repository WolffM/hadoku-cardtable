/**
 * How many particles one beat's effects throw in all: specks, shards and rocks are shared out across
 * whatever lands at once, never each effect's full count. One creature dying looks as it always did;
 * four dying together look about as busy as two, not four times as busy. The operator's own game,
 * 2026-10-23 (match m-14703a9e2126, Firefox): four creatures died in one combat and the page ran 232
 * animations at once — 102 specks, 26 rocks, 21 shards — at 40 fps; every element is a layer the
 * browser composites on every frame, whatever it moves.
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
 * The particles one effect on `root` may throw between `fromMs` and `untilMs`: what is left of the budget
 * once every other effect on screen in that time has taken its own. One pool for the board, whatever the
 * kind — a crash's rocks and dust, a shatter's specks, an impact's sparks — and whenever it was asked for,
 * so a board wipe's specks, the rams that caused them and the impacts that landed on them are as busy
 * together as one budget, not one each. The operator's game, 2026-10-25 (match m-0a1c953741c7): a
 * thirteen-creature wipe ran 60 specks, 16 sparks and 15 shards at once, each kind inside its own
 * budget, at 34 fps. First come, first served; never fewer than `floor` (or `want`, if that is fewer).
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
