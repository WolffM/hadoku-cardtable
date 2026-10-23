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
 * A charge at a player is a punch instead (`punchAt`): it draws back to rest, creeps, then bursts into the blow.
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

import { BEAT_ANIMATION_ID, homeEase, powerEase } from '../motion.ts';
import { copyOfCard } from './departures.ts';
import { along, seedOf } from './projectile.ts';
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
const REAR_MS = 120;
const RUSH_MS = 200;
/** A charge at a player: rearing back to face it (all chargers at once, in formation), then the flight in. */
export const ALIGN_MS = 300;
const CHARGE_MS = 640;
/** How long a winner and a charge hold the blow before they go back: a pause that lets the blow land. */
export const HOLD_MS: Readonly<Record<'win' | 'charge', number>> = { win: 280, charge: 180 };
/** Two that both live bounce off each other this fast, settle this long, then take the way home. */
const BOUNCE_MS = 190;
const SETTLE_MS = 70;
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
function tiltOf(key: string): number {
  const side = seedOf(`${key}:side`) < 0.5 ? -1 : 1;
  return side * (5 + 5 * seedOf(`${key}:lean`));
}

/** `p` turned by `deg` degrees. */
function turned(p: Point, deg: number): Point {
  const a = (deg * Math.PI) / 180;
  return { x: p.x * Math.cos(a) - p.y * Math.sin(a), y: p.x * Math.sin(a) + p.y * Math.cos(a) };
}
/** Samples of a charge's curve: enough that the burst at its end stays smooth. */
const SAMPLES = 32;
/** A charger's draw back: it comes to rest just as its punch sets off, so the two read as one move. */
const WIND_UP_EASE = 'cubic-bezier(0.2, 0.6, 0.3, 1)';
/** How far a charger draws back as it turns to face the player. */
const ALIGN_BACK_PX = 18;

const px = (p: Point): string => `${p.x.toFixed(1)}px ${p.y.toFixed(1)}px`;

/** Where a creature draws back to before it lunges at `strike`, and how it leans there. */
function rearOf(strike: Point, tilt: number): { at: Point; rot: number } {
  const d = Math.hypot(strike.x, strike.y) || 1;
  return { at: { x: (-strike.x / d) * REAR_PX, y: (-strike.y / d) * REAR_PX }, rot: -tilt * 0.3 };
}

/** The rear back: from its place to `rear`. Its pace is the blow's (`powerEase`), set on the animation. */
function rearFrames(rear: { at: Point; rot: number }): Keyframe[] {
  return [
    { translate: '0px 0px', rotate: '0deg' },
    { translate: px(rear.at), rotate: `${rear.rot.toFixed(1)}deg` },
  ];
}

/**
 * The lunge into the blow: from `rear` to `strike` along a slight curve (to the side `tilt` leans),
 * leaning into it until it lands at `tilt` degrees. Sampled evenly; the pace is the animation's.
 */
function lungeFrames(rear: { at: Point; rot: number }, strike: Point, tilt: number): Keyframe[] {
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
/** Fanned chargers stand this many of their longest side apart along their arc, and one rank behind another. */
const FAN_GAP = 1.25;
/** How finely a rank's arc is walked to find where it leaves the table (radians). */
const ARC_STEP = Math.PI / 720;

/** `a` radians brought into −π..π. */
const wrapPi = (a: number): number => ((((a + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) - Math.PI;
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * Where each of a pack of chargers forms up before it flies, as an offset from where it stands. All of
 * it points at the player — the cone the operator asked for ("they all point towards the enemy avatar"),
 * every charger a card's longest side and more from the next however they turn ("try to spread them out
 * a little bit so they aren't on top of eachother once they start 'the punch'").
 *
 * Every charger forms up whole on `table`, the visible table, on the board's side of the player — never
 * behind it or round it (the operator, 2026-10-20: "with a very large number of creatures (15+) they fan
 * out in a circle around the opponent, but they should fan out in a cone around the opponent, towards
 * the visible part of the board", then: "cone is maybe the wrong word. just keep the creatures on the
 * board.").
 *
 * A pack that fits stands as it did: each drawn back from the player along its own line, so it keeps the
 * loose arrangement it stood in, neighbours pushed apart around the player only as far as spacing needs,
 * the pack kept centred where it was, turned only as little as keeps it on the board.
 * One charger just draws straight back. A pack too wide for that forms ranks instead: arcs round the
 * player one rank's depth apart, outward first, then inward while the table allows, each filled in
 * proportion to its room and every other one staggered by half a place — and the chargers take their
 * places in the order they stood, so no two paths cross. Past all the room the table has, a rank
 * squeezes rather than leave it.
 */
export function fanOf(froms: readonly Box[], to: Box, key: string, table: Box): Point[] {
  const longest = Math.max(0, ...froms.map((b) => Math.max(b.w, b.h)));
  // However it turns, a card reaches no further from its centre than half its diagonal.
  const margin = Math.max(0, ...froms.map((b) => Math.hypot(b.w, b.h) / 2));
  const onTable = (p: Point): boolean => Math.abs(p.x - table.x) <= Math.max(0, table.w / 2 - margin) && Math.abs(p.y - table.y) <= Math.max(0, table.h / 2 - margin);
  const polar = (a: number, r: number): Point => ({ x: to.x + Math.cos(a) * r, y: to.y + Math.sin(a) * r });
  const natural = froms.map((b, i) => ({ i, a: Math.atan2(b.y - to.y, b.x - to.x), r: Math.hypot(b.x - to.x, b.y - to.y) + ALIGN_BACK_PX + (seedOf(`${key}:${i}:depth`) - 0.5) * 8 }));
  const mean = (as: readonly number[]): number => as.reduce((n, a) => n + a, 0) / Math.max(1, as.length);
  // The way to the board: of the ways from the player on the board's side of it, the middle of those that
  // reach the table at the pack's distance — down and in from an avatar in a corner, straight down from
  // one in the middle of an edge.
  const board = to.y < table.y ? Math.PI / 2 : -Math.PI / 2;
  const seen = Array.from({ length: 361 }, (_, n) => board - Math.PI / 2 + (n * Math.PI) / 360).filter((a) => onTable(polar(a, mean(natural.map((sp) => sp.r)))));
  const axis = seen.length === 0 ? board : (seen[0]! + seen[seen.length - 1]!) / 2;
  // Never behind the player's own level: the board's side of it, measured from that way.
  const sideLo = board - Math.PI / 2 - axis;
  const sideHi = board + Math.PI / 2 - axis;
  const at = (a: number, r: number): Point => polar(axis + a, r);
  const gapAt = (r: number): number => (longest * FAN_GAP) / Math.max(1, r);
  // Angles are measured from the way to the board, so a pack never straddles the jump at ±π.
  const spots = natural.map((sp) => ({ ...sp, a: wrapPi(sp.a - axis) })).sort((x, y) => x.a - y.a);
  const stood = spots.map((sp) => sp.a);
  const offsets = (placed: readonly { i: number; a: number; r: number }[]): Point[] => {
    const out: Point[] = froms.map(() => ({ x: 0, y: 0 }));
    for (const sp of placed) {
      const p = at(sp.a, sp.r);
      out[sp.i] = { x: p.x - froms[sp.i]!.x, y: p.y - froms[sp.i]!.y };
    }
    return out;
  };

  // As it stood, spread each from the last as needed, centred where it was, then turned onto the board.
  const spread = spots.map((sp) => ({ ...sp }));
  for (let j = 1; j < spread.length; j++) spread[j]!.a = Math.max(spread[j]!.a, spread[j - 1]!.a + gapAt((spread[j]!.r + spread[j - 1]!.r) / 2));
  const first = spread[0]?.a ?? 0;
  const last = spread[spread.length - 1]?.a ?? 0;
  const lowest = sideLo - first;
  const highest = sideHi - last;
  const wanted = clamp(mean(stood) - mean(spread.map((sp) => sp.a)), lowest, highest);
  // The nearest turn of it that keeps it all on the table.
  for (let d = 0; last - first <= sideHi - sideLo && (wanted - d >= lowest || wanted + d <= highest); d += ARC_STEP)
    for (const shift of [wanted - d, wanted + d]) {
      const loose = spread.map((sp) => ({ ...sp, a: sp.a + shift }));
      if (shift >= lowest && shift <= highest && loose.every((sp) => onTable(at(sp.a, sp.r)))) return offsets(loose);
    }

  // Ranks: arcs round the player, each the run on the board's side around the pack's middle that is on the table.
  const centre = clamp(mean(stood), sideLo, sideHi);
  const depth = longest * FAN_GAP;
  const nearest = Math.max(to.w, to.h) / 2 + depth;
  let r0 = mean(spots.map((sp) => sp.r));
  while (r0 > nearest && !onTable(at(centre, r0))) r0 -= 1;
  const arc = (r: number): { r: number; lo: number; hi: number; room: number } | null => {
    if (r < nearest || !onTable(at(centre, r))) return null;
    let lo = centre;
    let hi = centre;
    while (lo - ARC_STEP >= sideLo && onTable(at(lo - ARC_STEP, r))) lo -= ARC_STEP;
    while (hi + ARC_STEP <= sideHi && onTable(at(hi + ARC_STEP, r))) hi += ARC_STEP;
    return { r, lo, hi, room: Math.floor((hi - lo) / gapAt(r)) + 1 };
  };
  const ranks: { r: number; lo: number; hi: number; room: number }[] = [];
  const room = (): number => ranks.reduce((n, k) => n + k.room, 0);
  for (let k = 0; room() < spots.length; k++) {
    const rank = arc(r0 + k * depth);
    if (rank === null) break;
    ranks.push(rank);
  }
  for (let k = 1; room() < spots.length; k++) {
    const rank = arc(r0 - k * depth);
    if (rank === null) break;
    ranks.push(rank);
  }
  if (ranks.length === 0) ranks.push({ r: r0, lo: centre, hi: centre, room: 1 });
  // Each rank takes its share of the pack by its room; past all the table has, they squeeze.
  const total = room();
  const counts = ranks.map((k) => Math.min(k.room, Math.floor((spots.length * k.room) / total)));
  for (let k = 0; counts.reduce((n, c) => n + c, 0) < spots.length; k = (k + 1) % ranks.length)
    if (counts[k]! < ranks[k]!.room || total < spots.length) counts[k]! += 1;
  const places = ranks.flatMap((k, n) => {
    const count = counts[n]!;
    const step = count > 1 ? Math.min(gapAt(k.r), (k.hi - k.lo) / (count - 1)) : 0;
    const half = (step * (count - 1)) / 2;
    const staggered = Math.abs(Math.round((k.r - r0) / depth)) % 2 === 1;
    const mid = clamp(centre + (staggered ? step / 2 : 0), k.lo + half, k.hi - half);
    return Array.from({ length: count }, (_, j) => ({ a: mid - half + j * step, r: k.r }));
  });
  places.sort((x, y) => x.a - y.a);
  return offsets(spots.map((sp, j) => ({ i: sp.i, ...places[j]! })));
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
function bounceFrames(strike: Point, toward: Point, tilt: number, key: string, power: number): { frames: Keyframe[]; at: Point; rot: number } {
  const skew = (seedOf(`${key}:bounce`) - 0.5) * 70;
  const dir = turned({ x: -toward.x, y: -toward.y }, skew);
  const far = BOUNCE_PX * (0.7 + 0.8 * power);
  const at = { x: strike.x + dir.x * far, y: strike.y + dir.y * far };
  const rot = tilt + (seedOf(`${key}:kick`) < 0.5 ? -1 : 1) * (6 + 6 * seedOf(`${key}:spin`));
  return { frames: [{ translate: px(strike), rotate: `${tilt.toFixed(1)}deg` }, { translate: px(at), rotate: `${rot.toFixed(1)}deg` }], at, rot };
}

/**
 * How far along its flight a punch at `power` is at `t` (both 0 to 1): it sets off from rest and creeps,
 * then bursts, accelerating hard right into the blow (the operator, 2026-10-17: "the start should be
 * slower and then burst into motion with intense acceleration until impact"; "even small creatures
 * should punch harder than this"). The heavier, the longer the creep and the harder the burst ("larger
 * creature should start slower and then accelerate to faster speeds"): a point is a tenth of the way
 * at half time and lands at five times its average speed; seven, under a twentieth and ten times; twenty,
 * barely off the mark at half time and fifteen times. An exponential, since a cubic bezier ease could not
 * start slow enough and still burst.
 */
export function punchAt(t: number, power: number): number {
  const p = Math.min(1, Math.max(0, power));
  const k = 6 + 10 * p;
  const creep = 0.25 - 0.2 * p;
  return creep * t * t + ((1 - creep) * (Math.exp(k * t) - 1)) / (Math.exp(k) - 1);
}

/**
 * A charge's curve: its control point off the straight line to either side, from barely to well over a
 * third of its length, and anywhere from early to late along it — so one swings wide at once and the next
 * hooks in at the end (the operator, 2026-10-17: "add a bit of variance for the direction and curvature of
 * the arc? a bit of randomness would be nice here"). `random` gives 0 to 1; each charge draws its own.
 */
export function chargeControl(start: Point, end: Point, random: () => number): Point {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy) || 1;
  const side = random() < 0.5 ? -1 : 1;
  const bend = (0.06 + 0.4 * random()) * length * side;
  const at = 0.3 + 0.4 * random();
  return { x: start.x + dx * at + (-dy / length) * bend, y: start.y + dy * at + (dx / length) * bend };
}

/**
 * A charge's flight: from its aligned pose along its curve (`chargeControl`) onto what it strikes, still
 * facing it. Sampled evenly in time, each sample at the punch's distance (`punchAt`), so the pace is in the
 * frames: run it linear.
 */
function chargeFrames(align: { at: Point; rot: number }, strike: Point, power: number, random: () => number = Math.random): Keyframe[] {
  const control = chargeControl(align.at, strike, random);
  return Array.from({ length: SAMPLES + 1 }, (_, i) => ({ offset: i / SAMPLES, translate: px(along(align.at, control, strike, punchAt(i / SAMPLES, power))), rotate: `${align.rot.toFixed(1)}deg` }));
}

/** Slowly back to its place from `at`, turned `rot` degrees, straightening as it goes. */
function returnFrames(at: Point, rot: number): Keyframe[] {
  return [
    { translate: px(at), rotate: `${rot.toFixed(1)}deg` },
    { translate: '0px 0px', rotate: '0deg' },
  ];
}

/**
 * Knocked from `at` along `away` (a unit vector), further for a heavier blow. Only where it goes: its
 * departure's own exit (`departures.ts`'s shatter) cracks it and crumbles it to dust on the way.
 */
function blastFrames(at: Point, away: Point, power: number, tilt = 0): Keyframe[] {
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

/**
 * What moves for `source`: its departure's stand-in as it is, else a copy of its row element over
 * `from`, the box it was measured at. Reads no box: a ram's copy drawn between two reads laid the page
 * out again for every creature in the attack.
 */
function mover(root: HTMLElement, source: HTMLElement, from: Box): { el: HTMLElement; standIn: boolean } {
  if (root.contains(source)) return { el: source, standIn: true };
  const wrap = document.createElement('div');
  wrap.className = 'board-ram';
  wrap.setAttribute('aria-hidden', 'true');
  wrap.style.left = `${from.x - from.w / 2}px`;
  wrap.style.top = `${from.y - from.h / 2}px`;
  wrap.style.width = `${from.w}px`;
  wrap.style.setProperty('--card-w', `${from.w}px`);
  const copy = copyOfCard(source);
  // Placed over the card's own box, which for a turned card is the turned card already: its centring
  // margins (`card.css`) would move the copy off it. An upright card has none to drop.
  copy.style.marginBlock = '0';
  wrap.append(copy);
  root.append(wrap);
  return { el: wrap, standIn: false };
}

/** Run `parts` on `el` (each from its own delay), then `done` when the last is over; returns a cancel. */
function play(el: HTMLElement, parts: readonly { frames: Keyframe[]; delay: number; duration: number; easing?: string }[], done: () => void): () => void {
  const anims = parts.map((p) => el.animate(p.frames, { id: BEAT_ANIMATION_ID, delay: p.delay, duration: p.duration, easing: p.easing ?? 'linear', fill: 'forwards' }));
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
  from: Box,
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
  const { el, standIn } = mover(root, source, from);
  const strike = strikeOffset(from, to, kind);
  const contact = delayMs + contactMs(kind);
  const pace = powerEase(power);
  const home = homeEase(power);
  const parts: { frames: Keyframe[]; delay: number; duration: number; easing?: string }[] = [];
  // How it is turned when it lands the blow: for the way home.
  let tilt: number;
  if (kind === 'charge') {
    // Every charger starts turning to face the player at once, to its place in the fan, and keeps
    // drawing back until its own turn to fly — never standing still in between (the operator,
    // 2026-10-17: "once a card has reached it's starting position for the 'punch' it should transition
    // to that right away").
    const align = alignOf(from, to, formation.at ?? fanOf([from], to, key, boxIn(root, root))[0]!);
    tilt = align.rot;
    const launch = delayMs + ALIGN_MS;
    parts.push({ frames: [{ translate: '0px 0px', rotate: '0deg' }, { translate: px(align.at), rotate: `${align.rot.toFixed(1)}deg` }], delay: formation.start, duration: launch - formation.start, easing: WIND_UP_EASE });
    parts.push({ frames: chargeFrames(align, strike, power), delay: launch, duration: CHARGE_MS });
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
export function blast(root: HTMLElement, target: HTMLElement, from: Box, at: Box, key: string, atMs: number, power: number): () => void {
  if (typeof target.animate !== 'function' || !root.contains(target)) return () => undefined;
  const away = unit(from, at);
  return play(target, [{ frames: blastFrames({ x: 0, y: 0 }, away, power), delay: atMs, duration: BLAST_MS, easing: 'cubic-bezier(0.15, 0.7, 0.3, 1)' }], () => undefined);
}
