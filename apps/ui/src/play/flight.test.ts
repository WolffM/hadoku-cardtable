// @vitest-environment jsdom
/*
 * `pinFlight`: every `fly-*` animation of a flyer starts at the document's origin, so a part mounted
 * mid-loop runs in step with its card's art (`card.css`'s flying loop). jsdom runs no animations, so the
 * element's animations are stood in for.
 */
import { describe, expect, it } from 'vitest';

import { pinFlight } from './flight.ts';

type Stub = { animationName: string; startTime: number | null };

function animated(names: string[]): { el: HTMLElement; animations: Stub[] } {
  const el = document.createElement('div');
  const animations = names.map((animationName) => ({ animationName, startTime: 1234 }));
  el.getAnimations = (() => animations) as unknown as HTMLElement['getAnimations'];
  return { el, animations };
}

function start(el: Element, animationName: string): void {
  const event = new Event('animationstart', { bubbles: true });
  Object.defineProperty(event, 'animationName', { value: animationName });
  el.dispatchEvent(event);
}

describe('pinFlight', () => {
  it('starts every fly-* animation of a part at the document’s origin as it begins, and leaves the rest alone', () => {
    const root = document.createElement('div');
    const { el: pill, animations } = animated(['fly-across', 'fly-rise', 'board-number-rise']);
    root.append(pill);
    const unpin = pinFlight(root);

    start(pill, 'fly-rise');
    expect(animations.map((a) => [a.animationName, a.startTime])).toEqual([
      ['fly-across', 0],
      ['fly-rise', 0],
      ['board-number-rise', 1234],
    ]);

    unpin();
    const { el: late, animations: lateAnimations } = animated(['fly-across']);
    root.append(late);
    start(late, 'fly-across');
    expect(lateAnimations[0]!.startTime, 'uninstalled: nothing is pinned').toBe(1234);
  });

  it('ignores every other animation starting', () => {
    const root = document.createElement('div');
    const { el, animations } = animated(['fly-across']);
    root.append(el);
    pinFlight(root);
    start(el, 'stack-float');
    expect(animations[0]!.startTime).toBe(1234);
  });
});
