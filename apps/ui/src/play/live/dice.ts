/*
 * A die roll, drawn on the table (the operator, 2026-10-27: "wizard's spellbook animation? we need a
 * dice rolling animation that would be cool"). Of three treatments shown, the one chosen was A, "Tumble
 * from the card": the die drops out of the card that rolled it, bounces twice along the felt with its
 * shadow under it, turning two full turns, and settles beside the card on the roller's side, its faces
 * flickering fast and slowing until it lands on the real result; then a short pop and a ring.
 *
 * ## What it draws from
 *
 * Forge tells a roll only as prose ("Alice rolled 14"). The bridge reads the roll where Forge still
 * holds the ability and hands it to the seat's `message` frame that says it (`@hadoku/forge-wire`'s
 * `DieRollSchema`): who rolled, the die's sides, each result, and the card it came from. `match.ts`
 * keeps each as a {@link ShownRoll}; this draws each one once, as it arrives. The result stays readable
 * after the die is gone: the same frame's text is in the log.
 *
 * ## The die
 *
 * Six sides draw pips on a rounded square; every other die — a d20, and a d4, d8, d10, d12 or one whose
 * sides the bridge could not read — draws the d20's hexagon with its number on the front face. Several
 * dice in one roll each tumble, a little apart in time and in place; one the roll ignored dims once it
 * lands. The other seat's die is tinted, and its ring is theirs (`dice.css`).
 *
 * ## The board waits for it, as for any beat
 *
 * The tumble and its landing are a beat (`../motion.ts`'s `noteBoardDrawing`, the animations carrying
 * `BEAT_ANIMATION_ID`): the pacer holds what the other seat did next until the die has landed, and never
 * holds the seat's own acts (`./pace.ts`). Fast Mode is pacing, not motion: the die still tumbles, and
 * nothing waits for it. Reduced motion: the die appears where it lands, showing its result.
 *
 * Every element is in the board's overlay, never a transform on a card in a row (table-fit).
 */

import type { DieRoll } from '@hadoku/forge-wire';

import { viewerOf, type BoardView } from '../adapter.ts';
import { BEAT_ANIMATION_ID, noteBoardDrawing, prefersReducedMotion } from '../motion.ts';
import { battlefieldCard, faceBox, overlayOf } from './board-dom.ts';

import './dice.css';

/** A roll as the board draws it: numbered once for the page's life, and when it arrived. */
export interface ShownRoll {
  readonly id: number;
  readonly at: number;
  readonly player: number;
  /** Null: the bridge could not read the die's sides. */
  readonly sides: number | null;
  readonly results: readonly number[];
  readonly ignored: readonly number[];
  readonly source: number | null;
}

let lastRollId = 0;

/** The wire's roll, numbered and stamped as it arrives. */
export function shownRoll(roll: DieRoll, at: number = Date.now()): ShownRoll {
  lastRollId += 1;
  return {
    id: lastRollId,
    at,
    player: roll.player.id,
    sides: roll.sides,
    results: roll.results,
    ignored: roll.ignored ?? [],
    source: roll.source?.id ?? null,
  };
}

/** The tumble, from the card to where the die settles. */
export const TUMBLE_MS = 1250;
/** The pop as it lands. */
export const POP_MS = 260;
/** The ring it sends out as it lands. */
export const RING_MS = 420;
/** Between two dice of one roll. */
export const DIE_STAGGER_MS = 120;
/** How long a landed die stays on the table, then how long it takes to fade. */
export const LINGER_MS = 1800;
export const FADE_MS = 300;
/** A roll that arrived longer ago than this is history (a board mounted late): it is not drawn. */
const FRESH_MS = 1000;

/** One die of a roll: the face it lands on, and whether the roll ignored it. */
export interface Die {
  readonly result: number;
  readonly ignored: boolean;
}

/** Every die a roll threw: its kept results, then the ones it ignored. */
export function diceOf(roll: ShownRoll): Die[] {
  return [...roll.results.map((result) => ({ result, ignored: false })), ...roll.ignored.map((result) => ({ result, ignored: true }))];
}

/** The highest face the flicker shows: the die's own sides, else a d20's, else the result itself. */
export function facesOf(sides: number | null, result: number): number {
  return Math.max(sides ?? 20, result);
}

/** The die's shape: pips for six sides, the d20's hexagon and a number for every other. */
export function shapeOf(sides: number | null): 'd6' | 'd20' {
  return sides === 6 ? 'd6' : 'd20';
}

/**
 * The next face of the flicker after `n`, of `faces`: never the same face twice running. `r` is a random
 * number in [0, 1).
 */
export function nextFace(n: number, faces: number, r: number): number {
  return 1 + ((n + 6 + Math.floor(r * 5)) % faces);
}

/** The gap between two faces `t` (0–1) into the tumble: fast at first, slowing as it settles. */
export function faceGapMs(t: number): number {
  return 30 + 220 * t * t;
}

export interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface DiePath {
  readonly size: number;
  /** Where it starts: the card's centre. */
  readonly sx: number;
  readonly sy: number;
  /** Where it settles: beside the card, on the roller's side. */
  readonly ex: number;
  readonly ey: number;
  /** 1 when it rolls to the right, -1 to the left: the way it turns. */
  readonly dir: 1 | -1;
}

/**
 * Where the `index`th die of a roll from `card` goes, all in the overlay's own coordinates (`overlay`'s
 * width and height): from the card's centre, to beside it on the side that faces the table's middle —
 * the approved design's own two cases, the seat's card at the left throwing right and the other seat's
 * at the right throwing left — a little toward the roller's own edge, each further die a step further
 * out. A die that would leave the overlay settles on the card's other side instead.
 */
export function diePath(card: Box, overlay: Pick<Box, 'width' | 'height'>, own: boolean, index: number): DiePath {
  // Sized off the card's long side, so a tapped card throws the same die as an untapped one.
  const size = Math.round(Math.min(64, Math.max(40, Math.max(card.width, card.height) * 0.45)));
  const sx = card.left + card.width / 2 - size / 2;
  const sy = card.top + card.height / 2 - size / 2;
  const step = index * size * 1.15;
  const right = card.left + card.width + size * 1.2 + step;
  const left = card.left - size * 1.2 - size - step;
  const inward = card.left + card.width / 2 <= overlay.width / 2 ? right : left;
  const outward = inward === right ? left : right;
  const fits = (x: number): boolean => x >= 0 && x + size <= overlay.width;
  const ex = Math.min(Math.max(0, fits(inward) || !fits(outward) ? inward : outward), Math.max(0, overlay.width - size));
  const ey = Math.min(Math.max(0, sy + (own ? 1 : -1) * card.height * 0.18), Math.max(0, overlay.height - size));
  return { size, sx, sy, ex, ey, dir: ex >= sx ? 1 : -1 };
}

/** The tumble's keyframes: up off the card, down, a lower hop, and the last roll into place — two turns in all. */
export function tumbleFrames(p: DiePath): Keyframe[] {
  const { sx, sy, ex, ey, dir, size } = p;
  const mid1 = sx + (ex - sx) * 0.45;
  const mid2 = sx + (ex - sx) * 0.8;
  const high = size * 1.03;
  const low = size * 0.45;
  const nudge = size * 0.34;
  return [
    { transform: `translate(${sx}px,${sy}px) rotate(0deg) scale(.6)`, offset: 0 },
    { transform: `translate(${mid1}px,${ey - high}px) rotate(${dir * 260}deg) scale(1.05)`, offset: 0.3 },
    { transform: `translate(${mid1 + nudge * dir}px,${ey}px) rotate(${dir * 420}deg) scale(.95,1.05)`, offset: 0.45 },
    { transform: `translate(${mid2}px,${ey - low}px) rotate(${dir * 560}deg) scale(1)`, offset: 0.65 },
    { transform: `translate(${ex - size * 0.1 * dir}px,${ey}px) rotate(${dir * 680}deg) scale(1)`, offset: 0.82 },
    { transform: `translate(${ex}px,${ey}px) rotate(${dir * 720}deg) scale(1)`, offset: 1 },
  ];
}

/** The shadow's keyframes: under the die along the felt, always on the ground line. */
export function shadowFrames(p: DiePath, frames: readonly Keyframe[]): Keyframe[] {
  return frames.map((k) => {
    const m = /translate\(([-\d.e]+)px,/.exec(String(k.transform));
    const x = m === null ? p.ex : Number(m[1]);
    return { transform: `translate(${x + p.size * 0.07}px,${p.ey + p.size * 0.93}px)`, offset: k.offset ?? null };
  });
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/** The d20: a pointy-top hexagon, an upward front triangle and the facets out to the rim, each shade a theme mix (`dice.css`). */
function d20Svg(): SVGSVGElement {
  const svg = svgEl('svg', { viewBox: '-54 -54 108 108', 'aria-hidden': 'true' });
  const H = [
    [0, -50],
    [43.3, -25],
    [43.3, 25],
    [0, 50],
    [-43.3, 25],
    [-43.3, -25],
  ] as const;
  const T = [0, -24] as const;
  const L = [-28, 20] as const;
  const R = [28, 20] as const;
  const at = (...points: (readonly [number, number])[]): string => points.map((q) => q.join(',')).join(' ');
  const facets: [string, string][] = [
    [at(H[0], H[1], T), 'shade'],
    [at(H[0], T, H[5]), 'shade'],
    [at(H[1], H[2], R), 'dark'],
    [at(H[1], R, T), 'face'],
    [at(H[5], T, L), 'face'],
    [at(H[5], L, H[4]), 'dark'],
    [at(H[2], H[3], R), 'dark'],
    [at(H[3], L, R), 'shade'],
    [at(H[3], H[4], L), 'dark'],
  ];
  for (const [points, tone] of facets) svg.append(svgEl('polygon', { points, class: `board-die__facet board-die__facet--${tone}` }));
  svg.append(svgEl('polygon', { points: at(T, R, L), class: 'board-die__facet board-die__facet--front' }));
  const num = svgEl('text', { x: 0, y: 13, 'text-anchor': 'middle', class: 'board-die__num' });
  svg.append(num);
  return svg;
}

const PIPS: Record<number, readonly (readonly [number, number])[]> = {
  1: [[0, 0]],
  2: [
    [-1, -1],
    [1, 1],
  ],
  3: [
    [-1, -1],
    [0, 0],
    [1, 1],
  ],
  4: [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ],
  5: [
    [-1, -1],
    [1, -1],
    [0, 0],
    [-1, 1],
    [1, 1],
  ],
  6: [
    [-1, -1],
    [1, -1],
    [-1, 0],
    [1, 0],
    [-1, 1],
    [1, 1],
  ],
};

/** The d6: a rounded square and its pips. */
function d6Svg(): SVGSVGElement {
  const svg = svgEl('svg', { viewBox: '-54 -54 108 108', 'aria-hidden': 'true' });
  svg.append(svgEl('rect', { x: -42, y: -42, width: 84, height: 84, rx: 16, class: 'board-die__facet board-die__facet--front' }));
  svg.append(svgEl('g', { class: 'board-die__pips' }));
  return svg;
}

/** Shows face `n` on `die`: its pips, or its number. */
function showFace(die: HTMLElement, n: number): void {
  die.dataset.dieFace = String(n);
  const pips = die.querySelector('.board-die__pips');
  if (pips !== null) {
    pips.replaceChildren(...(PIPS[n] ?? []).map(([x, y]) => svgEl('circle', { cx: x * 22, cy: y * 22, r: 8, class: 'board-die__pip' })));
    return;
  }
  const num = die.querySelector('.board-die__num');
  if (num === null) return;
  num.textContent = String(n);
  // Two digits fit the front face at the house size; three are drawn smaller.
  num.setAttribute('font-size', String(n >= 100 ? 15 : 22));
}

export interface DiceHost {
  /** Defaults to the real `prefers-reduced-motion` media query. */
  readonly reducedMotion?: () => boolean;
}

export interface DiceHandle {
  /** Call with the match's rolls and the view drawn with them: draws each roll not drawn yet, once. */
  notify(rolls: readonly ShownRoll[], view: BoardView): void;
  dispose(): void;
}

export function installDice(canvas: HTMLElement, host: DiceHost = {}): DiceHandle {
  let live = true;
  const drawn = new Set<number>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const frames = new Set<number>();
  const elements = new Set<Element>();
  /** The settle of each roll still landing: settled at once on dispose. */
  const landing = new Set<() => void>();
  const reduced = (): boolean => host.reducedMotion?.() ?? prefersReducedMotion();

  function schedule(fn: () => void, ms: number): void {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (live) fn();
    }, ms);
    timers.add(timer);
  }

  function place(el: Element): void {
    elements.add(el);
  }

  function remove(el: Element): void {
    el.remove();
    elements.delete(el);
  }

  /** Faces flicker, fast and slowing, for `ms`, then land on `result`. */
  function flicker(die: HTMLElement, faces: number, result: number, ms: number): Promise<void> {
    return new Promise((done) => {
      const start = performance.now();
      let last = -Infinity;
      let n = 1;
      const tick = (now: number): void => {
        if (!live) return done();
        const t = (now - start) / ms;
        if (t >= 1) {
          showFace(die, result);
          return done();
        }
        if (now - last > faceGapMs(t)) {
          last = now;
          n = nextFace(n, faces, Math.random());
          showFace(die, n);
        }
        const id = requestAnimationFrame((next) => {
          frames.delete(id);
          tick(next);
        });
        frames.add(id);
      };
      tick(start);
    });
  }

  /** Where the roll comes from: its card on the battlefield, else that card on the stack, else the roller. */
  function sourceOf(roll: ShownRoll): Element | null {
    const card = roll.source === null ? null : (battlefieldCard(canvas, roll.source) ?? canvas.querySelector(`[data-placed-card="${roll.source}"]`));
    return card ?? faceBox(canvas, roll.player);
  }

  function makeDie(roll: ShownRoll, die: Die, own: boolean, size: number): HTMLElement {
    const el = document.createElement('div');
    el.className = 'board-die';
    el.dataset.die = String(roll.id);
    el.dataset.dieSides = roll.sides === null ? '' : String(roll.sides);
    el.dataset.dieResult = String(die.result);
    el.dataset.dieRoller = own ? 'you' : 'them';
    el.setAttribute('aria-hidden', 'true');
    el.style.width = el.style.height = `${size}px`;
    el.append(shapeOf(roll.sides) === 'd6' ? d6Svg() : d20Svg());
    return el;
  }

  /** The landed die: it stays a moment, then fades and goes. */
  function linger(die: HTMLElement): void {
    die.dataset.dieLanded = '';
    schedule(() => {
      if (reduced() || typeof die.animate !== 'function') return remove(die);
      die.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FADE_MS, fill: 'forwards', id: 'die-fade' }).finished.then(
        () => remove(die),
        () => remove(die),
      );
    }, LINGER_MS);
  }

  function ring(root: HTMLElement, x: number, y: number, size: number, own: boolean): void {
    const el = document.createElement('div');
    el.className = 'board-die-ring';
    el.dataset.dieRoller = own ? 'you' : 'them';
    el.style.left = `${x - size / 2}px`;
    el.style.top = `${y - size / 2}px`;
    el.style.width = el.style.height = `${size}px`;
    root.append(el);
    place(el);
    el.animate([{ transform: 'scale(.6)', opacity: 0.9 }, { transform: 'scale(1.6)', opacity: 0 }], { duration: RING_MS, easing: 'ease-out', id: BEAT_ANIMATION_ID }).finished.then(
      () => remove(el),
      () => remove(el),
    );
  }

  /** One die, from `from` to beside it: its tumble, its shadow, its faces, its landing. Settles when it has landed. */
  async function throwDie(root: HTMLElement, roll: ShownRoll, die: Die, own: boolean, path: DiePath): Promise<void> {
    const el = makeDie(roll, die, own, path.size);
    root.append(el);
    place(el);
    if (reduced() || typeof el.animate !== 'function') {
      el.style.transform = `translate(${path.ex}px,${path.ey}px)`;
      showFace(el, die.result);
      if (die.ignored) el.dataset.dieIgnored = '';
      linger(el);
      return;
    }
    const shadow = document.createElement('div');
    shadow.className = 'board-die-shadow';
    shadow.style.width = `${path.size * 0.86}px`;
    shadow.style.height = `${path.size * 0.24}px`;
    root.append(shadow);
    place(shadow);
    const kf = tumbleFrames(path);
    const easing = 'cubic-bezier(.3,.6,.4,1)';
    const tumble = el.animate(kf, { duration: TUMBLE_MS, easing, fill: 'forwards', id: BEAT_ANIMATION_ID });
    shadow.animate(shadowFrames(path, kf), { duration: TUMBLE_MS, easing, fill: 'forwards', id: BEAT_ANIMATION_ID });
    await Promise.all([tumble.finished.catch(() => undefined), flicker(el, facesOf(roll.sides, die.result), die.result, TUMBLE_MS * 0.92)]);
    remove(shadow);
    if (!live) return;
    ring(root, path.ex + path.size / 2, path.ey + path.size / 2, path.size * 1.2, own);
    const at = `translate(${path.ex}px,${path.ey}px) rotate(${path.dir * 720}deg)`;
    const pop = el.animate([{ transform: `${at} scale(1)` }, { transform: `${at} scale(1.18)` }, { transform: `${at} scale(1)` }], {
      duration: POP_MS,
      fill: 'forwards',
      id: BEAT_ANIMATION_ID,
    });
    if (die.ignored) el.dataset.dieIgnored = '';
    await pop.finished.catch(() => undefined);
    linger(el);
  }

  function draw(roll: ShownRoll, view: BoardView): void {
    const root = overlayOf(canvas);
    const from = sourceOf(roll);
    if (root === null || from === null) return;
    const box = root.getBoundingClientRect();
    const r = from.getBoundingClientRect();
    const card: Box = { left: r.left - box.left, top: r.top - box.top, width: r.width, height: r.height };
    const viewer = viewerOf(view)?.id ?? view.players[0]?.id;
    const own = roll.player === viewer;
    const still = reduced();
    const thrown = diceOf(roll).map(
      (die, i) =>
        new Promise<void>((resolve) => {
          const settle = (): void => {
            landing.delete(settle);
            resolve();
          };
          landing.add(settle);
          const go = (): void => void throwDie(root, roll, die, own, diePath(card, box, own, i)).then(settle, settle);
          // Reduced motion: every die is simply there, at once.
          if (i === 0 || still) go();
          else schedule(go, i * DIE_STAGGER_MS);
        }),
    );
    if (!still) noteBoardDrawing(Promise.all(thrown));
  }

  return {
    notify(rolls, view) {
      if (!live) return;
      const now = Date.now();
      for (const roll of rolls) {
        if (drawn.has(roll.id)) continue;
        drawn.add(roll.id);
        if (now - roll.at > FRESH_MS) continue;
        draw(roll, view);
      }
    },
    dispose() {
      live = false;
      for (const t of timers) clearTimeout(t);
      timers.clear();
      for (const f of frames) cancelAnimationFrame(f);
      frames.clear();
      for (const el of elements) el.remove();
      elements.clear();
      for (const settle of [...landing]) settle();
    },
  };
}
