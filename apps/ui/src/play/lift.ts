/*
 * The phantom and the slide: the two pieces every drag that MOVES a thing
 * within a row of things shares — the board's own rearrange (`Board.tsx`'s
 * `useArrangeDrag`), the hand's reorder (`live/gestures/hand.ts`) and every
 * prompt that asks for an order (`prompts/row-drag.ts`).
 *
 * ## The phantom (`liftGhost`)
 *
 * The thing picked up never leaves its place: it is dimmed where it stands, so
 * nothing around it reflows mid-drag, and a COPY of it — stripped of every id,
 * so ids stay unique — follows the pointer from the spot it was grabbed at.
 *
 * The copy is `position: fixed` and sits in viewport coordinates, so it never
 * counts toward any box's scroll overflow. A row the copy came out of can sit
 * in a scroll box (a prompt's body, a zone); a copy placed in flow, or one
 * moved by a transform inside that box, grows the box's scrollable area under
 * the pointer and draws its scrollbars. If an ancestor of `host` is the
 * containing block of a fixed box anyway (a transform, a filter, layout
 * containment), the copy's first measured box says where that block's origin
 * is, and every move is corrected by it.
 *
 * ## The slide (`flip`)
 *
 * When the order changes, every element that moved glides from where it was to
 * where it is now: FLIP (First, Last, Invert, Play) — the old position as an
 * inverse transform with no transition, then the same transform cleared with
 * one, so the browser animates the delta rather than snapping.
 */
import { GLIDE_MS } from './motion.ts';
import './lift.css';

/** A point in viewport coordinates. */
export interface At {
  x: number;
  y: number;
}

/** The house curve — `live/gestures/gestures.css`'s lift and return use the same one. */
const HOUSE_CURVE = 'cubic-bezier(0.3, 0.7, 0.3, 1)';

/** Marks the copy under the pointer; `board.css` gives it its lift (shadow, scale). */
export const GHOST_ATTR = 'data-arrange-ghost';

/** Attributes a copy must not carry: anything that finds a card or a row by id or by test id, and the drag's own marks. */
const STRIPPED = [
  'data-card-id',
  'data-board-card',
  'data-testid',
  'data-key',
  'data-arrange-card',
  'data-arrange-dragging',
  'data-arrange-target',
  'data-dragging',
  'data-over',
  'data-selectable',
  'data-can-act',
  // A card lifted out of a pile is one card: the pile's own layout rules must not reach its copy.
  'data-pile-size',
  'data-pile-depth',
  'id',
] as const;

export interface Ghost {
  readonly el: HTMLElement;
  /** Follow the pointer, keeping the spot it was grabbed at under it. */
  move(at: At): void;
  /** The copy's centre now, in viewport coordinates — where a slide of the real thing starts from. */
  centre(): At;
  remove(): void;
}

/**
 * Put `el` in `host` as a fixed box, and return what places it at a point in
 * viewport coordinates — corrected for a containing block other than the
 * viewport, if an ancestor of `host` makes one (see the module header).
 */
export function pinFixed(el: HTMLElement, host: Element): (left: number, top: number) => void {
  el.style.position = 'fixed';
  el.style.left = '0px';
  el.style.top = '0px';
  el.style.margin = '0';
  el.style.pointerEvents = 'none';
  host.append(el);
  // Measured unscaled: a lift's own `scale` (`lift.css`) grows the box about its centre, and an
  // origin read off the grown box put every copy that much down and right of where it was placed.
  const scale = el.style.scale;
  el.style.scale = 'none';
  const origin = el.getBoundingClientRect();
  el.style.scale = scale;
  return (left, top) => {
    el.style.left = `${left - origin.left}px`;
    el.style.top = `${top - origin.top}px`;
  };
}

/**
 * Draw a copy of `source` under the pointer, appended to `host`. `press` is
 * where the pointer went down on `source`: the copy keeps that same spot under
 * the pointer as it moves.
 *
 * `inList`: the copy is drawn inside an empty copy of `source`'s own list, so
 * a stylesheet that draws the row as a child of its list (`.prompt__cards >
 * li`, `.prompt__cards .card`) still draws the copy. The board's cards are
 * styled off `.board` itself, which is their host, and need no list.
 */
export function liftGhost(source: HTMLElement, host: Element, press: At, id: string, inList = false): Ghost {
  const at = source.getBoundingClientRect();
  const copy = source.cloneNode(true) as HTMLElement;
  const list = inList && source.parentElement !== null ? (source.parentElement.cloneNode(false) as HTMLElement) : null;
  const el = list ?? copy;
  if (list !== null) {
    // The list is only there for its stylesheet; its layout must not move or resize the row. A pile
    // sizes its rows off a variable only the pile's own box defines (`prompts.css`'s `--w`) and
    // lays them out from its foot (`column-reverse`): the copy came out smaller, at the foot, and
    // so down and left of the pointer that had grabbed it (the operator, 2026-10-19, on Ponder).
    list.style.display = 'block';
    list.style.padding = '0';
    copy.style.margin = '0';
    copy.style.width = `${at.width}px`;
    copy.style.height = `${at.height}px`;
    list.append(copy);
  }
  // A row still sliding from the last drop carries its slide's transform: the copy starts where the row is.
  copy.style.transform = '';
  copy.style.transition = '';
  for (const node of [el, ...el.querySelectorAll<HTMLElement>('*')]) {
    for (const attr of STRIPPED) node.removeAttribute(attr);
  }
  el.setAttribute(GHOST_ATTR, id);
  el.setAttribute('aria-hidden', 'true');
  el.inert = true;
  el.style.boxSizing = 'border-box';
  el.style.width = `${at.width}px`;
  el.style.height = `${at.height}px`;
  el.style.setProperty('--card-w', `${at.width}px`);
  el.style.zIndex = 'calc(var(--z-popover, 40) + 1)';
  const place = pinFixed(el, host);
  const grab = { x: press.x - at.left, y: press.y - at.top };
  const move = (p: At): void => place(p.x - grab.x, p.y - grab.y);
  move(press);
  return {
    el,
    move,
    centre: () => centreOf(el),
    remove: () => el.remove(),
  };
}

/** An element's box centre, in viewport coordinates. */
export function centreOf(el: Element): At {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/**
 * The slide: each element in `moved` glides from the centre it had (`was`) to
 * where it is drawn now. `flag`, if given, marks it for the length of the
 * glide, for a stylesheet that must keep it out of the pointer's way meanwhile.
 */
export function flip(moved: Iterable<readonly [HTMLElement, At]>, flag?: string): void {
  const moving: HTMLElement[] = [];
  for (const [el, was] of moved) {
    const now = centreOf(el);
    const dx = was.x - now.x;
    const dy = was.y - now.y;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
    if (flag !== undefined) el.setAttribute(flag, '');
    el.style.transition = 'none';
    el.style.transform = `translate(${dx}px, ${dy}px)`;
    moving.push(el);
  }
  if (moving.length === 0) return;
  // The start transform has to be a painted style before the transition replaces it.
  void moving[0]!.getBoundingClientRect();
  requestAnimationFrame(() => {
    for (const el of moving) {
      el.style.transition = `transform ${GLIDE_MS}ms ${HOUSE_CURVE}`;
      el.style.transform = '';
    }
    setTimeout(() => {
      for (const el of moving) {
        el.style.transition = '';
        if (flag !== undefined) el.removeAttribute(flag);
      }
    }, GLIDE_MS);
  });
}
