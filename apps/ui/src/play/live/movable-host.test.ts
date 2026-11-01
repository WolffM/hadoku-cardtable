// @vitest-environment jsdom
/*
 * A question's host reads its boxes before it writes its offset, and reads nothing at all when it stands
 * at its default spot: every box read is a layout (cut 3, 2026-11-01: 17–36 ms forced per resize).
 */
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { QuestionHost, SPOT_KEY } from './movable.tsx';

const rect = (left: number, top: number, width: number, height: number): DOMRect =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

/** jsdom has no `ResizeObserver`: this one hands its callback to the test. */
let grown: (() => void) | null = null;
class Resizes {
  constructor(report: ResizeObserverCallback) {
    grown = () => report([], this as unknown as ResizeObserver);
  }
  observe(): void {}
  disconnect(): void {}
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  document.body.innerHTML = '';
  grown = null;
});

/** Box reads, with what the host's own offset was at each: a sheet drawn at its default (600, 300) plus that offset. */
function stubBoxes(): { reads: string[] } {
  const reads: string[] = [];
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.classList.contains('live')) return rect(0, 0, 1000, 800);
    const host = this.closest<HTMLElement>('.live__prompt');
    const [x = '0', y = '0'] = (host?.style.translate ?? '').split(/\s+/);
    reads.push(host?.style.translate ?? '');
    return rect(600 + (Number.parseFloat(x) || 0), 300 + (Number.parseFloat(y) || 0), 160, 100);
  });
  return { reads };
}

function draw(spot: string) {
  return createElement('div', { className: 'live' }, createElement(QuestionHost, { spot, children: createElement('div', { className: 'sheet' }, 'a question') }));
}

describe('QuestionHost', () => {
  it('a question at its default spot reads no box when its sheet grows', () => {
    vi.stubGlobal('ResizeObserver', Resizes);
    const { reads } = stubBoxes();
    render(draw('a'));
    reads.length = 0;
    grown!();
    expect(reads).toEqual([]);
  });

  it('opens again at the remembered spot reading where it is drawn first — its offset still on — and lands in the same place', () => {
    vi.stubGlobal('ResizeObserver', Resizes);
    localStorage.setItem(SPOT_KEY, JSON.stringify({ x: 0.2, y: 0.5 }));
    const { reads } = stubBoxes();
    const { container, rerender } = render(draw('a'));
    const host = container.querySelector<HTMLElement>('.live__prompt')!;
    expect(host.style.translate).toBe('-400px 100px');
    reads.length = 0;
    rerender(draw('b'));
    expect(reads, 'every read with the offset it had').toEqual(['-400px 100px']);
    expect(host.style.translate, 'the same spot').toBe('-400px 100px');
  });
});
