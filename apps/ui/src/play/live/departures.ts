/*
 * A permanent leaving the battlefield is drawn leaving — never just gone from its row. The operator,
 * 2026-10-15: Slagstorm resolved and "it and all my creatures instantly went to the graveyard. that
 * was lame … we should have seen it be played and then seen an animation for my cards being
 * destroyed. That should be the default until we get custom animations."
 *
 * ## How a departure is drawn
 *
 * Forge moves the card in one frame: it is in a graveyard (or exile, or a hand) in the next view and
 * React has already dropped it from its row. So:
 *
 *  1. `Board.tsx` keeps the card's place — its row draws a gap where it was
 *     (`[data-leaving-gap="<id>"]`), so nothing beside it slides in yet (`departuresOf` says which
 *     cards left, the same diff on every screen);
 *  2. this module stands a copy of the card as it was last drawn (its element from the commit
 *     before) over that gap, in the board's overlay — never a transform on a card in a row
 *     (table-fit, `board-motion-needs-table-fit`);
 *  3. at its beat (`live/numbers.ts` says when: after the hit that killed it lands, else as the
 *     resolution's effects start) it plays its exit motion, then goes, and the gap closes
 *     (`DeparturesHost.onDone`).
 *
 * ## One exit motion today; more to come
 *
 * The operator, 2026-10-15: *"we'll probably incorporate different death animations in the future so
 * just make sure this is built in a good way where we can plug in a different animations"*. An exit
 * motion is a name in {@link EXIT_MOTIONS} — its length and how many copies of the card it cuts the card into, here — and keyframes in `departures.css`
 * under `[data-exit="<name>"][data-exit-go]`. {@link exitMotionFor} is the one place a departure's
 * motion is chosen; it sees the card and where it went, so a motion per destination, per card type or
 * per card is a line there, and a new animation is an entry in the table plus its keyframe. Nothing
 * else in this module or in `Board.tsx` knows any motion's name.
 *
 * ## A motion that travels
 *
 * A motion with `travels` in its entry is drawn going somewhere: its stand-in is given the way to its
 * destination as `--to-x`/`--to-y` (from its centre to the destination's) and `--to-scale` (the
 * destination's width over its own), and its keyframes end there. The destination's own element is
 * hidden (`[data-departure-landing]`) until the stand-in reaches it, so the card is drawn once. Back to a
 * hand (the operator, 2026-10-16: "next let's work on the return to hand animation") is the one today:
 * the card lifts off its row and flies into its owner's hand — to its own card in a hand this screen
 * sees, else onto that hand's newest back. Face up all the way, into either: it was on the battlefield
 * for everyone to see (the operator, 2026-10-16: "i notice the unsummon flips the card around. this is
 * unecessary").
 *
 * Reduced motion: no stand-in; the gap closes at the card's beat.
 */

import type { ManaColor } from '@hadoku/shared';

import type { BoardCard, BoardView, DeathCause } from '../adapter.ts';
import './departures.css';
import { seedOf } from './projectile.ts';
import { prefersReducedMotion } from '../motion.ts';
import { overlayOf } from './board-dom.ts';

/**
 * Why a permanent died. Forge's `GameEventCardDied` says it (`DeathCause`, folded here); before a Forge
 * that does, `numbers.ts` marks only `damage` — a hit it drew killed it — and nothing for the rest.
 */
export type DepartureCause = 'damage' | 'destroyed' | 'sacrificed' | 'zero-toughness' | 'state-rule';

/** Forge's cause, as a departure's. */
export function departureCause(cause: DeathCause): DepartureCause {
  switch (cause) {
    case 'LETHAL_DAMAGE':
    case 'DEATHTOUCH':
      return 'damage';
    case 'DESTROYED':
      return 'destroyed';
    case 'SACRIFICED':
      return 'sacrificed';
    case 'ZERO_TOUGHNESS':
      return 'zero-toughness';
    case 'STATE_RULE':
      return 'state-rule';
  }
}

/** Where a permanent went when it left the battlefield; `gone` for nowhere this seat is shown (a token ceasing to exist, a library). */
export type ExitDestination = 'graveyard' | 'exile' | 'hand' | 'gone';

export interface Departure {
  readonly cardId: number;
  /** The battlefield it left: the player whose row keeps its place. */
  readonly playerId: number;
  readonly to: ExitDestination;
  /** Whose zone it went to (a graveyard is its owner's); the battlefield's player when it went nowhere shown. */
  readonly toPlayerId: number;
  /** The card as it was last drawn on that battlefield. */
  readonly card: BoardCard;
  /** Its index in that battlefield's list, so an unarranged row keeps it where it was. */
  readonly index: number;
  /** Why it died, when it went to a graveyard: Forge's word (`BoardView.deathCauses`), else `numbers.ts`'s reading of the hits. */
  readonly cause?: DepartureCause;
  /** The first colour of what moved it — the resolving spell or ability's card — for a motion drawn in it (`data-colour`); absent for none. */
  readonly hue?: ManaColor;
}

/**
 * Every exit motion, by name: how long it plays, and how many copies of the card it is drawn with
 * (each `.board-departure__piece`, numbered `data-piece="1"`…); `travels`, it goes to its destination (see "A motion that travels"); `specks`, how many
 * motes it sheds (`.board-departure__speck`, each placed by `--x`/`--y` across the card, sent off by
 * `--dx`/`--dy`, `--size` across, and starting at `--at`, a share of the motion). The CSS for each is
 * `.board-departure[data-exit="<name>"][data-exit-go]` in `departures.css`.
 */
export const EXIT_MOTIONS = {
  /** Died some other way — sacrificed, no toughness left: the countered spell's shudder, then it crumples away (`placed.css`'s `placed-countered`). */
  crumple: { ms: 400, pieces: 1 },
  /**
   * Killed by damage: it cracks, then crumbles to dust (the operator, 2026-10-16: "i also like how cards
   * 'crack' and then crumble to dust when they die"). Cracks run out from a point near its middle
   * (`shards`), then the pieces they cut part, turn and fall, and dust drifts down.
   */
  shatter: { ms: 950, pieces: 7, shards: true, specks: 34 },
  /**
   * Destroyed: a slash crosses it and it falls apart in two halves that drift off and fade (the operator,
   * 2026-10-15: "a 'slice in half' effect where the card is cut in half and then fades away").
   */
  slice: { ms: 620, pieces: 2 },
  /** Back to a hand: it lifts off its row and flies, face up, to its own card there or the hand's newest back. */
  return: { ms: 760, pieces: 1, travels: true },
  /**
   * Exiled: it dissolves (the operator, 2026-10-16: "for exile can we try something 'disolving' or
   * 'disintegrating'? might be nice to apply a color effect also dependning on the color source of the
   * spell"). An edge crosses it from one corner to the other, eating it away with a ragged border that
   * glows in the colour of what exiled it, and it sheds motes of that colour as the edge passes. Two
   * copies: the card, and the crumbs trailing behind the edge in a second, coarser grain, so the two
   * grains together read as crumbling rather than as a pattern.
   */
  dissolve: { ms: 1600, pieces: 2, specks: 46 },
} as const satisfies Record<string, { readonly ms: number; readonly pieces: number; readonly travels?: true; readonly specks?: number; readonly shards?: true }>;

const shattered = (motion: ExitMotion): boolean => 'shards' in EXIT_MOTIONS[motion];

/** The share of a shatter in which the cracks run and nothing has moved yet. */
const CRACK_SHARE = 0.3;

const pct = (v: number): string => `${v.toFixed(1)}%`;

/** Where a ray from `c` (in %) at `angle` leaves the card's box, 0–100 on each axis. */
function edgeOf(c: { x: number; y: number }, angle: number): { x: number; y: number } {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const ts = [dx > 0 ? (100 - c.x) / dx : dx < 0 ? -c.x / dx : Infinity, dy > 0 ? (100 - c.y) / dy : dy < 0 ? -c.y / dy : Infinity];
  const t = Math.min(...ts);
  return { x: c.x + dx * t, y: c.y + dy * t };
}

/**
 * How a card killed by damage breaks: `count` cracks from a point near its middle out to its edges,
 * each with a kink, cutting it into `count` pieces. `clips` are the pieces as `clip-path` polygons
 * (in %), `cracks` the lines as SVG polyline points (in a 100×100 box), and `parts` how each piece
 * falls away: off its centre, down, turning, a beat after the others. Seeded by the card.
 */
export function shards(cardId: number, count: number): { clips: string[]; cracks: string[]; parts: { dx: number; dy: number; rot: number; lag: number }[] } {
  const r = (k: string): number => seedOf(`${cardId}:shard:${k}`);
  const c = { x: 38 + 24 * r('cx'), y: 34 + 28 * r('cy') };
  const step = (Math.PI * 2) / count;
  const angles = Array.from({ length: count }, (_, i) => r('a0') * Math.PI * 2 + i * step + (r(`j${i}`) - 0.5) * step * 0.5);
  const rays = angles.map((a, i) => {
    const p = edgeOf(c, a);
    const kink = (r(`k${i}`) - 0.5) * 9;
    const m = { x: (c.x + p.x) / 2 - Math.sin(a) * kink, y: (c.y + p.y) / 2 + Math.cos(a) * kink };
    return { a, p, m };
  });
  const corners = [
    { x: 100, y: 100 },
    { x: 0, y: 100 },
    { x: 0, y: 0 },
    { x: 100, y: 0 },
  ].map((p) => ({ p, a: Math.atan2(p.y - c.y, p.x - c.x) }));
  const norm = (a: number): number => ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  const clips = rays.map((ray, i) => {
    const next = rays[(i + 1) % count]!;
    const span = norm(next.a - ray.a);
    const between = corners.filter((k) => norm(k.a - ray.a) < span).sort((x, y) => norm(x.a - ray.a) - norm(y.a - ray.a));
    const pts = [c, ray.m, ray.p, ...between.map((k) => k.p), next.p, next.m];
    return `polygon(${pts.map((p) => `${pct(p.x)} ${pct(p.y)}`).join(', ')})`;
  });
  const cracks = rays.map((ray) => [c, ray.m, ray.p].map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '));
  const parts = rays.map((ray, i) => {
    const mid = norm(ray.a + norm(rays[(i + 1) % count]!.a - ray.a) / 2);
    const out = 6 + 12 * r(`o${i}`);
    return { dx: Math.cos(mid) * out, dy: Math.sin(mid) * out + 26 + 30 * r(`f${i}`), rot: (r(`r${i}`) - 0.5) * 50, lag: Math.round(70 * r(`l${i}`)) };
  });
  return { clips, cracks, parts };
}

const travels = (motion: ExitMotion): boolean => 'travels' in EXIT_MOTIONS[motion];
const specksOf = (motion: ExitMotion): number => {
  const entry = EXIT_MOTIONS[motion];
  return 'specks' in entry ? entry.specks : 0;
};

/**
 * Where a dissolving card's edge is, as a share of the motion, when it passes a point a share `along`
 * of the way across the card from the corner it starts at: it crosses in the first two thirds, so the
 * last motes it sheds have time to drift.
 */
export const DISSOLVE_SWEEP = 0.7;

/**
 * The motes a card sheds: each at a point across it (`x`, `y`, shares of its width and height), sent off
 * by `dx`/`dy` (px), `size` px across, starting at `at` (a share of the motion). A dissolve's rise up and
 * away as its edge passes them; a shatter's are dust, falling once the cracks have run. Seeded by the
 * card, so a card always comes apart the same way.
 */
export function specks(cardId: number, count: number, motion: ExitMotion = 'dissolve'): { x: number; y: number; dx: number; dy: number; size: number; at: number }[] {
  return Array.from({ length: count }, (_, n) => {
    const r = (k: string): number => seedOf(`${cardId}:${n}:${k}`);
    const x = r('x');
    const y = r('y');
    if (shattered(motion)) return { x, y, dx: (r('dx') - 0.5) * 50, dy: 18 + r('dy') * 46, size: 1.5 + r('size') * 3, at: CRACK_SHARE + r('at') * 0.35 };
    // The edge goes from the bottom left corner to the top right one.
    const along = (x + (1 - y)) / 2;
    return { x, y, dx: 18 + r('dx') * 60, dy: -(28 + r('dy') * 70), size: 2 + r('size') * 4, at: along * DISSOLVE_SWEEP };
  });
}

export type ExitMotion = keyof typeof EXIT_MOTIONS;

/**
 * Which exit motion a departure plays — the one place it is chosen. To a graveyard (or gone): killed by
 * damage, it cracks and crumbles; destroyed, it is sliced; any other death crumples. With no cause at
 * all (a Forge from before `GameEventCardDied`), a death no hit explains is taken for destroyed.
 */
export function exitMotionFor(departure: Departure): ExitMotion {
  if (departure.to === 'hand') return 'return';
  if (departure.to === 'exile') return 'dissolve';
  if (departure.cause === 'damage') return 'shatter';
  return departure.cause === undefined || departure.cause === 'destroyed' ? 'slice' : 'crumple';
}

/** How long a departure stays drawn once its beat starts. */
export function exitMs(departure: Departure): number {
  return EXIT_MOTIONS[exitMotionFor(departure)].ms;
}

function destinationIn(view: BoardView, cardId: number): { to: ExitDestination | 'battlefield'; playerId: number | null } {
  for (const player of view.players) {
    const has = (cards: readonly BoardCard[] | null): boolean => (cards ?? []).some((c) => c.id === cardId);
    if (has(player.battlefield)) return { to: 'battlefield', playerId: player.id };
    if (has(player.graveyard)) return { to: 'graveyard', playerId: player.id };
    if (has(player.exile)) return { to: 'exile', playerId: player.id };
    if (has(player.hand) || (player.handShown ?? []).some((c) => c?.id === cardId)) return { to: 'hand', playerId: player.id };
  }
  return { to: 'gone', playerId: null };
}

/**
 * The permanents on a battlefield in `prev` that are on none in `next`. A permanent that changed
 * control is still on a battlefield, and stays out of it. Pure, so both screens draw the same
 * departures from the same two views.
 *
 * A card found in no zone of `next` went to a hand this screen does not see into when a hidden hand
 * grew by more than it shows — one card per card it grew by, the hand of the battlefield it left
 * first — and otherwise nowhere shown (`gone`).
 */
export function departuresOf(prev: BoardView | null, next: BoardView): Departure[] {
  if (prev === null) return [];
  const out: Departure[] = [];
  const grown = new Map<number, number>();
  for (const player of next.players) {
    const was = prev.players.find((p) => p.id === player.id);
    if (player.hand === null && was !== undefined && player.handCount > was.handCount) grown.set(player.id, player.handCount - was.handCount);
  }
  const intoHidden = (from: number): number | null => {
    const id = (grown.get(from) ?? 0) > 0 ? from : ([...grown].find(([, n]) => n > 0)?.[0] ?? null);
    if (id !== null) grown.set(id, grown.get(id)! - 1);
    return id;
  };
  for (const player of prev.players) {
    player.battlefield.forEach((card, index) => {
      const { to, playerId } = destinationIn(next, card.id);
      if (to === 'battlefield') return;
      const base = { cardId: card.id, playerId: player.id, card, index };
      const hiddenHand = to === 'gone' ? intoHidden(player.id) : null;
      if (hiddenHand !== null) out.push({ ...base, to: 'hand', toPlayerId: hiddenHand });
      else out.push({ ...base, to, toPlayerId: playerId ?? player.id });
    });
  }
  return out;
}

/* ── the DOM ─────────────────────────────────────────────────────────── */

/** The attribute on the gap `Board.tsx` keeps where a departing card was. */
export const LEAVING_GAP_ATTR = 'data-leaving-gap';

/** On the copy drawn leaving: the departed card's id, so a hit in flight can aim at it. */
export const DEPARTURE_ATTR = 'data-departure';

/** How long a departure may keep its place at most, should its beat never come. */
export const DEPARTURE_MAX_MS = 4000;

export interface DeparturesHost {
  /** The card's exit is over (or there was none to draw): its row may close up. */
  onDone(cardId: number): void;
  /**
   * Told once per commit that drew departures how the board held still — the operator, 2026-10-15, of a
   * Slagstorm: "all the cards drifted down when the card start resolving", which the demo board never
   * showed: `copyDx`/`copyDy`, the most a copy sits off the card it stands in for; `rowShift`, the most
   * any card still on a battlefield moved in that commit, and `rowShiftLater` 250 ms on, with the card
   * that moved most.
   */
  report?(data: Record<string, string | number | boolean>): void;
}

export interface DeparturesHandle {
  /** Remember which element draws each battlefield card now — the next commit's departures are copied from it. Reads no box. */
  snapshot(): void;
  /**
   * The commit being rendered draws departures: read where each card `snapshot` kept is drawn, before
   * React writes that commit, for its layout report. The one box read a departure costs; a commit with
   * none reads nothing.
   */
  capture(): void;
  /** The gaps where a commit's departures' cards were: start each one's exit `delayMs` from now. One call per commit, so every box is read before anything is drawn. */
  leave(batch: readonly { departure: Departure; delayMs: number }[]): void;
  dispose(): void;
}

/** On a destination's own element while a stand-in travels to it: hidden, so the card is drawn once. */
export const LANDING_ATTR = 'data-departure-landing';

/**
 * Where a card going back to its owner's hand lands: its own card there when this screen sees it, else
 * that hand's newest back not yet flown to, else the hand itself. The hand is the one in the seat of the player's face.
 */
function handLanding(canvas: HTMLElement, departure: Departure, taken: ReadonlySet<Element>): HTMLElement | null {
  const own = canvas.querySelector<HTMLElement>(`[data-zone="hand"] [data-board-card="${departure.cardId}"]`);
  if (own !== null) return own;
  const seat = canvas.querySelector(`[data-player-face][data-player-id="${departure.toPlayerId}"]`)?.closest('.seat');
  const hand = seat?.querySelector<HTMLElement>('[data-zone="hand"]') ?? null;
  if (hand === null) return null;
  // The newest back no other card is flying to: two cards into one hand land on two backs.
  const backs = [...hand.querySelectorAll<HTMLElement>('.card-back')].filter((b) => !b.hasAttribute(LANDING_ATTR) && !taken.has(b));
  return backs.at(-1) ?? hand;
}

/** Ids, test ids and every hook another lane finds a card by: a stand-in is no card of the board's. */
const STRIPPED = ['id', 'data-board-card', 'data-card-id', 'data-testid', 'data-arrange-card', 'data-selectable', 'tabindex'];

/** A copy of a card as it is drawn, for a stand-in: nothing finds it as one of the board's cards. */
export function copyOfCard(from: HTMLElement): HTMLElement {
  const copy = from.cloneNode(true) as HTMLElement;
  for (const el of [copy, ...copy.querySelectorAll<HTMLElement>('*')]) for (const attr of STRIPPED) el.removeAttribute(attr);
  return copy;
}

/**
 * A turned card is centred in its upright place by margins above and below (`card.css`), a share of
 * its container's width, so a copy's are read off the copy where it is drawn. How far down they put it.
 * A read: in a batch, every copy is read before any is changed, so the page lays itself out once.
 */
function turnedStep(copy: HTMLElement | undefined): number {
  return copy === undefined ? 0 : Math.max(0, parseFloat(getComputedStyle(copy).marginTop) || 0);
}

/**
 * A stand-in placed at `top` over a turned card's upright place (a departure's kept gap) is made the
 * turned card's own box: its copies' margins dropped, itself moved down by `step`, so whatever it
 * draws is the card's shape, not an upright card's.
 */
function fitTurned(wrap: HTMLElement, copies: readonly HTMLElement[], top: number, step: number): void {
  if (step === 0) return;
  for (const copy of copies) copy.style.marginBlock = '0';
  wrap.style.top = `${top + step}px`;
}

export function installDepartures(canvas: HTMLElement, host: DeparturesHost): DeparturesHandle {
  /** Each battlefield card's element as of the last commit, by id. */
  let drawn = new Map<number, HTMLElement>();
  /** Each battlefield card's box before the commit that draws departures, by id (`capture`). */
  let boxes = new Map<number, DOMRect>();
  /** This commit's departures, for its layout report: how many, and the most a copy sat off its card. */
  let pending: { count: number; copyDx: number; copyDy: number } | null = null;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const standIns = new Set<HTMLElement>();
  let live = true;

  function schedule(fn: () => void, ms: number): void {
    const t = setTimeout(() => {
      timers.delete(t);
      if (live) fn();
    }, ms);
    timers.add(t);
  }

  function overlay(): HTMLElement | null {
    return overlayOf(canvas);
  }

  /** The stand-in, built and placed, with no box read: `box` is the overlay's, read with every other box of the batch. */
  function standIn(departure: Departure, from: HTMLElement, at: DOMRect, root: HTMLElement, box: DOMRect, motion: ExitMotion): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'board-departure';
    wrap.setAttribute('data-exit', motion);
    wrap.setAttribute('aria-hidden', 'true');
    wrap.style.left = `${at.left - box.left}px`;
    wrap.style.top = `${at.top - box.top}px`;
    wrap.style.width = `${at.width}px`;
    // The copy is sized by the zone's own `--card-w`, which the overlay is outside of.
    wrap.style.setProperty('--card-w', `${at.width}px`);
    const pieces = EXIT_MOTIONS[motion].pieces;
    wrap.style.setProperty('--exit-ms', `${EXIT_MOTIONS[motion].ms}ms`);
    if (departure.hue !== undefined) wrap.setAttribute('data-colour', departure.hue);
    const broken = shattered(motion) ? shards(departure.cardId, pieces) : null;
    for (let n = 1; n <= pieces; n++) {
      const copy = copyOfCard(from);
      const piece = document.createElement('div');
      piece.className = 'board-departure__piece';
      piece.setAttribute('data-piece', String(n));
      const part = broken?.parts[n - 1];
      if (broken !== null && part !== undefined) {
        piece.style.clipPath = broken.clips[n - 1]!;
        piece.style.setProperty('--dx', `${part.dx.toFixed(1)}px`);
        piece.style.setProperty('--dy', `${part.dy.toFixed(1)}px`);
        piece.style.setProperty('--rot', `${part.rot.toFixed(0)}deg`);
        piece.style.setProperty('--lag', `${part.lag}ms`);
      }
      piece.append(copy);
      wrap.append(piece);
    }
    if (broken !== null) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'board-departure__cracks');
      svg.setAttribute('viewBox', '0 0 100 100');
      svg.setAttribute('preserveAspectRatio', 'none');
      for (const points of broken.cracks) {
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
        line.setAttribute('points', points);
        line.setAttribute('pathLength', '1');
        svg.append(line);
      }
      wrap.append(svg);
    }
    for (const speck of specks(departure.cardId, specksOf(motion), motion)) {
      const el = document.createElement('i');
      el.className = 'board-departure__speck';
      el.style.setProperty('--x', `${(speck.x * 100).toFixed(1)}%`);
      el.style.setProperty('--y', `${(speck.y * 100).toFixed(1)}%`);
      el.style.setProperty('--dx', `${speck.dx.toFixed(1)}px`);
      el.style.setProperty('--dy', `${speck.dy.toFixed(1)}px`);
      el.style.setProperty('--size', `${speck.size.toFixed(1)}px`);
      el.style.setProperty('--at', speck.at.toFixed(3));
      wrap.append(el);
    }
    root.append(wrap);
    return wrap;
  }

  /** The way from the stand-in to where it lands (`to`, the landing's box), written on it for its keyframes. */
  function aim(wrap: HTMLElement, at: DOMRect, to: DOMRect): void {
    wrap.style.setProperty('--to-x', `${to.left + to.width / 2 - (at.left + at.width / 2)}px`);
    wrap.style.setProperty('--to-y', `${to.top + to.height / 2 - (at.top + at.height / 2)}px`);
    wrap.style.setProperty('--to-scale', String(at.width > 0 && to.width > 0 ? Math.min(1.2, to.width / at.width) : 1));
  }

  return {
    snapshot() {
      const before = boxes;
      drawn = new Map();
      boxes = new Map();
      for (const el of canvas.querySelectorAll<HTMLElement>('[data-zone="battlefield"] [data-board-card]')) {
        const id = Number(el.getAttribute('data-board-card'));
        if (Number.isFinite(id) && !drawn.has(id)) drawn.set(id, el);
      }
      if (pending === null) return;
      const batch = pending;
      pending = null;
      const shift = (): { most: number; card: number } => {
        let most = 0;
        let card = -1;
        for (const [id, el] of drawn) {
          const was = before.get(id);
          if (was === undefined || !el.isConnected) continue;
          const now = el.getBoundingClientRect();
          const moved = Math.max(Math.abs(now.top - was.top), Math.abs(now.left - was.left));
          if (moved > most) {
            most = moved;
            card = id;
          }
        }
        return { most: Math.round(most), card };
      };
      const atOnce = shift();
      schedule(() => {
        const later = shift();
        host.report?.({
          what: 'departure-layout',
          departures: batch.count,
          copyDx: Math.round(batch.copyDx),
          copyDy: Math.round(batch.copyDy),
          rowShift: atOnce.most,
          rowShiftCard: atOnce.card,
          rowShiftLater: later.most,
          rowShiftLaterCard: later.card,
        });
      }, 250);
    },
    capture() {
      boxes = new Map();
      for (const [id, el] of drawn) if (el.isConnected) boxes.set(id, el.getBoundingClientRect());
    },
    leave(batch) {
      const root = overlay();
      const still = prefersReducedMotion() || root === null;
      // Every box first, then every write: one layout for the whole batch, never one per card.
      const box = still ? null : root.getBoundingClientRect();
      const taken = new Set<Element>();
      const plans: { departure: Departure; delayMs: number; from: HTMLElement; at: DOMRect; motion: ExitMotion; landing: HTMLElement | null; to: DOMRect | null }[] = [];
      for (const { departure, delayMs } of batch) {
        const gap = canvas.querySelector<HTMLElement>(`[${LEAVING_GAP_ATTR}="${departure.cardId}"]`);
        const from = drawn.get(departure.cardId);
        if (still || gap === null || from === undefined) {
          schedule(() => host.onDone(departure.cardId), delayMs);
          continue;
        }
        const motion = exitMotionFor(departure);
        const at = gap.getBoundingClientRect();
        const was = boxes.get(departure.cardId);
        pending ??= { count: 0, copyDx: 0, copyDy: 0 };
        pending.count += 1;
        if (was !== undefined) {
          pending.copyDx = Math.max(pending.copyDx, Math.abs(at.left - was.left));
          pending.copyDy = Math.max(pending.copyDy, Math.abs(at.top - was.top));
        }
        const landing = travels(motion) ? handLanding(canvas, departure, taken) : null;
        if (landing !== null) taken.add(landing);
        plans.push({ departure, delayMs, from, at, motion, landing, to: landing?.getBoundingClientRect() ?? null });
      }
      if (root === null || box === null || plans.length === 0) return;
      const built = plans.map((p) => {
        const wrap = standIn(p.departure, p.from, p.at, root, box, p.motion);
        wrap.setAttribute(DEPARTURE_ATTR, String(p.departure.cardId));
        standIns.add(wrap);
        if (p.to !== null) aim(wrap, p.at, p.to);
        return { ...p, wrap, copies: [...wrap.querySelectorAll<HTMLElement>(':scope > .board-departure__piece > .board-card')] };
      });
      const steps = built.map((b) => turnedStep(b.copies[0]));
      built.forEach((b, i) => {
        fitTurned(b.wrap, b.copies, b.at.top - box.top, steps[i]!);
        const { wrap, at, landing, departure, delayMs, motion } = b;
        // Only a card or a back is hidden while it is flown to — never a whole hand.
        const hides = landing !== null && landing.getAttribute('data-zone') === null;
        if (hides) landing.setAttribute(LANDING_ATTR, '');
        schedule(() => {
          // Aimed again at its beat: the hand may have laid itself out anew since the card left.
          if (landing?.isConnected === true) aim(wrap, at, landing.getBoundingClientRect());
          wrap.setAttribute('data-exit-go', '');
        }, delayMs);
        schedule(() => {
          if (hides) landing.removeAttribute(LANDING_ATTR);
          wrap.remove();
          standIns.delete(wrap);
          host.onDone(departure.cardId);
        }, delayMs + EXIT_MOTIONS[motion].ms);
      });
    },
    dispose() {
      live = false;
      for (const t of timers) clearTimeout(t);
      timers.clear();
      for (const el of standIns) el.remove();
      standIns.clear();
      for (const el of canvas.querySelectorAll(`[${LANDING_ATTR}]`)) el.removeAttribute(LANDING_ATTR);
    },
  };
}
