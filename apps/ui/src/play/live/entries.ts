/*
 * A creature entering the battlefield is drawn arriving, and it lands as hard as it hits. Approved
 * design, after six preview rounds (AF413, ledger): https://claude.ai/artifact/U1nYg5D394VmKECMWbzpeu.
 *
 * Two independent parts, mirroring `departures.ts`'s `EXIT_MOTIONS`:
 *
 *  - an ENTRY MOTION, chosen by where the card came from (`entryMotionFor`): cast off the stack,
 *    raised out of a graveyard, returned from exile. A new origin or a per-card motion is an entry
 *    in `ENTRY_MOTIONS` plus its keyframes; nothing else knows a motion's name. The operator did not
 *    pick between the preview's two reanimate styles (a shadowed rise out of the pile, or a rift
 *    opening in the slot): shipped is `rise`; the other, `unearth`, is not ported — no dead code;
 *  - a LANDING, chosen by the creature's power (`entryWeight`), shared by every motion and every
 *    effect growing continuously with it, point by point, to `ENTRY_MAX` — no tier where several
 *    points look the same: the drop, a pressure ring from 2 power, debris thrown off the card's
 *    edges ramping in from 2 to a full spray at 7, the table shaking from 3, cracks in the table
 *    from 5 (reach, width, forks and glow all climbing to 15, a second generation of forks from 11),
 *    and, from 8 power, the cards around it knocked away (a second ring from 12), settling back into
 *    their own places.
 *
 * Everything is a stand-in in the board's overlay; the row card is hidden until the stand-in is
 * down (table-fit: never a transform on a card in a row). The stand-in follows its row card's box
 * every frame, so a row that reflows while it falls (the card's own arrival widening the row) moves
 * where it lands, and it lands there in one motion.
 *
 * `playEntry` plays a motion's own arrival (the climb to the hang point) and the landing as one
 * run, for `rise` and `blink`: nothing else travels the card to them (a graveyard pile, exile has no
 * ghost of its own). `playLanding` is the landing alone, for a card something else already carried
 * to its slot: `gestures/cast.ts`'s `landCastGhost` is the one trip a played or arriving card makes
 * on either screen (a cast, a token's travel from its maker, the other seat's echo) — its own flight
 * already ends in the slot, so the weight lands there as its last leg, never a second animation
 * bolted on after a gap.
 */

import { copyOfCard } from './departures.ts';
import { seedOf } from './projectile.ts';
import { shake } from './crash.ts';
import { BEAT_ANIMATION_ID, powerEase, powerSize } from '../motion.ts';
import './entries.css';

/** Where a permanent came from, picking its entry motion. A cast creature's own motion is `gestures/cast.ts`'s, not this module's — see the header. */
export type EntryOrigin = 'stack' | 'graveyard' | 'exile' | 'token';

/** How the table cracks under a landing, continuous with power — see {@link entryWeight}. */
export interface CrackLook {
  /** How many cracks. */
  readonly count: number;
  /** How many times each crack breaks direction, at least: a crack may break once more. */
  readonly breaks: number;
  /** How far, in the card's own size. */
  readonly reach: number;
  /** Width at the root, px. */
  readonly root: number;
  readonly forks: number;
  /** How many generations of forks (1: a fork never forks again). */
  readonly depth: number;
  /** The hot glow in the crack, 0..1. */
  readonly glow: number;
  readonly holdMs: number;
}

/** What a landing weighs, from the creature's power: every effect grows with it, point by point, to `ENTRY_MAX`. */
export interface EntryWeight {
  /** 0..1: how heavy the landing is, from a 1-power creature to `ENTRY_MAX`'s, past which nothing grows. */
  readonly power: number;
  /** How far the table shakes, px; 0 below 3 power. */
  readonly shakePx: number;
  /** Share of a full spray of debris, 0..1: a wisp at 2, all of it at 7. */
  readonly debris: number;
  /** The pressure ring under it: from 2 power. */
  readonly thump: boolean;
  /** How the table cracks under it: from 5 power. */
  readonly cracks: CrackLook | null;
  /** The cards around it knocked away (and settling back into their own places): from 8 power one ring, from 12 two. */
  readonly shove: { readonly rings: 0 | 1 | 2; readonly strength: number };
}

/** The power every effect stops growing at: a 15/15 lands as hard as anything ever does. */
export const ENTRY_MAX = 15;

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
/** 0 at `from`, 1 at `to`, straight between. */
const ramp = (p: number, from: number, to: number): number => clamp01((p - from) / (to - from));

/** A landing's weight, 0..1: a square-root curve from 1 to `ENTRY_MAX`, so the first few points each count and the top still climbs. */
export function entryPower(power: number): number {
  return Math.sqrt(ramp(power, 1, ENTRY_MAX));
}

/**
 * What a permanent's landing is weighed by: a creature by its power, every other permanent —
 * artifact, enchantment, planeswalker, battle — by its mana value (the operator, 2026-10-27: "all
 * non-creature permanents … similar entry but based on CMC"). A land's mana value is 0, so it just
 * drops. Instants and sorceries are out of scope — the operator is still deciding how a resolution
 * itself should look, a separate question from a permanent's own entry.
 */
export function entryHeft(card: { readonly typeLine: string; readonly power?: string | null; readonly manaValue?: number | null }): number {
  return /\bCreature\b/.test(card.typeLine) ? Number(card.power ?? 0) || 0 : (card.manaValue ?? 0);
}

/**
 * Every effect of a landing at `power`. Each starts at its own threshold and grows continuously to
 * `ENTRY_MAX` — no tier where several points look the same, no step where one point doubles it:
 * the thump and a wisp of debris from 2, no screen movement before 5 (the operator, 2026-10-27),
 * all the debris by 7, no cracks before 7 either (the operator, same day: "no crackles until 7"),
 * starting small (2-3 cracks, 2-3 breaks each, no forks) and growing in number, breaks, reach,
 * width and glow to 15 — forks only from 10, one level (a fork never forks again) — the shove from
 * 8, its second ring from 12. A 0-heft permanent lands light: nothing but the drop.
 */
export function entryWeight(power: number): EntryWeight {
  const p = Math.min(power, ENTRY_MAX);
  const t = ramp(p, 7, ENTRY_MAX);
  const s = ramp(p, 8, ENTRY_MAX);
  return {
    power: entryPower(p),
    shakePx: p < 5 ? 0 : 0.6 + ((p - 5) * (13 - 0.6)) / (ENTRY_MAX - 5),
    debris: ramp(p, 1.5, 7),
    thump: p >= 2,
    cracks:
      p < 7
        ? null
        : {
            count: 2 + Math.floor(4.99 * t),
            breaks: 2 + Math.floor(3.99 * t),
            reach: 0.8 + 0.7 * t,
            root: 2.2 + 3.8 * t,
            forks: p < 10 ? 0 : 0.15 + 0.2 * ramp(p, 10, ENTRY_MAX),
            depth: 1,
            glow: ramp(p, 8, ENTRY_MAX),
            holdMs: Math.round(250 + 600 * t),
          },
    shove: { rings: p >= 12 ? 2 : p >= 8 ? 1 : 0, strength: 0.15 + 0.45 * s },
  };
}

export const ENTRY_MOTIONS = {
  /** Off the stack: the cast card's own glide ends lifted over its slot, then drops. Never driven from here — see the header. */
  cast: { ms: 0 },
  /** Out of a graveyard: drained of colour, it flies up from the pile in a pall of shadow, then takes its colour back. */
  rise: { ms: 640 },
  /** Back from exile: it flickers in out of light. */
  blink: { ms: 420 },
  /** A token made: it appears over the place it will take, a touch small and bright, held there a beat, then let go (the operator, 2026-10-27: "created tokens drop onto the space they appear on as if released in that space"). */
  release: { ms: 220 },
} as const;
export type EntryMotion = keyof typeof ENTRY_MOTIONS;

/** Which entry motion a permanent plays, from where it came from. The one place this is chosen. */
export function entryMotionFor(origin: EntryOrigin): EntryMotion {
  if (origin === 'graveyard') return 'rise';
  if (origin === 'exile') return 'blink';
  if (origin === 'token') return 'release';
  return 'cast';
}

/** A rough budget for how long a motion plus its landing run, for a caller's own pacing — never the effects' own timing, which is the `Promise` `playEntry`/`playLanding` return. */
export function entryDurationMs(motion: EntryMotion, weight: EntryWeight): number {
  const dropMs = Math.round(260 + 260 * weight.power);
  const tailMs = motion === 'rise' ? 300 : motion === 'cast' ? 60 + 120 * weight.power : 0;
  return ENTRY_MOTIONS[motion].ms + tailMs + dropMs;
}

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

const rel = (r: DOMRect, to: DOMRect): Box => ({ left: r.left - to.left, top: r.top - to.top, width: r.width, height: r.height });

/** How high the stand-in hangs before it drops, how big it is there, and how long the drop takes. */
function hang(w: EntryWeight): { lift: number; scale: number; dropMs: number } {
  return { lift: 26 + 50 * w.power, scale: 1.1 + 0.2 * w.power, dropMs: Math.round(260 + 260 * w.power) };
}

export interface EntryRun {
  /** The board's `.board` element: what shakes. */
  board: HTMLElement;
  overlay: HTMLElement;
  /** The creature's row card, already rendered; hidden until the stand-in lands. */
  card: HTMLElement;
  /** Where it came from: a graveyard pile; null when it has nowhere to travel from (exile). */
  from: HTMLElement | null;
  motion: EntryMotion;
  weight: EntryWeight;
  key: string;
}

/**
 * A stand-in copy of `card`, in `overlay`, kept on its row card's box every frame until `stop`. Once
 * mounted it is lined up on the row card exactly — whatever the row does to the card's box (a turned
 * card is centred in its upright place by margins the copy does not have), the copy's own face is
 * moved onto the row card's face, so taking over from it and handing back to it never jumps.
 */
function standIn(overlay: HTMLElement, card: HTMLElement, cls: string): { wrap: HTMLElement; box: () => Box; mount: () => void; stop: () => void } {
  const wrap = document.createElement('div');
  wrap.className = cls;
  wrap.dataset.standIn = card.dataset.boardCard ?? '';
  wrap.setAttribute('aria-hidden', 'true');
  const piece = document.createElement('div');
  piece.className = 'board-entry__piece';
  const copy = copyOfCard(card);
  // The row card may already be hidden for its arrival; its copy never is.
  copy.style.visibility = '';
  piece.append(copy);
  wrap.append(piece);
  let at: Box = rel(card.getBoundingClientRect(), overlay.getBoundingClientRect());
  let fix = { x: 0, y: 0 };
  let live = true;
  const id = card.dataset.boardCard;
  const root = card.closest('.board') ?? document;
  const place = (): void => {
    // React may draw the row card again (a row reordered): the card as it is drawn now, still hidden.
    if (!card.isConnected) {
      const now = root.querySelector<HTMLElement>(`[data-zone="battlefield"] [data-board-card="${id}"]`);
      if (now !== null) {
        card = now;
        card.style.visibility = 'hidden';
      }
    }
    if (card.isConnected) at = rel(card.getBoundingClientRect(), overlay.getBoundingClientRect());
    Object.assign(wrap.style, { left: `${at.left + fix.x}px`, top: `${at.top + fix.y}px`, width: `${at.width}px` });
    wrap.style.setProperty('--card-w', `${at.width}px`);
  };
  const loop = (): void => {
    if (!live) return;
    place();
    requestAnimationFrame(loop);
  };
  const mount = (): void => {
    place();
    overlay.append(wrap);
    // Read with no motion on it yet: where the copy's card is drawn against where the row's is.
    const want = card.getBoundingClientRect();
    const got = copy.getBoundingClientRect();
    fix = { x: want.left - got.left, y: want.top - got.top };
    place();
    requestAnimationFrame(loop);
  };
  return { wrap, box: () => at, mount, stop: () => (live = false) };
}

const DRAINED = 'grayscale(1) brightness(0.55) contrast(1.1)';

function shadow(lift: number): string {
  return `drop-shadow(0 ${(2 + lift * 0.5).toFixed(1)}px ${(3 + lift * 0.6).toFixed(1)}px rgb(0 0 0 / ${(0.25 + lift * 0.006).toFixed(2)}))`;
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * `el.animate(frames, options)`, resolved when it finishes — or at once where the environment has
 * no Web Animations (a jsdom test; `crash.ts`/`ram.ts`/`projectile.ts`'s own guard, one place here).
 * Never throws, and never rejects: a cancelled animation ends a run the same as a finished one.
 */
function play(el: Element, frames: Keyframe[], options: KeyframeAnimationOptions): Promise<void> {
  if (typeof (el as HTMLElement).animate !== 'function') return Promise.resolve();
  return (el as HTMLElement)
    .animate(frames, options)
    .finished.then(() => undefined, () => undefined);
}

async function recolour(wrap: HTMLElement, lift: number): Promise<void> {
  await play(
    wrap,
    [
      { filter: `${DRAINED} ${shadow(lift)}` },
      { filter: `grayscale(0.2) brightness(1.35) ${shadow(lift)}`, offset: 0.6 },
      { filter: shadow(lift) },
    ],
    { id: BEAT_ANIMATION_ID, duration: 300, easing: 'ease-out', fill: 'forwards' },
  );
}

/** Shadow wisps along the way from the pile. */
function trailShadow(overlay: HTMLElement, a: { x: number; y: number }, b: { x: number; y: number }, key: string): void {
  const n = 9;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const r = (k: string): number => seedOf(`${key}:w${i}:${k}`);
    const x = a.x + (b.x - a.x) * t + (r('x') - 0.5) * 30;
    const y = a.y + (b.y - a.y) * t - Math.sin(t * Math.PI) * 60 + (r('y') - 0.5) * 20;
    const el = document.createElement('span');
    el.className = 'board-entry__wisp';
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.setProperty('--s', (0.7 + r('s') * 0.9).toFixed(2));
    overlay.append(el);
    void play(
      el,
      [
        { opacity: 0, scale: '0.4', translate: '0 0' },
        { opacity: 0.85, offset: 0.25 },
        { opacity: 0, scale: '1.6', translate: `${(r('d') - 0.5) * 24}px ${-18 - r('u') * 26}px` },
      ],
      { id: BEAT_ANIMATION_ID, duration: 700, delay: t * ENTRY_MOTIONS.rise.ms * 0.7, easing: 'ease-out', fill: 'backwards' },
    ).then(() => el.remove());
  }
}

/** Play one entry — the climb to the hang point, by motion, then the landing; resolves when everything it drew is gone. */
export async function playEntry(run: EntryRun): Promise<void> {
  const { board, overlay, card, from, motion, weight, key } = run;
  const { lift, scale } = hang(weight);
  const box = (): DOMRect => overlay.getBoundingClientRect();

  const s = standIn(overlay, card, 'board-entry');
  const wrap = s.wrap;
  s.mount();
  wrap.dataset.entry = motion;
  card.style.visibility = 'hidden';

  const hung: Keyframe = { translate: `0 ${-lift}px`, scale: String(scale), filter: shadow(lift) };

  // 1. Arrive at the hang point, by origin. Every offset is from the slot, which the stand-in follows.
  if (motion === 'rise' && from !== null) {
    const slot = s.box();
    const src = rel(from.getBoundingClientRect(), box());
    const dx = src.left + src.width / 2 - (slot.left + slot.width / 2);
    const dy = src.top + src.height / 2 - (slot.top + slot.height / 2);
    const s0 = Math.max(0.3, src.width / slot.width);
    trailShadow(overlay, { x: src.left + src.width / 2, y: src.top + src.height / 2 }, { x: slot.left + slot.width / 2, y: slot.top + slot.height / 2 - lift }, key);
    await play(
      wrap,
      [
        { translate: `${dx}px ${dy}px`, scale: String(s0), filter: `${DRAINED} ${shadow(0)}`, opacity: 0.2 },
        { offset: 0.25, opacity: 1 },
        { translate: `${dx * 0.4}px ${dy * 0.4 - 60 - lift}px`, scale: String((s0 + scale) / 2), filter: `${DRAINED} ${shadow(lift * 1.6)}`, offset: 0.6 },
        { ...hung, filter: `${DRAINED} ${shadow(lift)}` },
      ],
      { id: BEAT_ANIMATION_ID, duration: ENTRY_MOTIONS.rise.ms, easing: 'cubic-bezier(0.3, 0, 0.3, 1)', fill: 'forwards' },
    );
    await recolour(wrap, lift);
  } else if (motion === 'release') {
    // Materialises where it is held, a touch small and bright, then a beat before it is let go.
    await play(wrap, [{ ...hung, scale: String(scale * 0.9), opacity: 0, filter: `brightness(1.5) ${shadow(lift)}` }, { ...hung, opacity: 1 }], {
      id: BEAT_ANIMATION_ID,
      duration: ENTRY_MOTIONS.release.ms,
      easing: 'ease-out',
      fill: 'forwards',
    });
    await wait(60 + 80 * weight.power);
  } else if (motion === 'blink') {
    await play(
      wrap,
      [
        { ...hung, opacity: 0, filter: `brightness(2.4) ${shadow(lift)}` },
        { opacity: 0.8, offset: 0.25 },
        { opacity: 0.2, offset: 0.4 },
        { opacity: 1, filter: `brightness(1.6) ${shadow(lift)}`, offset: 0.6 },
        hung,
      ],
      { id: BEAT_ANIMATION_ID, duration: ENTRY_MOTIONS.blink.ms, easing: 'ease-out', fill: 'forwards' },
    );
  } else {
    // Cast: off the stack (where it resolved) up over its slot, hung there for the drop.
    const slot = s.box();
    const src = from === null ? null : rel(from.getBoundingClientRect(), box());
    const dx = src === null ? 0 : src.left + src.width / 2 - (slot.left + slot.width / 2);
    const dy = src === null ? -lift * 2 : src.top + src.height / 2 - (slot.top + slot.height / 2);
    await play(
      wrap,
      [
        { translate: `${dx}px ${dy}px`, scale: String(src === null ? scale : Math.max(0.5, src.width / slot.width)), filter: shadow(lift * 1.4), opacity: src === null ? 0 : 1 },
        { ...hung, offset: 1 },
      ],
      { id: BEAT_ANIMATION_ID, duration: 420, easing: 'cubic-bezier(0.3, 0, 0.2, 1)', fill: 'forwards' },
    );
    await wait(60 + 120 * weight.power);
  }

  // 2. The landing: the same for every origin, as heavy as the creature.
  await landingDrop(wrap, weight);
  const slot = s.box();
  const done = landingEffects(board, overlay, card, slot, weight, key);
  s.stop();
  card.style.visibility = '';
  wrap.remove();
  await done;
}

/** The squish from the hang point down onto the table. */
async function landingDrop(wrap: HTMLElement, weight: EntryWeight): Promise<void> {
  const { lift, scale, dropMs } = hang(weight);
  const hung: Keyframe = { translate: `0 ${-lift}px`, scale: String(scale), filter: shadow(lift) };
  await play(
    wrap,
    [
      hung,
      { translate: '0 0', scale: weight.thump ? String(1 - 0.02 - 0.04 * weight.power) : '1', filter: shadow(0), offset: 0.88 },
      { translate: '0 0', scale: '1', filter: shadow(0) },
    ],
    { id: BEAT_ANIMATION_ID, duration: dropMs, easing: powerEase(weight.power), fill: 'forwards' },
  );
}

/** The weight effects alone, anchored at `slot` (overlay-relative): the pressure ring, debris, the shake, cracks and the shove. */
function landingEffects(board: HTMLElement, overlay: HTMLElement, card: HTMLElement, slot: Box, weight: EntryWeight, key: string): Promise<unknown> {
  const done: Promise<unknown>[] = [];
  if (weight.cracks !== null) done.push(crackle(card, weight.cracks, key));
  if (weight.debris > 0) done.push(debris(overlay, slot, weight.power, weight.debris, key));
  if (weight.shakePx > 0) shake(board, weight.shakePx, key);
  if (weight.thump) done.push(thump(overlay, slot, weight.power));
  if (weight.shove.rings > 0) done.push(shove(overlay, card, weight, key));
  return Promise.all(done);
}

/**
 * The landing alone, for a card something else already carried to its slot (`gestures/cast.ts`'s
 * `landCastGhost`, or Fast Mode's "landing only, no rise/no travel"): a quick hang-and-drop squish on
 * `wrap` (the ghost already standing in `card`'s place, or `card` itself when nothing need stand in
 * for it — Fast Mode draws no travel, so the row card is never hidden), then the same weight effects
 * `playEntry` ends with.
 */
export async function playLanding(board: HTMLElement, overlay: HTMLElement, card: HTMLElement, weight: EntryWeight, key: string, wrap: HTMLElement = card): Promise<void> {
  await landingDrop(wrap, weight);
  const slot = rel(card.getBoundingClientRect(), overlay.getBoundingClientRect());
  await landingEffects(board, overlay, card, slot, weight, key);
}

/** A brief ring of pressure flattening out from under the card. */
function thump(overlay: HTMLElement, slot: Box, power: number): Promise<void> {
  const el = document.createElement('div');
  el.className = 'board-entry__thump';
  Object.assign(el.style, { left: `${slot.left}px`, top: `${slot.top}px`, width: `${slot.width}px`, height: `${slot.height}px` });
  el.style.setProperty('--p', power.toFixed(2));
  overlay.append(el);
  return play(el, [{ opacity: 0.85, scale: '1' }, { opacity: 0, scale: String(1.18 + 0.3 * power) }], {
    id: BEAT_ANIMATION_ID,
    duration: 380 + 200 * power,
    easing: 'cubic-bezier(0.2, 0.7, 0.4, 1)',
  }).then(() => el.remove());
}

/**
 * Where on the card's edge a piece of debris leaves from, and the way out from there. Mostly the
 * bottom and the sides — a card slammed down pushes out sideways — a few off the top.
 */
function edgePoint(slot: Box, r: (k: string) => number): { x: number; y: number; nx: number; ny: number } {
  const side = r('side');
  const t = r('t');
  if (side < 0.4) return { x: slot.left + t * slot.width, y: slot.top + slot.height, nx: (t - 0.5) * 0.8, ny: 1 };
  if (side < 0.65) return { x: slot.left, y: slot.top + (0.3 + 0.7 * t) * slot.height, nx: -1, ny: (t - 0.3) * 0.6 };
  if (side < 0.9) return { x: slot.left + slot.width, y: slot.top + (0.3 + 0.7 * t) * slot.height, nx: 1, ny: (t - 0.3) * 0.6 };
  return { x: slot.left + t * slot.width, y: slot.top, nx: (t - 0.5) * 0.8, ny: -1 };
}

/** Dust and rock thrown out from the card's edges, as heavy as the landing: `crash.ts`'s look, the card's shape. */
function debris(overlay: HTMLElement, slot: Box, power: number, share: number, key: string): Promise<void> {
  const ms = 650 + 250 * power;
  const layer = document.createElement('div');
  layer.className = 'effect-crash board-entry__debris';
  layer.style.setProperty('--crash-ms', `${ms}ms`);
  layer.style.setProperty('--power-size', powerSize(power).toFixed(2));
  overlay.append(layer);
  const anims: Promise<unknown>[] = [];
  const rocks = Math.round((8 + 40 * power) * share);
  const puffs = Math.round((4 + 16 * power) * share);
  const reach = 18 + 60 * power;
  for (let i = 0; i < puffs; i++) {
    const r = (k: string): number => seedOf(`${key}:p${i}:${k}`);
    const e = edgePoint(slot, r);
    const el = document.createElement('span');
    el.className = 'effect-crash__dust';
    el.style.animation = 'none';
    el.style.left = `${e.x - 14}px`;
    el.style.top = `${e.y - 14}px`;
    layer.append(el);
    const far = reach * (0.35 + 0.4 * r('d'));
    anims.push(
      play(
        el,
        [
          { translate: '0 0', scale: '0.5', opacity: 0.9 },
          { translate: `${e.nx * far}px ${e.ny * far * 0.6 - 4}px`, scale: String(1.4 + 1.2 * power), opacity: 0 },
        ],
        { id: BEAT_ANIMATION_ID, duration: ms * (0.8 + 0.2 * r('m')), easing: 'cubic-bezier(0.1, 0.7, 0.3, 1)', fill: 'forwards' },
      ),
    );
  }
  for (let i = 0; i < rocks; i++) {
    const r = (k: string): number => seedOf(`${key}:k${i}:${k}`);
    const e = edgePoint(slot, r);
    const el = document.createElement('span');
    el.className = 'effect-crash__rock';
    const size = (2.5 + 4.5 * r('s')) * powerSize(power);
    Object.assign(el.style, { left: `${e.x}px`, top: `${e.y}px`, width: `${size}px`, height: `${size}px` });
    layer.append(el);
    const far = reach * (0.5 + 0.7 * r('d'));
    const dx = e.nx * far + (r('j') - 0.5) * 16;
    const dy = e.ny * far * 0.55;
    const up = 10 + 34 * power * r('l');
    const spin = (r('r') - 0.5) * 720;
    anims.push(
      play(
        el,
        [
          { translate: '0 0', rotate: '0deg', opacity: 1 },
          { translate: `${dx * 0.55}px ${dy * 0.55 - up}px`, rotate: `${spin * 0.5}deg`, opacity: 1, offset: 0.45 },
          { translate: `${dx}px ${dy + 10}px`, rotate: `${spin}deg`, opacity: 0 },
        ],
        { id: BEAT_ANIMATION_ID, duration: ms * (0.75 + 0.25 * r('m')), easing: 'cubic-bezier(0.2, 0.6, 0.5, 1)', fill: 'forwards' },
      ),
    );
  }
  return Promise.all(anims).then(() => layer.remove());
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
 * Cracks in the table running out from under the card: they run outward in stages, hold, then
 * fade. Under the cards, not over them, and across the whole table: each battlefield draws the same
 * cracks in table coordinates, clipped to itself, below everything it holds — the two sides meet
 * (`board.css`'s `.zone--battlefield` seam), so a crack runs straight over onto the other side.
 */
function crackle(card: HTMLElement, look: CrackLook, key: string): Promise<void> {
  const board = card.closest<HTMLElement>('.board')!;
  const b = board.getBoundingClientRect();
  const c = card.getBoundingClientRect();
  const cx = c.left - b.left + c.width / 2;
  const cy = c.top - b.top + c.height / 2;
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
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `${-size / 2} ${-size / 2} ${size} ${size}`);
    Object.assign(svg.style, { left: `${cx - (z.left - b.left) - size / 2}px`, top: `${cy - (z.top - b.top) - size / 2}px`, width: `${size}px`, height: `${size}px` });
    const defs = document.createElementNS(ns, 'defs');
    svg.append(defs);
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
      run.style.strokeWidth = String(crack.root * 4);
      const length = crack.pts.slice(1).reduce((sum, p, n) => sum + Math.hypot(p.x - crack.pts[n]!.x, p.y - crack.pts[n]!.y), 0);
      run.style.animationDelay = `${Math.round(crack.at)}ms`;
      run.style.animationDuration = `${Math.max(60, Math.round(length * CRACK_MS_PER_PX))}ms`;
      mask.append(run);
      defs.append(mask);
      for (const kind of look.glow > 0 ? (['glow', 'line'] as const) : (['line'] as const)) {
        const shape = document.createElementNS(ns, 'path');
        shape.setAttribute('d', outline(crack, kind === 'glow' ? 2.6 : 1));
        shape.setAttribute('mask', `url(#${id})`);
        shape.classList.add(`board-entry__crack--${kind}`);
        if (kind === 'glow') shape.style.opacity = (0.55 * look.glow).toFixed(2);
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
    layers.map((layer) => play(layer, [{ opacity: 1 }, { opacity: 1, offset: (400 + look.holdMs) / total }, { opacity: 0 }], { id: BEAT_ANIMATION_ID, duration: total, easing: 'ease-in' })),
  ).then(() => layers.forEach((l) => l.remove()));
}

/**
 * A heavy landing knocks the cards around it away from it, and each settles back into its own
 * place: drawn as stand-ins, thrown out along the line from the landing, turning, then gliding home.
 * No card changes its place. The first ring — within one card of it every way, diagonals too,
 * either seat's — is thrown hardest; from 12 power the ring beyond is knocked too, more gently and a
 * beat later, as the blow travels out.
 */
async function shove(overlay: HTMLElement, titan: HTMLElement, weight: EntryWeight, key: string): Promise<void> {
  const t = titan.getBoundingClientRect();
  const tx = t.left + t.width / 2;
  const ty = t.top + t.height / 2;
  const root = titan.closest('.board') ?? document;
  /** Which ring a card is in: 1 within one card every way, 2 within two, else 0. */
  const ringOf = (b: DOMRect): number => {
    const dx = Math.abs(b.left + b.width / 2 - tx);
    const dy = Math.abs(b.top + b.height / 2 - ty);
    if (dx <= t.width * 1.6 && dy <= t.height * 1.5) return 1;
    if (dx <= t.width * 2.7 && dy <= t.height * 2.5) return 2;
    return 0;
  };
  const near = [...root.querySelectorAll<HTMLElement>('[data-zone="battlefield"] [data-board-card]')]
    .filter((el) => el !== titan)
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
      ).then(() => {
        s.stop();
        s.wrap.remove();
        el.style.visibility = '';
      });
    }),
  );
}
