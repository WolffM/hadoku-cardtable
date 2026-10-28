/*
 * What a hit looks like on its way: a projectile that slings off its source, out and back first, then
 * accelerates in, trailing fire, and slams into what it hits (AF420, the operator, 2026-10-27: "some
 * randomization to the arc … follow the creature attack animation style … a 'sling' look … first arc
 * away then arc towards the target with increasing acceleration"). It started simpler — the operator,
 * 2026-10-15, of a sweeper's hits: *"i would prefer if a fiery ball took a semi-random arc and
 * accelerated to slam into the cards. we dont have to show a number, just the impact would be fine."*
 *
 * ## The path
 *
 * A cubic Bezier (`slingFrames`): from the source, pulled BACK away from the target and out to one
 * side first — further the heavier the blow — then swinging in. Which side, how far back and how far
 * out come from the hit's own key, so a sweeper's balls fan out instead of flying in a bundle, and a
 * hit is drawn the same way every time it is drawn — seeded PER RESOLUTION (the face-hit key carries
 * the stack item's own id), so two casts at the same player still fly their own arcs. The two control
 * points are clamped inside the overlay: a Bezier never leaves the hull of its own control points, so
 * the flight never carries off the board. The ball runs the curve on an accelerating ease (`motion.ts`'s
 * `powerEase`): slow and winding up off the source, fastest at the end — more so for a heavier hit, in
 * the same time (the ram's own punch: a heavy blow creeps at the back of its swing and whips in).
 *
 * ## The trail and the slam
 *
 * `trail` sheds embers along the path the ball actually travelled, cooling from its own colour to
 * smoke. `impact` draws the slam as `explode`: a flash, a fireball of puffs, a shockwave ring, spark
 * streaks on their own arcs, and falling embers for a heavy blow — every particle swarm shared out of
 * the board's pool (`effect-budget.ts`), never each effect's full count.
 *
 * ## Looks
 *
 * A look is a name in {@link ProjectileLook}, and its rules are in `projectile.css`
 * (`.effect-hit[data-projectile="<name>"]`, its trail, its blast). `bolt` is damage, drawn in the
 * colour of the card that dealt it (`data-colour`, a mana letter, `C` for colourless — the operator,
 * 2026-10-15: "make the fireball color match the spell's color"); `heal` is life gained, which keeps
 * its own look but takes the same trail and sling as a bolt.
 *
 * Every element is in the board's overlay, never a transform on a card in a row (table-fit).
 */

import type { ManaColor } from '@hadoku/shared';

import { BEAT_ANIMATION_ID, damageSize, powerEase } from '../motion.ts';
import { claimParticles } from './effect-budget.ts';

import './projectile.css';

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** Every projectile look, by name. Its CSS is `projectile.css`. */
export type ProjectileLook = 'bolt' | 'heal';

/** The blast's own life at no power; it runs longer the heavier the blow (`explode`'s own `life`). */
const IMPACT_MS = 420;
/** Samples of the sling's own path. */
const SAMPLES = 16;

/**
 * A small, stable hash of a hit's key: the same key always draws the same arc. FNV-1a alone barely
 * moves when only a key's LAST character differs (measured: `…:pr1`…`:pr8` landed within 0.351–0.398,
 * every seeded visual whose key ends in a counter — a sweeper's balls, AF413's cracks `l${i}`/`w${i}`/
 * `t${i}` — nearly uniform), so the hash is finished with a murmur3 `fmix32`: every bit of the input
 * spreads before the division, deterministic on both screens either way.
 */
export function seedOf(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** The point at `t` (0–1) on a quadratic curve — `ram.ts`'s own, straighter path for a creature's blow. */
export function along(start: Point, control: Point, end: Point, t: number): Point {
  const u = 1 - t;
  return { x: u * u * start.x + 2 * u * t * control.x + t * t * end.x, y: u * u * start.y + 2 * u * t * control.y + t * t * end.y };
}

/**
 * The sling's path: a cubic Bezier from `start` to `end` that first swings AWAY from the target —
 * pulled back by `8 + (0.05..0.17)·d·power` and out to a seeded side by `0.10..0.26·d` — then curves in.
 * Each cast its own side, bend and pull, seeded by `key`; `size` scales the ball (`damageSize`, bigger
 * for a heavier hit) — applied last, inside the transform, never as a separate CSS `scale`, which would
 * scale the flight with it and send a heavy bolt past its target. The two control points are clamped
 * `16px` inside `bounds` (the overlay's own size): a Bezier never leaves the hull of its control
 * points, so the flight never carries off the board (measured: 0 off-board frames).
 */
export function slingFrames(start: Point, end: Point, power: number, size: number, key: string, bounds: { w: number; h: number }): Keyframe[] {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const d = Math.hypot(dx, dy) || 1;
  const ux = dx / d;
  const uy = dy / d;
  const nx = -uy;
  const ny = ux;
  const side = seedOf(`${key}:side`) < 0.5 ? -1 : 1;
  const bend = (0.1 + 0.16 * seedOf(`${key}:bend`)) * d * side;
  const back = 8 + (0.05 + 0.12 * power) * d * (0.8 + 0.4 * seedOf(`${key}:back`));
  // The curve stays inside its control points: keeping them on the board keeps the whole flight on it.
  const pad = 16;
  const inside = (q: Point): Point => ({ x: Math.min(bounds.w - pad, Math.max(pad, q.x)), y: Math.min(bounds.h - pad, Math.max(pad, q.y)) });
  const p1 = inside({ x: start.x - ux * back + nx * bend, y: start.y - uy * back + ny * bend });
  const reach = 0.45 + 0.2 * seedOf(`${key}:reach`);
  const p2 = inside({ x: start.x + ux * d * reach + nx * bend * 0.9, y: start.y + uy * d * reach + ny * bend * 0.9 });
  return Array.from({ length: SAMPLES + 1 }, (_, i) => {
    const t = i / SAMPLES;
    const u = 1 - t;
    const x = u * u * u * start.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * end.x;
    const y = u * u * u * start.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * end.y;
    const scale = (0.45 + 0.55 * Math.min(1, t / 0.3)) * size;
    return { transform: `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%) scale(${scale.toFixed(3)})` };
  });
}

/**
 * Fly a projectile of `look` from `start` to `end` (overlay coordinates) over `ms`, inside `root`, on
 * its sling's path (`slingFrames`), trailing fire behind it (`trail`). Returns the ball, marked
 * `data-hit=<key>` while it flies; it and its trail remove themselves when they arrive. Without the Web
 * Animations API (a test's DOM) the ball is placed at the end at once and trails nothing.
 */
export function fly(root: HTMLElement, start: Point, end: Point, key: string, look: ProjectileLook, ms: number, hue: ManaColor | null = null, power: number | null = null): HTMLElement {
  const p = power ?? 1;
  const size = power === null ? 1 : damageSize(power);
  const frames = slingFrames(start, end, p, size, key, { w: root.clientWidth, h: root.clientHeight });
  const ball = document.createElement('div');
  ball.className = 'effect-hit';
  ball.setAttribute('aria-hidden', 'true');
  ball.dataset.projectile = look;
  ball.dataset.colour = hue ?? 'C';
  ball.dataset.hit = key;
  root.append(ball);
  if (typeof ball.animate !== 'function') {
    ball.style.transform = frames[frames.length - 1]!.transform as string;
    return ball;
  }
  ball.animate(frames, { id: BEAT_ANIMATION_ID, duration: ms, easing: powerEase(p), fill: 'both' }).finished.then(
    () => ball.remove(),
    () => ball.remove(),
  );
  trail(root, ball, look, key, ms, power ?? 0, Math.hypot(end.x - start.x, end.y - start.y));
  return ball;
}

/**
 * The fire trail: every frame the ball is in flight it sheds an ember where it is, centred on the path
 * — never behind it, never beside it. Each one shrinks, cools from its own colour through the flame to
 * smoke, and drifts off as it fades: more, bigger and longer-lived the heavier the blow. One ember
 * roughly every `5 - 2·power` px of the ball's own travel, however fast it moves, so the trail is
 * unbroken on a fast screen and on a slow one alike. The whole trail's embers are claimed once from the
 * board's particle pool (`effect-budget.ts`), estimated from the flight's straight-line `distance` (the
 * sling's own path runs a little longer), so a busy board throttles the trail rather than ignoring the
 * budget. The claim's window ends when the flight does, not past it: `impact`'s own explosion is the
 * SAME hit's next beat, not a rival one, and must find the trail's reservation already freed.
 */
function trail(root: HTMLElement, ball: HTMLElement, look: ProjectileLook, key: string, ms: number, power: number, distance: number): void {
  const t0 = performance.now();
  const now = Date.now();
  const spacing = 5 - 2 * power;
  const wanted = Math.max(2, Math.round((distance * 1.5) / spacing));
  const budget = claimParticles(root, wanted, 2, now, now + ms);
  let n = 0;
  let last: { x: number; y: number } | null = null;
  const tick = (): void => {
    if (!ball.isConnected || performance.now() - t0 > ms || n >= budget) return;
    const r = ball.getBoundingClientRect();
    const b = root.getBoundingClientRect();
    const here = { x: r.left - b.left + r.width / 2, y: r.top - b.top + r.height / 2 };
    const from = last ?? here;
    const steps = Math.min(budget - n, Math.max(1, Math.round(Math.hypot(here.x - from.x, here.y - from.y) / spacing)));
    for (let k = 1; k <= steps; k++) {
      const s = (q: string): number => seedOf(`${key}:t${n}:${q}:mix`);
      n++;
      const f = k / steps;
      const x = from.x + (here.x - from.x) * f;
      const y = from.y + (here.y - from.y) * f;
      const el = document.createElement('span');
      el.className = 'effect-trail';
      el.setAttribute('aria-hidden', 'true');
      el.dataset.projectile = look;
      el.dataset.colour = ball.dataset.colour ?? 'C';
      const size = r.width * (0.55 + 0.35 * s('z'));
      Object.assign(el.style, { left: `${x + (s('x') - 0.5) * r.width * 0.25}px`, top: `${y + (s('y') - 0.5) * r.width * 0.25}px`, width: `${size}px`, height: `${size}px` });
      root.append(el);
      const life = (180 + 240 * power) * (0.75 + 0.5 * s('l'));
      if (typeof el.animate === 'function') {
        // Centred on the path: the drift is added to the -50% that centres it, never in place of it
        // (v3's bug — the drift's own `translate` replaced the centring, so every ember sat half its
        // own size down-right of the path it was supposed to follow).
        el.animate(
          [
            { scale: '0.9', opacity: 0.85, translate: '-50% -50%' },
            { scale: '0.15', opacity: 0, translate: `calc(-50% + ${((s('dx') - 0.5) * 10).toFixed(1)}px) calc(-50% + ${(-4 - 10 * s('dy')).toFixed(1)}px)` },
          ],
          { duration: life, easing: 'ease-out', fill: 'forwards' },
        ).finished.then(
          () => el.remove(),
          () => el.remove(),
        );
      } else {
        setTimeout(() => el.remove(), life);
      }
    }
    last = here;
    if (n < budget) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** The slam where a projectile of `look` landed: `explode`'s burst, at `at`. */
export function impact(root: HTMLElement, at: Point, look: ProjectileLook, key: string, hue: ManaColor | null = null, power: number | null = null): HTMLElement {
  const burst = document.createElement('div');
  burst.className = 'effect-impact';
  burst.setAttribute('aria-hidden', 'true');
  burst.dataset.projectile = look;
  burst.dataset.colour = hue ?? 'C';
  burst.dataset.impact = key;
  burst.style.left = `${at.x}px`;
  burst.style.top = `${at.y}px`;
  return explode(root, burst, key, power ?? 0);
}

/**
 * The explosion: a white-hot flash; a fireball of puffs clustered round the point of impact (the
 * first the white-hot heart), billowing out and leaving smoke ghosts; a shockwave ring from 3 damage
 * up; spark streaks each on their own arc (length, speed, distance, gravity); falling embers for a
 * heavy blow. Every particle swarm (puffs, sparks, falling embers) is claimed once from the board's
 * particle pool (`effect-budget.ts`), never each swarm's full count on a busy board. A heavier blow
 * throws MORE puffs, not bigger ones (the operator, 2026-10-27: "the large balls that spawn after the
 * explosion animations look a bit distracting. maybe dont have those scale with size"). All in the
 * bolt's own colour (`burst.dataset.colour`, read by `projectile.css`'s `--bolt*`).
 */
function explode(root: HTMLElement, burst: HTMLElement, key: string, power: number): HTMLElement {
  // The varying part is never last: `seedOf` barely moves when only a key's final character does.
  const r = (q: string): number => seedOf(`${key}:x:${q}:mix`);
  const now = Date.now();
  const life = Math.round(IMPACT_MS + 520 * power);
  burst.classList.add('effect-blast');
  burst.style.setProperty('--blast-ms', `${life}ms`);
  const add = (cls: string): HTMLElement => {
    const el = document.createElement('span');
    el.className = cls;
    burst.append(el);
    return el;
  };
  // The flash: white-hot, gone in a blink.
  const flash = add('effect-blast__flash');
  flash.style.setProperty('--r', `${Math.round(20 * damageSize(power))}px`);
  // The fireball: puffs around the point of impact, each its own size, lag and drift — more of them
  // the heavier the blow, never bigger ones.
  const puffsWanted = 3 + Math.round(6 * power);
  const puffs = claimParticles(root, puffsWanted, 2, now, now + life);
  for (let i = 0; i < puffs; i++) {
    const el = add('effect-blast__puff');
    // Clustered, not a ring: random angles, most puffs near the middle, the first the biggest and hottest.
    const a = r(`pa${i}`) * Math.PI * 2;
    const off = i === 0 ? 0 : (6 + 12 * power) * Math.sqrt(r(`po${i}`));
    const rad = 13 * (i === 0 ? 1.2 : 0.55 + 0.45 * r(`pr${i}`));
    if (i === 0) el.dataset.core = '';
    Object.assign(el.style, { left: `${Math.cos(a) * off - rad}px`, top: `${Math.sin(a) * off - rad}px`, width: `${rad * 2}px`, height: `${rad * 2}px` });
    el.style.setProperty('--drift-x', `${Math.cos(a) * (8 + 14 * power)}px`);
    el.style.setProperty('--drift-y', `${Math.sin(a) * (8 + 14 * power) - 8}px`);
    el.style.animationDelay = `${Math.round(r(`pd${i}`) * 70)}ms`;
  }
  // The shockwave: one ring, as wide as the blow.
  if (power > 0.15) {
    const ring = add('effect-blast__ring');
    ring.style.setProperty('--r', `${Math.round(30 + 90 * power)}px`);
  }
  // Sparks: streaks, each thrown on its own arc.
  const sparksWanted = 6 + Math.round(22 * power);
  const sparks = claimParticles(root, sparksWanted, 3, now, now + life);
  for (let i = 0; i < sparks; i++) {
    const el = add('effect-blast__spark');
    const a = (i / sparks) * 360 + r(`sa${i}`) * (360 / sparks) * 1.6;
    const far = (30 + 90 * power) * (0.45 + 0.75 * r(`sd${i}`));
    const rad = (a * Math.PI) / 180;
    const dx = Math.cos(rad) * far;
    const dy = Math.sin(rad) * far;
    el.style.width = `${Math.round(5 + (8 + 10 * power) * r(`sl${i}`))}px`;
    el.style.rotate = `${a}deg`;
    const ms = Math.round((300 + 380 * power) * (0.6 + 0.6 * r(`st${i}`)));
    if (typeof el.animate === 'function') {
      el.animate(
        [
          { translate: '0 0', opacity: 1 },
          { translate: `${dx * 0.6}px ${dy * 0.6 - 6}px`, opacity: 1, offset: 0.45 },
          { translate: `${dx}px ${dy + 10 + 30 * power * r(`sg${i}`)}px`, opacity: 0 },
        ],
        { duration: ms, easing: 'cubic-bezier(0.15, 0.7, 0.35, 1)', fill: 'forwards' },
      );
    }
  }
  // Embers falling after a heavy blow.
  const fallingWanted = power < 0.45 ? 0 : Math.round(3 + 8 * (power - 0.45));
  const falling = fallingWanted === 0 ? 0 : claimParticles(root, fallingWanted, 0, now, now + life + 1300);
  for (let i = 0; i < falling; i++) {
    const el = add('effect-blast__ember');
    const x = (r(`ex${i}`) - 0.5) * (40 + 80 * power);
    if (typeof el.animate === 'function') {
      el.animate(
        [
          { translate: `${x * 0.4}px ${-10 - 20 * r(`ey${i}`)}px`, opacity: 0 },
          { opacity: 1, offset: 0.15 },
          { translate: `${x}px ${30 + 50 * r(`ef${i}`)}px`, opacity: 0 },
        ],
        { duration: Math.round(700 + 600 * r(`et${i}`)), delay: Math.round(120 + 200 * r(`ed${i}`)), easing: 'ease-in', fill: 'both' },
      );
    }
  }
  root.append(burst);
  setTimeout(() => burst.remove(), life + 1300);
  return burst;
}
