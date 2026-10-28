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
});
