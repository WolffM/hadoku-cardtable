/*
 * What the pointer is over. Re-homed from `../LiveBoard.tsx` (wave 20) with its
 * reasoning intact; nothing here decides what anything MEANS — `./commit.ts`
 * does that.
 */
import { cardBox, faceBox } from '../board-dom.ts';
import type { LiveClickables } from '../match.ts';
import type { DropTarget, Point } from './types.ts';

/**
 * Where an arrow's head lands on a card: the nearest of EIGHT points on its
 * edge — the four corners and the four edge midpoints — to the arrow's origin.
 * Never the centre (wave 32 Q11: *"snaps to the nearest of eight points on the
 * card's edge"*). Ties go to the first in the order below, which is only ever
 * reached when `from` sits exactly on a symmetry axis of the box.
 */
export function edgePointNearest(el: Element, from: Point): Point {
  const r = el.getBoundingClientRect();
  const xs = [r.left, r.left + r.width / 2, r.right];
  const ys = [r.top, r.top + r.height / 2, r.bottom];
  let best: Point | null = null;
  let bestD = Infinity;
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      if (row === 1 && col === 1) continue; // the centre is not on the edge
      const p = { x: xs[col]!, y: ys[row]! };
      const d = Math.hypot(p.x - from.x, p.y - from.y);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
  }
  return best!;
}

export function boxOf(root: ParentNode, target: DropTarget): Element | null {
  if (target.kind === 'card') return cardBox(root, target.id);
  if (target.kind === 'stack') return root.querySelector(`[data-stack-id="${target.id}"]`);
  return faceBox(root, target.id);
}

/** A board id: digits only. See `boardId` on why that matters. */
const BOARD_ID = /^\d+$/;

/**
 * An id attribute's value, when it is one of OUR ids.
 *
 * `CardTile` (`../../Board.tsx`'s own note) draws a `data-card-id` of its own in
 * the DRAFT's namespace — `w<forge id>` — and it is a descendant of the board
 * card's `<li>`. A walk up from a pointer event meets the tile first, so an id
 * that is not a plain integer means "not this lane's attribute, keep walking"
 * rather than "a card Forge did not offer".
 */
export function boardId(el: Element, ...names: string[]): number | null {
  for (const name of names) {
    const raw = el.getAttribute(name);
    if (raw !== null && BOARD_ID.test(raw)) return Number(raw);
  }
  return null;
}

/**
 * The nearest thing under `node` that Forge has offered, or null.
 *
 * Nearest wins, walking up: a card inside a seat section is the card, not the
 * seat. A card or face Forge did NOT offer stops the walk — dropping on an
 * inert thing is not a drop on whatever contains it.
 *
 * **Item 17.1: the player hit-test is `data-player-face` ONLY, never the
 * whole `[data-testid="player"]` seat.** The operator, 2026-09-28: *"by
 * default it points at player portraits which doesnt make sense at all."*
 * `data-testid="player"` is on `PlayerArea`'s outer `<section>`
 * (`Board.tsx`), which wraps a whole side of the table — battlefield, hand,
 * graveyard, the lot. Before this wave, a walk that reached it (anywhere in
 * that seat that was not itself a card) matched it, so releasing or hovering
 * on the row label, the pile gutter, the seat's own padding — most of the
 * board that is not a card — resolved to "targeting that player" whenever a
 * player was legal at all. `faceBox` keeps the WIDER selector as its own
 * fallback for the box a decided target snaps TO, which is a different,
 * harmless question (`boxOf` is only ever called once a target id is already
 * chosen); this is the question of what counts as a hit in the first place,
 * and only the face itself may answer it.
 */
export function targetUnder(node: EventTarget | null, offered: LiveClickables): DropTarget | null {
  let el = node instanceof Element ? node : null;
  while (el !== null) {
    const cardId = boardId(el, 'data-board-card', 'data-card-id');
    if (cardId !== null) {
      return offered.selectable.has(cardId) ? { kind: 'card', id: cardId } : null;
    }
    if (el.hasAttribute('data-player-face')) {
      const id = boardId(el, 'data-player-id');
      return id !== null && offered.selectablePlayers.has(id) ? { kind: 'player', id } : null;
    }
    el = el.parentElement;
  }
  return null;
}

/** Every board card's `<li>` under `root`, with the id it carries. Ours only — see `boardId`. */
export function cardElements(root: ParentNode): { id: number; el: Element }[] {
  const out: { id: number; el: Element }[] = [];
  const seen = new Set<number>();
  for (const el of root.querySelectorAll('[data-board-card], [data-card-id]')) {
    const id = boardId(el, 'data-board-card', 'data-card-id');
    if (id === null || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, el });
  }
  return out;
}
