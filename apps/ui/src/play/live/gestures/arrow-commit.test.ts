// @vitest-environment jsdom
/*
 * The targeter's life after the aim (`arrow.ts`'s `commitArrowAt`): a ghost while aiming, closed
 * into a solid arrow by a press on the target it is snapped to, then gone once the arrow Forge's
 * answer draws to that target arrives, the gesture is cancelled, or nothing came.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLOSE_MS, COMMITTED_MAX_MS, clearArrow, clearCommitted, commitArrowAt, drawArrow, markArrow, newArrow, retireCommitted } from './arrow.ts';

let overlay: HTMLElement;
let target: HTMLElement;
let inner: HTMLElement;
let reduced = false;
let frames: FrameRequestCallback[] = [];

beforeEach(() => {
  reduced = false;
  frames = [];
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: reduced && query === '(prefers-reduced-motion: reduce)' }));
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
  overlay = document.createElement('div');
  target = document.createElement('div');
  inner = document.createElement('span');
  target.append(inner);
  document.body.append(overlay, target);
});

afterEach(() => {
  clearCommitted(null);
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function aim(): SVGSVGElement {
  drawArrow(overlay, { from: { x: 300, y: 300 }, to: { x: 5, y: 5 }, source: 1, target: { kind: 'card', id: 2 }, snap: target, tail: null, mode: 'click' });
  return overlay.querySelector<SVGSVGElement>('[data-testid="targeter"]')!;
}

/** Run every queued animation frame at `at` ms. */
function runFrames(at: number): void {
  const queued = frames;
  frames = [];
  for (const f of queued) f(at);
}

describe('the targeter while aiming', () => {
  it('is a ghost: a dashed stem in each layer, its head whole, the curve still the first path', () => {
    const svg = aim();
    expect(svg.hasAttribute('data-ghost')).toBe(true);
    expect(svg.querySelector('path')!.getAttribute('class'), 'the spine is the first path, what every reader parses').toBe('arrow__spine');
    expect(svg.querySelector('path')!.getAttribute('d')).toMatch(/^M 300 300 Q /);
    const stems = svg.querySelectorAll('.arrow__stem');
    expect(stems).toHaveLength(2);
    expect([...stems].map((p) => p.parentElement!.getAttribute('class'))).toEqual(['arrow__rim', 'arrow__core']);
    for (const stem of stems) expect(stem.getAttribute('d'), 'the stem starts at the tail too').toMatch(/^M 300 300 Q /);
    expect(svg.querySelector('mask'), 'no masks: they repaint whole on every frame').toBeNull();
  });

  it('the stem stops inside the head, short of the tip', () => {
    const svg = aim();
    const stem = svg.querySelector('.arrow__stem')!.getAttribute('d')!.replace(/[MQ]/g, ' ').trim().split(/\s+/).map(Number);
    const spine = svg.querySelector('.arrow__spine')!.getAttribute('d')!.replace(/[MQ]/g, ' ').trim().split(/\s+/).map(Number);
    const short = Math.hypot(stem[4]! - spine[4]!, stem[5]! - spine[5]!);
    expect(short).toBeGreaterThan(0);
    expect(short).toBeLessThan(32);
  });

  it('a committed arrow never carries the dashes', () => {
    const svg = newArrow();
    expect(svg.querySelector('.arrow__stem')).toBeNull();
    expect(svg.hasAttribute('data-ghost')).toBe(false);
  });
});

describe('committing the aim', () => {
  it('a press inside the snapped target commits it: it leaves the targeter testid and closes solid', () => {
    const svg = aim();
    commitArrowAt(overlay, inner);
    expect(svg.getAttribute('data-testid')).toBe('targeter-committed');
    expect(overlay.querySelector('[data-testid="targeter"]'), 'no live arrow any more').toBeNull();
    expect(svg.hasAttribute('data-ghost'), 'still a ghost while the gaps close').toBe(true);
    runFrames(performance.now() + CLOSE_MS / 2);
    const mid = svg.querySelector<SVGPathElement>('.arrow__core > .arrow__stem')!.style.strokeDasharray;
    expect(mid, 'halfway: the chunks have grown into their gaps').not.toBe('');
    runFrames(performance.now() + CLOSE_MS + 1);
    expect(svg.hasAttribute('data-ghost')).toBe(false);
    expect(svg.querySelector('.arrow__stem'), 'the ribbon has taken over from the dashes').toBeNull();
    expect(svg.hasAttribute('data-settle'), 'the rim bumps once').toBe(true);
  });

  it('with reduced motion it is solid at once', () => {
    reduced = true;
    const svg = aim();
    commitArrowAt(overlay, inner);
    expect(svg.hasAttribute('data-ghost')).toBe(false);
    expect(frames).toHaveLength(0);
  });

  it('a press anywhere else commits nothing', () => {
    const svg = aim();
    commitArrowAt(overlay, document.body);
    expect(svg.getAttribute('data-testid')).toBe('targeter');
  });

  it('an unsnapped arrow is never committed', () => {
    drawArrow(overlay, { from: { x: 300, y: 300 }, to: { x: 5, y: 5 }, source: 1, target: null, snap: null, tail: null, mode: 'click' });
    commitArrowAt(overlay, inner);
    expect(overlay.querySelector('[data-testid="targeter"]')).not.toBeNull();
  });

  it('survives the gesture layer clearing the live arrow', () => {
    const svg = aim();
    commitArrowAt(overlay, inner);
    clearArrow(overlay);
    expect(svg.isConnected).toBe(true);
  });

  it('goes once an arrow to the same target is drawn, and not for one to another', () => {
    const svg = aim();
    commitArrowAt(overlay, inner);
    retireCommitted(overlay, [document.body]);
    expect(svg.isConnected).toBe(true);
    retireCommitted(overlay, [target]);
    expect(svg.isConnected).toBe(false);
  });

  it('goes when the gesture is cancelled', () => {
    const svg = aim();
    commitArrowAt(overlay, inner);
    clearCommitted(overlay);
    expect(svg.isConnected).toBe(false);
  });

  it('goes by itself if no arrow ever replaces it', () => {
    vi.useFakeTimers();
    const svg = aim();
    commitArrowAt(overlay, inner);
    vi.advanceTimersByTime(COMMITTED_MAX_MS - 1);
    expect(svg.isConnected).toBe(true);
    vi.advanceTimersByTime(1);
    expect(svg.isConnected).toBe(false);
  });
});

describe('the target brackets', () => {
  it('stand at the four corners of the target, outside it', () => {
    const svg = newArrow();
    const box = { left: 10, top: 20 } as DOMRect;
    markArrow(svg, { left: 110, top: 220, right: 170, bottom: 304 }, box);
    const paths = svg.querySelectorAll('.arrow__mark path');
    expect(paths).toHaveLength(2);
    const d = paths[0]!.getAttribute('d')!;
    expect(d.match(/M /g)).toHaveLength(4);
    // 6px outside the box, in the overlay's own coordinates.
    expect(d).toMatch(/^M 94 /);
    expect(d).toContain('L 166 290');
  });
});
