/*
 * The gesture layer's types. THE SEAM's vocabulary — `./index.ts` re-exports
 * the two interfaces lane C names, and nothing else in this directory is
 * public.
 */
import type { LiveMatch } from '../match.ts';

export interface GestureOptions {
  /** The match's root element — the canvas. All pointer handling is delegated here. */
  canvas: HTMLElement;
  match: LiveMatch;
  /** Called when the gesture layer's own visible state changed. Optional. */
  onChange?: () => void;
}

export interface GestureHandle {
  dispose(): void;
}

/** What the pointer is over, when Forge has offered it. `stack` is a spell on the stack an open ask names (Q7). */
export type DropTarget = { kind: 'card'; id: number } | { kind: 'player'; id: number } | { kind: 'stack'; id: number };

/** A point in CLIENT coordinates. Every gesture measures in these and converts once, at the draw. */
export interface Point {
  x: number;
  y: number;
}

/**
 * How far the pointer must travel before a press is a DRAG (or a box-draw)
 * rather than a click. Below it the card's own button handles the click,
 * exactly as before.
 */
export const DRAG_SLOP_PX = 6;

export interface DragState {
  /** The card the gesture started on. Null: a pointing gesture inside a selection. */
  source: number | null;
  /**
   * Where the pointer went down, in client coordinates. The slop is measured
   * from HERE and not from `from`: a press near a card's edge is already
   * several pixels from its centre, and measuring from the centre would call
   * that press a drag before the pointer had moved at all.
   */
  press: Point;
  /** Where the arrow starts, in client coordinates: the source's centre. */
  from: Point;
  /** Where the pointer is, in client coordinates. */
  at: Point;
  target: DropTarget | null;
  /** The pointer has travelled past `DRAG_SLOP_PX`. */
  moved: boolean;
  /**
   * Arena casting (R7): set only when `source` is a card Forge offered that is
   * sitting in the VIEWER'S OWN HAND right now — never a battlefield permanent
   * (a land offered for its mana ability, say), and never a combat, payment or
   * source-less drag. `null` for every one of those; unchanged otherwise.
   *
   * `'lifted'` from the press (even before the slop — a plain click lifts it
   * too, see `install.ts`'s header) until the pointer first crosses into
   * `[data-zone="battlefield"][data-owner="you"]`; `'settled'` from that frame
   * on. `./install.ts`'s `paint()` reads this to decide whether to draw the
   * card following the pointer (`lifted`) or pin it at `stagedAt` and let only
   * the targeter arrow move (`settled`) — the operator's own words for the
   * Arena model.
   */
  stage: 'lifted' | 'settled' | null;
  /**
   * Where the card settled, in client coordinates — null until `stage` becomes
   * `'settled'`, then fixed for the rest of this gesture. The arrow's tail
   * once settled; the ghost's pinned position either way.
   */
  stagedAt: Point | null;
  /**
   * Arena casting (R7) only — `false` for every other kind of drag. True from
   * the instant `stage` becomes `'settled'`: THAT is when `selectCard(source)`
   * is sent (`install.ts`'s `onPointerMove`), not at release — the operator's
   * ruling casts at the settle, and the round trip to whatever target ask
   * Forge opens next happens WHILE the gesture is still held. Once true, the
   * gesture's own `source` must never be sent again; `./commit.ts`'s
   * `commitDrag` is still how a release answers a target ask that arrived in
   * the meantime, called with `source: null` so it only ever sends the target.
   */
  cast: boolean;
  /**
   * Arena casting (R7) only — always `true` for every other kind of drag,
   * which still ends at its own `pointerup` exactly as before. For an Arena
   * cast, `false` from the moment a PLAIN CLICK's `pointerup` fires (zero
   * `moved`): the operator's ruling is that clicking "make[s] the card follow
   * your mouse" with no button held, same as a drag, until a LATER press
   * resolves it (`install.ts`'s `onPointerDown`, the check at its very top).
   * `onPointerMove` keeps tracking and settling regardless of this flag — it
   * is a plain `window` listener, not gated on any button state.
   */
  held: boolean;
}

/** A box-draw in progress: Arena's marquee over one's own creatures (§B.2). */
export interface MarqueeState {
  press: Point;
  at: Point;
  moved: boolean;
}
