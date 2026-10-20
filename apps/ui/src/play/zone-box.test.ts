// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CARD_BOXES, observeZoneBoxes, writeCardBox, writeZoneBox, ZONE_BOXES } from './zone-box.ts';

const dir = import.meta.dirname ?? 'apps/ui/src/play';
const rules = (file: string): string => readFileSync(resolve(dir, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

describe('a zone’s box, measured instead of queried (the operator, 2026-10-10: "buttery smooth")', () => {
  it('writes the content box as px and the aspect band the row count steps on', () => {
    const el = document.createElement('section');
    writeZoneBox(el, 900, 150);
    expect(el.style.getPropertyValue('--zone-w')).toBe('900px');
    expect(el.style.getPropertyValue('--zone-h')).toBe('150px');
    expect(el.getAttribute('data-zone-aspect'), '6 wide for 1 tall').toBe('6');
    writeZoneBox(el, 299, 100);
    expect(el.hasAttribute('data-zone-aspect'), 'under 3 is the base rule').toBe(false);
    writeZoneBox(el, 300, 100);
    expect(el.getAttribute('data-zone-aspect')).toBe('3');
    writeZoneBox(el, 799, 100);
    expect(el.getAttribute('data-zone-aspect')).toBe('6');
    writeZoneBox(el, 5000, 100);
    expect(el.getAttribute('data-zone-aspect')).toBe('10');
    writeZoneBox(el, 300, 0);
    expect(el.hasAttribute('data-zone-aspect'), 'nothing tall to divide by').toBe(false);
  });

  it('no stylesheet sizes from a size container any more: no container, no query, no container unit', () => {
    for (const file of ['board.css', 'live/presence.css', 'card.css', 'pile-view.css']) {
      const css = rules(file);
      expect(css, file).not.toMatch(/container(-type|-name)?\s*:/);
      expect(css, file).not.toContain('@container');
      expect(css, file).not.toMatch(/\d(cqh|cqw|cqi|cqb|cqmin|cqmax)\b/);
    }
  });

  it('a measured zone is size-contained but never layout-contained: a lifted card’s position: fixed stays the window’s', () => {
    const css = rules('board.css');
    expect(css.match(/contain: [^;]+;/g)).toEqual(['contain: inline-size style;', 'contain: size style;', 'contain: size style;', 'contain: size style;', 'contain: inline-size style;']);
  });

  it('every band the row count steps on has its rule, on the zones the query used to resolve to — a hand of backs included', () => {
    const css = rules('board.css');
    for (const band of [3, 4, 5, 6, 8, 10]) {
      expect(css).toContain(`:is(.seat > .zone--battlefield, .zone--hand)[data-zone-aspect='${band}'] > :is(.zone__rows, .zone__cards, .card-backs) {`);
    }
  });

  it('a pile’s own card is measured as the width it is drawn at — a crowded row squeezes it under --card-w — and forgotten once it is no pile', () => {
    const observedEls: Element[] = [];
    const unobserved: Element[] = [];
    class Stub {
      observe(el: Element): void {
        observedEls.push(el);
      }
      unobserve(el: Element): void {
        unobserved.push(el);
      }
      disconnect(): void {}
    }
    const real = globalThis.ResizeObserver;
    globalThis.ResizeObserver = Stub as unknown as typeof ResizeObserver;
    try {
      document.body.innerHTML = '<ul class="zone__cards"><li class="board-card" data-pile-size="2"></li><li class="board-card"></li></ul>';
      const pile = document.querySelector<HTMLElement>(CARD_BOXES)!;
      const boxes = observeZoneBoxes()!;
      boxes.sync(document.body);
      expect(observedEls, 'the pile, not the lone card').toEqual([pile]);
      window.dispatchEvent(new Event('resize'));
      expect(pile.style.getPropertyValue('--card-drawn-w'), 'a card box, never a zone box').toBe('0px');
      expect(pile.style.getPropertyValue('--zone-w')).toBe('');
      pile.removeAttribute('data-pile-size');
      boxes.sync(document.body);
      expect(unobserved).toEqual([pile]);
      boxes.disconnect();
    } finally {
      globalThis.ResizeObserver = real;
      document.body.innerHTML = '';
    }
    const li = document.createElement('li');
    writeCardBox(li, 40.25);
    expect(li.style.getPropertyValue('--card-drawn-w')).toBe('40.25px');
  });

  it('a window resize is measured from its own event — before the frame callbacks — and not after a disconnect', () => {
    const observedEls: Element[] = [];
    class Stub {
      observe(el: Element): void {
        observedEls.push(el);
      }
      unobserve(): void {}
      disconnect(): void {}
    }
    const real = globalThis.ResizeObserver;
    globalThis.ResizeObserver = Stub as unknown as typeof ResizeObserver;
    try {
      document.body.innerHTML = '<div class="board"><section class="seat"><section class="zone zone--hand"></section></section></div>';
      const hand = document.querySelector<HTMLElement>('.zone--hand')!;
      const boxes = observeZoneBoxes()!;
      boxes.sync(document.body);
      expect(observedEls).toEqual([hand]);
      window.dispatchEvent(new Event('resize'));
      expect(hand.style.getPropertyValue('--zone-h'), 'written by the resize itself').toBe('0px');
      boxes.disconnect();
      hand.style.removeProperty('--zone-h');
      window.dispatchEvent(new Event('resize'));
      expect(hand.style.getPropertyValue('--zone-h')).toBe('');
    } finally {
      globalThis.ResizeObserver = real;
      document.body.innerHTML = '';
    }
  });

  it('measures every box board.css reads a zone size from', () => {
    for (const selector of ['.seat > .zone--battlefield', '.seat > .zone--hand', '.zone__row', '.seat .zone--graveyard', '.seat .zone--exile']) {
      expect(ZONE_BOXES.split(', ')).toContain(selector);
    }
  });
});
