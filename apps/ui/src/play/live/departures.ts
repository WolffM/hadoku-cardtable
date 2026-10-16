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
 * motion is a name in {@link EXIT_MOTIONS} — its length, here — and a keyframe in `departures.css`
 * under `[data-exit="<name>"][data-exit-go]`. {@link exitMotionFor} is the one place a departure's
 * motion is chosen; it sees the card and where it went, so a motion per destination, per card type or
 * per card is a line there, and a new animation is an entry in the table plus its keyframe. Nothing
 * else in this module or in `Board.tsx` knows any motion's name.
 *
 * Reduced motion: no stand-in; the gap closes at the card's beat.
 */

import type { BoardCard, BoardView } from '../adapter.ts';
import './departures.css';

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
}

/**
 * Every exit motion, by name, and how long it plays. The CSS for each is
 * `.board-departure[data-exit="<name>"][data-exit-go]` in `departures.css`.
 */
export const EXIT_MOTIONS = {
  /** Destroyed: the countered spell's shudder, then it crumples away (`placed.css`'s `placed-countered`). */
  crumple: { ms: 400 },
  /** Out of play some other way — exiled, returned to a hand: it lifts and fades. */
  fade: { ms: 300 },
} as const satisfies Record<string, { readonly ms: number }>;

export type ExitMotion = keyof typeof EXIT_MOTIONS;

/** Which exit motion a departure plays — the one place it is chosen. */
export function exitMotionFor(departure: Departure): ExitMotion {
  return departure.to === 'graveyard' || departure.to === 'gone' ? 'crumple' : 'fade';
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
    if (has(player.hand)) return { to: 'hand', playerId: player.id };
  }
  return { to: 'gone', playerId: null };
}

/**
 * The permanents on a battlefield in `prev` that are on none in `next`. A permanent that changed
 * control is still on a battlefield, and stays out of it. Pure, so both screens draw the same
 * departures from the same two views.
 */
export function departuresOf(prev: BoardView | null, next: BoardView): Departure[] {
  if (prev === null) return [];
  const out: Departure[] = [];
  for (const player of prev.players) {
    player.battlefield.forEach((card, index) => {
      const { to, playerId } = destinationIn(next, card.id);
      if (to !== 'battlefield') out.push({ cardId: card.id, playerId: player.id, to, toPlayerId: playerId ?? player.id, card, index });
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

/** Ids, test ids and every hook another lane finds a card by: a stand-in is no card of the board's. */
const STRIPPED = ['id', 'data-board-card', 'data-card-id', 'data-testid', 'data-arrange-card', 'data-selectable', 'tabindex'];

export function installDepartures(canvas: HTMLElement, host: DeparturesHost): DeparturesHandle {
  /** Each battlefield card's element as of the last commit, by id. */
  let drawn = new Map<number, HTMLElement>();
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

  function standIn(from: HTMLElement, at: DOMRect, root: HTMLElement, motion: ExitMotion): HTMLElement {
    const copy = from.cloneNode(true) as HTMLElement;
    for (const el of [copy, ...copy.querySelectorAll<HTMLElement>('*')]) for (const attr of STRIPPED) el.removeAttribute(attr);
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
    wrap.append(copy);
    root.append(wrap);
    return wrap;
  }

  return {
    snapshot() {
      drawn = new Map();
      for (const el of canvas.querySelectorAll<HTMLElement>('[data-zone="battlefield"] [data-board-card]')) {
        const id = Number(el.getAttribute('data-board-card'));
        if (Number.isFinite(id) && !drawn.has(id)) drawn.set(id, el);
      }
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
      const wrap = standIn(from, gap.getBoundingClientRect(), root, motion);
      wrap.setAttribute(DEPARTURE_ATTR, String(departure.cardId));
      standIns.add(wrap);
      schedule(() => wrap.setAttribute('data-exit-go', ''), delayMs);
      schedule(() => {
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
    },
  };
}
