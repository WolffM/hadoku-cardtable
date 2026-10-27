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

    const pill = document.createElement('span');
    const pillAnimations = animate(pill, ['fly-across']);
    drawn.append(pill);
    await flush();
    expect(pillAnimations[0]!.startTime, 'a pill added to it').toBe(0);

    const face = document.createElement('div');
    face.className = 'board-card__face';
    drawn.append(face);
    await flush();
    const art = document.createElement('div');
    const artAnimations = animate(art, ['fly-tilt-across']);
    face.append(art);
    await flush();
    expect(artAnimations[0]!.startTime, 'art drawn into its face').toBe(0);

    // Inside a part, nothing starts a `fly-*` animation: no re-read of the card for a pill's text.
    drawnAnimations[0]!.startTime = 1234;
    pillAnimations[0]!.startTime = 1234;
    pill.append(document.createElement('b'));
    await flush();
    expect([drawnAnimations[0]!.startTime, pillAnimations[0]!.startTime], 'a change inside a pill').toEqual([1234, 1234]);

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

  /**
   * AF405 (wave 76 §C). `card.css`'s attacking outline ring (`[data-flying][data-attacking] >
   * .board-card__face::before`) starts a brand-new `fly-*` animation the moment `data-attacking` is
   * set on a card already flying — no node is added for `FLYING_PART`'s own watch to see, so without
   * `data-attacking` in the observer's `attributeFilter` this ring was left on its own clock instead
   * of the document's, and rode out of step with the art it is meant to outline.
   */
  it('pins a flyer’s outline ring the moment it starts attacking, not a frame later', async () => {
    const root = document.createElement('div');
    const unpin = pinFlight(root);
    const li = flyer();
    const flying = animate(li, ['fly-across', 'fly-rise']);
    root.append(li);
    await flush();
    expect(flying.map((a) => a.startTime), 'already flying, already pinned').toEqual([0, 0]);

    // The ring's own `fly-across` joins the two already-pinned ones, unpinned until this very change.
    const withRing = animate(li, ['fly-across', 'fly-rise', 'fly-across']);
    li.setAttribute('data-attacking', '');
    await flush();
    expect(withRing.map((a) => a.startTime), 'the ring is pinned with everything else, the moment it appears').toEqual([0, 0, 0]);

    unpin();
  });
});
