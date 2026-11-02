/*
 * What a heavy blow does to the table, as heavy as `entries.ts`'s `entryWeight` says: the table
 * shaking (`crash.ts`'s `shake`), cracks running out from under it and the cards around it knocked
 * away, settling back into their own places. One module for every such blow: a creature landing
 * (`entries.ts`) and a creature's charge striking a player (`numbers.ts`) — the operator, 2026-10-30:
 * "we should match the power of the board effects to how they scale with entry". Each starts at
 * `entryWeight`'s own threshold and grows with it; nothing here decides how heavy a blow is. A
 * charge's weight carries no cracks (`cracks: null`): the table cracks under a landing alone (the
 * operator, 2026-11-01: "the crack looks ugly").
 *
 * Also the board's stand-ins (`standIn`): a copy of a row card in the overlay that follows the card's
 * box every frame — what a knocked card and a landing card are drawn as, never a transform on a card
 * in a row (table-fit). Reduced motion: the cracks are not drawn (`quake.css`); the caller draws no
 * motion at all.
 */

import { everyFrame } from '../frame-phases.ts';
import { BEAT_ANIMATION_ID } from '../motion.ts';
import { shake } from './crash.ts';
import { copyOfCard, LEAVING_GAP_ATTR } from './departures.ts';
import type { CrackLook, EntryWeight } from './entries.ts';
import { seedOf } from './projectile.ts';
import { RAMMING_ATTR } from './ram.ts';
import { quicken } from './tempo.ts';
import './quake.css';

/** On everything a quake draws: the key of the blow it belongs to. */
export const QUAKE_ATTR = 'data-quake';

/** Where a blow lands, in client coordinates, and the size of what lands it: the cracks' reach and the rings of cards knocked away are measured in it. */
export interface Anchor {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** `el` as a blow's anchor: its centre and its own size. */
export function anchorOf(el: Element): Anchor {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
}

/**
 * A blow at `at` as heavy as `weight`: the table shakes, cracks and knocks the cards around it away,
 * each only past its own threshold. `self`, the card that landed, is never knocked. `done` settles
 * once everything it drew is gone; `cancel` takes it all off the table at once. At `tempo` (`./tempo.ts`).
 */
export function quake(
  board: HTMLElement,
  overlay: HTMLElement,
  at: Anchor,
  weight: EntryWeight,
  key: string,
  self: Element | null = null,
  tempo = 1,
): { done: Promise<unknown>; cancel: () => void } {
  const anims: Animation[] = [];
  const done: Promise<unknown>[] = [];
  const still = weight.shakePx > 0 ? shake(board, weight.shakePx, key, tempo) : () => undefined;
  if (weight.cracks !== null) done.push(crackle(board, at, weight.cracks, key, anims, tempo));
  if (weight.shove.rings > 0) done.push(shove(board, overlay, at, self, weight, key, anims, tempo));
  return {
    done: Promise.all(done),
    cancel: () => {
      still();
      for (const a of anims) a.cancel();
    },
  };
}

/** A row card a quake may copy and knock away: one drawn in its row right now — not a rammer's own card while its copy is out, a dying card's kept gap, a card waiting for its arrival or one another stand-in is drawing. */
function drawn(el: HTMLElement): boolean {
  return !el.hasAttribute(RAMMING_ATTR) && !el.hasAttribute(LEAVING_GAP_ATTR) && !WAITING_MARKS.some((m) => el.hasAttribute(m)) && el.style.visibility !== 'hidden';
}

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export const rel = (r: DOMRect, to: DOMRect): Box => ({ left: r.left - to.left, top: r.top - to.top, width: r.width, height: r.height });

/** What a row card wears while it waits for its arrival — `gestures/cast.ts`'s landing mark hides it, `numbers.ts`'s arrival mark fades it in — and its stand-in must not. */
const WAITING_MARKS = ['data-cast-landing', 'data-arriving-from'];

/**
 * A stand-in copy of `card`, in `overlay`, kept on its row card's box every frame until `stop`. Once
 * mounted it is lined up on the row card exactly — whatever the row does to the card's box (a turned
 * card is centred in its upright place by margins the copy does not have), the copy's own face is
 * moved onto the row card's face, so taking over from it and handing back to it never jumps.
 */
export function standIn(overlay: HTMLElement, card: HTMLElement, cls: string): { wrap: HTMLElement; box: () => Box; card: () => HTMLElement; mount: () => void; stop: () => void } {
  const wrap = document.createElement('div');
  wrap.className = cls;
  wrap.dataset.standIn = card.dataset.boardCard ?? '';
  wrap.setAttribute('aria-hidden', 'true');
  const piece = document.createElement('div');
  piece.className = 'board-entry__piece';
  const copy = copyOfCard(card);
  // The row card may already be hidden for its arrival; its copy never is.
  copy.style.visibility = '';
  for (const mark of WAITING_MARKS) copy.removeAttribute(mark);
  piece.append(copy);
  wrap.append(piece);
  let at: Box = rel(card.getBoundingClientRect(), overlay.getBoundingClientRect());
  let fix = { x: 0, y: 0 };
  let live = true;
  const id = card.dataset.boardCard;
  const root = card.closest('.board') ?? document;
  /** The read: where the row card is drawn now. */
  const measure = (): void => {
    // React may draw the row card again (a row reordered): the card as it is drawn now, still hidden.
    if (!card.isConnected) {
      const now = root.querySelector<HTMLElement>(`[data-zone="battlefield"] [data-board-card="${id}"]`);
      if (now !== null) {
        card = now;
        card.style.visibility = 'hidden';
      }
    }
    if (card.isConnected) at = rel(card.getBoundingClientRect(), overlay.getBoundingClientRect());
  };
  /** The write: the copy over it. */
  const draw = (): void => {
    Object.assign(wrap.style, { left: `${at.left + fix.x}px`, top: `${at.top + fix.y}px`, width: `${at.width}px` });
    wrap.style.setProperty('--card-w', `${at.width}px`);
  };
  const mount = (): void => {
    measure();
    draw();
    overlay.append(wrap);
    // Read with no motion on it yet: where the copy's card is drawn against where the row's is. One
    // layout, which the row card's own box comes out of as well: it is not read a second time.
    const want = card.getBoundingClientRect();
    const got = copy.getBoundingClientRect();
    fix = { x: want.left - got.left, y: want.top - got.top };
    at = rel(want, overlay.getBoundingClientRect());
    draw();
    // Every frame after, with every other loop's reads and then its writes (`../frame-phases.ts`).
    everyFrame(() => {
      if (!live) return null;
      measure();
      return draw;
    });
  };
  return { wrap, box: () => at, card: () => card, mount, stop: () => (live = false) };
}

/** A card's shadow when it is `lift` px off the table. */
export function shadow(lift: number): string {
  return `drop-shadow(0 ${(2 + lift * 0.5).toFixed(1)}px ${(3 + lift * 0.6).toFixed(1)}px rgb(0 0 0 / ${(0.25 + lift * 0.006).toFixed(2)}))`;
}

/**
 * `el.animate(frames, options)`, resolved when it finishes — or at once where the environment has
 * no Web Animations (a jsdom test; `crash.ts`/`ram.ts`/`projectile.ts`'s own guard, one place here).
 * Never throws, and never rejects: a cancelled animation ends a run the same as a finished one.
 * `into` keeps the animation, for a caller that may cancel it. It plays at `tempo` (`./tempo.ts`).
 */
export function play(el: Element, frames: Keyframe[], options: KeyframeAnimationOptions, into: Animation[] | undefined, tempo: number): Promise<void> {
  if (typeof (el as HTMLElement).animate !== 'function') return Promise.resolve();
  const anim = quicken((el as HTMLElement).animate(frames, options), tempo);
  into?.push(anim);
  return anim.finished.then(
    () => undefined,
    () => undefined,
  );
}

/** How fast a crack runs, in ms per px. */
const CRACK_MS_PER_PX = 1.6;

interface Crack {
  pts: { x: number; y: number }[];
  /** Its width at its root; it narrows to a point at its end. */
  root: number;
  /** When it starts to run, ms after the landing: a fork waits for its parent to reach it. */
  at: number;
}

/** Along a crack's length, 0 at its root and 1 at its end: how wide it is, as a share of its root. */
const taper = (t: number): number => 1 - 0.92 * t;

/**
 * One crack as the ground splits, breaking direction `breaks` times (or once more): straight runs
 * that zigzag about the crack's own line — each run splinters the opposite way to the last, 18 to
 * 40 degrees off it — so it never bends into a curve and always heads outward. Forks leave from a
 * kink, on alternate sides, as wide as the crack is there less a third, once it reaches them.
 */
function runCrack(out: Crack[], x: number, y: number, heading: number, len: number, root: number, at: number, breaks: number, depth: number, forks: number, r: (k: string) => number, id: string): void {
  // `breaks` changes of direction, or one more: that many runs, plus one.
  const runs = breaks + 1 + (r(`${id}n`) < 0.5 ? 0 : 1);
  const pts = [{ x, y }];
  const lengths = Array.from({ length: runs }, (_, k) => (len / runs) * (0.6 + 0.8 * r(`${id}l${k}`)));
  const total = lengths.reduce((a, b) => a + b, 0);
  let side = r(`${id}s`) > 0.5 ? 1 : -1;
  let forkSide = r(`${id}fs`) > 0.5 ? 1 : -1;
  let gone = 0;
  const pending: (() => void)[] = [];
  for (let k = 0; k < runs; k++) {
    const run = heading + side * (0.31 + 0.39 * r(`${id}a${k}`));
    side = -side;
    x += Math.cos(run) * lengths[k]!;
    y += Math.sin(run) * lengths[k]!;
    pts.push({ x, y });
    gone += lengths[k]!;
    if (depth > 0 && k < runs - 1 && r(`${id}f${k}`) < forks) {
      const [fx, fy, fh, left, there] = [x, y, heading + forkSide * (0.6 + 0.4 * r(`${id}fa${k}`)), total - gone, gone];
      forkSide = -forkSide;
      pending.push(() => runCrack(out, fx, fy, fh, left * (0.45 + 0.3 * r(`${id}fl${k}`)), root * taper(there / total) * 0.66, at + there * CRACK_MS_PER_PX, Math.max(1, breaks - 2), depth - 1, forks, r, `${id}.${k}`));
    }
  }
  out.push({ pts, root, at });
  for (const fork of pending) fork();
}

/** A crack's outline: both sides of its line, as wide as `taper` says at each point, closed at its tip. */
function outline(c: Crack, scale: number): string {
  const { pts } = c;
  const along = [0];
  for (let i = 1; i < pts.length; i++) along.push(along[i - 1]! + Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y));
  const total = along[along.length - 1]! || 1;
  const left: string[] = [];
  const right: string[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    // The normal at a point: the average of its two runs' normals, stretched so both runs keep their width (a mitre).
    const a = pts[Math.max(0, i - 1)]!;
    const b = pts[i]!;
    const n = pts[i + 1]!;
    const d1 = i === 0 ? { x: n.x - b.x, y: n.y - b.y } : { x: b.x - a.x, y: b.y - a.y };
    const d2 = { x: n.x - b.x, y: n.y - b.y };
    const l1 = Math.hypot(d1.x, d1.y) || 1;
    const l2 = Math.hypot(d2.x, d2.y) || 1;
    const nx = -(d1.y / l1 + d2.y / l2);
    const ny = d1.x / l1 + d2.x / l2;
    const nl = Math.hypot(nx, ny) || 1;
    const cos = Math.max(0.35, (nx / nl) * (-d2.y / l2) + (ny / nl) * (d2.x / l2));
    const half = ((c.root * scale) / 2) * taper(along[i]! / total) / cos;
    left.push(`${(b.x + (nx / nl) * half).toFixed(1)} ${(b.y + (ny / nl) * half).toFixed(1)}`);
    right.unshift(`${(b.x - (nx / nl) * half).toFixed(1)} ${(b.y - (ny / nl) * half).toFixed(1)}`);
  }
  const tip = pts[pts.length - 1]!;
  return `M ${left.join(' L ')} L ${tip.x.toFixed(1)} ${tip.y.toFixed(1)} L ${right.join(' L ')} Z`;
}

/**
 * Cracks in the table running out from under the blow: they run outward in stages, hold, then
 * fade. Under the cards, not over them, and across the whole table: each battlefield draws the same
 * cracks in table coordinates, clipped to itself, below everything it holds — the two sides meet
 * (`board.css`'s `.zone--battlefield` seam), so a crack runs straight over onto the other side.
 */
function crackle(board: HTMLElement, at: Anchor, look: CrackLook, key: string, into: Animation[], tempo: number): Promise<void> {
  const c = { width: at.w, height: at.h };
  const reach = Math.max(c.width, c.height) * look.reach;

  const r = (k: string): number => seedOf(`${key}:c:${k}`);
  const cracks: Crack[] = [];
  for (let i = 0; i < look.count; i++) {
    const a0 = (i / look.count) * Math.PI * 2 + (r(`a${i}`) - 0.5) * 0.6;
    // From the card's edge, not its centre: the card covers where they start.
    const ex = Math.cos(a0) * c.width * 0.45;
    const ey = Math.sin(a0) * c.height * 0.45;
    runCrack(cracks, ex, ey, a0, reach * (0.5 + 0.5 * r(`l${i}`)), look.root * (0.85 + 0.3 * r(`w${i}`)), r(`t${i}`) * 60, look.breaks, look.depth, look.forks, r, `${i}`);
  }

  const ns = 'http://www.w3.org/2000/svg';
  const size = reach * 2.6;
  const layers: HTMLElement[] = [];
  const zones = [...board.querySelectorAll<HTMLElement>('[data-zone="battlefield"]')];
  zones.forEach((zone, zi) => {
    const z = zone.getBoundingClientRect();
    const layer = document.createElement('div');
    layer.className = 'board-entry__crackle';
    layer.setAttribute(QUAKE_ATTR, key);
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `${-size / 2} ${-size / 2} ${size} ${size}`);
    Object.assign(svg.style, { left: `${at.x - z.left - size / 2}px`, top: `${at.y - z.top - size / 2}px`, width: `${size}px`, height: `${size}px` });
    const defs = document.createElementNS(ns, 'defs');
    svg.append(defs);
    // The glow's own blur, an SVG filter (never a CSS one: a card image sits in every battlefield
    // this draws into, and no stylesheet rule reaching it may carry a colour filter).
    const glowFilterId = `glow-blur-${key}-${zi}`;
    const glowFilter = document.createElementNS(ns, 'filter');
    glowFilter.id = glowFilterId;
    glowFilter.setAttribute('x', '-50%');
    glowFilter.setAttribute('y', '-50%');
    glowFilter.setAttribute('width', '200%');
    glowFilter.setAttribute('height', '200%');
    const blur = document.createElementNS(ns, 'feGaussianBlur');
    blur.setAttribute('stdDeviation', '3');
    glowFilter.append(blur);
    defs.append(glowFilter);
    cracks.forEach((crack, ci) => {
      // The crack runs: its outline is shown through its own line, drawn from root to tip.
      const id = `crack-${key}-${zi}-${ci}`;
      const mask = document.createElementNS(ns, 'mask');
      mask.id = id;
      Object.entries({ maskUnits: 'userSpaceOnUse', x: -size / 2, y: -size / 2, width: size, height: size }).forEach(([k, v]) => mask.setAttribute(k, String(v)));
      const run = document.createElementNS(ns, 'path');
      run.setAttribute('d', crack.pts.map((p, n) => `${n === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' '));
      run.setAttribute('pathLength', '1');
      run.classList.add('board-entry__crack-run');
      // The mask's own reveal — full luminance, not a themed colour (hence inline, not in entries.css).
      run.style.stroke = 'rgb(255 255 255)';
      run.style.strokeWidth = String(crack.root * 4);
      const length = crack.pts.slice(1).reduce((sum, p, n) => sum + Math.hypot(p.x - crack.pts[n]!.x, p.y - crack.pts[n]!.y), 0);
      run.style.animationDelay = `${Math.round(crack.at / tempo)}ms`;
      run.style.animationDuration = `${Math.max(60, Math.round(length * CRACK_MS_PER_PX)) / tempo}ms`;
      mask.append(run);
      defs.append(mask);
      for (const kind of look.glow > 0 ? (['glow', 'line'] as const) : (['line'] as const)) {
        const shape = document.createElementNS(ns, 'path');
        shape.setAttribute('d', outline(crack, kind === 'glow' ? 2.6 : 1));
        shape.setAttribute('mask', `url(#${id})`);
        shape.classList.add(`board-entry__crack--${kind}`);
        if (kind === 'glow') {
          shape.style.opacity = (0.55 * look.glow).toFixed(2);
          shape.setAttribute('filter', `url(#${glowFilterId})`);
        }
        svg.append(shape);
      }
    });
    layer.append(svg);
    // First in the battlefield: painted before its cards, which are positioned, so always under them.
    zone.prepend(layer);
    layers.push(layer);
  });
  const total = 400 + look.holdMs + 450;
  return Promise.all(
    layers.map((layer) => play(layer, [{ opacity: 1 }, { opacity: 1, offset: (400 + look.holdMs) / total }, { opacity: 0 }], { id: BEAT_ANIMATION_ID, duration: total, easing: 'ease-in' }, into, tempo)),
  ).then(() => layers.forEach((l) => l.remove()));
}

/**
 * A heavy blow knocks the cards around it away from it, and each settles back into its own
 * place: drawn as stand-ins, thrown out along the line from the landing, turning, then gliding home.
 * No card changes its place. The first ring — within one card of it every way, diagonals too,
 * either seat's — is thrown hardest; from 12 power the ring beyond is knocked too, more gently and a
 * beat later, as the blow travels out.
 */
async function shove(board: HTMLElement, overlay: HTMLElement, at: Anchor, self: Element | null, weight: EntryWeight, key: string, into: Animation[], tempo: number): Promise<void> {
  const t = { width: at.w, height: at.h };
  const tx = at.x;
  const ty = at.y;
  /** Which ring a card is in: 1 within one card every way, 2 within two, else 0. */
  const ringOf = (b: DOMRect): number => {
    const dx = Math.abs(b.left + b.width / 2 - tx);
    const dy = Math.abs(b.top + b.height / 2 - ty);
    if (dx <= t.width * 1.6 && dy <= t.height * 1.5) return 1;
    if (dx <= t.width * 2.7 && dy <= t.height * 2.5) return 2;
    return 0;
  };
  const near = [...board.querySelectorAll<HTMLElement>('[data-zone="battlefield"] [data-board-card]')]
    .filter((el) => el !== self && drawn(el))
    .map((el) => ({ el, ring: ringOf(el.getBoundingClientRect()) }))
    .filter((n) => n.ring > 0 && n.ring <= weight.shove.rings);
  await Promise.all(
    near.map(({ el, ring }, i) => {
      const b = el.getBoundingClientRect();
      const vx = b.left + b.width / 2 - tx;
      const vy = b.top + b.height / 2 - ty;
      const len = Math.hypot(vx, vy) || 1;
      const r = (k: string): number => seedOf(`${key}:sh${i}:${k}`);
      const strength = weight.shove.strength * (ring === 1 ? 1 : 0.4);
      const push = t.width * strength * (0.8 + 0.4 * r('d'));
      const kx = (vx / len) * push;
      const ky = (vy / len) * push * 0.7;
      const spin = (vx < 0 ? -1 : 1) * (6 + 10 * r('r')) * (strength / 0.6);
      const lift = 16 * strength;
      const s = standIn(overlay, el, 'board-entry board-entry--shoved');
      s.wrap.setAttribute(QUAKE_ATTR, key);
      s.mount();
      el.style.visibility = 'hidden';
      return play(
        s.wrap,
        [
          // Thrown out hard, hanging a moment, then home: each leg its own pace.
          { translate: '0 0', rotate: '0deg', scale: '1', filter: shadow(0), easing: 'cubic-bezier(0.15, 0.8, 0.3, 1)' },
          { translate: `${kx}px ${ky - lift}px`, rotate: `${spin}deg`, scale: String(1 + 0.1 * strength), filter: shadow(24 * strength), offset: 0.35, easing: 'ease-in-out' },
          { translate: `${kx * 0.9}px ${ky * 0.9 - lift * 0.9}px`, rotate: `${spin * 0.85}deg`, scale: String(1 + 0.08 * strength), filter: shadow(22 * strength), offset: 0.48, easing: 'cubic-bezier(0.45, 0, 0.25, 1)' },
          { translate: '0 0', rotate: '0deg', scale: '1', filter: shadow(0) },
        ],
        // The outer ring a beat after the inner: the blow travels out.
        { id: BEAT_ANIMATION_ID, duration: 860, delay: ring === 1 ? 0 : 70, easing: 'linear', fill: 'both' },
        into,
        tempo,
      ).then(() => {
        s.stop();
        s.wrap.remove();
        el.style.visibility = '';
      });
    }),
  );
}
