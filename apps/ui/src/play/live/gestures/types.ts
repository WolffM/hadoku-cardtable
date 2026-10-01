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
}

/** A box-draw in progress: Arena's marquee over one's own creatures (§B.2). */
export interface MarqueeState {
  press: Point;
  at: Point;
  moved: boolean;
}
