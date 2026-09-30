/*
 * What the pointer is over. Re-homed from `../LiveBoard.tsx` (wave 20) with its
 * reasoning intact; nothing here decides what anything MEANS — `./commit.ts`
 * does that.
 */
import type { LiveClickables } from '../match.ts';
import type { DropTarget, Point } from './types.ts';

export function centreOf(el: Element): Point {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/**
 * A card's box. `data-board-card` first, `data-card-id` (lane A's name, same
 * value on the same element) second. Both are on the `<li>`, so either finds
 * the whole card rather than something inside it.
 */
export function cardBox(root: ParentNode, id: number): Element | null {
  return root.querySelector(`[data-board-card="${id}"]`) ?? root.querySelector(`[data-card-id="${id}"]`);
}

/** A player's face. Lane A's `data-player-face`, with the seat section as the fallback. */
export function faceBox(root: ParentNode, id: number): Element | null {
  return (
    root.querySelector(`[data-player-face][data-player-id="${id}"]`) ??
    root.querySelector(`[data-testid="player"][data-player-id="${id}"]`)
  );
}

export function boxOf(root: ParentNode, target: DropTarget): Element | null {
  return target.kind === 'card' ? cardBox(root, target.id) : faceBox(root, target.id);
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
