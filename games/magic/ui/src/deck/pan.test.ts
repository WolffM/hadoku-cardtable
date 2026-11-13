// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { clampOffset, clampZoom, IDENTITY_VIEW, mayPan, panBy, pinchCenter, pinchDistance, transformOf, zoomAt, ZOOM_MAX, ZOOM_MIN, type Extent } from './pan.ts';

const ORIGIN = { pool: { x: 0, y: 0 }, deck: { x: 0, y: 0 } };
const at = (x: number, y: number) => ({ pool: { x, y }, deck: { x: 0, y: 0 } });

describe('clampZoom', () => {
  it('never goes under 1 or over the max', () => {
    expect(clampZoom(0)).toBe(ZOOM_MIN);
    expect(clampZoom(0.4)).toBe(ZOOM_MIN);
    expect(clampZoom(1)).toBe(1);
    expect(clampZoom(2)).toBe(2);
    expect(clampZoom(50)).toBe(ZOOM_MAX);
  });
});

describe('mayPan', () => {
  const card = document.createElement('button');
  card.className = 'deck-editor__card';
  const face = document.createElement('img');
  card.append(face);
  const empty = document.createElement('div');

  it('a finger may pan from anywhere, a card included', () => {
    expect(mayPan('touch', face)).toBe(true);
    expect(mayPan('touch', empty)).toBe(true);
    expect(mayPan('pen', card)).toBe(true);
  });

  it('a mouse pans only from empty space: a press on a card is its click or its drag', () => {
    expect(mayPan('mouse', face)).toBe(false);
    expect(mayPan('mouse', card)).toBe(false);
    expect(mayPan('mouse', empty)).toBe(true);
  });
});

describe('clampOffset', () => {
  const e: Extent = { viewW: 300, viewH: 200, contentW: 500, contentH: 150 };

  it('content wider than its view pans as far as its own far edge, never past either edge', () => {
    expect(clampOffset({ x: 40, y: 0 }, 1, e).x).toBe(0);
    expect(clampOffset({ x: -150, y: 0 }, 1, e).x).toBe(-150);
    expect(clampOffset({ x: -900, y: 0 }, 1, e).x).toBe(-200);
  });

  it('content that fits its view does not pan at all on that axis', () => {
    expect(clampOffset({ x: 0, y: -30 }, 1, e).y).toBe(0);
    expect(clampOffset({ x: 0, y: 30 }, 1, e).y).toBe(0);
  });

  it('zoomed in, the scaled content sets the bound', () => {
    expect(clampOffset({ x: -2000, y: -2000 }, 2, e)).toEqual({ x: -700, y: -100 });
  });
});

describe('panBy', () => {
  it('moves only the named surface, by exactly the given delta', () => {
    const v = panBy(IDENTITY_VIEW, 'pool', -12, -4);
    expect(v.pool).toEqual({ x: -12, y: -4 });
    expect(v.deck).toEqual({ x: 0, y: 0 });
    expect(v.zoom).toBe(1);
  });

  it('is a no-op (same reference) when nothing moves, including a move the clamp refuses', () => {
    expect(panBy(IDENTITY_VIEW, 'deck', 0, 0)).toBe(IDENTITY_VIEW);
    expect(panBy(IDENTITY_VIEW, 'deck', 30, 30, { viewW: 100, viewH: 100, contentW: 400, contentH: 400 })).toBe(IDENTITY_VIEW);
  });

  it('accumulates: panning twice adds, it does not replace', () => {
    const twice = panBy(panBy(IDENTITY_VIEW, 'pool', -10, -10), 'pool', -5, 2);
    expect(twice.pool).toEqual({ x: -15, y: -8 });
  });
});

describe('zoomAt', () => {
  it('a no-op target zoom (same clamped value) returns the same view', () => {
    expect(zoomAt(IDENTITY_VIEW, 1, at(100, 100))).toBe(IDENTITY_VIEW);
    expect(zoomAt(IDENTITY_VIEW, 0.2, at(50, 50))).toBe(IDENTITY_VIEW);
  });

  it('keeps the anchor point over the same point of its content', () => {
    const after = zoomAt(IDENTITY_VIEW, 2, at(100, 40));
    expect((100 - after.pool.x) / after.zoom).toBeCloseTo(100, 9);
    expect((40 - after.pool.y) / after.zoom).toBeCloseTo(40, 9);
  });

  it('the other surface keeps its top-left corner where it is', () => {
    const started = panBy(IDENTITY_VIEW, 'deck', -30, -30);
    const zoomed = zoomAt(started, 2, at(10, 10));
    expect(zoomed.deck).toEqual({ x: -60, y: -60 });
  });

  it('zooming back out to 1 at the same anchor returns to no pan at all', () => {
    const back = zoomAt(zoomAt(IDENTITY_VIEW, 2, at(50, 50)), 1, at(50, 50));
    expect(back.pool.x).toBeCloseTo(0, 9);
    expect(back.pool.y).toBeCloseTo(0, 9);
    expect(back.zoom).toBe(1);
  });

  it('clamps each surface it has an extent for', () => {
    const v = zoomAt(IDENTITY_VIEW, 2, ORIGIN, { pool: { viewW: 100, viewH: 100, contentW: 100, contentH: 100 } });
    expect(v.pool).toEqual({ x: 0, y: 0 });
    const out = zoomAt({ zoom: 2, pool: { x: -100, y: -100 }, deck: { x: 0, y: 0 } }, 1, ORIGIN, { pool: { viewW: 100, viewH: 100, contentW: 100, contentH: 100 } });
    expect(out.pool).toEqual({ x: 0, y: 0 });
  });
});

describe('pinchDistance / pinchCenter', () => {
  it('distance is the straight-line span between the two touches', () => {
    expect(pinchDistance(0, 0, 3, 4)).toBe(5);
  });

  it('center is the midpoint', () => {
    expect(pinchCenter(0, 0, 10, 20)).toEqual({ x: 5, y: 10 });
  });
});

describe('transformOf', () => {
  it('translates first, then scales — the CSS a surface draws at', () => {
    expect(transformOf(1.5, { x: 10, y: -5 })).toBe('translate(10px, -5px) scale(1.5)');
  });
});
