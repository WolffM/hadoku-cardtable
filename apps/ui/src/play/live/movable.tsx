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
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from 'react';

import { usePortraitLayout } from '../portrait.ts';

import './dock.css';

/**
 * Whether the open question offers cards in the viewer's own hand (`LiveBoard.tsx` provides it from
 * Forge's selectables). In portrait the dock then stands on the hand instead of over it (`dock.css`).
 */
export const OffersHandContext = createContext(false);

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

/**
 * The offset nearest `want` that keeps `drawn` (a box at offset zero) on `board` and off every box in `clear`,
 * or `want` itself when it covers none — a pick that offers cards on the board must never be drawn over them,
 * or the player presses the dialog where they meant the card. Tried beside each box to clear, on all four
 * sides, nearest first; when none fits, `want` (the player can still pick in the dialog, and move it).
 */
export function clearOffset(want: { x: number; y: number }, drawn: Box, board: Box, clear: readonly Box[], edge = EDGE_PX): { x: number; y: number } {
  const at = (o: { x: number; y: number }): Box => ({ left: drawn.left + o.x, top: drawn.top + o.y, right: drawn.right + o.x, bottom: drawn.bottom + o.y });
  const covers = (b: Box): boolean => clear.some((c) => b.left < c.right && c.left < b.right && b.top < c.bottom && c.top < b.bottom);
  const onBoard = (b: Box): boolean => b.left >= board.left + edge - 0.5 && b.right <= board.right - edge + 0.5 && b.top >= board.top + edge - 0.5 && b.bottom <= board.bottom - edge + 0.5;
  if (!covers(at(want))) return want;
  const w = drawn.right - drawn.left;
  const h = drawn.bottom - drawn.top;
  const candidates: { x: number; y: number }[] = [];
  for (const c of clear) {
    const x = { left: c.left - edge - w - drawn.left, right: c.right + edge - drawn.left };
    const y = { above: c.top - edge - h - drawn.top, below: c.bottom + edge - drawn.top };
    candidates.push({ x: x.left, y: want.y }, { x: x.right, y: want.y }, { x: want.x, y: y.above }, { x: want.x, y: y.below });
  }
  const fits = candidates.map((o) => clampOffset(o, drawn, board, edge)).filter((o) => onBoard(at(o)) && !covers(at(o)));
  if (fits.length === 0) return want;
  const far = (o: { x: number; y: number }): number => Math.hypot(o.x - want.x, o.y - want.y);
  return fits.reduce((best, o) => (far(o) < far(best) ? o : best));
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

/** Hold a moved frame on the board, as it is drawn now. A frame at its default spot reads nothing: every box read here lays the page out. */
function keepOnBoard(frame: HTMLElement): void {
  if (!frame.hasAttribute(MOVED_ATTR)) return;
  const board = boardOf(frame);
  const drawn = drawnBox(frame);
  if (board === null || drawn === null) return;
  const by = offsetOf(frame);
  setOffset(frame, clampOffset(by, atRest(drawn, by), board.getBoundingClientRect()));
}

/**
 * Open a question at the remembered spot when it fits there; at its default when it does not. False while its
 * sheet has no size yet (a prompt that lays itself out after its first commit), so the caller tries again once
 * it has one: measured empty, every question would fit anywhere.
 */
function openAtSpot(frame: HTMLElement, keepClearOf: readonly number[] = []): boolean {
  // Its default box read where it is drawn now, less its offset: every read before the one write.
  const seen = drawnBox(frame);
  const drawn = seen === null ? null : atRest(seen, offsetOf(frame));
  const spot = drawn === null ? null : readSpot();
  const boardEl = drawn === null ? null : boardOf(frame);
  const board = boardEl?.getBoundingClientRect() ?? null;
  const want = drawn === null || spot === null || board === null ? null : offsetToSpot(spot, drawn, board);
  const clear =
    boardEl === null
      ? []
      : keepClearOf.flatMap((id) => {
          const el = boardEl.querySelector(`[data-board-card="${id}"]`);
          const r = el?.getBoundingClientRect();
          return r === undefined || r.width === 0 ? [] : [{ left: r.left, top: r.top, right: r.right, bottom: r.bottom }];
        });
  setOffset(frame, drawn === null || board === null || clear.length === 0 ? want : clearOffset(want ?? { x: 0, y: 0 }, drawn, board, clear));
  return drawn !== null;
}

/** The top of a question's drawn element as it would stand at its default spot: a moved question leaves the stack where it was. */
export function restingTop(el: Element): number {
  const frame = el.closest<HTMLElement>(QUESTION);
  return el.getBoundingClientRect().top - (frame === null ? 0 : offsetOf(frame).y);
}

/*
 * ── wave 89 §C: the decision dock (Settled 6) ───────────────────────────────────────────────────────
 *
 * In portrait every question's host — `QuestionHost` below, the one mechanism for all fourteen asks, the
 * selection pop-up, the payment window, the bar decision and the waits — stops floating over the board and
 * docks over the hand, above the action bar, instead: `dock.css` repositions `.live__prompt` under
 * `:root[data-layout="portrait"]`, each rule written specific enough to outrank every one of `live.css`'s
 * own `.live__prompt` variants, so nothing here is edited there (the blast-radius table's own rule).
 *
 * `data-mode` (`dock`/`full`/`min`) is the only thing a rule in `dock.css` reads — never which prompt is
 * open (RULES "no hardcoded fixes", Settled 6's own wording). The expand control exists only while the
 * docked sheet is actually clipping something: `hasOverflow` walks the host's own descendants with no
 * prompt-shape knowledge in it at all, so a sheet nobody has imagined yet needs nothing taught to it either.
 *
 * `usePortraitLayout` is lane A's own (`../portrait.ts`) — this file used to carry a second,
 * `MutationObserver`-based copy of the same idea and was told to drop it once A's landed, so this is
 * the one place in the tree that reads the switch besides `Board.tsx` itself.
 */

/** A decision's three sizes (Settled 6): docked over the hand, full for a search that cannot fit docked, or shrunk to a pill. */
export type DockMode = 'dock' | 'full' | 'min';

/** How far a swipe on the dock's handle travels before it changes the mode, in px (the approved prototype's own threshold). */
const SWIPE_SLOP_PX = 30;

/**
 * Whether the docked sheet holds more than it shows: the host itself, or any scroller inside it
 * (`overflow-y: auto | scroll`) with more to scroll to. A generic probe, not a prompt-shape special case:
 * it walks every descendant rather than knowing `.prompt__body` from `.confirm`'s own flat body apart, so
 * the rule that decides "does this one need the expand button" never learns a prompt's method. An
 * element that clips on purpose (`overflow: hidden` — a card tile's own face and caption) is not
 * something more room would reveal, so it never asks for the expand.
 */
function hasOverflow(root: HTMLElement): boolean {
  if (root.scrollHeight > root.clientHeight + 1) return true;
  for (const el of root.querySelectorAll('*')) {
    if (el.scrollHeight > el.clientHeight + 1 && /^(auto|scroll)$/.test(getComputedStyle(el).overflowY)) return true;
  }
  return false;
}

/**
 * The pill's own label: whatever the sheet inside is already saying (its title or its message), read
 * rather than invented — the lane adds no words of its own (RULES "no explanatory UI text").
 */
function dockLabel(root: HTMLElement): string {
  const said = root.querySelector('.prompt__title, .confirm__message');
  const text = said?.textContent?.trim().replace(/\s+/g, ' ');
  return text === undefined || text === '' ? 'Decision' : text;
}

/**
 * The dock's own state: which of the three sizes it is drawn at, and whether its sheet currently overflows
 * the docked height — measured, per Settled 6, with a `ResizeObserver` on the host itself, re-run only
 * while docked (a sheet already grown to `full` or shrunk to `min` is not what the measurement asks about).
 * A fresh host (almost always a fresh mount for a new question — see `QuestionHost`'s own header) starts docked.
 */
function useDock(frameRef: RefObject<HTMLDivElement | null>, active: boolean): { mode: DockMode; overflow: boolean; label: string; setMode: (mode: DockMode) => void } {
  const [mode, setMode] = useState<DockMode>('dock');
  const [overflow, setOverflow] = useState(false);
  const [label, setLabel] = useState('Decision');
  const modeRef = useRef(mode);
  modeRef.current = mode;
  // Whether this host's first measurement has happened yet: a sheet that already overflows the
  // moment it opens (Scapeshift's library search) opens `full` outright, with no visible flash of the
  // docked size first — see `measure` below. A sheet that only grows PAST the docked height later
  // (after the player has already started with it docked) gets the expand control instead: snapping it
  // to full under a finger already mid-pick would be the surprise, not the help.
  const settled = useRef(false);
  useLayoutEffect(() => {
    settled.current = false;
  }, [active]);
  useLayoutEffect(() => {
    // Read fresh here, never from a value captured at render time: the ref is only attached once this
    // render commits, after the function component itself already ran with the previous (or no) node.
    const frame = frameRef.current;
    if (active && mode === 'min' && frame !== null) setLabel(dockLabel(frame));
  }, [active, mode, frameRef]);
  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!active || frame === null) return undefined;
    const measure = (): void => {
      if (modeRef.current !== 'dock') return;
      const over = hasOverflow(frame);
      if (over && !settled.current) {
        settled.current = true;
        setMode('full');
        return;
      }
      settled.current = true;
      setOverflow(over);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const grown = new ResizeObserver(measure);
    const watch = (): void => {
      grown.disconnect();
      grown.observe(frame);
      for (const child of frame.children) grown.observe(child);
    };
    watch();
    // A sheet that mounts after the host (a prompt behind its own boundary) is watched once it is there.
    const added =
      typeof MutationObserver === 'undefined'
        ? null
        : new MutationObserver(() => {
            watch();
            measure();
          });
    added?.observe(frame, { childList: true, subtree: true });
    return () => {
      grown.disconnect();
      added?.disconnect();
    };
  }, [active, frameRef]);
  return { mode, overflow, label, setMode };
}

/**
 * The dock's handle: the strip a swipe moves it by (drawn as nothing), and its own controls — expand (only while `overflow`
 * says the docked sheet is clipping something), shrink back from full, and minimize to a pill. The swipe
 * mirrors the approved prototype exactly: up grows to full (only when that is allowed), down steps the
 * dock down one size at a time (full → dock → min), and the "–" button jumps straight to the pill.
 */
function DockHandle({ mode, overflow, onFull, onDock, onMin }: { mode: DockMode; overflow: boolean; onFull: () => void; onDock: () => void; onMin: () => void }) {
  const from = useRef<{ y: number; id: number } | null>(null);
  // Window-level, like `installDialogMover`'s own drag: a swipe that drifts past the handle's own 40px
  // strip (easy, on a phone) must still end the gesture.
  useEffect(() => {
    const onUp = (event: PointerEvent): void => {
      if (from.current === null || event.pointerId !== from.current.id) return;
      const dy = event.clientY - from.current.y;
      from.current = null;
      if (dy < -SWIPE_SLOP_PX) {
        if (mode === 'full' || overflow) onFull();
      } else if (dy > SWIPE_SLOP_PX) {
        if (mode === 'full') onDock();
        else onMin();
      }
    };
    const onCancel = (): void => {
      from.current = null;
    };
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    return () => {
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
    };
  }, [mode, overflow, onFull, onDock, onMin]);
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.target instanceof Element && event.target.closest('button') !== null) return;
    from.current = { y: event.clientY, id: event.pointerId };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // jsdom (unit tests) and a pointer the browser no longer tracks both lack this — the window
      // listener above still gets the `pointerup` either way.
    }
  };
  return (
    <div className="dock__handle" data-testid="decision-dock-handle" onPointerDown={onPointerDown}>
      <span className="dock__controls">
        {mode === 'dock' && overflow && (
          <button type="button" className="dock__ctl" data-testid="decision-expand" aria-label="Expand" onClick={onFull} />
        )}
        {mode === 'full' && <button type="button" className="dock__ctl dock__ctl-shrink" aria-label="Shrink" onClick={onDock} />}
        <button type="button" className="dock__ctl dock__ctl-min" data-testid="decision-minimize" aria-label="Minimize" onClick={onMin} />
      </span>
    </div>
  );
}

/**
 * A question's host, in the question column: `live.css`'s `.live__prompt`. On a desktop or landscape table
 * it opens at the remembered spot, and holds itself on the board as its sheet grows. `spot="staged"` (the
 * pop-up under a card staged for its target) opens at its default whatever is remembered, since it belongs
 * under that card; the host opens afresh whenever `spot` changes.
 *
 * In portrait (Settled 6) it docks instead — see the module section above — and the remembered-spot
 * mechanism does not apply at all: a dock has one place, not a habit to remember.
 */
export function QuestionHost({
  spot,
  keepClearOf,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { spot?: string; keepClearOf?: readonly number[]; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const clearKey = keepClearOf === undefined ? '' : [...keepClearOf].sort((a, b) => a - b).join(',');
  const portrait = usePortraitLayout();
  useLayoutEffect(() => {
    const frame = ref.current;
    if (frame === null || portrait) return undefined;
    if (spot === 'staged') {
      setOffset(frame, null);
      return undefined;
    }
    const clear = clearKey === '' ? [] : clearKey.split(',').map(Number);
    let opened = openAtSpot(frame, clear);
    if (typeof ResizeObserver === 'undefined') return undefined;
    const grown = new ResizeObserver(() => {
      if (opened) keepOnBoard(frame);
      else opened = openAtSpot(frame, clear);
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
  }, [spot, clearKey, portrait]);
  const { mode, overflow, label, setMode } = useDock(ref, portrait);
  const offersHand = useContext(OffersHandContext);
  if (!portrait) {
    return (
      <div ref={ref} className="live__prompt" {...rest}>
        {children}
      </div>
    );
  }
  // The empty-stack pass / an unforced resolve (`data-pass` — `LiveBoard.tsx`'s own `route === 'pass'`,
  // already read the same way by `../inspect/index.ts`'s placement rule): the prototype's own
  // `primaryAction` never makes a decision object for it either, and B's `action-primary` already
  // mirrors this exact OK with the same press. Nothing here would say anything the action bar does
  // not already say, so nothing here docks.
  if ((rest as Record<string, unknown>)['data-pass'] === true) return null;
  return (
    // The wrapper carries the Test-ID contract's own identity (`decision-dock`, `data-mode`); the host
    // inside keeps the testid its OWN caller gave it, unchanged — `pick-drawn` (`LiveBoard.tsx`) and
    // every existing reader of `live-decision-host`/`live-selection-host`/… still finds it. Only this
    // wrapper is portrait-only: the desktop return above never grows one.
    <div
      className="dock"
      data-testid="decision-dock"
      data-mode={mode}
      data-clear={offersHand ? 'hand' : undefined}
      // How many controls stand on the sheet's first row (`dock.css` keeps that row clear of them).
      style={{ '--dock-ctl-n': 1 + (mode === 'full' || (mode === 'dock' && overflow) ? 1 : 0) } as CSSProperties}
    >
      <div ref={ref} className="live__prompt" {...rest}>
        {mode !== 'min' && (
          <DockHandle mode={mode} overflow={overflow} onFull={() => setMode('full')} onDock={() => setMode('dock')} onMin={() => setMode('min')} />
        )}
        {children}
        {mode === 'min' && (
          <button type="button" className="dock__pill" data-testid="decision-pill" onClick={() => setMode('dock')}>
            <span>{label}</span>
          </button>
        )}
      </div>
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
    // In portrait a question's host docks (Settled 6); its own handle swipes it between sizes, and a
    // free drag would only fight that. A pile's view and the deck list still drag — portrait has no
    // other place for either of them yet.
    if (frame.matches(QUESTION) && document.documentElement.dataset.layout === 'portrait') return;
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
