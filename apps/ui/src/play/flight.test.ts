// @vitest-environment jsdom
/*
 * `pinFlight`: every `fly-*` animation of a flyer starts at the document's origin before the frame that
 * first draws it, so a part mounted mid-loop runs in step with its card's art (`card.css`'s flying
 * loop) and never jumps into step a frame late. jsdom runs no animations, so each element's animations
 * are stood in for.
 */
import { describe, expect, it } from 'vitest';

import { pinFlight } from './flight.ts';

type Stub = { animationName: string; startTime: number | null };

/** `el` reporting `names` as its (and its subtree's) running animations, each started at its own time. */
function animate<E extends Element>(el: E, names: string[]): Stub[] {
  const animations = names.map((animationName) => ({ animationName, startTime: 1234 as number | null }));
  el.getAnimations = (() => animations) as unknown as Element['getAnimations'];
  return animations;
}

/** A mutation's callback is a microtask: awaiting one more runs after it, as the page would before its next frame. */
const flush = (): Promise<void> => Promise.resolve();

function flyer(): HTMLLIElement {
  const li = document.createElement('li');
  li.setAttribute('data-flying', '');
  return li;
}

describe('pinFlight', () => {
  it('pins what already flies as it is installed, before the board is drawn', () => {
    const root = document.createElement('div');
    const li = flyer();
    root.append(li);
    const animations = animate(li, ['fly-across', 'fly-rise', 'board-number-rise']);
    pinFlight(root);
    expect(animations.map((a) => [a.animationName, a.startTime])).toEqual([
      ['fly-across', 0],
      ['fly-rise', 0],
      ['board-number-rise', 1234],
    ]);
  });

  it('pins a flyer drawn later, a part added to one, and a card that starts flying — as the DOM changes, not a frame later', async () => {
    const root = document.createElement('div');
    const unpin = pinFlight(root);

    const drawn = flyer();
    const drawnAnimations = animate(drawn, ['fly-across']);
    root.append(drawn);
    await flush();
    expect(drawnAnimations[0]!.startTime, 'a flyer drawn').toBe(0);

    drawnAnimations[0]!.startTime = 1234;
    drawn.append(document.createElement('span'));
    await flush();
    expect(drawnAnimations[0]!.startTime, 'a pill added to it').toBe(0);

    const grounded = document.createElement('li');
    const groundedAnimations = animate(grounded, ['fly-rise']);
    root.append(grounded);
    await flush();
    expect(groundedAnimations[0]!.startTime, 'not flying: left alone').toBe(1234);
    grounded.setAttribute('data-flying', '');
    await flush();
    expect(groundedAnimations[0]!.startTime, 'a card that starts flying').toBe(0);

    unpin();
    const late = flyer();
    const lateAnimations = animate(late, ['fly-across']);
    root.append(late);
    await flush();
    expect(lateAnimations[0]!.startTime, 'uninstalled: nothing is pinned').toBe(1234);
  });
});
