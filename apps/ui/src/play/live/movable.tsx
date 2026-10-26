/*
 * Dialogs the player can move — the operator, 2026-10-25: *"can we actually make all dialogs movable? within
 * reason"*, and *"ideally we remember where the user last moved the dialog and try to appear new dialogs there;
 * if the dialog needs extra space then we give it the default location"*.
 *
 * One mechanism for every floating dialog over the board: the question column's hosts (`.live__prompt`: every
 * ask, yes/no, decision, payment and waiting pop-up), an opened pile (`../PileView.tsx`) and the deck list
 * (`./own-deck.tsx`). Not the control box, the phase rail, the inspector or the settings popout: those have a
 * home the table is laid out around.
 *
 *   - **A press on the body or the header moves it**, once it has travelled `MOVE_SLOP_PX` — under that it is
 *     still a click. A press on anything that answers a press of its own (`OWN_PRESS`: a button, a field, a
 *     card, an ordering list's row) is left to it. One listener on the match's root, so a dialog needs no
 *     wiring of its own to be moved.
 *   - **It moves by `translate`**, never by `left`/`top` or a box of its own: the frame is out of flow already,
 *     and a transform moves nothing else on the table. The frame is what moves (a host, not just its sheet), so
 *     what measures the frame — the inspector standing beside an open window (`../inspect/index.ts`) — follows.
 *   - **It stays on the board**: its drawn box is held inside the match's own (`.live`) while it is dragged,
 *     when the window resizes and when the board does.
 *   - **One spot is remembered**: the place the player last put a question, as a fraction of the board, in this
 *     browser (`SPOT_KEY`). Each question opens there if its drawn box fits there inside the board, and at its
 *     own default spot if it does not. A fresh match starts from it too: the spot is the player's habit, not the
 *     match's. An opened pile and the deck list are moved the same way, but they open beside what they show (a
 *     pile's view is sized to the room beside the pile), so they neither read the spot nor write it.
 */
import { useLayoutEffect, useRef, type HTMLAttributes, type ReactNode } from 'react';

/** The one place a question was last put: the top-left of its drawn box, as fractions of the board's width and height. */
export interface DialogSpot {
  readonly x: number;
  readonly y: number;
}

export const SPOT_KEY = 'cardtable:dialog-spot';

/** How far a press travels before it is a move rather than a click, in px. */
export const MOVE_SLOP_PX = 4;

/** The gap a moved dialog keeps from the board's edge, in px. */
const EDGE_PX = 4;

/** A question's host: what opens at the remembered spot and writes it. */
const QUESTION = '.live__prompt';

/** Every frame a press can move. */
export const MOVABLE_DIALOG = `${QUESTION}, [data-testid="pile-view"], #own-deck`;

/** What answers a press of its own inside a dialog, so a press there is never a move. */
const OWN_PRESS =
  'button, input, select, textarea, a, label, summary, [role="button"], [role="checkbox"], [role="radio"], [role="slider"], [role="option"], [data-card-id], [data-board-card], [data-dragging], [draggable="true"]';

/** Set on a frame while it stands anywhere but its default spot. */
const MOVED_ATTR = 'data-moved';

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The remembered spot, or null: none yet, or storage that throws or holds something else. */
export function readSpot(storage: Pick<Storage, 'getItem'> | null = safeStorage()): DialogSpot | null {
  try {
    const raw = storage?.getItem(SPOT_KEY);
    if (raw == null) return null;
    const spot = JSON.parse(raw) as Partial<DialogSpot>;
    const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
    return ok(spot.x) && ok(spot.y) ? { x: spot.x, y: spot.y } : null;
  } catch {
    return null;
  }
}

/** Remember `spot`. Storage that throws (a private window, a full quota) keeps nothing, and the move still stands. */
export function writeSpot(spot: DialogSpot, storage: Pick<Storage, 'setItem'> | null = safeStorage()): boolean {
  try {
    storage?.setItem(SPOT_KEY, JSON.stringify(spot));
    return storage !== null;
  } catch {
    return false;
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/**
 * The offset that keeps `drawn` (a box at offset zero) inside `board`, nearest to `want`. A box wider or taller
 * than the board keeps its top-left corner on the board.
 */
export function clampOffset(want: { x: number; y: number }, drawn: Box, board: Box, edge = EDGE_PX): { x: number; y: number } {
  const axis = (d: number, lo: number, hi: number, boardLo: number, boardHi: number): number => {
    const min = boardLo + edge - lo;
    const max = boardHi - edge - hi;
    return max < min ? min : Math.min(max, Math.max(min, d));
  };
  return { x: axis(want.x, drawn.left, drawn.right, board.left, board.right), y: axis(want.y, drawn.top, drawn.bottom, board.top, board.bottom) };
}

/**
 * The offset that puts `drawn` (a box at offset zero) at `spot` on `board`, or null when it does not fit there
 * whole: it needs more room than that spot allows, so it stays at its own default.
 */
export function offsetToSpot(spot: DialogSpot, drawn: Box, board: Box, edge = EDGE_PX): { x: number; y: number } | null {
  const left = board.left + spot.x * (board.right - board.left);
  const top = board.top + spot.y * (board.bottom - board.top);
  const fits = left + (drawn.right - drawn.left) <= board.right - edge + 0.5 && top + (drawn.bottom - drawn.top) <= board.bottom - edge + 0.5;
  return fits ? { x: left - drawn.left, y: top - drawn.top } : null;
}

/** The spot a box drawn at `drawn` stands at on `board`. */
export function spotOf(drawn: Box, board: Box): DialogSpot {
  const frac = (n: number) => Math.min(1, Math.max(0, n));
  return { x: frac((drawn.left - board.left) / (board.right - board.left)), y: frac((drawn.top - board.top) / (board.bottom - board.top)) };
}

/** The frame's current offset: what `translate` holds, in px. */
function offsetOf(frame: HTMLElement): { x: number; y: number } {
  const [x = '0', y = '0'] = frame.style.translate.split(/\s+/);
  return { x: Number.parseFloat(x) || 0, y: Number.parseFloat(y) || 0 };
}

function setOffset(frame: HTMLElement, at: { x: number; y: number } | null): void {
  if (at === null || (Math.abs(at.x) < 0.5 && Math.abs(at.y) < 0.5)) {
    frame.style.removeProperty('translate');
    frame.removeAttribute(MOVED_ATTR);
    return;
  }
  frame.style.translate = `${Math.round(at.x)}px ${Math.round(at.y)}px`;
  frame.setAttribute(MOVED_ATTR, '');
}

/**
 * What the player sees of a frame, in client px: a question's host is a pointer-transparent column around its
 * sheet, so the box that is drawn is its children's; any other frame is its own box.
 */
function drawnBox(frame: HTMLElement): Box | null {
  const parts = frame.matches(QUESTION) ? Array.from(frame.children, (c) => c.getBoundingClientRect()) : [frame.getBoundingClientRect()];
  const seen = parts.filter((r) => r.width > 0 && r.height > 0);
  if (seen.length === 0) return null;
  return {
    left: Math.min(...seen.map((r) => r.left)),
    top: Math.min(...seen.map((r) => r.top)),
    right: Math.max(...seen.map((r) => r.right)),
    bottom: Math.max(...seen.map((r) => r.bottom)),
  };
}

/** `box` with the frame's current offset taken out: where it would be drawn at its default spot. */
function atRest(box: Box, by: { x: number; y: number }): Box {
  return { left: box.left - by.x, top: box.top - by.y, right: box.right - by.x, bottom: box.bottom - by.y };
}

function boardOf(frame: Element): HTMLElement | null {
  return frame.closest<HTMLElement>('.live');
}

/** Hold a moved frame on the board, as it is drawn now. */
function keepOnBoard(frame: HTMLElement): void {
  const board = boardOf(frame);
  const drawn = drawnBox(frame);
  if (board === null || drawn === null || !frame.hasAttribute(MOVED_ATTR)) return;
  const by = offsetOf(frame);
  setOffset(frame, clampOffset(by, atRest(drawn, by), board.getBoundingClientRect()));
}

/**
 * Open a question at the remembered spot when it fits there; at its default when it does not. False while its
 * sheet has no size yet (a prompt that lays itself out after its first commit), so the caller tries again once
 * it has one: measured empty, every question would fit anywhere.
 */
function openAtSpot(frame: HTMLElement): boolean {
  setOffset(frame, null);
  const drawn = drawnBox(frame);
  if (drawn === null) return false;
  const spot = readSpot();
  const board = boardOf(frame);
  if (spot !== null && board !== null) setOffset(frame, offsetToSpot(spot, drawn, board.getBoundingClientRect()));
  return true;
}

/** The top of a question's drawn element as it would stand at its default spot: a moved question leaves the stack where it was. */
export function restingTop(el: Element): number {
  const frame = el.closest<HTMLElement>(QUESTION);
  return el.getBoundingClientRect().top - (frame === null ? 0 : offsetOf(frame).y);
}

/**
 * A question's host, in the question column: `live.css`'s `.live__prompt`. It opens at the remembered spot,
 * and holds itself on the board as its sheet grows. `spot="staged"` (the pop-up under a card staged for its
 * target) opens at its default whatever is remembered, since it belongs under that card; the host opens
 * afresh whenever `spot` changes.
 */
export function QuestionHost({ spot, children, ...rest }: HTMLAttributes<HTMLDivElement> & { spot?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const frame = ref.current;
    if (frame === null) return undefined;
    if (spot === 'staged') {
      setOffset(frame, null);
      return undefined;
    }
    let opened = openAtSpot(frame);
    if (typeof ResizeObserver === 'undefined') return undefined;
    const grown = new ResizeObserver(() => {
      if (opened) keepOnBoard(frame);
      else opened = openAtSpot(frame);
    });
    const watch = (): void => {
      for (const child of frame.children) grown.observe(child);
    };
    watch();
    // A sheet that mounts after the host (a prompt behind its own boundary) is watched once it is there.
    const added = new MutationObserver(watch);
    added.observe(frame, { childList: true });
    return () => {
      grown.disconnect();
      added.disconnect();
    };
  }, [spot]);
  return (
    <div ref={ref} className="live__prompt" {...rest}>
      {children}
    </div>
  );
}

/**
 * Let the player move every dialog drawn inside `root` (the match's `.live`). Returns the uninstall.
 */
export function installDialogMover(root: HTMLElement): () => void {
  let press: { frame: HTMLElement; id: number; from: { x: number; y: number }; by: { x: number; y: number }; rest: Box; moved: boolean } | null = null;

  const onDown = (event: PointerEvent): void => {
    if (event.button !== 0 || event.defaultPrevented || !(event.target instanceof Element)) return;
    const frame = event.target.closest<HTMLElement>(MOVABLE_DIALOG);
    if (frame === null || !root.contains(frame)) return;
    const own = event.target.closest(OWN_PRESS);
    if (own !== null && frame.contains(own)) return;
    // A press on a scrollbar scrolls.
    const t = event.target;
    if (t instanceof HTMLElement && t.clientWidth > 0 && event.offsetX > t.clientWidth) return;
    const drawn = drawnBox(frame);
    if (drawn === null) return;
    const by = offsetOf(frame);
    press = { frame, id: event.pointerId, from: { x: event.clientX, y: event.clientY }, by, rest: atRest(drawn, by), moved: false };
  };

  const onMove = (event: PointerEvent): void => {
    if (press === null || event.pointerId !== press.id) return;
    const dx = event.clientX - press.from.x;
    const dy = event.clientY - press.from.y;
    if (!press.moved) {
      if (Math.hypot(dx, dy) < MOVE_SLOP_PX) return;
      press.moved = true;
      press.frame.setAttribute('data-moving', '');
      // A move is not a text selection: what the press began selecting is let go (`live.css` holds it off from here).
      window.getSelection()?.removeAllRanges();
      try {
        press.frame.setPointerCapture(event.pointerId);
      } catch {
        // A pointer the browser no longer tracks: the window listeners still follow it.
      }
    }
    event.preventDefault();
    setOffset(press.frame, clampOffset({ x: press.by.x + dx, y: press.by.y + dy }, press.rest, root.getBoundingClientRect()));
  };

  const onUp = (event: PointerEvent): void => {
    if (press === null || event.pointerId !== press.id) return;
    const { frame, moved } = press;
    press = null;
    frame.removeAttribute('data-moving');
    if (!moved) return;
    const drawn = drawnBox(frame);
    if (frame.matches(QUESTION) && drawn !== null) writeSpot(spotOf(drawn, root.getBoundingClientRect()));
  };

  // A press on text already selected would start the browser's own drag of it, which cancels the pointer.
  const onDragStart = (event: DragEvent): void => {
    if (press !== null) event.preventDefault();
  };

  const reclamp = (): void => {
    for (const frame of root.querySelectorAll<HTMLElement>(`[${MOVED_ATTR}]`)) keepOnBoard(frame);
  };

  root.addEventListener('pointerdown', onDown);
  root.addEventListener('dragstart', onDragStart);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
  const resized = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(reclamp);
  resized?.observe(root);
  return () => {
    root.removeEventListener('pointerdown', onDown);
    root.removeEventListener('dragstart', onDragStart);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    resized?.disconnect();
  };
}
