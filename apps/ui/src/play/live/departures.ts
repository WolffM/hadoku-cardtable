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
  /** Killed by damage: the countered spell's shudder, then it crumples away (`placed.css`'s `placed-countered`). */
  crumple: { ms: 400, pieces: 1 },
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
} as const satisfies Record<string, { readonly ms: number; readonly pieces: number; readonly travels?: true; readonly specks?: number }>;

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
 * up and away by `dx`/`dy` (px), `size` px across, starting as the edge passes it (`at`, a share of the motion). Seeded by
 * the card, so a card always comes apart the same way.
 */
export function specks(cardId: number, count: number): { x: number; y: number; dx: number; dy: number; size: number; at: number }[] {
  return Array.from({ length: count }, (_, n) => {
    const r = (k: string): number => seedOf(`${cardId}:${n}:${k}`);
    const x = r('x');
    const y = r('y');
    // The edge goes from the bottom left corner to the top right one.
    const along = (x + (1 - y)) / 2;
    return { x, y, dx: 18 + r('dx') * 60, dy: -(28 + r('dy') * 70), size: 2 + r('size') * 4, at: along * DISSOLVE_SWEEP };
  });
}

export type ExitMotion = keyof typeof EXIT_MOTIONS;

/**
 * Which exit motion a departure plays — the one place it is chosen. To a graveyard (or gone): destroyed
 * is sliced, any other death crumples. With no cause at all (a Forge from before `GameEventCardDied`),
 * a death no hit explains is taken for destroyed.
 */
export function exitMotionFor(departure: Departure): ExitMotion {
  if (departure.to === 'hand') return 'return';
  if (departure.to === 'exile') return 'dissolve';
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
  /** Remember how every battlefield card is drawn now — the next commit's departures are copied from it. */
  snapshot(): void;
  /** The gap where `departure`'s card was: start its exit `delayMs` from now. */
  leave(departure: Departure, delayMs: number): void;
  dispose(): void;
}

function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** On a destination's own element while a stand-in travels to it: hidden, so the card is drawn once. */
export const LANDING_ATTR = 'data-departure-landing';

/**
 * Where a card going back to its owner's hand lands: its own card there when this screen sees it, else
 * that hand's newest back not yet flown to, else the hand itself. The hand is the one in the seat of the player's face.
 */
function handLanding(canvas: HTMLElement, departure: Departure): HTMLElement | null {
  const own = canvas.querySelector<HTMLElement>(`[data-zone="hand"] [data-board-card="${departure.cardId}"]`);
  if (own !== null) return own;
  const seat = canvas.querySelector(`[data-player-face][data-player-id="${departure.toPlayerId}"]`)?.closest('.seat');
  const hand = seat?.querySelector<HTMLElement>('[data-zone="hand"]') ?? null;
  if (hand === null) return null;
  // The newest back no other card is flying to: two cards into one hand land on two backs.
  const backs = [...hand.querySelectorAll<HTMLElement>('.card-back')].filter((b) => !b.hasAttribute(LANDING_ATTR));
  return backs.at(-1) ?? hand;
}

/** Ids, test ids and every hook another lane finds a card by: a stand-in is no card of the board's. */
const STRIPPED = ['id', 'data-board-card', 'data-card-id', 'data-testid', 'data-arrange-card', 'data-selectable', 'tabindex'];

export function installDepartures(canvas: HTMLElement, host: DeparturesHost): DeparturesHandle {
  /** Each battlefield card's element as of the last commit, by id. */
  let drawn = new Map<number, HTMLElement>();
  /** Each battlefield card's box as of the last commit, by id. */
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
    return canvas.querySelector<HTMLElement>('[data-board-overlay]');
  }

  function standIn(departure: Departure, from: HTMLElement, at: DOMRect, root: HTMLElement, motion: ExitMotion): HTMLElement {
    const box = root.getBoundingClientRect();
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
    if (departure.hue !== undefined) wrap.setAttribute('data-colour', departure.hue);
    for (let n = 1; n <= pieces; n++) {
      const copy = from.cloneNode(true) as HTMLElement;
      for (const el of [copy, ...copy.querySelectorAll<HTMLElement>('*')]) for (const attr of STRIPPED) el.removeAttribute(attr);
      const piece = document.createElement('div');
      piece.className = 'board-departure__piece';
      piece.setAttribute('data-piece', String(n));
      piece.append(copy);
      wrap.append(piece);
    }
    for (const speck of specks(departure.cardId, specksOf(motion))) {
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
    // A turned card is centred in its upright place by margins above and below (`card.css`): the
    // stand-in is the turned card's own box instead, moved down by that margin, so every piece, its
    // tint and its motes are the card's shape and not an upright card's.
    const copies = [...wrap.querySelectorAll<HTMLElement>(':scope > .board-departure__piece > .board-card')];
    const step = copies.length === 0 ? 0 : parseFloat(getComputedStyle(copies[0]!).marginTop) || 0;
    if (step > 0) {
      for (const copy of copies) copy.style.marginBlock = '0';
      wrap.style.top = `${at.top - box.top + step}px`;
    }
    return wrap;
  }

  /** The way from the stand-in to where it lands, written on it for its keyframes. */
  function aim(wrap: HTMLElement, at: DOMRect, landing: HTMLElement): void {
    const to = landing.getBoundingClientRect();
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
        if (Number.isFinite(id) && !drawn.has(id)) {
          drawn.set(id, el);
          boxes.set(id, el.getBoundingClientRect());
        }
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
    leave(departure, delayMs) {
      const done = (): void => host.onDone(departure.cardId);
      const gap = canvas.querySelector<HTMLElement>(`[${LEAVING_GAP_ATTR}="${departure.cardId}"]`);
      const from = drawn.get(departure.cardId);
      const root = overlay();
      if (prefersReducedMotion() || gap === null || from === undefined || root === null) {
        schedule(done, delayMs);
        return;
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
      const landing = travels(motion) ? handLanding(canvas, departure) : null;
      const wrap = standIn(departure, from, at, root, motion);
      wrap.setAttribute(DEPARTURE_ATTR, String(departure.cardId));
      standIns.add(wrap);
      // Only a card or a back is hidden while it is flown to — never a whole hand.
      const hides = landing !== null && landing.getAttribute('data-zone') === null;
      if (hides) landing.setAttribute(LANDING_ATTR, '');
      if (landing !== null) aim(wrap, at, landing);
      schedule(() => {
        // Aimed again at its beat: the hand may have laid itself out anew since the card left.
        if (landing?.isConnected === true) aim(wrap, at, landing);
        wrap.setAttribute('data-exit-go', '');
      }, delayMs);
      schedule(() => {
        if (hides) landing.removeAttribute(LANDING_ATTR);
        wrap.remove();
        standIns.delete(wrap);
        done();
      }, delayMs + EXIT_MOTIONS[motion].ms);
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
