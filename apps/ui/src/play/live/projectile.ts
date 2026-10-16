/*
 * What a hit looks like on its way: a projectile that leaves its source on its own curve, speeds up,
 * and slams into what it hits. The operator, 2026-10-15, of a sweeper's hits: *"i would prefer if a
 * fiery ball took a semi-random arc and accelerated to slam into the cards. we dont have to show a
 * number, just the impact would be fine."*
 *
 * ## The path
 *
 * A quadratic curve from start to end, its control point pushed off the straight line sideways by
 * 25–55% of the distance and always lifted a little (`arcControl`). Which side and how far come from
 * the hit's own key, so a sweeper's balls fan out instead of flying in a bundle, and a hit is drawn
 * the same way every time it is drawn. The ball runs that curve on an accelerating ease
 * (`PROJECTILE_EASING`): slow off the source, fastest at the end.
 *
 * ## Looks
 *
 * A look is a name in {@link PROJECTILES} and its rules in `projectile.css`
 * (`.effect-hit[data-projectile="<name>"]`, its trail's embers and its impact). `fire` is damage;
 * `heal` is life gained. A look per colour or per card is a new entry and its CSS.
 *
 * Every element is in the board's overlay, never a transform on a card in a row (table-fit).
 */

import './projectile.css';

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** Every projectile look, by name: how many embers trail it. Its CSS is `projectile.css`. */
export const PROJECTILES = {
  fire: { embers: 3 },
  heal: { embers: 2 },
} as const satisfies Record<string, { readonly embers: number }>;

export type ProjectileLook = keyof typeof PROJECTILES;

/**
 * Slow off the source, then a hard acceleration into the slam — an exponential ease-in (the operator,
 * 2026-10-15: "the fireball should start slow and then accellerate quicker").
 */
export const PROJECTILE_EASING = 'cubic-bezier(0.7, 0, 0.84, 0)';
/** How far behind the ball each ember of its trail runs. */
export const EMBER_LAG_MS = 28;
/** The impact's burst, after the ball lands. */
export const IMPACT_MS = 380;
/** Samples of the curve the animation runs through. */
const SAMPLES = 16;

/** A small, stable hash of a hit's key: the same key always draws the same arc. */
export function seedOf(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

/** The curve's control point: off the straight line to one side, by a share of its length set by `seed`, and lifted. */
export function arcControl(start: Point, end: Point, seed: number): Point {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy) || 1;
  const side = seed < 0.5 ? -1 : 1;
  const bend = (0.25 + ((seed * 2) % 1) * 0.3) * length * side;
  // The unit normal, then a lift toward the top of the screen so no ball skims the table.
  const nx = -dy / length;
  const ny = dx / length;
  return { x: (start.x + end.x) / 2 + nx * bend, y: (start.y + end.y) / 2 + ny * bend - length * 0.15 };
}

/** The point at `t` (0–1) on the curve. */
export function along(start: Point, control: Point, end: Point, t: number): Point {
  const u = 1 - t;
  return { x: u * u * start.x + 2 * u * t * control.x + t * t * end.x, y: u * u * start.y + 2 * u * t * control.y + t * t * end.y };
}

function keyframes(start: Point, control: Point, end: Point): Keyframe[] {
  return Array.from({ length: SAMPLES + 1 }, (_, i) => {
    const p = along(start, control, end, i / SAMPLES);
    return { transform: `translate(${p.x}px, ${p.y}px) translate(-50%, -50%)` };
  });
}

/**
 * Fly a projectile of `look` from `start` to `end` (overlay coordinates) over `ms`, inside `root`.
 * Returns the ball, marked `data-hit=<key>` while it flies; it and its trail remove themselves when
 * they arrive. Without the Web Animations API (a test's DOM) the ball is placed at the end at once.
 */
export function fly(root: HTMLElement, start: Point, end: Point, key: string, look: ProjectileLook, ms: number): HTMLElement {
  const control = arcControl(start, end, seedOf(key));
  const frames = keyframes(start, control, end);
  const make = (ember: number): HTMLElement => {
    const el = document.createElement('div');
    el.className = ember === 0 ? 'effect-hit' : 'effect-hit-ember';
    el.setAttribute('aria-hidden', 'true');
    el.dataset.projectile = look;
    if (ember > 0) el.style.setProperty('--ember', String(ember));
    root.append(el);
    return el;
  };
  const ball = make(0);
  ball.dataset.hit = key;
  if (typeof ball.animate !== 'function') {
    ball.style.transform = frames[frames.length - 1]!.transform as string;
    return ball;
  }
  const run = (el: HTMLElement, delay: number): void => {
    el.animate(frames, { duration: ms, delay, easing: PROJECTILE_EASING, fill: 'both' }).finished.then(
      () => el.remove(),
      () => el.remove(),
    );
  };
  run(ball, 0);
  for (let i = 1; i <= PROJECTILES[look].embers; i++) run(make(i), i * EMBER_LAG_MS);
  return ball;
}

/** The slam where a projectile of `look` landed: a burst and sparks at `at`, gone after {@link IMPACT_MS}. */
export function impact(root: HTMLElement, at: Point, look: ProjectileLook, key: string): HTMLElement {
  const burst = document.createElement('div');
  burst.className = 'effect-impact';
  burst.setAttribute('aria-hidden', 'true');
  burst.dataset.projectile = look;
  burst.dataset.impact = key;
  burst.style.left = `${at.x}px`;
  burst.style.top = `${at.y}px`;
  const seed = seedOf(key);
  for (let i = 0; i < 6; i++) {
    const spark = document.createElement('span');
    spark.className = 'effect-impact__spark';
    spark.style.setProperty('--angle', `${Math.round((i / 6) * 360 + seed * 60)}deg`);
    burst.append(spark);
  }
  root.append(burst);
  setTimeout(() => burst.remove(), IMPACT_MS);
  return burst;
}
