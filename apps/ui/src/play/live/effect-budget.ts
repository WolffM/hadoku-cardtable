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
