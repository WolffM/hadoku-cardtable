/*
 * A creature entering the battlefield is drawn arriving, and it lands as hard as it hits. Approved
 * design, after six preview rounds (AF413, ledger): https://claude.ai/artifact/U1nYg5D394VmKECMWbzpeu.
 *
 * Two independent parts, mirroring `departures.ts`'s `EXIT_MOTIONS`:
 *
 *  - an ENTRY MOTION, chosen by where the card came from (`entryMotionFor`): cast off the stack or
 *    put there out of a hand, raised out of a graveyard, returned from exile. A new origin or a per-card motion is an entry
 *    in `ENTRY_MOTIONS` plus its keyframes; nothing else knows a motion's name. The operator did not
 *    pick between the preview's two reanimate styles (a shadowed rise out of the pile, or a rift
 *    opening in the slot): shipped is `rise`; the other, `unearth`, is not ported — no dead code;
 *  - a LANDING, chosen by the creature's power (`entryWeight`), shared by every motion and every
 *    effect growing continuously with it, point by point, to `ENTRY_MAX` — no tier where several
 *    points look the same: the drop, a pressure ring from 2 power, debris thrown off the card's
 *    edges ramping in from 2 to a full spray at 7, and the table's own quake (`quake.ts`, which a
 *    creature's blow on a player draws too): shaking from 5, cracks from 7 (reach, width and glow
 *    climbing to 15, forks from 10), and, from 8 power, the cards around it knocked away (a second
 *    ring from 12), settling back into their own places.
 *
 * Everything is a stand-in in the board's overlay; the row card is hidden until the stand-in is
 * down (table-fit: never a transform on a card in a row). The stand-in follows its row card's box
 * every frame, so a row that reflows while it falls (the card's own arrival widening the row) moves
 * where it lands, and it lands there in one motion.
 *
 * `playEntry` is every arrival on the battlefield, on either screen: a motion's own arrival (the
 * climb to the hang point) and the landing as one run, drawn by one stand-in from its first frame to
 * the row card taking over where it touches down. A cast or played card, the other seat's echo of
 * one, and a card travelling from its maker are the `cast` motion, from wherever the card is drawn
 * when it starts (`gestures/cast.ts`'s `landCastGhost` hands it over); `rise`, `blink` and `release`
 * have nowhere else to come from. `playLanding` is the landing alone, for Fast Mode: no travel.
 */

import { seedOf } from './projectile.ts';
import { anchorOf, play, quake, rel, shadow, standIn, type Box } from './quake.ts';
import { BEAT_ANIMATION_ID, powerEase, powerSize } from '../motion.ts';
import './entries.css';
import { markTempo } from './tempo.ts';

/** Where a permanent came from, picking its entry motion. */
export type EntryOrigin = 'stack' | 'hand' | 'graveyard' | 'exile' | 'token';

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

/** What a landing adds past its own drop: nothing at 0 heft (see `entryWeight`), so no caller runs a tail that draws nothing. */
export function landingWeight(heft: number): EntryWeight | null {
  return heft > 0 ? entryWeight(heft) : null;
}

export const ENTRY_MOTIONS = {
  /** Off the stack, out of a hand, or from its maker: from where it is drawn when it starts, up over its slot, then it drops. */
  cast: { ms: 420 },
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
export function entryDurationMs(motion: EntryMotion, weight: EntryWeight | null): number {
  const { dropMs } = hang(weight);
  const tailMs = weight === null ? 0 : motion === 'rise' ? 300 : motion === 'cast' ? 60 + 120 * weight.power : 0;
  return ENTRY_MOTIONS[motion].ms + tailMs + dropMs;
}

/** How high the stand-in hangs before it drops, how big it is there, and how long the drop takes. Weightless: it glides straight into its slot. */
function hang(w: EntryWeight | null): { lift: number; scale: number; dropMs: number } {
  if (w === null) return { lift: 0, scale: 1, dropMs: 0 };
  return { lift: 26 + 50 * w.power, scale: 1.1 + 0.2 * w.power, dropMs: Math.round(260 + 260 * w.power) };
}

export interface EntryRun {
  /** The board's `.board` element: what shakes. */
  board: HTMLElement;
  overlay: HTMLElement;
  /** The creature's row card, already rendered; hidden until the stand-in lands. */
  card: HTMLElement;
  /** Where it came from — a graveyard pile, a hand, or whatever draws the card when a `cast` starts (its stand-in, the stack's card, or the box it was last drawn in); null when it has nowhere to travel from (exile). Read once, as `playEntry` starts. */
  from: Pick<Element, 'getBoundingClientRect'> | null;
  motion: EntryMotion;
  /** Null: a weightless landing (a land, a 0-power creature) — it glides into its slot, nothing more. */
  weight: EntryWeight | null;
  key: string;
  /** The stand-in has touched down and the row card (as drawn now) is shown in its place: the weight effects are still to run. */
  onLanded?: (card: HTMLElement) => void;
  /** How fast it plays (`./tempo.ts`): 1 when not given. */
  tempo?: number;
}

const DRAINED = 'grayscale(1) brightness(0.55) contrast(1.1)';

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function recolour(wrap: HTMLElement, lift: number, tempo: number): Promise<void> {
  await play(
    wrap,
    [
      { filter: `${DRAINED} ${shadow(lift)}` },
      { filter: `grayscale(0.2) brightness(1.35) ${shadow(lift)}`, offset: 0.6 },
      { filter: shadow(lift) },
    ],
    { id: BEAT_ANIMATION_ID, duration: 300, easing: 'ease-out', fill: 'forwards' },
    undefined,
    tempo,
  );
}

/** Shadow wisps along the way from the pile. */
function trailShadow(overlay: HTMLElement, a: { x: number; y: number }, b: { x: number; y: number }, key: string, tempo: number): void {
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
      undefined,
      tempo,
    ).then(() => el.remove());
  }
}

/** Play one entry — the climb to the hang point, by motion, then the landing; resolves when everything it drew is gone. */
export async function playEntry(run: EntryRun): Promise<void> {
  const { board, overlay, card, from, motion, weight, key } = run;
  const tempo = run.tempo ?? 1;
  const { lift, scale } = hang(weight);
  const box = (): DOMRect => overlay.getBoundingClientRect();

  // Read now, while the caller's own element still draws the card: it is taken away once this returns.
  // And first, in the layout the stand-in's own first read uses, before anything here writes.
  const src = from === null ? null : rel(from.getBoundingClientRect(), box());
  const s = standIn(overlay, card, 'board-entry');
  const wrap = s.wrap;
  s.mount();
  markTempo(wrap, tempo);
  wrap.dataset.entry = motion;
  card.style.visibility = 'hidden';

  const hung: Keyframe = { translate: `0 ${-lift}px`, scale: String(scale), filter: shadow(lift) };

  // 1. Arrive at the hang point, by origin. Every offset is from the slot, which the stand-in follows.
  if (motion === 'rise' && src !== null) {
    const slot = s.box();
    const dx = src.left + src.width / 2 - (slot.left + slot.width / 2);
    const dy = src.top + src.height / 2 - (slot.top + slot.height / 2);
    const s0 = Math.max(0.3, src.width / slot.width);
    trailShadow(overlay, { x: src.left + src.width / 2, y: src.top + src.height / 2 }, { x: slot.left + slot.width / 2, y: slot.top + slot.height / 2 - lift }, key, tempo);
    await play(
      wrap,
      [
        { translate: `${dx}px ${dy}px`, scale: String(s0), filter: `${DRAINED} ${shadow(0)}`, opacity: 0.2 },
        { offset: 0.25, opacity: 1 },
        { translate: `${dx * 0.4}px ${dy * 0.4 - 60 - lift}px`, scale: String((s0 + scale) / 2), filter: `${DRAINED} ${shadow(lift * 1.6)}`, offset: 0.6 },
        { ...hung, filter: `${DRAINED} ${shadow(lift)}` },
      ],
      { id: BEAT_ANIMATION_ID, duration: ENTRY_MOTIONS.rise.ms, easing: 'cubic-bezier(0.3, 0, 0.3, 1)', fill: 'forwards' },
      undefined,
      tempo,
    );
    await recolour(wrap, lift, tempo);
  } else if (motion === 'release') {
    // Materialises where it is held, a touch small and bright, then a beat before it is let go.
    await play(
      wrap,
      [{ ...hung, scale: String(scale * 0.9), opacity: 0, filter: `brightness(1.5) ${shadow(lift)}` }, { ...hung, opacity: 1 }],
      { id: BEAT_ANIMATION_ID, duration: ENTRY_MOTIONS.release.ms, easing: 'ease-out', fill: 'forwards' },
      undefined,
      tempo,
    );
    await wait((60 + 80 * (weight?.power ?? 0)) / tempo);
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
      undefined,
      tempo,
    );
  } else {
    // Cast: from where the card is drawn (the stack's card, its stand-in) up over its slot, hung there for the drop.
    const slot = s.box();
    const dx = src === null ? 0 : src.left + src.width / 2 - (slot.left + slot.width / 2);
    const dy = src === null ? -lift * 2 : src.top + src.height / 2 - (slot.top + slot.height / 2);
    await play(
      wrap,
      [
        { translate: `${dx}px ${dy}px`, scale: String(src === null ? scale : Math.max(0.5, src.width / slot.width)), filter: shadow(lift * 1.4), opacity: src === null ? 0 : 1 },
        { ...hung, offset: 1 },
      ],
      { id: BEAT_ANIMATION_ID, duration: ENTRY_MOTIONS.cast.ms, easing: 'cubic-bezier(0.3, 0, 0.2, 1)', fill: 'forwards' },
      undefined,
      tempo,
    );
    if (weight !== null) await wait((60 + 120 * weight.power) / tempo);
  }

  // 2. The landing: the same for every origin, as heavy as the creature. A board taken down while
  // the card was on its way (the match left) is drawn into no more: the row card is handed back as it is.
  if (weight !== null && overlay.isConnected) await landingDrop(wrap, weight, tempo);
  const slot = s.box();
  s.stop();
  // The row card as the stand-in last followed it: React may have drawn it again meanwhile.
  const landed = s.card();
  landed.style.visibility = '';
  run.onLanded?.(landed);
  wrap.remove();
  if (weight !== null && overlay.isConnected) await landingEffects(board, overlay, landed, slot, weight, key, tempo);
}

/** The squish from the hang point down onto the table. */
async function landingDrop(wrap: HTMLElement, weight: EntryWeight, tempo: number): Promise<void> {
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
    undefined,
    tempo,
  );
}

/** The weight effects alone, anchored at `slot` (overlay-relative): the pressure ring and debris under the card, and the table's own quake (`quake.ts`: the shake, cracks and the shove). */
function landingEffects(board: HTMLElement, overlay: HTMLElement, card: HTMLElement, slot: Box, weight: EntryWeight, key: string, tempo: number): Promise<unknown> {
  const done: Promise<unknown>[] = [quake(board, overlay, anchorOf(card), weight, key, card, tempo).done];
  if (weight.debris > 0) done.push(debris(overlay, slot, weight.power, weight.debris, key, tempo));
  if (weight.thump) done.push(thump(overlay, slot, weight.power, tempo));
  return Promise.all(done);
}

/**
 * The landing alone, for Fast Mode's "landing only, no rise/no travel": a quick hang-and-drop squish
 * on the row card itself (Fast Mode draws no travel, so it is never hidden), then the same weight
 * effects `playEntry` ends with.
 */
export async function playLanding(board: HTMLElement, overlay: HTMLElement, card: HTMLElement, weight: EntryWeight, key: string, tempo = 1): Promise<void> {
  await landingDrop(card, weight, tempo);
  // A board taken down while the card came down is drawn into no more.
  if (!overlay.isConnected) return;
  const slot = rel(card.getBoundingClientRect(), overlay.getBoundingClientRect());
  await landingEffects(board, overlay, card, slot, weight, key, tempo);
}

/** A brief ring of pressure flattening out from under the card. */
function thump(overlay: HTMLElement, slot: Box, power: number, tempo: number): Promise<void> {
  const el = document.createElement('div');
  el.className = 'board-entry__thump';
  Object.assign(el.style, { left: `${slot.left}px`, top: `${slot.top}px`, width: `${slot.width}px`, height: `${slot.height}px` });
  el.style.setProperty('--p', power.toFixed(2));
  overlay.append(el);
  return play(
    el,
    [{ opacity: 0.85, scale: '1' }, { opacity: 0, scale: String(1.18 + 0.3 * power) }],
    { id: BEAT_ANIMATION_ID, duration: 380 + 200 * power, easing: 'cubic-bezier(0.2, 0.7, 0.4, 1)' },
    undefined,
    tempo,
  ).then(() => el.remove());
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
function debris(overlay: HTMLElement, slot: Box, power: number, share: number, key: string, tempo: number): Promise<void> {
  const ms = 650 + 250 * power;
  const layer = document.createElement('div');
  layer.className = 'effect-crash board-entry__debris';
  layer.style.setProperty('--crash-ms', `${ms}ms`);
  markTempo(layer, tempo);
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
        undefined,
        tempo,
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
        undefined,
        tempo,
      ),
    );
  }
  return Promise.all(anims).then(() => layer.remove());
}
