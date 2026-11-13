// @vitest-environment jsdom
/*
 * `pinFlight`: every `fly-*` animation of a flyer starts at the document's origin before the frame that
 * first draws it, so a part mounted mid-loop runs in step with its card's art (`card.css`'s flying
 * loop) and never jumps into step a frame late. jsdom runs no animations, so each element's animations
 * are stood in for.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
    const animations = animate(li, ['fly-figure', 'fly-tilt', 'board-number-rise']);
    pinFlight(root);
    expect(animations.map((a) => [a.animationName, a.startTime])).toEqual([
      ['fly-figure', 0],
      ['fly-tilt', 0],
      ['board-number-rise', 1234],
    ]);
  });

  it('pins a flyer drawn later, a part added to one, and a card that starts flying — as the DOM changes, not a frame later', async () => {
    const root = document.createElement('div');
    const unpin = pinFlight(root);

    const drawn = flyer();
    const drawnAnimations = animate(drawn, ['fly-figure']);
    root.append(drawn);
    await flush();
    expect(drawnAnimations[0]!.startTime, 'a flyer drawn').toBe(0);

    const pill = document.createElement('span');
    const pillAnimations = animate(pill, ['fly-figure']);
    drawn.append(pill);
    await flush();
    expect(pillAnimations[0]!.startTime, 'a pill added to it').toBe(0);

    const face = document.createElement('div');
    face.className = 'board-card__face';
    drawn.append(face);
    await flush();
    const art = document.createElement('div');
    const artAnimations = animate(art, ['fly-tilt']);
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
    const groundedAnimations = animate(grounded, ['fly-tilt']);
    root.append(grounded);
    await flush();
    expect(groundedAnimations[0]!.startTime, 'not flying: left alone').toBe(1234);
    grounded.setAttribute('data-flying', '');
    await flush();
    expect(groundedAnimations[0]!.startTime, 'a card that starts flying').toBe(0);

    unpin();
    const late = flyer();
    const lateAnimations = animate(late, ['fly-figure']);
    root.append(late);
    await flush();
    expect(lateAnimations[0]!.startTime, 'uninstalled: nothing is pinned').toBe(1234);
  });

  /**
   * Wave 76 §C. `card.css`'s attacking outline ring (`[data-flying][data-attacking] >
   * .board-card__face::before`) starts a brand-new `fly-*` animation the moment `data-attacking` is
   * set on a card already flying — no node is added for `FLYING_PART`'s own watch to see, so without
   * `data-attacking` in the observer's `attributeFilter` this ring was left on its own clock instead
   * of the document's, and rode out of step with the art it is meant to outline.
   */
  it('pins a flyer’s outline ring the moment it starts attacking, not a frame later', async () => {
    const root = document.createElement('div');
    const unpin = pinFlight(root);
    const li = flyer();
    const flying = animate(li, ['fly-figure', 'fly-tilt']);
    root.append(li);
    await flush();
    expect(flying.map((a) => a.startTime), 'already flying, already pinned').toEqual([0, 0]);

    // The ring's own `fly-figure` joins the two already-pinned ones, unpinned until this very change.
    const withRing = animate(li, ['fly-figure', 'fly-tilt', 'fly-figure']);
    li.setAttribute('data-attacking', '');
    await flush();
    expect(withRing.map((a) => a.startTime), 'the ring is pinned with everything else, the moment it appears').toEqual([0, 0, 0]);

    unpin();
  });
});

describe('the loop as flight.css draws it', () => {
  const css = readFileSync(resolve(import.meta.dirname ?? 'games/magic/ui/src/play', 'flight.css'), 'utf8');
  /** A keyframe list's stops: where in the iteration (0–1) and the declarations there. */
  const stops = (name: string): { at: number; body: string }[] => {
    const block = css.match(new RegExp(`@keyframes ${name} \\{([\\s\\S]*?)\\n\\}`))?.[1] ?? '';
    return [...block.matchAll(/([\d.]+)% \{([^}]*)\}/g)].map((m) => ({ at: Number(m[1]) / 100, body: m[2]! }));
  };
  const LOOPS = 4;
  const theta = (at: number): number => 2 * Math.PI * LOOPS * at;
  const nums = (s: string): number[] => [...s.matchAll(/-?[\d.]+/g)].map((m) => Number(m[0]));
  /** The largest distance from the curve, at every stop and halfway between each two (linear in between). */
  const worst = (name: string, read: (body: string) => number[], curve: (t: number) => number[]): number => {
    const list = stops(name);
    expect(list.length, `${name}: every 15° of four loops`).toBe(LOOPS * 24 + 1);
    let most = 0;
    list.forEach((s, i) => {
      const at = read(s.body);
      most = Math.max(most, ...curve(theta(s.at)).map((v, j) => Math.abs(v - at[j]!)));
      const next = list[i + 1];
      if (next === undefined) return;
      const mid = read(next.body).map((v, j) => (v + at[j]!) / 2);
      most = Math.max(most, ...curve(theta((s.at + next.at) / 2)).map((v, j) => Math.abs(v - mid[j]!)));
    });
    return most;
  };

  it('draws the figure-8 within 0.05 px, about the resting lift', () => {
    const read = (body: string): number[] => {
      const m = body.match(/translate: (-?[\d.]+)px calc\(var\(--fly-rest\) \+ (-?[\d.]+)px\)/);
      expect(m, body).not.toBeNull();
      return [Number(m![1]), Number(m![2])];
    };
    expect(worst('fly-figure', read, (t) => [-3.5 * Math.cos(t), 1.25 * Math.sin(2 * t)])).toBeLessThan(0.05);
  });

  it('leans with the path’s speed within 0.1°, about an axis in the card’s own plane', () => {
    const read = (body: string): number[] => {
      const [x, y, z, deg] = nums(body);
      expect(z, body).toBe(0);
      return [x! * deg!, y! * deg!];
    };
    expect(worst('fly-tilt', read, (t) => [3 * Math.cos(2 * t), -4 * Math.sin(t)])).toBeLessThan(0.1);
  });

  it('drifts the shadow against the sway, narrowing and fading as the card rises', () => {
    const read = (body: string): number[] => {
      const [x, , s, , o] = nums(body);
      return [x!, s!, o!];
    };
    expect(worst('fly-shadow', read, (t) => [1.4 * Math.cos(t), 1 + 0.08 * Math.sin(2 * t), 0.825 + 0.175 * Math.sin(2 * t)])).toBeLessThan(0.02);
  });

  it('runs four loops to an iteration, so a flyer wakes the main thread once in four loops', () => {
    const card = readFileSync(resolve(import.meta.dirname ?? 'games/magic/ui/src/play', 'card.css'), 'utf8');
    expect(card).toMatch(/--fly-iteration:\s*calc\(var\(--fly-loop\) \* 4\)/);
    for (const name of ['fly-figure', 'fly-tilt', 'fly-shadow']) {
      expect(card, `${name} runs on the iteration`).toMatch(new RegExp(`${name} var\\(--fly-iteration\\) linear var\\(--fly-start\\) infinite`));
      const list = stops(name);
      expect(list[0]!.body, `${name} ends where it starts`).toBe(list.at(-1)!.body);
    }
  });
});
