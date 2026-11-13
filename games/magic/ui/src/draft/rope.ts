/*
 * The draft rope's clock: where the fuse is drawn at any moment of a pick.
 *
 * The time is the server's. Each envelope says how much of the pick was left
 * when it left the server (`viewer.timer.msLeft`), and the page turns that into
 * a moment on its own monotonic clock, `endsAt`: when the envelope arrived plus
 * what was left. Every later envelope for the same pick re-anchors it, so the
 * fuse is always drawn from the server's latest word, never from when the page
 * mounted (the operator, 2026-11-07: "it finished its animation maybe ~10s
 * before it actually picked a card" — a running CSS animation whose delay was
 * rewritten by each envelope, measured from the first one).
 *
 * The fuse drains on a curve, not a line (the operator: "visually slows down
 * as it nears zero (to create more pressure near the end of the timer)"): the
 * share of the fuse left is the share of the burn left raised to a power, so it
 * runs fast at first and crawls at the end, and is empty exactly at the
 * deadline. Never early, never late: the curve only bends the path between the
 * two ends.
 */

/** The share of a pick the rope burns through: its last third (the operator, 2026-10-30). */
const ROPE_SHARE = 1 / 3;

/** The last stretch of a pick that draws the rope as urgent. */
export const ROPE_URGENT_MS = 3_000;

/**
 * How hard the fuse slows toward zero: the fuse left is (burn left)^power. 1 is
 * a straight line; the operator picks from the look artifact's variants.
 */
const ROPE_CURVE_POWER = 2;

export type RopeState = 'waiting' | 'burning' | 'urgent' | 'out';

/** One pick's rope, on the page's own monotonic clock (`performance.now()`). */
interface RopeClock {
  /** When the server's deadline falls, on the page's clock. */
  endsAt: number;
  /** How long the whole pick was given. */
  totalMs: number;
}

/** The rope an envelope describes, anchored at `receivedAt` (when it arrived). */
export function ropeClock(timer: { totalMs: number; msLeft: number }, receivedAt: number): RopeClock {
  return { endsAt: receivedAt + timer.msLeft, totalMs: timer.totalMs };
}

/** How long the fuse burns for: the last {@link ROPE_SHARE} of the pick. */
export function burnMs(clock: RopeClock): number {
  return clock.totalMs * ROPE_SHARE;
}

/** The rope's state at `now`. */
export function ropeState(clock: RopeClock, now: number): RopeState {
  const left = clock.endsAt - now;
  if (left <= 0) return 'out';
  if (left <= Math.min(ROPE_URGENT_MS, burnMs(clock))) return 'urgent';
  return left <= burnMs(clock) ? 'burning' : 'waiting';
}

/** The share of the fuse still drawn when `burnLeft` (0–1) of the burn is left. */
export function fuseLeft(burnLeft: number, power: number = ROPE_CURVE_POWER): number {
  const r = Math.min(1, Math.max(0, burnLeft));
  return r ** power;
}

/** Samples in the fuse's keyframes: enough that the curve reads smooth between them. */
const KEYFRAMES = 24;

/**
 * The fuse's keyframes over the burn, sampled from {@link fuseLeft}: a Web
 * Animation drawn with linear easing between them follows the curve, so the
 * curve has one definition, here.
 */
export function fuseKeyframes(power: number = ROPE_CURVE_POWER): Keyframe[] {
  return Array.from({ length: KEYFRAMES + 1 }, (_, i) => {
    const offset = i / KEYFRAMES;
    return { offset, width: `${(fuseLeft(1 - offset, power) * 100).toFixed(3)}%` };
  });
}

/** The same burn under reduced motion: the fuse stays whole and fades on the same curve. */
export function fuseFadeKeyframes(power: number = ROPE_CURVE_POWER): Keyframe[] {
  return Array.from({ length: KEYFRAMES + 1 }, (_, i) => {
    const offset = i / KEYFRAMES;
    return { offset, opacity: fuseLeft(1 - offset, power).toFixed(4) };
  });
}

/** Where the fuse's burn animation is at `now`, in ms of its `burnMs` (negative before it starts). */
export function burnElapsedAt(clock: RopeClock, now: number): number {
  return burnMs(clock) - (clock.endsAt - now);
}
