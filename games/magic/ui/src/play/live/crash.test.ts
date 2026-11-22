// @vitest-environment jsdom
/*
 * A ram's crash (`crash.ts`): rocks as heavy as the damage, and a crash that cleans up.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { boardStage, damagePower } from '../motion.ts';
import { crash, CRASH_MS, rocks, shake } from './crash.ts';
import { claimParticles, PARTICLE_BUDGET } from '@hadoku/ui-shell/motion';
import { fly, impact } from './projectile.ts';
import { recoil, RECOIL_ART } from './recoil.ts';

/** The board's stage, attached to the page every test draws on: `Stage.of` finds it from anything there. */
const stage = boardStage();
stage.attach(document.documentElement);

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
  delete (HTMLElement.prototype as { animate?: unknown }).animate;
});

describe('rocks', () => {
  it('a heavier blow throws more rocks, bigger and further, and they all come down', () => {
    const light = rocks('k', damagePower(1));
    const heavy = rocks('k', damagePower(20));
    expect(heavy.length).toBeGreaterThan(light.length);
    const furthest = (rs: typeof light): number => Math.max(...rs.map((r) => Math.hypot(r.dx, r.dy)));
    expect(furthest(heavy)).toBeGreaterThan(furthest(light));
    expect(Math.max(...heavy.map((r) => r.size))).toBeGreaterThan(Math.max(...light.map((r) => r.size)));
    expect(rocks('k', 0.5), 'the same blow throws the same rocks').toEqual(rocks('k', 0.5));
  });

  it('a share of a beat’s budget throws fewer, never none (`particles.ts`)', () => {
    const full = rocks('k', 1).length;
    expect(rocks('k', 1, 0.5).length).toBe(Math.floor(full / 2));
    expect(rocks('k', 1, 0.01).length).toBeGreaterThan(0);
  });
});

describe('crash', () => {
  it('draws a ring, dust and rocks where it lands, and is gone once they have flown', () => {
    vi.useFakeTimers();
    const root = document.createElement('div');
    document.body.append(root);
    const el = crash(root, { x: 120, y: 80 }, damagePower(3), 'c');
    expect([el.style.left, el.style.top]).toEqual(['120px', '80px']);
    expect(el.querySelectorAll('.effect-crash__ring')).toHaveLength(1);
    expect(el.querySelectorAll('.effect-crash__rock')).toHaveLength(rocks('c', damagePower(3)).length);
    vi.advanceTimersByTime(CRASH_MS + 50);
    expect(root.querySelector('.effect-crash')).toBeNull();
  });

  it('a crash and an impact on a board already full of particles throw only their floors (`particles.ts`)', () => {
    vi.useFakeTimers();
    const root = document.createElement('div');
    document.body.append(root);
    claimParticles(root, PARTICLE_BUDGET, 6, Date.now(), Date.now() + 5000);
    const el = crash(root, { x: 0, y: 0 }, 1, 'c');
    expect([el.querySelectorAll('.effect-crash__rock').length, el.querySelectorAll('.effect-crash__dust').length]).toEqual([4, 2]);
    expect(impact(root, { x: 0, y: 0 }, 'bolt', 'i', 'R', 1).querySelectorAll('.effect-blast__spark')).toHaveLength(3);
  });
});

describe('a blow on the board’s stage', () => {
  it('every Web Animation a crash, a shake or a bolt plays is a beat the pacer counts, and none holds it; a recoil is not one', () => {
    const made: { anim: Animation; el: Element }[] = [];
    HTMLElement.prototype.animate = vi.fn(function (this: HTMLElement) {
      const anim = { id: '', finished: new Promise(() => undefined), cancel: () => undefined } as unknown as Animation;
      made.push({ anim, el: this });
      return anim;
    }) as unknown as typeof HTMLElement.prototype.animate;
    const board = document.createElement('div');
    const root = document.createElement('div');
    board.append(root);
    document.body.append(board);
    const drawing = stage.drawingCount;
    crash(root, { x: 0, y: 0 }, 1, 'stage-c', 1, 2);
    shake(root, 6, 'stage-s', 2);
    fly(root, { x: 0, y: 0 }, { x: 100, y: 100 }, 'stage-f', 'bolt', 400, 'R', 1, 2);
    const blows = made.length;
    expect(blows, 'rocks, a shake and a ball').toBeGreaterThan(3);
    expect(made.every(({ anim }) => stage.isBeat(anim) && anim.playbackRate === 2), 'each a beat, at its tempo').toBe(true);
    expect(stage.drawingCount, 'a blow adds no hold of its own').toBe(drawing);
    const face = document.createElement('div');
    face.append(Object.assign(document.createElement('span'), { className: RECOIL_ART.slice(1) }));
    recoil(face, { x: 0, y: 0 }, { x: 0, y: 10 }, 5, 'stage-r');
    expect(made.slice(blows).map(({ anim }) => stage.isBeat(anim)), 'nothing waits for a recoil').toEqual([false]);
  });
});
