/*
 * The board's own press-drag lift, reused by every prompt that rearranges
 * rows by dragging them — `ManipulateCardListPrompt.tsx`'s one pile with two
 * ends, and `OrderPrompt.tsx`'s two lists.
 *
 * The operator, 2026-10-08: *"dragging cards for scrying is
 * a bit inconsistent. can we us the same phantom card and placement logic we
 * use for putting cards on the board?"* Both prompts used native HTML5
 * `draggable`/`onDrag*` — the browser's own ghost, no slop, nothing like the
 * board's lift. This file is the ONE gesture both now use instead, built
 * directly on `../live/gestures/cast.ts`'s exported, framework-free
 * functions — `drawCastLift`, `clearCastLift`, `floatCastLiftHome` — the
 * same three calls `../live/gestures/install.ts` makes for a lifted hand
 * card, called here rather than copied. None of the three takes a
 * `LiveMatch`; all they need is a root, a numeric id, and a point, which is
 * exactly what a prompt has.
 *
 * ## Every row needs a NUMBER, even one that is not a card
 *
 * `cardBox`/`drawCastLift` find an element by `data-board-card`/`data-card-id`
 * — a card's real Forge id. `OrderPrompt.tsx` also orders rows that are NOT
 * cards (Forge's own "order simultaneous triggers", words, no art, no id):
 * those still need to lift, so each caller hands every row a numeric "lift
 * id" — a real card's own id where there is one, and a small per-mount
 * NEGATIVE number where there is not (Forge's own ids are never negative, so
 * a synthetic one can never collide with a real board card's, wherever in the
 * document `cardBox`'s `document`-wide query happens to land first). The lift
 * itself does not care which kind of number it was handed.
 *
 * ## What this file does NOT decide
 *
 * Nothing here knows what a drop zone is, what "before" means in a caller's
 * own list, or what state changes. `usePressDragLift` calls back with the
 * release's own `event.target` and the id that was lifted; the caller hit-
 * tests it with its OWN selectors (`rowIdUnder`/`testIdUnder` below are the
 * two small, shared pieces of that hit-test — `closest`, not coordinate math,
 * exactly as `install.ts`'s own release does it) and returns whether it
 * changed anything. `true` ends the lift at once (the row's new position is
 * wherever the caller's own re-render puts it); `false`/`undefined` floats
 * the row back to the box it was lifted from — `install.ts`'s own "released
 * nowhere this gesture answers" ending, via `floatCastLiftHome`.
 *
 * ## The click a resolved drag leaves behind
 *
 * A press that never passes `DRAG_SLOP_PX` is left to the plain click the
 * row's own checkbox/button already answers — nothing here claims it. A
 * press that DOES become a drag still leaves a native `click` behind it in a
 * real browser once the pointer goes up; the board's own `clickLatch`
 * (`../live/gestures/types.ts`) is reused here, one per hook instance: `onListClickCapture`, wired to the
 * list's own `onClickCapture`, swallows exactly that one click.
 */

import { useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';

import { battlefieldCardWidth, sizeAsBattlefieldCard } from '../card-size.ts';
import { clearCastLift, drawCastLift, floatCastLiftHome } from '../live/gestures/cast.ts';
import { cardBox } from '../live/gestures/targets.ts';
import { clickLatch, pastSlop, type Point } from '../live/gestures/types.ts';
import { documentScope, eventTarget } from '../../dom.ts';

/**
 * The nearest ROW's own lift id under a point in the gesture — never a stale
 * index. `li` only: `CardTile` stamps its own `data-card-id` (the draft's
 * `w<id>` namespace) on the `.card` element INSIDE a row, and a bare
 * `[data-card-id]` selector would match that one first and never reach the
 * row it is in.
 */
export function rowIdUnder(target: EventTarget | null): number | null {
  const li = target instanceof Element ? target.closest<HTMLElement>('li[data-card-id]') : null;
  const raw = li?.getAttribute('data-card-id') ?? null;
  return raw === null ? null : Number(raw);
}

/** Which of the given testids, if any, a point in the gesture is over (an ancestor counts — the list itself, not only a row). */
export function testIdUnder(target: EventTarget | null, testids: readonly string[]): string | null {
  if (!(target instanceof Element)) return null;
  const selector = testids.map((t) => `[data-testid="${t}"]`).join(', ');
  return target.closest<HTMLElement>(selector)?.getAttribute('data-testid') ?? null;
}

export interface PressDragLift {
  /** The row currently followed by the lift, or null — for a `data-dragging`-style cue. */
  liftedId: number | null;
  /** Attach to a row's own element: starts the lift when the press is button 0, off any button inside the row, and `canLift(id)`. */
  onRowPointerDown: (id: number) => (event: ReactPointerEvent<HTMLElement>) => void;
  /** Attach to the list's own `onClickCapture`: swallows the native click a resolved drag leaves behind. */
  onListClickCapture: (event: ReactMouseEvent) => void;
}

export interface PressDragLiftOptions {
  /** Whether this row may be lifted at all. */
  canLift: (id: number) => boolean;
  /** Called on every move once the lift is under way (past the slop) — a caller's own "which zone is this over" highlight, if it wants one. */
  onMove?: (id: number, target: EventTarget | null) => void;
  /** The release. Return `true` if the drop changed something; `false`/`undefined` floats the row home. */
  onDrop: (id: number, target: EventTarget | null) => boolean | void;
}

/** The board's press-drag lift, as a hook any prompt list can wire a row to. See the module header. */
export function usePressDragLift(opts: PressDragLiftOptions): PressDragLift {
  const [liftedId, setLiftedId] = useState<number | null>(null);
  /**
   * `scope` is the prompt the row sits in: a card the prompt shows can ALSO be drawn on the board at
   * the same id (a library's top card under Courser of Kruphix, looked at by a scry), and the lift
   * must take the prompt's row, never the board's copy a document-wide lookup finds first.
   */
  const liftRef = useRef<{ id: number; press: Point; home: Point; moved: boolean; scope: ParentNode } | null>(null);
  const [clicks] = useState(clickLatch);

  const removeLiftListeners = (): void => {
    window.removeEventListener('pointermove', onLiftMove);
    window.removeEventListener('pointerup', onLiftUp);
  };

  function onLiftMove(event: PointerEvent): void {
    const state = liftRef.current;
    if (state === null) return;
    const at = { x: event.clientX, y: event.clientY };
    if (!state.moved) {
      if (!pastSlop(state.press, at)) return;
      state.moved = true;
      clicks.arm();
      setLiftedId(state.id);
    }
    drawCastLift(state.scope, state.id, at, 'lifted');
    // Board-sized from the board itself, which the prompt's own scope does not hold.
    const row = cardBox(state.scope, state.id);
    if (row instanceof HTMLElement) sizeAsBattlefieldCard(row, battlefieldCardWidth(documentScope(), 'you'));
    opts.onMove?.(state.id, eventTarget(event));
  }

  function onLiftUp(event: PointerEvent): void {
    const state = liftRef.current;
    liftRef.current = null;
    removeLiftListeners();
    if (state === null) return;
    if (!state.moved) return; // a plain press: whatever click it leaves behind answers as it always has
    const handled = opts.onDrop(state.id, eventTarget(event)) ?? false;
    if (handled) {
      clearCastLift(state.scope, state.id);
      setLiftedId(null);
      return;
    }
    // Released nowhere this gesture answers: the house glide back to where it was picked up.
    floatCastLiftHome(state.scope, state.id, state.home, () => setLiftedId(null));
  }

  const onRowPointerDown = (id: number) => (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || !opts.canLift(id)) return;
    if (event.target instanceof Element && event.target.closest('button') !== null) return;
    // Reset at the top of every FRESH press — the same safety net `install.ts` keeps,
    // in case a prior gesture's resolved click never reached `onListClickCapture`.
    clicks.reset();
    const box = event.currentTarget.getBoundingClientRect();
    liftRef.current = {
      id,
      press: { x: event.clientX, y: event.clientY },
      home: { x: box.left + box.width / 2, y: box.top + box.height / 2 },
      moved: false,
      scope: event.currentTarget.closest('[data-testid="live-prompt"]') ?? documentScope(),
    };
    window.addEventListener('pointermove', onLiftMove);
    window.addEventListener('pointerup', onLiftUp);
  };

  return { liftedId, onRowPointerDown, onListClickCapture: clicks.swallow };
}
