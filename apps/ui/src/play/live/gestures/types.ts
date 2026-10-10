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
  /**
   * Whether an arrival is shown as motion: a played card travels from where it
   * was let go to its place in the row. False (the person's reduced-motion
   * setting) and it is simply there. Read at each arrival. Absent: no motion.
   */
  motion?: () => boolean;
  /**
   * Telemetry: how a played card arrived (`landing`), written to the match's
   * log by the server so the report "it just appeared" is read, not guessed.
   * Absent: nothing is recorded.
   */
  report?: (kind: 'landing', data: Record<string, string | number | boolean>) => void;
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
 * rather than a click — every press-drag on the table and in a prompt, and the
 * drift that cancels the inspector's long-press. Below it the card's own
 * button handles the click.
 */
export const DRAG_SLOP_PX = 6;

/** Whether the pointer has travelled from `press` to `at` far enough to be a drag. */
export function pastSlop(press: Point, at: Point): boolean {
  return Math.hypot(at.x - press.x, at.y - press.y) >= DRAG_SLOP_PX;
}

/**
 * The native `click` a resolved press leaves behind, swallowed once: `arm` it
 * when a press is claimed, `reset` it at the top of every fresh press (a press
 * that never produced a click must not eat an unrelated later one), and hang
 * `swallow` as a CAPTURE-phase click listener, so it runs before React's own
 * delegated handler — and the card's `onClick` — ever sees the click.
 */
export interface ClickLatch {
  arm(): void;
  reset(): void;
  swallow(event: Pick<Event, 'preventDefault' | 'stopPropagation'>): void;
}

export function clickLatch(): ClickLatch {
  let armed = false;
  return {
    arm: () => {
      armed = true;
    },
    reset: () => {
      armed = false;
    },
    swallow: (event) => {
      if (!armed) return;
      armed = false;
      event.preventDefault();
      event.stopPropagation();
    },
  };
}

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
  /**
   * Where the arrow starts, in client coordinates: the source's centre at
   * press time. For a lifted hand card (`lifted`), this doubles as the
   * float-back HOME point — the card slides back to exactly where it was
   * picked up, never to wherever the hand has reflowed to since.
   */
  from: Point;
  /** Where the pointer is, in client coordinates. */
  at: Point;
  target: DropTarget | null;
  /** The pointer has travelled past `DRAG_SLOP_PX`. */
  moved: boolean;
  /**
   * True only when `source` is a card Forge offered that is sitting in the
   * VIEWER'S OWN HAND right now — never a battlefield permanent (a land
   * offered for its mana ability, say), and never a combat, payment or
   * source-less drag. False for every one of those.
   *
   * While true, the card follows the pointer (`./install.ts`'s
   * `onPointerMove` draws it via `./cast.ts`'s `drawCastLift`), and nothing
   * reaches Forge until the gesture ends — `./install.ts`'s `resolveLift` is
   * the one place that happens, reading `./cast.ts`'s `needsTarget` and
   * `overOwnHand`/`overOwnBattlefield` against the release point.
   */
  lifted: boolean;
  /**
   * Always `true` for every kind of drag that is not a lifted hand card,
   * which still ends at its own `pointerup` exactly as before. For a lifted
   * hand card, `false` from the moment a PLAIN CLICK's `pointerup` fires
   * (zero `moved`): a click lifts the card with no button held, the same as
   * a drag, until a LATER press resolves it (`install.ts`'s `onPointerDown`,
   * the check at its very top). `onPointerMove` keeps tracking the card
   * regardless of this flag — it is a plain `window` listener, not gated on
   * any button state.
   */
  held: boolean;
}

/** A box-draw in progress: Arena's marquee over one's own creatures (§B.2). */
export interface MarqueeState {
  press: Point;
  at: Point;
  moved: boolean;
}
