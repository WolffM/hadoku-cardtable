// @vitest-environment jsdom
/*
 * The pod drawn as one table: who sits where around the ring, which way the
 * arcs point, and the face each seat wears. `DraftScreen.test.ts` and
 * `DraftStates.test.ts` cover what every seat says (waiting, held, watched).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';

import { loadFixtures } from '../draft/fixtures.ts';
import type { DraftView } from '../draft/types.ts';
import { SeatBar } from './SeatBar.tsx';
import { IN_VIEW, packSlot, type Pile } from './pack-queue.ts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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
    expect(screen.getByTestId('seat-7').querySelector('svg.player-mark')).not.toBeNull();
  });

  it('names the viewer’s own seat by their own name, like every other seat', () => {
    const view = seatView(0, 'left');
    render(createElement(SeatBar, { view }));
    const name = screen.getByTestId('seat-0').querySelector('.seatbar__name')!;
    expect(name.textContent).toBe(view.seats[0]!.displayName);
    expect(name.getAttribute('title')).toBe(view.seats[0]!.displayName);
  });

  it('turns no table for a spectator: whichever seat they watch, seat 0 is at the bottom and every seat stays put', () => {
    const watching = (seatId: number): DraftView => {
      const base = seatView(0, 'left');
      return { ...base, viewer: { kind: 'watcher', seatId, pack: [], pool: [] } };
    };
    const ids = [0, 1, 2, 3, 4, 5, 6, 7];
    const { rerender } = render(createElement(SeatBar, { view: { ...seatView(0, 'left'), viewer: { kind: 'spectator' } } }));
    const unwatched = ids.map(at);
    for (const seatId of [3, 5]) {
      rerender(createElement(SeatBar, { view: watching(seatId), onWatch: () => undefined }));
      expect(ids.map(at), `watching seat ${seatId}`).toEqual(unwatched);
      expect(at(0).x).toBeCloseTo(50, 1);
      expect(Math.max(...ids.map((id) => at(id).y))).toBe(at(0).y);
      expect(screen.getByTestId(`seat-${seatId}`).classList.contains('seatbar__seat--watched')).toBe(true);
    }
  });

  it('lights the arc into the watched seat, not into the bottom one', () => {
    const base = seatView(0, 'right');
    const { container } = render(createElement(SeatBar, { view: { ...base, viewer: { kind: 'watcher', seatId: 3, pack: [], pool: [] } } }));
    const lit = container.querySelectorAll<SVGPathElement>('.podcircle__arc--in');
    expect(lit).toHaveLength(1);
    const arc = ends(lit[0]!);
    const seats = [0, 1, 2, 3, 4, 5, 6, 7];
    const nearest = (p: { x: number; y: number }): number => seats.reduce((best, id) => (dist(at(id), p) < dist(at(best), p) ? id : best));
    expect(nearest(arc.to)).toBe(3);
    expect(nearest(arc.from)).toBe(4);
  });
});

/** The seats with these many packs waiting in front of each. */
function queued(view: DraftView, depths: readonly number[]): DraftView {
  return { ...view, seats: view.seats.map((s, i) => ({ ...s, queueDepth: depths[i] ?? 0 })) };
}

/**
 * jsdom lays nothing out, so the pod's own measure reads nothing and draws no
 * pack. This gives every box the pod measures a size: a 264px ring in an 8px
 * padded panel, 40px faces, a name line under each.
 */
function laidOut(): void {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const r = (left: number, top: number, w: number, h: number) => ({ left, top, right: left + w, bottom: top + h, width: w, height: h, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
    const el = this as HTMLElement;
    if (el.classList.contains('seats')) return r(-9, -9, 282, 282);
    if (el.classList.contains('podcircle')) return r(0, 0, 264, 264);
    if (el.classList.contains('podcircle__centre')) return r(112, 112, 40, 24);
    const seat = el.closest<HTMLElement>('.seatbar__seat');
    if (seat !== null) {
      const x = (parseFloat(seat.style.left) / 100) * 264;
      const y = (parseFloat(seat.style.top) / 100) * 264;
      if (el.classList.contains('seatbar__face')) return r(x - 20, y - 20, 40, 40);
      if (el.classList.contains('seatbar__label')) return r(x - 24, y + 22, 48, 13);
    }
    return r(0, 0, 0, 0);
  });
}

const packsAt = (container: HTMLElement, id: number): number => container.querySelectorAll(`[data-testid^="seat-${id}-pack-"]`).length;

describe('the packs waiting in front of each seat', () => {
  it('reads each seat’s pile from the view, everyone else’s pack at most', () => {
    render(createElement(SeatBar, { view: queued(seatView(0, 'left'), [0, 1, 2, 3, 4, 5, 6, 9]) }));
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((id) => screen.getByTestId(`seat-${id}`).dataset.queue)).toEqual(['0', '1', '2', '3', '4', '5', '6', '7']);
  });

  it('draws one pack per waiting pack, once the table is measured, and none for a seat with none', () => {
    laidOut();
    const { container, rerender } = render(createElement(SeatBar, { view: queued(seatView(0, 'left'), [0, 1, 2, 3, 4, 7, 0, 0]) }));
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((id) => packsAt(container, id))).toEqual([0, 1, 2, 3, 4, 7, 0, 0]);
    // A pack taken leaves the pile; one passed on joins the next.
    rerender(createElement(SeatBar, { view: queued(seatView(0, 'left'), [0, 0, 3, 3, 4, 7, 0, 0]) }));
    expect([1, 2].map((id) => packsAt(container, id))).toEqual([0, 3]);
    expect(screen.getByTestId('seat-5').hasAttribute('data-swamped'), 'more than four is the seat buried').toBe(true);
    expect(screen.getByTestId('seat-4').hasAttribute('data-swamped')).toBe(false);
  });

  it('draws no pack before the table is measured: it would only slide in from the wrong place', () => {
    const { container } = render(createElement(SeatBar, { view: queued(seatView(0, 'left'), [3, 3, 3, 3, 3, 3, 3, 3]) }));
    expect(container.querySelectorAll('.packq__pack')).toHaveLength(0);
  });

  it('gives each of the first four packs its own place, and the rest the seat', () => {
    const pile: Pile = {
      places: [
        { x: 2, y: 0, turn: 0 },
        { x: 3.75, y: 0, turn: 0 },
        { x: 2, y: 2, turn: 0 },
        { x: 3.75, y: 2, turn: 0 },
      ],
      along: 'room',
    };
    for (let depth = 1; depth <= IN_VIEW; depth++) {
      const places = Array.from({ length: depth }, (_, i) => packSlot(i, depth, pile)).map((p) => `${p.x},${p.y}`);
      expect(new Set(places).size, `depth ${depth}`).toBe(depth);
      expect(places).toEqual(pile.places.slice(0, depth).map((p) => `${p.x},${p.y}`));
    }
    // From the fifth on, on the face itself (within a face's half width of its centre).
    for (const i of [4, 5, 6]) expect(Math.hypot(packSlot(i, 7, pile).x, packSlot(i, 7, pile).y)).toBeLessThan(3);
  });
});

/** Every animation the pod starts, by the test id of what moves (`leaving` for a pack going into its seat). */
function recordMotion(): string[] {
  const started: string[] = [];
  Object.defineProperty(Element.prototype, 'animate', {
    configurable: true,
    value: function (this: HTMLElement) {
      started.push(this.dataset.testid ?? (this.classList.contains('packq__leaving') ? 'leaving' : this.className));
      return { cancel: () => undefined, onfinish: null } as unknown as Animation;
    },
  });
  return started;
}

describe('the pod moves only when the draft steps on screen', () => {
  afterEach(() => {
    delete (Element.prototype as { animate?: unknown }).animate;
  });

  const DEPTHS = [0, 1, 2, 3, 4, 2, 1, 0];

  it('draws the piles already there in place: the first draw moves nothing', () => {
    laidOut();
    const started = recordMotion();
    const { container } = render(createElement(SeatBar, { view: queued(seatView(0, 'left'), DEPTHS) }));
    expect(container.querySelectorAll('.packq__pack[data-testid]')).toHaveLength(13);
    expect(started).toEqual([]);
  });

  it('moves a pick seen live: the pack passed on hops in, the one taken leaves, the pile it joins shoves up', () => {
    laidOut();
    const started = recordMotion();
    const { rerender } = render(createElement(SeatBar, { view: queued(seatView(0, 'left'), DEPTHS) }));
    // Seat 2 takes a pack and passes it to seat 3.
    rerender(createElement(SeatBar, { view: queued(seatView(0, 'left'), [0, 1, 1, 4, 4, 2, 1, 0]) }));
    expect(started).toContain('seat-3-pack-3');
    expect(started).toContain('leaving');
    expect(started.filter((id) => /^seat-3-pack-[012]$/.test(id)), 'the three already there make room').toHaveLength(3);
    expect(started.filter((id) => /^seat-[0145-7]-/.test(id)), 'no seat the pick did not touch').toEqual([]);
  });

  it('draws a view that arrives whole in place, though its piles differ: a rejoin catches up without replaying the picks it missed', () => {
    laidOut();
    const started = recordMotion();
    const { container, rerender } = render(createElement(SeatBar, { view: queued(seatView(0, 'left'), DEPTHS) }));
    rerender(createElement(SeatBar, { view: queued(seatView(0, 'left'), [3, 0, 4, 1, 2, 2, 0, 3]), arrivedWhole: true }));
    expect(started).toEqual([]);
    expect(container.querySelectorAll('.packq__pack[data-testid]')).toHaveLength(15);
    expect(container.querySelectorAll('.packq__leaving')).toHaveLength(0);
    // …and the next step seen live moves again.
    rerender(createElement(SeatBar, { view: queued(seatView(0, 'left'), [3, 0, 4, 1, 2, 2, 0, 4]) }));
    expect(started).toEqual(['seat-7-pack-3', 'seat-7-pack-0', 'seat-7-pack-1', 'seat-7-pack-2']);
  });

  it('redraws the piles in place when another seat is watched: the lit arrow moves them, no pick did', () => {
    laidOut();
    const started = recordMotion();
    const watching = (seatId: number): DraftView => ({ ...queued(seatView(0, 'left'), DEPTHS), viewer: { kind: 'watcher', seatId, pack: [], pool: [] } });
    const { rerender } = render(createElement(SeatBar, { view: watching(3), onWatch: () => undefined }));
    rerender(createElement(SeatBar, { view: watching(5), onWatch: () => undefined }));
    expect(started).toEqual([]);
  });
});

