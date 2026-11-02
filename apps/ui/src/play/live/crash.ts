/*
 * The blow of a ram (`ram.ts`): a neutral crash, not an explosion — a ring of dust, chips of rock
 * thrown out and falling, and the table shaking (`shake`, as far as `quake.ts` says), all as heavy as the damage (the operator,
 * 2026-10-16: "more of something like what hearthstone does with a more neutral crash. hearthstone
 * also has a cool screenshake and dust/rocks fly about depending on how much damage was dealt").
 *
 * Everything is drawn in the board's overlay. The shake moves the board itself, so for its length
 * the board's container clips its paint (`[data-shaking]`): a board moved a few pixels must never
 * give the page a scrollbar (table-fit). Reduced motion: none of it.
 */

import { BEAT_ANIMATION_ID, damageSize } from '../motion.ts';
import { seedOf } from './projectile.ts';
import { claimParticles, shared } from './effect-budget.ts';
import { markTempo, quicken } from './tempo.ts';
import './crash.css';

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** How long a crash's dust and rocks are drawn. */
export const CRASH_MS = 700;
/** On the board's container while the board shakes: it clips, so the page never scrolls for it. */
const SHAKING_ATTR = 'data-shaking';

/** A rock thrown by a crash: where it lands from the blow (px), how high it is thrown, its size and spin. */
export interface Rock {
  readonly dx: number;
  readonly dy: number;
  readonly lift: number;
  readonly size: number;
  readonly spin: number;
}

/** A crash's full count of rocks and of dust puffs, at `power`. */
const rockCount = (power: number): number => 6 + Math.round(14 * power);
const puffCount = (power: number): number => 3 + Math.round(4 * power);

/** Every particle a crash of `power` throws at its full count: what a beat's budget (`effect-budget.ts`) is shared against. */
export function crashParticles(power: number): number {
  return rockCount(power) + puffCount(power);
}

/** The rocks a crash of `power` throws: more, bigger and further the heavier, at `share` of the full count, at most `most`. Seeded by `key`. */
export function rocks(key: string, power: number, share = 1, most = Infinity): Rock[] {
  const count = Math.min(most, shared(rockCount(power), share, 4));
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
      size: (2.5 + 4.5 * r('s')) * damageSize(power),
      spin: (r('r') - 0.5) * 540,
    };
  });
}

/** Draw a crash at `at` (overlay coordinates) inside `root`, at `share` of its particles and out of the board's pool; it removes itself. */
export function crash(root: HTMLElement, at: Point, power: number, key: string, share = 1, tempo = 1): HTMLElement {
  const now = Date.now();
  const puffs = claimParticles(root, shared(puffCount(power), share, 2), 2, now, now + CRASH_MS / tempo);
  const thrown = claimParticles(root, shared(rockCount(power), share, 4), 4, now, now + CRASH_MS / tempo);
  const el = document.createElement('div');
  el.className = 'effect-crash';
  el.setAttribute('aria-hidden', 'true');
  el.dataset.crash = key;
  el.style.left = `${at.x}px`;
  el.style.top = `${at.y}px`;
  el.style.setProperty('--power-size', damageSize(power).toFixed(2));
  el.style.setProperty('--crash-ms', `${CRASH_MS}ms`);
  markTempo(el, tempo);
  const ring = document.createElement('span');
  ring.className = 'effect-crash__ring';
  el.append(ring);
  for (let i = 0; i < puffs; i++) {
    const puff = document.createElement('span');
    puff.className = 'effect-crash__dust';
    const a = (i / 7) * Math.PI * 2 + seedOf(`${key}:p${i}`) * 1.2;
    puff.style.setProperty('--dx', `${(Math.cos(a) * (18 + 26 * power)).toFixed(1)}px`);
    puff.style.setProperty('--dy', `${(Math.sin(a) * (10 + 14 * power) - 6).toFixed(1)}px`);
    el.append(puff);
  }
  for (const rock of rocks(key, power, share, thrown)) {
    const chip = document.createElement('span');
    chip.className = 'effect-crash__rock';
    chip.style.width = chip.style.height = `${rock.size.toFixed(1)}px`;
    el.append(chip);
    if (typeof chip.animate === 'function') {
      quicken(
        chip.animate(
          [
            { translate: '0px 0px', rotate: '0deg', opacity: 1 },
            { offset: 0.4, translate: `${(rock.dx * 0.55).toFixed(1)}px ${(rock.dy * 0.4 - rock.lift).toFixed(1)}px`, opacity: 1 },
            { translate: `${rock.dx.toFixed(1)}px ${rock.dy.toFixed(1)}px`, rotate: `${rock.spin.toFixed(0)}deg`, opacity: 0 },
          ],
          { id: BEAT_ANIMATION_ID, duration: CRASH_MS * (0.75 + 0.25 * seedOf(`${key}:t`)), easing: 'cubic-bezier(0.2, 0.6, 0.5, 1)', fill: 'forwards' },
        ),
        tempo,
      );
    }
  }
  root.append(el);
  setTimeout(() => el.remove(), (CRASH_MS + 50) / tempo);
  return el;
}

/** How long a shake of `px` runs: longer the further it goes. */
export function shakeMsOf(px: number): number {
  return px === 0 ? 0 : Math.round(160 + 22 * px);
}

/**
 * Shake `board` by `px`: a few quick, dying jolts, as far and as long as `px` says — a blow's or a
 * landing's (`entries.ts`'s `entryWeight`, the one curve, drawn by `quake.ts`) or a spell's own
 * (`numbers.ts`'s `boltShakePx`). Its container clips while it does. Returns a cancel.
 */
export function shake(board: HTMLElement, px: number, key: string, tempo = 1): () => void {
  const ms = shakeMsOf(px);
  if (typeof board.animate !== 'function' || px <= 0) return () => undefined;
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
  const anim = quicken(board.animate(frames, { id: BEAT_ANIMATION_ID, duration: ms, easing: 'linear', composite: 'add' }), tempo);
  const done = (): void => holder?.removeAttribute(SHAKING_ATTR);
  anim.finished.then(done, done);
  return () => anim.cancel();
}
