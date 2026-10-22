// @vitest-environment jsdom
/*
 * The pod drawn as one table: who sits where around the ring, which way the
 * arcs point, and the face each seat wears. `DraftScreen.test.ts` and
 * `DraftStates.test.ts` cover what every seat says (waiting, held, watched).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';

import { loadFixtures } from '../draft/fixtures.ts';
import type { DraftView } from '../draft/types.ts';
import { SeatBar } from './SeatBar.tsx';

afterEach(cleanup);

const CHARACTERS = ['rogue', 'sage', 'herald', 'cleric', 'knight', 'mage', 'brawler'];

/** A seat's view mid-draft: the first fixture a seat sees, its seats wearing characters but the last. */
function seatView(seatId: number, passDirection: DraftView['passDirection']): DraftView {
  const base = loadFixtures().find((v) => v.viewer.kind === 'seat')!;
  if (base.viewer.kind !== 'seat') throw new Error('no seat fixture');
  return {
    ...base,
    passDirection,
    viewer: { ...base.viewer, seatId },
    seats: base.seats.map((s, i) => (i < CHARACTERS.length ? { ...s, avatarId: CHARACTERS[i] } : s)),
  };
}

const at = (id: number): { x: number; y: number } => {
  const el = screen.getByTestId(`seat-${id}`);
  return { x: parseFloat(el.style.left), y: parseFloat(el.style.top) };
};

/** Where an arc starts and ends, read off its path. */
function ends(path: SVGPathElement): { from: { x: number; y: number }; to: { x: number; y: number } } {
  const n = (path.getAttribute('d') ?? '').match(/-?\d+(\.\d+)?/g)!.map(Number);
  return { from: { x: n[0]!, y: n[1]! }, to: { x: n[n.length - 2]!, y: n[n.length - 1]! } };
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(a.x - b.x, a.y - b.y);

describe('the pod as a circle', () => {
  it('draws the viewer’s own seat at the bottom', () => {
    render(createElement(SeatBar, { view: seatView(3, 'left') }));
    const ys = [0, 1, 2, 3, 4, 5, 6, 7].map((id) => at(id).y);
    expect(Math.max(...ys)).toBe(at(3).y);
    expect(at(3).x).toBeCloseTo(50, 1);
  });

  for (const [direction, from] of [
    ['left', 2],
    ['right', 4],
  ] as const) {
    it(`passing ${direction}, the one lit arc runs into the viewer from seat ${from}`, () => {
      // The engine's rule: left passes seat s to s + 1, right to s - 1. Seat 3 receives from 2, or from 4.
      const { container } = render(createElement(SeatBar, { view: seatView(3, direction) }));
      const lit = container.querySelectorAll<SVGPathElement>('.podcircle__arc--in');
      expect(lit).toHaveLength(1);
      const arc = ends(lit[0]!);
      const seats = [0, 1, 2, 3, 4, 5, 6, 7];
      const nearest = (p: { x: number; y: number }): number => seats.reduce((best, id) => (dist(at(id), p) < dist(at(best), p) ? id : best));
      expect(nearest(arc.to), 'it ends at the viewer').toBe(3);
      expect(nearest(arc.from), 'it leaves the seat that passes to them').toBe(from);
      expect(container.querySelectorAll('.podcircle__arc'), 'one arc between each pair of neighbours').toHaveLength(8);
    });
  }

  it('draws each seat’s character, and our own mark for a seat with none', () => {
    render(createElement(SeatBar, { view: seatView(0, 'left') }));
    expect(screen.getByTestId('seat-1').querySelector('img')?.getAttribute('src')).toMatch(/\/media\/sprites\/square_sage\.png$/);
    expect(screen.getByTestId('seat-7').querySelector('img')).toBeNull();
    expect(screen.getByTestId('seat-7').querySelector('svg.face__art')).not.toBeNull();
  });

  it('names the viewer’s own seat You, and keeps their name for the tooltip', () => {
    const view = seatView(0, 'left');
    render(createElement(SeatBar, { view }));
    const name = screen.getByTestId('seat-0').querySelector('.seatbar__name')!;
    expect(name.textContent).toBe('You');
    expect(name.getAttribute('title')).toBe(view.seats[0]!.displayName);
  });
});
