// @vitest-environment jsdom
/*
 * A popover is no taller than the room on its side of what opened it, so a long panel scrolls
 * inside instead of running off the screen (the match settings at 125% UI scale in a 720px window:
 * placed above the seat's gear, the scale slider at its top was out of reach).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';

import { Popover } from './Popover.tsx';

afterEach(cleanup);

/** A trigger whose box is `top`..`top + 20` in a 1280×720 window. */
function triggerAt(top: number): Element {
  const el = document.createElement('button');
  el.getBoundingClientRect = () => ({ top, bottom: top + 20, left: 40, right: 60, width: 20, height: 20, x: 40, y: top, toJSON: () => ({}) }) as DOMRect;
  return el;
}

function open(trigger: Element): HTMLElement {
  globalThis.innerWidth = 1280;
  globalThis.innerHeight = 720;
  render(createElement(Popover, { trigger, onClose: () => undefined, title: 'Settings', testId: 'pop' }));
  return screen.getByTestId('pop');
}

describe('Popover', () => {
  it('above an anchor low on the screen, is no taller than the room above it', () => {
    const pop = open(triggerAt(600));
    expect(pop.style.bottom).toBe('128px');
    expect(pop.style.maxHeight).toBe('584px');
  });

  it('below an anchor high on the screen, is no taller than the room below it', () => {
    const pop = open(triggerAt(100));
    expect(pop.style.top).toBe('128px');
    expect(pop.style.maxHeight).toBe('584px');
  });

  // Room settings' wide panel on a 390px phone, right-aligned to a button 55px in from the edge, ran 39px off the left.
  it('a panel wider than the room beside its anchor moves in, so all of it is on screen', () => {
    globalThis.innerWidth = 390;
    globalThis.innerHeight = 844;
    const trigger = document.createElement('button');
    trigger.getBoundingClientRect = () => ({ top: 190, bottom: 212, left: 212, right: 335, width: 123, height: 22, x: 212, y: 190, toJSON: () => ({}) }) as DOMRect;
    const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 374 });
    try {
      render(createElement(Popover, { trigger, onClose: () => undefined, title: 'Room settings', testId: 'pop', wide: true }));
    } finally {
      if (width !== undefined) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', width);
    }
    // 390 - 8 - 374: the panel's left edge lands on the 8px gutter, not past it.
    expect(screen.getByTestId('pop').style.right).toBe('8px');
  });

  it('a panel that fits beside its anchor stays aligned to it', () => {
    globalThis.innerWidth = 390;
    globalThis.innerHeight = 844;
    const trigger = document.createElement('button');
    trigger.getBoundingClientRect = () => ({ top: 190, bottom: 212, left: 212, right: 335, width: 123, height: 22, x: 212, y: 190, toJSON: () => ({}) }) as DOMRect;
    const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 288 });
    try {
      render(createElement(Popover, { trigger, onClose: () => undefined, title: 'Settings', testId: 'pop' }));
    } finally {
      if (width !== undefined) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', width);
    }
    expect(screen.getByTestId('pop').style.right).toBe('55px');
  });
});
