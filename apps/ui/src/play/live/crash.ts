/*
 * The blow of a ram (`ram.ts`): a neutral crash, not an explosion — a ring of dust, chips of rock
 * thrown out and falling, and the table shaking, all as heavy as the damage (the operator,
 * 2026-10-16: "more of something like what hearthstone does with a more neutral crash. hearthstone
 * also has a cool screenshake and dust/rocks fly about depending on how much damage was dealt").
 *
 * Everything is drawn in the board's overlay. The shake moves the board itself, so for its length
 * the board's container clips its paint (`[data-shaking]`): a board moved a few pixels must never
 * give the page a scrollbar (table-fit). Reduced motion: none of it.
 */

import { powerSize } from '../motion.ts';
import { seedOf } from './projectile.ts';
import './crash.css';

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** How long a crash's dust and rocks are drawn. */
export const CRASH_MS = 700;
/** On the board's container while the board shakes: it clips, so the page never scrolls for it. */
export const SHAKING_ATTR = 'data-shaking';

/** A rock thrown by a crash: where it lands from the blow (px), how high it is thrown, its size and spin. */
export interface Rock {
  readonly dx: number;
  readonly dy: number;
  readonly lift: number;
  readonly size: number;
  readonly spin: number;
}

/** The rocks a crash of `power` throws: more, bigger and further the heavier. Seeded by `key`. */
export function rocks(key: string, power: number): Rock[] {
  const count = 6 + Math.round(14 * power);
  const reach = 34 + 70 * power;
  return Array.from({ length: count }, (_, i) => {
    const r = (k: string): number => seedOf(`${key}:${i}:${k}`);
    const angle = (i / count) * Math.PI * 2 + r('a') * 0.8;
    const far = reach * (0.45 + 0.55 * r('d'));
    return {
      dx: Math.cos(angle) * far,
      // Thrown up and out, and landing lower than it started: rocks fall.
      dy: Math.sin(angle) * far * 0.6 + 14 + 18 * r('f'),
      lift: 16 + 30 * power * r('l'),
      size: (2.5 + 4.5 * r('s')) * powerSize(power),
      spin: (r('r') - 0.5) * 540,
    };
  });
}

/** Draw a crash at `at` (overlay coordinates) inside `root`; it removes itself. */
export function crash(root: HTMLElement, at: Point, power: number, key: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'effect-crash';
  el.setAttribute('aria-hidden', 'true');
  el.dataset.crash = key;
  el.style.left = `${at.x}px`;
  el.style.top = `${at.y}px`;
  el.style.setProperty('--power-size', powerSize(power).toFixed(2));
  el.style.setProperty('--crash-ms', `${CRASH_MS}ms`);
  const ring = document.createElement('span');
  ring.className = 'effect-crash__ring';
  el.append(ring);
  for (let i = 0; i < 3 + Math.round(4 * power); i++) {
    const puff = document.createElement('span');
    puff.className = 'effect-crash__dust';
    const a = (i / 7) * Math.PI * 2 + seedOf(`${key}:p${i}`) * 1.2;
    puff.style.setProperty('--dx', `${(Math.cos(a) * (18 + 26 * power)).toFixed(1)}px`);
    puff.style.setProperty('--dy', `${(Math.sin(a) * (10 + 14 * power) - 6).toFixed(1)}px`);
    el.append(puff);
  }
  for (const rock of rocks(key, power)) {
    const chip = document.createElement('span');
    chip.className = 'effect-crash__rock';
    chip.style.width = chip.style.height = `${rock.size.toFixed(1)}px`;
    el.append(chip);
    if (typeof chip.animate === 'function') {
      chip.animate(
        [
          { translate: '0px 0px', rotate: '0deg', opacity: 1 },
          { offset: 0.4, translate: `${(rock.dx * 0.55).toFixed(1)}px ${(rock.dy * 0.4 - rock.lift).toFixed(1)}px`, opacity: 1 },
          { translate: `${rock.dx.toFixed(1)}px ${rock.dy.toFixed(1)}px`, rotate: `${rock.spin.toFixed(0)}deg`, opacity: 0 },
        ],
        { duration: CRASH_MS * (0.75 + 0.25 * seedOf(`${key}:t`)), easing: 'cubic-bezier(0.2, 0.6, 0.5, 1)', fill: 'forwards' },
      );
    }
  }
  root.append(el);
  setTimeout(() => el.remove(), CRASH_MS + 50);
  return el;
}

/**
 * How far the table shakes (px) for a blow of each amount of damage, 0 to 20: barely at all until it
 * is heavy (the operator, 2026-10-16: "screenshake should be very subtle at 5dmg. i think 7damage is
 * when i'd expect that level of screenshake"), then on up to twenty. A table, not a curve, so each
 * step can be tuned on its own.
 */
export const SHAKE_PX: readonly number[] = [0, 0, 0.5, 1, 1.5, 2.5, 4.5, 7, 8, 9, 10, 10.6, 11.2, 11.8, 12.4, 13, 13.6, 14.2, 14.8, 15.4, 16];

/** How far and how long the table shakes for a blow of `amount` damage; nothing for one point, the twenty's beyond it. */
export function shakeOf(amount: number): { px: number; ms: number } {
  const px = SHAKE_PX[Math.min(SHAKE_PX.length - 1, Math.max(0, Math.round(amount)))]!;
  return { px, ms: px === 0 ? 0 : Math.round(160 + 22 * px) };
}

/**
 * Shake `board` for a blow of `amount` damage: a few quick, dying jolts. Its container clips while it
 * does. Returns a cancel.
 */
export function shake(board: HTMLElement, amount: number, key: string): () => void {
  const { px, ms } = shakeOf(amount);
  if (typeof board.animate !== 'function' || px === 0) return () => undefined;
  const frames: Keyframe[] = [{ translate: '0px 0px' }];
  const jolts = 6;
  for (let i = 1; i < jolts; i++) {
    const fade = 1 - i / jolts;
    const a = seedOf(`${key}:j${i}`) * Math.PI * 2;
    frames.push({ translate: `${(Math.cos(a) * px * fade).toFixed(1)}px ${(Math.sin(a) * px * fade).toFixed(1)}px` });
  }
  frames.push({ translate: '0px 0px' });
  const holder = board.parentElement;
  holder?.setAttribute(SHAKING_ATTR, '');
  const anim = board.animate(frames, { duration: ms, easing: 'linear', composite: 'add' });
  const done = (): void => holder?.removeAttribute(SHAKING_ATTR);
  anim.finished.then(done, done);
  return () => anim.cancel();
}
