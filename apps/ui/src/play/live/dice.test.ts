// @vitest-environment jsdom
/*
 * A die roll on the table (`dice.ts`): what each roll throws, where each die goes, and the die each one
 * lands as — its shape, its face and whose it is.
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { BoardPlayer, BoardView } from '../adapter.ts';
import { diceOf, diePath, facesOf, installDice, nextFace, shapeOf, tumbleFrames } from './dice.ts';
import { shownRoll, type ShownRoll } from './shown.ts';

const rect = (left: number, top: number, width: number, height: number): DOMRect =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

const view = { players: [{ id: 0, isViewer: true } as BoardPlayer, { id: 1, isViewer: false } as BoardPlayer] } as BoardView;

function roll(over: Partial<Parameters<typeof shownRoll>[0]> = {}): ShownRoll {
  return shownRoll({ player: { kind: 'player', id: 0 }, sides: 20, results: [14], source: { kind: 'card', id: 7 }, ...over });
}

function board(): HTMLElement {
  const canvas = document.createElement('div');
  canvas.innerHTML = `
    <div data-zone="battlefield"><ul><li class="board-card" data-board-card="7" data-card-id="7"></li></ul></div>
    <div data-board-overlay=""></div>`;
  canvas.querySelector<HTMLElement>('[data-board-overlay]')!.getBoundingClientRect = () => rect(0, 0, 1000, 800);
  canvas.querySelector<HTMLElement>('[data-board-card="7"]')!.getBoundingClientRect = () => rect(400, 500, 120, 168);
  document.body.append(canvas);
  return canvas;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('a roll as the board draws it', () => {
  it('numbers each roll once, and reads the wire roll into it', () => {
    const a = shownRoll({ player: { kind: 'player', id: 1 }, sides: null, results: [3, 17], ignored: [2], source: null }, 5);
    const b = roll();
    expect(b.id).toBeGreaterThan(a.id);
    expect(a).toMatchObject({ at: 5, player: 1, sides: null, results: [3, 17], ignored: [2], source: null });
    expect(b.ignored).toEqual([]);
  });

  it('throws one die per result, and the ignored ones after them', () => {
    expect(diceOf(shownRoll({ player: { kind: 'player', id: 0 }, sides: 20, results: [9, 15], ignored: [4], source: null }))).toEqual([
      { result: 9, ignored: false },
      { result: 15, ignored: false },
      { result: 4, ignored: true },
    ]);
  });

  it('draws pips for a d6 and the d20 hexagon for every other die', () => {
    expect(shapeOf(6)).toBe('d6');
    for (const sides of [4, 8, 10, 12, 20, null]) expect(shapeOf(sides)).toBe('d20');
  });

  it('flickers through the die’s own faces, a d20’s when the sides are unknown, and never past the result', () => {
    expect(facesOf(6, 4)).toBe(6);
    expect(facesOf(null, 7)).toBe(20);
    expect(facesOf(null, 37)).toBe(37);
    for (const faces of [6, 20]) {
      for (let n = 1; n <= faces; n++) {
        for (const r of [0, 0.5, 0.99]) {
          const next = nextFace(n, faces, r);
          expect(next).toBeGreaterThanOrEqual(1);
          expect(next).toBeLessThanOrEqual(faces);
          expect(next).not.toBe(n);
        }
      }
    }
  });
});

describe('where a die goes', () => {
  const card = { left: 400, top: 500, width: 120, height: 168 };
  const overlay = { width: 1000, height: 800 };

  it('drops from the card’s centre and settles beside it, toward the table’s middle and the roller’s own edge', () => {
    const left = { ...card, left: 100 };
    const right = { ...card, left: 780 };
    const mine = diePath(left, overlay, true, 0);
    expect(mine.sx + mine.size / 2).toBe(160);
    expect(mine.sy + mine.size / 2).toBe(584);
    expect(mine.ex).toBeGreaterThan(left.left + left.width);
    expect(mine.dir).toBe(1);
    expect(mine.ey).toBeGreaterThan(mine.sy);
    const theirs = diePath(right, overlay, false, 0);
    expect(theirs.ex + theirs.size).toBeLessThan(right.left);
    expect(theirs.dir).toBe(-1);
    expect(theirs.ey).toBeLessThan(theirs.sy);
  });

  it('puts each further die of a roll a step further out', () => {
    expect(diePath(card, overlay, true, 1).ex).toBeGreaterThan(diePath(card, overlay, true, 0).ex);
    const right = { ...card, left: 780 };
    expect(diePath(right, overlay, false, 1).ex).toBeLessThan(diePath(right, overlay, false, 0).ex);
  });

  it('settles on the card’s other side when its own side has no room, and never leaves the overlay', () => {
    const nearLeft = { ...card, left: 380, width: 120 };
    const p = diePath(nearLeft, { width: 600, height: 800 }, true, 0);
    expect(p.ex + p.size).toBeLessThanOrEqual(nearLeft.left);
    const tiny = diePath({ left: 0, top: 0, width: 40, height: 56 }, { width: 60, height: 60 }, false, 3);
    expect(tiny.ex).toBeGreaterThanOrEqual(0);
    expect(tiny.ex + tiny.size).toBeLessThanOrEqual(60);
  });

  it('turns two full turns the way it rolls, from .6 scale to full', () => {
    const frames = tumbleFrames(diePath({ ...card, left: 100 }, overlay, true, 0));
    expect(String(frames[0]!.transform)).toContain('scale(.6)');
    expect(String(frames.at(-1)!.transform)).toContain('rotate(720deg)');
    expect(String(tumbleFrames(diePath({ ...card, left: 780 }, overlay, false, 0)).at(-1)!.transform)).toContain('rotate(-720deg)');
  });
});

describe('the die on the board', () => {
  it('lands on the result, beside its card, the seat’s own — with reduced motion, at once', () => {
    const canvas = board();
    const dice = installDice(canvas, { reducedMotion: () => true });
    const r = roll();
    dice.notify([r], view);
    const die = canvas.querySelector<HTMLElement>('[data-board-overlay] .board-die')!;
    expect(die).not.toBeNull();
    expect(die.dataset).toMatchObject({ die: String(r.id), dieSides: '20', dieResult: '14', dieFace: '14', dieRoller: 'you' });
    expect('dieLanded' in die.dataset).toBe(true);
    expect(die.querySelector('.board-die__num')!.textContent).toBe('14');
    // Once: the same roll, seen again with the next view, draws nothing more.
    dice.notify([r], view);
    expect(canvas.querySelectorAll('.board-die')).toHaveLength(1);
    dice.dispose();
    expect(canvas.querySelectorAll('.board-die')).toHaveLength(0);
  });

  it('draws a d6’s result as pips, and the other seat’s die as theirs', () => {
    const canvas = board();
    const dice = installDice(canvas, { reducedMotion: () => true });
    dice.notify([roll({ player: { kind: 'player', id: 1 }, sides: 6, results: [5] })], view);
    const die = canvas.querySelector<HTMLElement>('.board-die')!;
    expect(die.dataset.dieRoller).toBe('them');
    expect(die.querySelectorAll('.board-die__pip')).toHaveLength(5);
    dice.dispose();
  });

  it('throws every die of a roll, the ignored one dimmed', () => {
    const canvas = board();
    const dice = installDice(canvas, { reducedMotion: () => true });
    dice.notify([roll({ results: [11, 18], ignored: [3] })], view);
    const faces = [...canvas.querySelectorAll<HTMLElement>('.board-die')].map((d) => [d.dataset.dieFace, 'dieIgnored' in d.dataset]);
    expect(faces).toEqual([
      ['11', false],
      ['18', false],
      ['3', true],
    ]);
    dice.dispose();
  });

  it('draws nothing for a roll that arrived long before the board did', () => {
    const canvas = board();
    const dice = installDice(canvas, { reducedMotion: () => true });
    dice.notify([shownRoll({ player: { kind: 'player', id: 0 }, sides: 20, results: [2], source: { kind: 'card', id: 7 } }, Date.now() - 60_000)], view);
    expect(canvas.querySelectorAll('.board-die')).toHaveLength(0);
    dice.dispose();
  });
});
