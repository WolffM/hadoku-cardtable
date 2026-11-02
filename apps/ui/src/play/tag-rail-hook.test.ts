// @vitest-environment jsdom
/*
 * The rail's fit is measured from boxes, and every box read forces the browser to lay out whatever the
 * last commit changed. The bench (e2e/perf) found the rail re-reading every chip on every render of
 * every card: 1.0 s of forced layout across the intense moments. A render that changes nothing the fit
 * depends on reads no box; a new chip set, a changed badge beside the rail, or a resized card does.
 */
import { act, render } from '@testing-library/react';
import { createElement as h, useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useRailFit } from './tag-rail.ts';

let reads = 0;
let resize: (() => void) | null = null;

beforeEach(() => {
  reads = 0;
  for (const prop of ['offsetWidth', 'offsetHeight', 'offsetLeft', 'offsetTop'] as const)
    Object.defineProperty(HTMLElement.prototype, prop, {
      configurable: true,
      get() {
        reads += 1;
        return prop === 'offsetWidth' ? 20 : 0;
      },
    });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(cb: () => void) {
        resize = cb;
      }
      observe(): void {}
      disconnect(): void {}
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  resize = null;
});

/** A card with a rail and a counter badge beside it, inside something else on the board that re-renders it (`other`). */
function Card({ chips, counter, other }: { chips: string[]; counter: string; other: number }) {
  const rail = useRef<HTMLUListElement>(null);
  const shown = useRailFit(rail, chips.join('|'));
  return h(
    'section',
    { 'data-other': other },
    h(
      'div',
      null,
      h('ul', { className: 'board-card__counters' }, h('li', null, counter)),
      h('ul', { ref: rail, className: 'board-card__tags', 'data-shown': String(shown) }, ...chips.map((c) => h('li', { key: c }, c))),
    ),
  );
}

const card = (chips: string[], counter: string, other: number) => h(Card, { chips, counter, other });

describe('useRailFit: measures only when what the fit depends on changed', () => {
  it('reads no box on a render that changes nothing the rail sits in', () => {
    const { rerender } = render(card(['Flying', 'Vigilance'], '+1/+1', 0));
    expect(reads).toBeGreaterThan(0);
    reads = 0;
    rerender(card(['Flying', 'Vigilance'], '+1/+1', 1));
    rerender(card(['Flying', 'Vigilance'], '+1/+1', 2));
    expect(reads).toBe(0);
  });

  it('measures again for a new chip set, a changed badge beside the rail, and a resized card', () => {
    const { rerender } = render(card(['Flying'], '+1/+1', 0));
    reads = 0;
    rerender(card(['Flying', 'Trample'], '+1/+1', 0));
    expect(reads, 'a new chip set').toBeGreaterThan(0);
    reads = 0;
    rerender(card(['Flying', 'Trample'], '+2/+2 ×3', 0));
    expect(reads, 'a counter badge beside the rail changed').toBeGreaterThan(0);
    reads = 0;
    act(() => resize?.());
    expect(reads, 'the card resized').toBeGreaterThan(0);
  });
});
