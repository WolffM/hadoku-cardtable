/*
 * Combat damage is a creature ramming what it hit (the operator, 2026-10-16: "we want the card to
 * physically 'ram' eachother and the player avatar"), and how a fight ends decides how it is drawn
 * (the operator, after the first cut was "too bouncy"):
 *
 *  - both die: a brief rear back, they ram into each other and crumple into each other there;
 *  - one dies: the stronger one rams and stays still on the blow, then goes slowly back to its place;
 *    the weaker one is knocked back from it, cracking and crumbling to dust as it goes;
 *  - neither dies: they ram and bounce off each other at once, each a little to one side, turning, then
 *    settle and go slowly back — the winner's own way back (the operator: "on collision i think they
 *    should bounce back quickly rather than lingering … a slight randomness to what direction they get
 *    bounced off");
 *  - at a player: it rears back and turns to face the avatar, in a cone with the others attacking —
 *    spread a little apart, all pointing at it — then arcs in for the slam, pauses on the blow and goes
 *    slowly back, straightening (the operator: "rear back and rotate the card so it 'faces' the players
 *    avatar … then arc towards it for the slam … correct back to position"; "when there are a lot of
 *    attckers it would be nice if they spread out a bit in a sort of 'cone formation'").
 *
 * A heavier blow feels heavier and arrives at the same moment: every move keeps its length whatever the
 * damage, and the damage shapes its pace — a weak one sets off quickly and barely speeds up, a strong
 * one starts slow and accelerates hard; its rear back and its way home take the same pace (the
 * operator: "creatures with greater attack must have a greater impact feeling but should arrive at the
 * location in the same time"). `motion.ts`'s `powerEase` and `homeEase`.
 *
 * Every lunge at a creature runs on a slight curve and tilts into the blow, its side and lean seeded by
 * the creature ("can we add a slight arc and rotation for how they ram into eachother? it looks boring
 * when they are just moving vertically"); the way home straightens it.
 *
 * A creature hit by one that does not ram it (it dealt no damage back) stands still until the blow,
 * and is blasted away if it dies of it.
 *
 * What moves is a copy of the creature in the board's overlay, never a transform on a card in a row
 * (table-fit, `board-motion-needs-table-fit`); the creature's own element is hidden while its copy is
 * away (`[data-ramming]`). A creature that died in the fight is already drawn as its departure's
 * stand-in (`departures.ts`) over its kept place: that stand-in is what moves, and its exit motion
 * (a shatter: it cracks and crumbles) plays where the blow lands, or on the way back for one knocked away.
 * The blow itself is `crash.ts`'s: dust, rocks and the table shaking.
 *
 * `numbers.ts` decides who rams what, when, and how it ends; this module draws one creature's part.
 * Reduced motion: none.
 */

import { homeEase, powerEase } from '../motion.ts';
import { copyOfCard, dropTurnedMargins } from './departures.ts';
import { along, arcControl, seedOf } from './projectile.ts';
import './ram.css';

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** A box in overlay coordinates: its centre and size. */
export interface Box extends Point {
  readonly w: number;
  readonly h: number;
}

/** What a creature rams: a creature by itself, a creature ramming it back, or a player's avatar. */
export type RamKind = 'strike' | 'meet' | 'charge';

/**
 * How a creature's ram ends: `crumple`, it dies against one that dies too and crumples there;
 * `blasted`, it dies against one that lives and is knocked away; `win`, it lives and the other dies;
 * `bounce`, both live; `charge`, it struck a player.
 */
export type RamEnd = 'crumple' | 'blasted' | 'win' | 'bounce' | 'charge';

/** The rear back before a lunge, and the lunge itself, faster and faster: the blow lands at their end. */
export const REAR_MS = 120;
export const RUSH_MS = 200;
/** A charge at a player: rearing back to face it (all chargers at once, in formation), then the flight in. */
export const ALIGN_MS = 300;
export const CHARGE_MS = 640;
/** How long a winner and a charge hold the blow before they go back: a pause that lets the blow land. */
export const HOLD_MS: Readonly<Record<'win' | 'charge', number>> = { win: 280, charge: 180 };
/** Two that both live bounce off each other this fast, settle this long, then take the way home. */
export const BOUNCE_MS = 190;
export const SETTLE_MS = 70;
/** The slow way back to its place, the same for a winner, a bounce and a charge. */
export const RETURN_MS = 620;
/** Knocked away and gone: inside a crumple's own length (`departures.ts`), so its stand-in outlives it. */
export const BLAST_MS = 380;
/** Rams go one after another, far enough apart that each blow reads on its own. */
export const RAM_STAGGER_MS = 280;

/** On a creature's own element while its copy rams: laid out, not drawn. */
export const RAMMING_ATTR = 'data-ramming';

/** When a ram of `kind` strikes, from its start (a charge's start is its turn to face the player). */
export function contactMs(kind: RamKind): number {
  return kind === 'charge' ? ALIGN_MS + CHARGE_MS : REAR_MS + RUSH_MS;
}

/** How long a creature's part lasts, from its start: a crumple's and a blast's end are the stand-in's own. */
export function ramMs(kind: RamKind, end: RamEnd): number {
  const contact = contactMs(kind);
  if (end === 'crumple' || end === 'blasted') return contact + BLAST_MS;
  if (end === 'bounce') return contact + BOUNCE_MS + SETTLE_MS + RETURN_MS;
  return contact + HOLD_MS[end] + RETURN_MS;
}

/** How far a box reaches from its centre toward `u` (a unit vector). */
function reach(box: Box, u: Point): number {
  return (Math.abs(u.x) * box.w + Math.abs(u.y) * box.h) / 2;
}

function unit(from: Point, to: Point): Point {
  const d = Math.hypot(to.x - from.x, to.y - from.y);
  return d === 0 ? { x: 0, y: -1 } : { x: (to.x - from.x) / d, y: (to.y - from.y) / d };
}

/**
 * Where the rammer's centre is when it strikes, as an offset from where it stands. At a creature,
 * far enough that a quarter of the two cards overlap; meeting a creature that rams back, halfway
 * less a quarter of its own reach; at a player, onto the avatar, less a little of its own reach.
 */
export function strikeOffset(from: Box, to: Box, kind: RamKind): Point {
  const d = Math.hypot(to.x - from.x, to.y - from.y);
  if (d === 0) return { x: 0, y: 0 };
  const u = unit(from, to);
  const own = reach(from, u);
  const travel = kind === 'meet' ? d / 2 - own * 0.25 : kind === 'strike' ? d - (own + reach(to, u)) * 0.75 : d - own * 0.4;
  const t = Math.max(0, travel);
  return { x: u.x * t, y: u.y * t };
}

/** How far a creature draws back before it lunges, how far one blasted away flies, and how far one bounces off. */
const REAR_PX = 12;
const BLAST_PX = 60;
const BOUNCE_PX = 22;
/** How far a lunge bows off the straight line, as a share of its length. */
const ARC = 0.14;
/** Samples of a lunge's curve. */
const LUNGE_SAMPLES = 8;

/** How far a creature leans into its blow (degrees), and to which side: seeded by the creature. */
export function tiltOf(key: string): number {
  const side = seedOf(`${key}:side`) < 0.5 ? -1 : 1;
  return side * (5 + 5 * seedOf(`${key}:lean`));
}

/** `p` turned by `deg` degrees. */
function turned(p: Point, deg: number): Point {
  const a = (deg * Math.PI) / 180;
  return { x: p.x * Math.cos(a) - p.y * Math.sin(a), y: p.x * Math.sin(a) + p.y * Math.cos(a) };
}
/** Samples of a charge's curve. */
const SAMPLES = 16;
/** How far a charger draws back as it turns to face the player. */
const ALIGN_BACK_PX = 18;

const px = (p: Point): string => `${p.x.toFixed(1)}px ${p.y.toFixed(1)}px`;

/** Where a creature draws back to before it lunges at `strike`, and how it leans there. */
export function rearOf(strike: Point, tilt: number): { at: Point; rot: number } {
  const d = Math.hypot(strike.x, strike.y) || 1;
  return { at: { x: (-strike.x / d) * REAR_PX, y: (-strike.y / d) * REAR_PX }, rot: -tilt * 0.3 };
}

/** The rear back: from its place to `rear`. Its pace is the blow's (`powerEase`), set on the animation. */
export function rearFrames(rear: { at: Point; rot: number }): Keyframe[] {
  return [
    { translate: '0px 0px', rotate: '0deg' },
    { translate: px(rear.at), rotate: `${rear.rot.toFixed(1)}deg` },
  ];
}

/**
 * The lunge into the blow: from `rear` to `strike` along a slight curve (to the side `tilt` leans),
 * leaning into it until it lands at `tilt` degrees. Sampled evenly; the pace is the animation's.
 */
export function lungeFrames(rear: { at: Point; rot: number }, strike: Point, tilt: number): Keyframe[] {
  const back = rear.at;
  const d = Math.hypot(strike.x - back.x, strike.y - back.y) || 1;
  const bow = d * ARC * (Math.sign(tilt) || 1);
  const control = { x: (back.x + strike.x) / 2 + (-(strike.y - back.y) / d) * bow, y: (back.y + strike.y) / 2 + ((strike.x - back.x) / d) * bow };
  return Array.from({ length: LUNGE_SAMPLES + 1 }, (_, i) => {
    const s = i / LUNGE_SAMPLES;
    return { offset: s, translate: px(along(back, control, strike, s)), rotate: `${(rear.rot + (tilt - rear.rot) * s).toFixed(1)}deg` };
  });
}

/** `deg` brought into −180..180. */
const wrap180 = (deg: number): number => ((((deg + 180) % 360) + 360) % 360) - 180;
/** Fanned chargers stand this many of their longest side apart along their arc. */
const FAN_GAP = 1.25;

/**
 * Where each of a pack of chargers forms up before it flies, as an offset from where it stands: drawn
 * back from the player along its own line to them, so the pack keeps the loose arrangement it stood in
 * and all of it points at the player — the cone the operator asked for ("they all point towards the
 * enemy avatar"). Neighbours are then pushed apart around the player only as far as it takes for no
 * two to overlap however they turn ("try to spread them out a little bit so they aren't on top of
 * eachother once they start 'the punch'"): more than a card's longest side apart along the arc, the
 * pack kept centred where it was. One charger just draws straight back.
 */
export function fanOf(froms: readonly Box[], to: Box, key: string): Point[] {
  const longest = Math.max(0, ...froms.map((b) => Math.max(b.w, b.h)));
  const spots = froms
    .map((b, i) => ({ i, a: Math.atan2(b.y - to.y, b.x - to.x), r: Math.hypot(b.x - to.x, b.y - to.y) + ALIGN_BACK_PX + (seedOf(`${key}:${i}:depth`) - 0.5) * 8 }))
    .sort((x, y) => x.a - y.a);
  // Unwrap so the pack's angles run without a jump across ±π, then spread each from the last as needed.
  for (let j = 1; j < spots.length; j++) while (spots[j]!.a - spots[j - 1]!.a > Math.PI) spots[j]!.a -= Math.PI * 2;
  spots.sort((x, y) => x.a - y.a);
  const before = spots.map((sp) => sp.a);
  for (let j = 1; j < spots.length; j++) {
    const gap = (longest * FAN_GAP) / Math.max(1, (spots[j]!.r + spots[j - 1]!.r) / 2);
    spots[j]!.a = Math.max(spots[j]!.a, spots[j - 1]!.a + gap);
  }
  const shift = before.reduce((n, a) => n + a, 0) / Math.max(1, before.length) - spots.reduce((n, sp) => n + sp.a, 0) / Math.max(1, spots.length);
  const out: Point[] = froms.map(() => ({ x: 0, y: 0 }));
  for (const sp of spots) {
    const a = sp.a + shift;
    out[sp.i] = { x: to.x + Math.cos(a) * sp.r - froms[sp.i]!.x, y: to.y + Math.sin(a) * sp.r - froms[sp.i]!.y };
  }
  return out;
}

/** A charger's pose before it flies: at `at` (its place in the fan, `fanOf`), turned so its top points at the player — an upright card's top is up, a turned card's (an attacker drawn sideways) its right. */
export function alignOf(from: Box, to: Box, at: Point): { at: Point; rot: number } {
  const toward = Math.atan2(to.y - (from.y + at.y), to.x - (from.x + at.x)) * (180 / Math.PI);
  return { at, rot: wrap180(from.w > from.h ? toward : toward + 90) };
}

/**
 * Bounced off the blow: from `strike`, quickly back the way it came (`toward` is the way it hit) but
 * thrown a little to one side and turned further, both seeded; further for a heavier blow. Returns
 * the frames and where it ends, for the way home.
 */
export function bounceFrames(strike: Point, toward: Point, tilt: number, key: string, power: number): { frames: Keyframe[]; at: Point; rot: number } {
  const skew = (seedOf(`${key}:bounce`) - 0.5) * 70;
  const dir = turned({ x: -toward.x, y: -toward.y }, skew);
  const far = BOUNCE_PX * (0.7 + 0.8 * power);
  const at = { x: strike.x + dir.x * far, y: strike.y + dir.y * far };
  const rot = tilt + (seedOf(`${key}:kick`) < 0.5 ? -1 : 1) * (6 + 6 * seedOf(`${key}:spin`));
  return { frames: [{ translate: px(strike), rotate: `${tilt.toFixed(1)}deg` }, { translate: px(at), rotate: `${rot.toFixed(1)}deg` }], at, rot };
}

/** A charge's flight: from its aligned pose up a lifted curve onto the avatar, still facing it. Sampled evenly. */
export function chargeFrames(align: { at: Point; rot: number }, strike: Point, key: string): Keyframe[] {
  const control = arcControl(align.at, strike, seedOf(key));
  return Array.from({ length: SAMPLES + 1 }, (_, i) => ({ offset: i / SAMPLES, translate: px(along(align.at, control, strike, i / SAMPLES)), rotate: `${align.rot.toFixed(1)}deg` }));
}

/** Slowly back to its place from `at`, turned `rot` degrees, straightening as it goes. */
export function returnFrames(at: Point, rot: number): Keyframe[] {
  return [
    { translate: px(at), rotate: `${rot.toFixed(1)}deg` },
    { translate: '0px 0px', rotate: '0deg' },
  ];
}

/**
 * Knocked from `at` along `away` (a unit vector), further for a heavier blow. Only where it goes: its
 * departure's own exit (`departures.ts`'s shatter) cracks it and crumbles it to dust on the way.
 */
export function blastFrames(at: Point, away: Point, power: number, tilt = 0): Keyframe[] {
  const far = BLAST_PX * (0.6 + 0.9 * power);
  const to = { x: at.x + away.x * far, y: at.y + away.y * far };
  const spin = (Math.sign(tilt) || 1) * (10 + 14 * power);
  return [
    { translate: px(at), rotate: `${tilt.toFixed(1)}deg` },
    { translate: px(to), rotate: `${(tilt + spin).toFixed(1)}deg` },
  ];
}

/** The centre and size of `el`, in `root`'s coordinates. */
export function boxIn(el: Element, root: Element): Box {
  const r = el.getBoundingClientRect();
  const o = root.getBoundingClientRect();
  return { x: r.left - o.left + r.width / 2, y: r.top - o.top + r.height / 2, w: r.width, h: r.height };
}

/** What moves for `source`: its departure's stand-in as it is, else a copy of its row element over it. */
function mover(root: HTMLElement, source: HTMLElement): { el: HTMLElement; standIn: boolean } {
  if (root.contains(source)) return { el: source, standIn: true };
  const at = source.getBoundingClientRect();
  const box = root.getBoundingClientRect();
  const wrap = document.createElement('div');
  wrap.className = 'board-ram';
  wrap.setAttribute('aria-hidden', 'true');
  wrap.style.left = `${at.left - box.left}px`;
  wrap.style.top = `${at.top - box.top}px`;
  wrap.style.width = `${at.width}px`;
  wrap.style.setProperty('--card-w', `${at.width}px`);
  const copy = copyOfCard(source);
  wrap.append(copy);
  root.append(wrap);
  // Placed over the card's own box, which for a turned card is the turned card already: margins only.
  dropTurnedMargins([copy]);
  return { el: wrap, standIn: false };
}

/** Run `parts` on `el` (each from its own delay), then `done` when the last is over; returns a cancel. */
function play(el: HTMLElement, parts: readonly { frames: Keyframe[]; delay: number; duration: number; easing?: string }[], done: () => void): () => void {
  const anims = parts.map((p) => el.animate(p.frames, { delay: p.delay, duration: p.duration, easing: p.easing ?? 'linear', fill: 'forwards' }));
  const last = anims[anims.length - 1]!;
  last.finished.then(done, done);
  return () => {
    for (const a of anims) a.cancel();
  };
}

/**
 * Draw one creature's ram: `source` (its element in its row, or its departure's stand-in) strikes
 * `to` after `delayMs` plus its contact time, and ends as `end` says. `away` is the way a blasted
 * creature is knocked: from the one that struck it. Returns a cancel that puts everything back.
 */
export function ram(
  root: HTMLElement,
  source: HTMLElement,
  to: Box,
  kind: RamKind,
  end: RamEnd,
  key: string,
  delayMs: number,
  power: number,
  struckPower: number,
  formation: { start: number; at: Point | null } = { start: delayMs, at: null },
): () => void {
  if (typeof source.animate !== 'function') return () => undefined;
  const { el, standIn } = mover(root, source);
  const from = boxIn(el, root);
  const strike = strikeOffset(from, to, kind);
  const contact = delayMs + contactMs(kind);
  const pace = powerEase(power);
  const home = homeEase(power);
  const parts: { frames: Keyframe[]; delay: number; duration: number; easing?: string }[] = [];
  // How it is turned when it lands the blow: for the way home.
  let tilt: number;
  if (kind === 'charge') {
    // Every charger turns to face the player at once, in its place in the cone; each flies in its turn.
    const align = alignOf(from, to, formation.at ?? fanOf([from], to, key)[0]!);
    tilt = align.rot;
    parts.push({ frames: [{ translate: '0px 0px', rotate: '0deg' }, { translate: px(align.at), rotate: `${align.rot.toFixed(1)}deg` }], delay: formation.start, duration: ALIGN_MS, easing: pace });
    parts.push({ frames: chargeFrames(align, strike, key), delay: delayMs + ALIGN_MS, duration: CHARGE_MS, easing: pace });
  } else {
    tilt = tiltOf(key);
    const rear = rearOf(strike, tilt);
    parts.push({ frames: rearFrames(rear), delay: delayMs, duration: REAR_MS, easing: pace });
    parts.push({ frames: lungeFrames(rear, strike, tilt), delay: delayMs + REAR_MS, duration: RUSH_MS, easing: pace });
  }
  if (end === 'blasted') {
    // Blasted by the blow it took: as far as the one that struck it hit.
    parts.push({ frames: blastFrames(strike, unit(to, from), struckPower, tilt), delay: contact, duration: BLAST_MS, easing: 'cubic-bezier(0.15, 0.7, 0.3, 1)' });
  } else if (end === 'bounce') {
    // Off the blow at once, to one side; a moment to settle; then the slow way home.
    const off = bounceFrames(strike, unit(from, to), tilt, key, power);
    parts.push({ frames: off.frames, delay: contact, duration: BOUNCE_MS, easing: 'cubic-bezier(0.1, 0.75, 0.3, 1)' });
    parts.push({ frames: returnFrames(off.at, off.rot), delay: contact + BOUNCE_MS + SETTLE_MS, duration: RETURN_MS, easing: home });
  } else if (end !== 'crumple') {
    parts.push({ frames: returnFrames(strike, tilt), delay: contact + HOLD_MS[end], duration: RETURN_MS, easing: home });
  }
  const timer = standIn ? null : window.setTimeout(() => source.setAttribute(RAMMING_ATTR, ''), kind === 'charge' ? formation.start : delayMs);
  return play(el, parts, () => {
    if (timer !== null) window.clearTimeout(timer);
    if (!standIn) {
      source.removeAttribute(RAMMING_ATTR);
      el.remove();
    }
  });
}

/**
 * A creature that dies of a blow it did not ram back into: its departure's stand-in `target` stands
 * still until `atMs`, then is blasted away from `from` (the box of the one that struck it).
 */
export function blast(root: HTMLElement, target: HTMLElement, from: Box, key: string, atMs: number, power: number): () => void {
  if (typeof target.animate !== 'function' || !root.contains(target)) return () => undefined;
  const away = unit(from, boxIn(target, root));
  return play(target, [{ frames: blastFrames({ x: 0, y: 0 }, away, power), delay: atMs, duration: BLAST_MS, easing: 'cubic-bezier(0.15, 0.7, 0.3, 1)' }], () => undefined);
}
