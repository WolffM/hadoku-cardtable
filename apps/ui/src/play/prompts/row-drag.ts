/*
 * The drag of every prompt that moves cards between zones or orders them —
 * `MovePrompt.tsx` (a library order, a scry, a dig, an order of triggers) —
 * and it is the board's drag: the
 * operator, 2026-10-12, *"dragging should work just like it does with cards on
 * board or cards in hand … it should behave well for any decision windows that
 * ask me to place something in order like this."*
 *
 * What the board does, and so what this does (`../lift.ts` holds the shared
 * pieces):
 *
 *  - the press selects nothing — it is cancelled, as `Board.tsx`'s own
 *    `useArrangeDrag` cancels its press, and the prompt is `user-select: none`
 *    for the length of the drag;
 *  - past `DRAG_SLOP_PX`, the row stays where it is, dimmed (`data-dragging`),
 *    and its phantom (`liftGhost`) follows the pointer from the spot it was
 *    grabbed at. The phantom is fixed, outside the prompt's scroll box, so it
 *    never grows that box: the in-place lift this replaced moved the row ITSELF
 *    by `left`/`top`, and `.prompt__cards > li { position: relative }` outranked
 *    the lift's `position: fixed`, so the row was pushed by the pointer's whole
 *    page offset inside the 190px body — scrollbars both ways, the card far off
 *    under neither the pointer nor the eye (`e2e/order-drag.spec.ts`, run
 *    38342922179: scroll 756×443 in a 190×195 body);
 *  - nothing else moves while the drag is under way; a bar shows where the card
 *    will land (the board's `[data-arrange-indicator]`), worked out from where the
 *    pointer is among the rows — not only from which row it is over;
 *  - carried to the top or bottom of the box the rows scroll in, the box scrolls,
 *    so a card can be carried to a row the box does not show yet — never toward
 *    an edge the card is being carried away from; and a row the pointer comes
 *    over with its top scrolled out of sight has its top scrolled back, so the
 *    half of it that means "before it" can always be pointed at;
 *  - on release the rows that moved slide into their new places (`flip`, the
 *    hand's slide), the dropped one from where it was let go; a release that
 *    changes nothing glides the phantom back to its row.
 *
 * The caller names its drop targets by test id. A `rows` target is a list whose
 * order is the answer: a drop lands between two of its rows. A target that is
 * not (`rows: false` — a list whose order is not the answer) takes the
 * drop as a whole, and the caller highlights it off `over`.
 *
 * Rows carry their id on `li[data-card-id]`: a card's own Forge id, or any
 * number the caller hands a row that is not a card (`MovePrompt.tsx`'s words).
 *
 * A list is read down its column, or across when it is marked `ACROSS_ATTR`
 * (`MovePrompt.tsx`'s rows of cards): there a drop lands before the first row
 * the pointer is short of the middle of, however few rows it has. Down a
 * column a row is pointed at by the part of it that shows — its own top down to
 * the top of the row drawn below it — and a drop lands in the half of that
 * strip it is let go in.
 */

import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

import { centreOf, flip, liftGhost, pinFixed, type At, type Ghost } from '../lift.ts';
import { GLIDE_MS, prefersReducedMotion } from '../motion.ts';
import { clickLatch, pastSlop } from '../live/gestures/types.ts';
import { eventTarget, hitAt, scopeOf } from '../../dom.ts';

export interface DropTargetSpec {
  testid: string;
  /** True when the order of its rows is the answer, so a drop lands between two of them. */
  rows: boolean;
}

/** Where a release lands: a target, and in a `rows` target the row it goes before (`null`: the end). */
export interface Slot {
  testid: string;
  before: number | null;
}

export interface RowDragOptions {
  targets: readonly DropTargetSpec[];
  /** Whether this row may be picked up at all. */
  canLift: (id: number) => boolean;
  /** The release over a slot. Return `true` if it changed something; `false` glides the phantom home. */
  onDrop: (id: number, slot: Slot) => boolean;
}

export interface RowDrag {
  /** The row being dragged, for its `data-dragging`. */
  liftedId: number | null;
  /** The target the pointer is over while a row is dragged, for a target that highlights as a whole. */
  over: string | null;
  /** Attach to a row's own element. */
  onRowPointerDown: (id: number) => (event: ReactPointerEvent<HTMLElement>) => void;
}

/** Set on the prompt while a row is dragged: `prompts.css` turns off text selection and shows the grab. */
const ROW_DRAG_ATTR = 'data-row-drag';
/** Set on a list laid out left to right: a drop lands between two rows by where the pointer is across them. */
export const ACROSS_ATTR = 'data-across';
/** The bar's thickness, px. */
const BAR = 3;
/** How near the scroll box's top or bottom the pointer scrolls it, px, and the fastest it scrolls, px a frame. */
const EDGE = 28;
const EDGE_SPEED = 12;

/** The nearest ancestor of `el` that scrolls vertically and has something to scroll. */
function scrollerOf(el: HTMLElement): HTMLElement | null {
  for (let a = el.parentElement; a !== null; a = a.parentElement) {
    const y = getComputedStyle(a).overflowY;
    if ((y === 'auto' || y === 'scroll') && a.scrollHeight > a.clientHeight) return a;
  }
  return null;
}

/**
 * How far to scroll `box` this frame for a pointer at `y`, pressed at `from`: toward whichever edge
 * it holds near, faster the nearer — and only an edge the pointer has been carried toward. A card
 * grabbed near the bottom and carried up is going up: the box holds still under it, rather than
 * scrolling the row it is aimed at up out of reach (a scry's "above the first card", measured
 * landing after it when the press sat in the bottom band).
 */
function edgeSpeed(box: DOMRect, y: number, from: number): number {
  if (y < box.top + EDGE && y < from) return -Math.ceil((EDGE_SPEED * (box.top + EDGE - y)) / EDGE);
  if (y > box.bottom - EDGE && y > from) return Math.ceil((EDGE_SPEED * (y - (box.bottom - EDGE))) / EDGE);
  return 0;
}

const rowsOf = (list: Element): HTMLElement[] => [...list.querySelectorAll<HTMLElement>(':scope > li[data-card-id]')];
const idOf = (li: Element): number => Number(li.getAttribute('data-card-id'));
const inside = (r: DOMRect, at: At): boolean => at.x >= r.left && at.x <= r.right && at.y >= r.top && at.y <= r.bottom;

/** The target under the pointer: the one the element under it is in, or else the one whose box holds the point. */
function targetAt(root: ParentNode, targets: readonly DropTargetSpec[], at: At, hit: EventTarget | null): { spec: DropTargetSpec; el: HTMLElement } | null {
  const found = targets.flatMap((spec) => {
    const el = root.querySelector<HTMLElement>(`[data-testid="${spec.testid}"]`);
    return el === null ? [] : [{ spec, el }];
  });
  return found.find(({ el }) => hit instanceof Node && el.contains(hit)) ?? found.find(({ el }) => inside(el.getBoundingClientRect(), at)) ?? null;
}

/** True when every row of a list sits in one column — a list, not a grid. */
function oneColumn(rows: readonly HTMLElement[]): boolean {
  const lefts = rows.map((r) => r.getBoundingClientRect().left);
  return lefts.every((l) => Math.abs(l - lefts[0]!) < 2);
}

/** A row as drawn, and the part of it that shows: from its own top to the top of the row drawn below it. */
interface Shown {
  readonly row: HTMLElement;
  readonly box: DOMRect;
  readonly top: number;
  readonly bottom: number;
}

/** A one-column list's rows from the top of the screen down, each with the strip of it that shows. */
function shownDown(rows: readonly HTMLElement[]): Shown[] {
  const drawn = rows.map((row) => ({ row, box: row.getBoundingClientRect() })).sort((a, b) => a.box.top - b.box.top);
  return drawn.map(({ row, box }, k) => ({ row, box, top: box.top, bottom: Math.min(box.bottom, drawn[k + 1]?.box.top ?? box.bottom) }));
}

/** Where a drop lands in a list: before `before` (`null`: at the end), and where its bar is drawn. */
interface Landing {
  readonly before: HTMLElement | null;
  readonly bar: { left: number; top: number; width: number; height: number };
}

/**
 * Where among `rows` the point falls, and the bar that shows it. Down a one-column list: the gap
 * between two rows as drawn, picked by which half of a row's showing strip the point is in. Across a
 * line (`across`, or rows that do not share a column): before the first row the point is above, or
 * level with and short of its middle.
 */
function landing(list: HTMLElement, rows: readonly HTMLElement[], at: At, across: boolean): Landing {
  const style = getComputedStyle(list);
  const half = (v: string) => (Number.parseFloat(v) || 4) / 2;
  if (rows.length === 0) {
    const r = list.getBoundingClientRect();
    return { before: null, bar: { left: r.left + 4, top: r.top + 4, width: Math.max(r.width - 8, BAR), height: BAR } };
  }
  if (!across && oneColumn(rows)) {
    const down = shownDown(rows);
    const gap = down.findIndex((s) => at.y < (s.top + s.bottom) / 2);
    const k = gap === -1 ? down.length : gap;
    const above = down[k - 1];
    const below = down[k];
    const y =
      above === undefined
        ? below!.top - half(style.rowGap)
        : below === undefined
          ? above.box.bottom + half(style.rowGap)
          : above.box.bottom <= below.top
            ? (above.box.bottom + below.top) / 2
            : below.top;
    const edge = (below ?? above)!.box;
    const before = below?.row ?? null;
    return { before, bar: { left: edge.left, top: y - BAR / 2, width: edge.width, height: BAR } };
  }
  const row =
    rows.find((r) => {
      const b = r.getBoundingClientRect();
      if (at.y < b.top) return true;
      if (at.y > b.bottom) return false;
      return at.x < b.left + b.width / 2;
    }) ?? null;
  const edge = (row ?? rows[rows.length - 1]!).getBoundingClientRect();
  const x = row === null ? edge.right + half(style.columnGap) : edge.left - half(style.columnGap);
  return { before: row, bar: { left: x - BAR / 2, top: edge.top, width: BAR, height: edge.height } };
}

interface Press {
  readonly id: number;
  readonly row: HTMLElement;
  readonly root: HTMLElement;
  readonly host: Element;
  readonly press: At;
  ghost: Ghost | null;
  bar: { el: HTMLElement; place: (left: number, top: number) => void } | null;
  slot: Slot | null;
  /** The box the prompt scrolls its rows in, if it scrolls at all — scrolled while the pointer holds near its top or bottom. */
  readonly scroller: HTMLElement | null;
  /** The last pointer event, re-read while the scroller moves under a still pointer. */
  last: { at: At; event: PointerEvent } | null;
  /** The running edge scroll's frame. */
  frame: number | null;
  /** The row last revealed under the pointer (`reveal`), so it is scrolled once. */
  revealed: number | null;
  /** Takes the window listeners this press added off again. */
  off: () => void;
}

/** The ordering prompts' drag. See the module header. */
export function useRowDrag(opts: RowDragOptions): RowDrag {
  const [liftedId, setLiftedId] = useState<number | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const latest = useRef(opts);
  latest.current = opts;
  const pressRef = useRef<Press | null>(null);
  /** Every row's centre just before a drop changed the order, keyed by id: the slide's starting points. */
  const pendingFlip = useRef<{ root: HTMLElement; before: Map<number, At> } | null>(null);
  const [clicks] = useState(clickLatch);

  // After the render a drop caused: slide whatever moved.
  useLayoutEffect(() => {
    const pending = pendingFlip.current;
    if (pending === null) return;
    pendingFlip.current = null;
    const moved: (readonly [HTMLElement, At])[] = [];
    for (const li of pending.root.querySelectorAll<HTMLElement>('li[data-card-id]')) {
      const was = pending.before.get(idOf(li));
      if (was !== undefined) moved.push([li, was]);
    }
    // No flag: a row still sliding can be picked up again at once.
    flip(moved);
  });

  /** Every trace of the drag away. */
  const end = (): void => {
    const p = pressRef.current;
    pressRef.current = null;
    if (p === null) return;
    p.off();
    if (p.frame !== null) cancelAnimationFrame(p.frame);
    p.ghost?.remove();
    p.bar?.el.remove();
    p.root.removeAttribute(ROW_DRAG_ATTR);
    setLiftedId(null);
    setOver(null);
  };

  useEffect(() => {
    // The click a real drag leaves behind is not a click on what it ended over.
    window.addEventListener('click', clicks.swallow, true);
    return () => {
      window.removeEventListener('click', clicks.swallow, true);
      end();
    };
  }, [clicks]);

  function track(p: Press, at: At, event: PointerEvent): void {
    p.ghost?.move(at);
    // What is under the pointer, not what the event names: a touch's events all name the row it pressed.
    const hit = hitAt(scopeOf(p.root), at.x, at.y) ?? eventTarget(event);
    const target = targetAt(p.root, latest.current.targets, at, hit);
    let slot: Slot | null = null;
    let bar: Landing['bar'] | null = null;
    if (target !== null && !target.spec.rows) {
      slot = { testid: target.spec.testid, before: null };
    } else if (target !== null) {
      const rows = rowsOf(target.el).filter((r) => idOf(r) !== p.id);
      if (reveal(p, rows, at)) {
        track(p, at, event);
        return;
      }
      const land = landing(target.el, rows, at, target.el.hasAttribute(ACROSS_ATTR));
      slot = { testid: target.spec.testid, before: land.before === null ? null : idOf(land.before) };
      bar = land.bar;
    }
    p.slot = slot;
    setOver(slot?.testid ?? null);
    if (bar === null) {
      p.bar?.el.setAttribute('hidden', '');
      return;
    }
    if (p.bar === null) {
      const el = document.createElement('div');
      el.setAttribute('data-arrange-indicator', '');
      el.setAttribute('aria-hidden', 'true');
      p.bar = { el, place: pinFixed(el, p.host) };
    }
    p.bar.el.removeAttribute('hidden');
    p.bar.el.style.width = `${bar.width}px`;
    p.bar.el.style.height = `${bar.height}px`;
    p.bar.place(bar.left, bar.top);
  }

  /**
   * The row under the pointer, its top scrolled into view the first time the pointer is over it.
   * Rows a scry draws do not fit its body two at a time, so the card above the one being carried
   * often shows only its lower part: the half that means "before it" sat out of sight or in the
   * edge band, where no still pointer holds, and a drop above it landed after it. Only a row cut
   * off at the TOP moves — one cut off at the bottom still shows its upper half. The pointer stays
   * over the row, since the scroll moves it by no more than its hidden part. True when the box moved.
   */
  function reveal(p: Press, rows: readonly HTMLElement[], at: At): boolean {
    if (p.scroller === null) return false;
    const row = rows.find((r) => {
      const b = r.getBoundingClientRect();
      return at.y >= b.top && at.y <= b.bottom && at.x >= b.left && at.x <= b.right;
    });
    if (row === undefined || idOf(row) === p.revealed) return false;
    p.revealed = idOf(row);
    const r = row.getBoundingClientRect();
    const view = p.scroller.getBoundingClientRect();
    const by = Math.min(0, r.top - view.top);
    const was = p.scroller.scrollTop;
    p.scroller.scrollTop = was + by;
    return p.scroller.scrollTop !== was;
  }

  /** While the pointer holds near the scroller's top or bottom, scroll it a little every frame, and re-read the slot under the pointer. */
  function edgeScroll(p: Press): void {
    if (p.scroller === null || p.last === null || p.frame !== null) return;
    const step = (): void => {
      p.frame = null;
      if (pressRef.current !== p || p.scroller === null || p.last === null) return;
      const by = edgeSpeed(p.scroller.getBoundingClientRect(), p.last.at.y, p.press.y);
      const was = p.scroller.scrollTop;
      if (by !== 0) p.scroller.scrollTop = was + by;
      if (p.scroller.scrollTop === was) return;
      track(p, p.last.at, p.last.event);
      p.frame = requestAnimationFrame(step);
    };
    p.frame = requestAnimationFrame(step);
  }

  function onMove(event: PointerEvent): void {
    const p = pressRef.current;
    if (p === null) return;
    const at = { x: event.clientX, y: event.clientY };
    if (p.ghost === null) {
      if (!pastSlop(p.press, at)) return;
      p.ghost = liftGhost(p.row, p.host, p.press, String(p.id), true);
      p.root.setAttribute(ROW_DRAG_ATTR, '');
      setLiftedId(p.id);
    }
    p.last = { at, event };
    track(p, at, event);
    edgeScroll(p);
  }

  function onUp(event: PointerEvent): void {
    const p = pressRef.current;
    if (p === null) return;
    if (p.ghost === null) {
      // A plain press: whatever click it leaves behind answers as it always has.
      end();
      return;
    }
    track(p, { x: event.clientX, y: event.clientY }, event);
    // The click this release leaves behind arrives in the same task; one that never comes must not eat a later one.
    clicks.arm();
    setTimeout(clicks.reset, 0);
    const before = new Map<number, At>();
    for (const li of p.root.querySelectorAll<HTMLElement>('li[data-card-id]')) before.set(idOf(li), centreOf(li));
    before.set(p.id, p.ghost.centre());
    const changed = p.slot !== null && latest.current.onDrop(p.id, p.slot);
    if (changed) {
      pendingFlip.current = { root: p.root, before };
      end();
      return;
    }
    // Nothing changed: the phantom glides back to its row, then goes.
    const ghost = p.ghost;
    p.ghost = null;
    end();
    ghost.el.style.transition = `left ${GLIDE_MS}ms ease-out, top ${GLIDE_MS}ms ease-out`;
    ghost.move(p.press);
    if (prefersReducedMotion()) ghost.remove();
    else setTimeout(() => ghost.remove(), GLIDE_MS);
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') end();
  }

  const onRowPointerDown = (id: number) => (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || pressRef.current !== null || !latest.current.canLift(id)) return;
    if (event.target instanceof Element && event.target.closest('button') !== null) return;
    // Ours now: the press selects no text.
    event.preventDefault();
    // A fresh press: whatever an earlier drag left armed is stale.
    clicks.reset();
    const row = event.currentTarget;
    const root = row.closest<HTMLElement>('.prompt') ?? row.parentElement!;
    pressRef.current = {
      id,
      row,
      root,
      // Outside the prompt and its scroll box: the match's own frame, the board's parent.
      host: row.closest('.live') ?? root.parentElement ?? root,
      press: { x: event.clientX, y: event.clientY },
      ghost: null,
      bar: null,
      slot: null,
      scroller: scrollerOf(row),
      last: null,
      frame: null,
      revealed: null,
      off: () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', end);
        window.removeEventListener('keydown', onKey, true);
      },
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', end);
    window.addEventListener('keydown', onKey, true);
  };

  return { liftedId, over, onRowPointerDown };
}
