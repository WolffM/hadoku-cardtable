/*
 * From the ban/pick board into choosing a deck (`arrive.ts`), as data: which step change is drawn
 * as a transition, and what moves where, when, for how long — with no layout engine in the way.
 */
import { describe, expect, it } from 'vitest';

import type { GauntletView } from '@hadoku/shared';

import { CROSSFADE_MS, boardToLeave, flightFrames, plan, planMs, trackSizes, type Box, type Measured } from './arrive.ts';

const at = (phase: GauntletView['phase']): GauntletView => ({ phase }) as GauntletView;

describe('the step drawn as a transition', () => {
  it('is the step out of ban/pick into the choice, and leaves the board as it was last drawn', () => {
    const board = at('banpick');
    expect(boardToLeave(board, at('choose'))).toBe(board);
  });

  it('is no other step: a reload onto the choice, game 2’s choice, the reveal ending, a game starting', () => {
    expect(boardToLeave(null, at('choose'))).toBeNull();
    expect(boardToLeave(at('choose'), at('choose'))).toBeNull();
    expect(boardToLeave(at('playing'), at('choose'))).toBeNull();
    expect(boardToLeave(at('reveal'), at('banpick'))).toBeNull();
    expect(boardToLeave(at('choose'), at('playing'))).toBeNull();
  });
});

/** Two seats of three: P1's left, P2's right, each deck coming from a column tile or (the last pick) the pool. */
function measured(): Measured<string> {
  const column = (x: number, i: number): Box => ({ x, y: 80 + i * 94, w: 190, h: 86 });
  const seat = (x: number, i: number): Box => ({ x: x + i * 205, y: 70, w: 197, h: 197 });
  return {
    board: 'board',
    content: ['title', 'seats'],
    tiles: [
      { el: 'p1-a', from: column(0, 0), to: seat(0, 0), rows: [[56, 30, 0], [149, 26, 22]], reveal: ['p1-a-pilot'] },
      { el: 'p1-b', from: column(0, 1), to: seat(0, 1) },
      { el: 'p1-c', from: column(0, 2), to: seat(0, 2) },
      { el: 'p2-a', from: column(1050, 0), to: seat(620, 0) },
      { el: 'p2-b', from: column(1050, 1), to: seat(620, 1) },
      { el: 'p2-c', from: { x: 600, y: 220, w: 167, h: 133 }, to: seat(620, 2) },
    ],
    banned: ['ban-1', 'ban-2', 'ban-3', 'ban-4'],
    fading: ['slot', 'turn'],
    carried: [
      { el: 'era', from: { x: 500, y: 10, w: 160, h: 30 }, to: { x: 450, y: 10, w: 160, h: 30 } },
      { el: 'name-p2', from: { x: 1100, y: 50, w: 120, h: 20 }, to: { x: 620, y: 40, w: 120, h: 20 } },
    ],
    arriving: ['game', 'pill-p1', 'pill-p2'],
    rows: [
      { el: 'row-p1', h: 197 },
      { el: 'row-p2', h: 197 },
    ],
    screen: { el: 'screen', from: 420, to: 300 },
  };
}

const CHOOSE_SCREEN = new Set(['screen', 'p1-a-pilot', 'title', 'seats', 'p1-a', 'p1-b', 'p1-c', 'p2-a', 'p2-b', 'p2-c', 'era', 'name-p2', 'game', 'pill-p1', 'pill-p2', 'row-p1', 'row-p2']);
const of = (steps: ReturnType<typeof plan<string>>, el: string) => steps.filter((s) => s.el === el);

describe('the arrival', () => {
  const steps = plan(measured(), false);

  it('lasts between 0.6 s and 1.2 s', () => {
    expect(planMs(steps)).toBeGreaterThanOrEqual(600);
    expect(planMs(steps)).toBeLessThanOrEqual(1200);
  });

  it('flies each surviving deck from the box the board drew it in to its own, sized by its own box at both ends', () => {
    for (const { el, from, to } of measured().tiles) {
      const [step] = of(steps, el);
      const first = step!.keyframes[0]!;
      const last = step!.keyframes.at(-1)!;
      expect(first, el).toMatchObject({ transform: `translate(${from!.x - to.x}px, ${from!.y - to.y}px)`, width: `${from!.w}px`, height: `${from!.h}px` });
      expect(last, el).toMatchObject({ transform: 'translate(0px, 0px)', width: `${to.w}px`, height: `${to.h}px` });
    }
  });

  it('lays a deck out as the board drew it on its first frame and as its own on its last, and brings in what the board’s tile did not show over the flight', () => {
    const [flight] = of(steps, 'p1-a');
    expect(flight!.keyframes[0]!.gridTemplateRows).toBe('56px 30px 0px');
    expect(flight!.keyframes.at(-1)!.gridTemplateRows).toBe('149px 26px 22px');
    const [pilot] = of(steps, 'p1-a-pilot');
    expect(pilot!.keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    expect(pilot!.timing).toMatchObject({ delay: flight!.timing.delay, duration: flight!.timing.duration });
  });

  it('drops every banned deck off the board, out of sight, and keeps it gone until the board goes', () => {
    for (const el of measured().banned) {
      const [step] = of(steps, el);
      expect(step!.keyframes.at(-1)!.opacity, el).toBe(0);
      expect(step!.keyframes.at(-1)!.transform, el).toMatch(/^translateY\(48px\) rotate\(-?5deg\)$/);
      expect(step!.timing.fill, el).toBe('forwards');
    }
  });

  it('fades the board’s empty slots and turn banner, and eases in what only the choose screen has', () => {
    for (const el of ['slot', 'turn']) expect(of(steps, el)[0]!.keyframes.at(-1)!.opacity).toBe(0);
    for (const el of ['game', 'pill-p1', 'pill-p2']) expect(of(steps, el)[0]!.keyframes[0]!.opacity).toBe(0);
  });

  it('carries the title and the names from where the board drew them, at their own size', () => {
    expect(of(steps, 'name-p2')[0]!.keyframes).toEqual([{ transform: 'translate(480px, 10px)' }, { transform: 'none' }]);
    expect(of(steps, 'era')[0]!.keyframes[0]).toEqual({ transform: 'translate(50px, 0px)' });
  });

  it('holds each row of picks at its own height for the whole length, so nothing under the choose screen moves', () => {
    for (const el of ['row-p1', 'row-p2']) expect(of(steps, el)[0]).toMatchObject({ keyframes: [{ height: '197px' }, { height: '197px' }], timing: { duration: planMs(steps) } });
  });

  it('shortens the choose screen from the board’s height to its own as the decks land, so a scrolled page slides rather than jumps', () => {
    const [step] = of(steps, 'screen');
    expect(step!.keyframes).toEqual([{ height: '420px' }, { height: '300px' }]);
    const landed = Math.max(...measured().tiles.map(({ el }) => Number(of(steps, el)[0]!.timing.delay) + Number(of(steps, el)[0]!.timing.duration)));
    expect(step!.timing.duration).toBe(landed);
  });

  it('leaves nothing on the choose screen held by an animation once it ends: every part is its own layout again', () => {
    for (const step of steps.filter((s) => CHOOSE_SCREEN.has(s.el))) expect([undefined, 'backwards', 'none'], step.el).toContain(step.timing.fill);
  });
});

describe('under prefers-reduced-motion', () => {
  it('is a crossfade alone: the whole board out, the choose screen in, nothing moved or resized', () => {
    const steps = plan(measured(), true);
    expect(steps.map((s) => s.el)).toEqual(['board', 'title', 'seats']);
    expect(steps[0]!.keyframes).toEqual([{ opacity: 1 }, { opacity: 0 }]);
    for (const s of steps.slice(1)) expect(s.keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    expect(planMs(steps)).toBe(CROSSFADE_MS);
  });
});

describe('a flight', () => {
  it('straight: from the old box to the new, two frames', () => {
    expect(flightFrames({ x: 10, y: 20, w: 100, h: 50 }, { x: 0, y: 0, w: 200, h: 200 })).toEqual([
      { transform: 'translate(10px, 20px)', width: '100px', height: '50px' },
      { transform: 'translate(0px, 0px)', width: '200px', height: '200px' },
    ]);
  });

  it('with rows: each end laid out in its own', () => {
    const frames = flightFrames({ x: 0, y: 0, w: 100, h: 100 }, { x: 0, y: 0, w: 200, h: 200 }, [
      [40, 30, 0],
      [150, 26, 22],
    ]);
    expect(frames.map((f) => f.gridTemplateRows)).toEqual(['40px 30px 0px', '150px 26px 22px']);
  });

  it('a tile’s rows are read in px, and anything else is nothing to move between', () => {
    expect(trackSizes('121.5px 30px')).toEqual([121.5, 30]);
    expect(trackSizes('none')).toBeNull();
    expect(trackSizes('1fr 30px')).toBeNull();
  });
});
