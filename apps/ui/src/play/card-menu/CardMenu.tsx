/*
 * The board's own context menu: a right-click on one of the viewer's own
 * battlefield cards, or a long-press on touch (the inspector's own long-press,
 * `CARD_LONG_PRESS`), lists the quick actions that apply to it
 * (`actions.ts`). The browser's menu never shows on the board
 * (`live/gestures/install.ts` suppresses it); a card with no action to offer
 * opens nothing.
 *
 * Drawn the way the settings popover is (`settings/Settings.tsx`, the same
 * card-over-the-page tokens): inside the board's own tree, in its overlay and
 * kept inside the board's box, so an embed's theme reaches it and it never
 * widens the match shell. Escape, Tab, a press anywhere outside it, or
 * choosing an item closes it; the arrow keys, Home and End move between items.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from 'react';

import type { Arrangement, BoardLayout } from '../Board.tsx';
import type { BoardCard } from '../adapter.ts';
import { eventTarget, scopeOf } from '../../dom.ts';
import { clampSpan, useDismiss } from '../../popover.ts';
import { CARD_LONG_PRESS, type CardLongPress } from '../inspect/index.ts';
import { actionsFor, pilesOf, withStacked, type CardAction, type CardActionContext } from './actions.ts';
import './card-menu.css';

/** Its distance from the board's edges. */
const GAP = 8;

/** The seat whose cards the menu acts on — the viewer's own — and how to write its arrangement. */
export interface CardMenuSeat {
  readonly cards: readonly BoardCard[];
  readonly playerId: number;
  readonly arranged: Arrangement;
  readonly layout: BoardLayout;
  readonly commit: (next: Arrangement) => void;
}

interface Open {
  readonly cardId: number;
  readonly x: number;
  readonly y: number;
}

function contextFor(seat: CardMenuSeat, card: BoardCard): CardActionContext {
  return {
    card,
    battlefield: seat.cards,
    piles: pilesOf(seat.cards, seat.playerId, seat.arranged, seat.layout),
    stack: (groups) => seat.commit(withStacked(seat.cards, seat.playerId, seat.arranged, groups, seat.layout)),
  };
}

/**
 * Opens the menu on `root`'s cards and returns it, to be drawn in the board's overlay. `seat` is null
 * when nobody is seated (a spectator): there is nothing of theirs to act on, and nothing opens.
 */
export function useCardMenu(root: RefObject<HTMLElement | null>, seat: CardMenuSeat | null): ReactNode {
  const [open, setOpen] = useState<Open | null>(null);
  const latest = useRef(seat);
  latest.current = seat;
  const close = useCallback(() => setOpen(null), []);

  useEffect(() => {
    const board = root.current;
    if (board === null) return undefined;
    /** True when it opened: the event was the menu's. */
    const openAt = (target: EventTarget | null, x: number, y: number): boolean => {
      const now = latest.current;
      const el = target instanceof Element ? target.closest<HTMLElement>('li.board-card[data-card-id]') : null;
      const card = el !== null && board.contains(el) ? now?.cards.find((c) => c.id === Number(el.dataset.cardId)) : undefined;
      if (now === null || card === undefined || actionsFor(contextFor(now, card)).length === 0) {
        setOpen(null);
        return false;
      }
      setOpen({ cardId: card.id, x, y });
      return true;
    };
    // At the scope, not the board: a right-click that cancelled a live gesture is the gesture's, and
    // `live/gestures/install.ts` stops it on the way up.
    const scope = scopeOf(board);
    const onContextMenu = (event: Event): void => {
      const { clientX, clientY } = event as MouseEvent;
      if (openAt(eventTarget(event), clientX, clientY)) event.preventDefault();
    };
    const onLongPress = (event: Event): void => {
      const { x, y } = (event as CustomEvent<CardLongPress>).detail;
      openAt(eventTarget(event), x, y);
    };
    scope.addEventListener('contextmenu', onContextMenu);
    board.addEventListener(CARD_LONG_PRESS, onLongPress);
    return () => {
      scope.removeEventListener('contextmenu', onContextMenu);
      board.removeEventListener(CARD_LONG_PRESS, onLongPress);
    };
  }, [root]);

  if (open === null || seat === null) return null;
  const card = seat.cards.find((c) => c.id === open.cardId);
  if (card === undefined) return null;
  const ctx = contextFor(seat, card);
  const actions = actionsFor(ctx);
  // The card left, or what it offered no longer applies: nothing to draw.
  if (actions.length === 0) return null;
  return <CardMenu key={`${open.cardId}@${open.x},${open.y}`} at={open} label={card.card.name} actions={actions} ctx={ctx} onClose={close} />;
}

function CardMenu({
  at,
  label,
  actions,
  ctx,
  onClose,
}: {
  at: { x: number; y: number };
  label: string;
  actions: readonly CardAction[];
  ctx: CardActionContext;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const menu = ref.current;
    // Placed in the overlay it is drawn in, as the pile view is.
    const overlay = menu?.parentElement;
    if (menu === null || overlay === null || overlay === undefined) return;
    const box = overlay.getBoundingClientRect();
    setPlace({ left: clampSpan(at.x - box.left, menu.offsetWidth, 0, box.width, GAP), top: clampSpan(at.y - box.top, menu.offsetHeight, 0, box.height, GAP) });
  }, [at]);
  // Once placed: a browser does not focus an element that is still `visibility: hidden`.
  const placed = place !== null;
  useLayoutEffect(() => {
    if (placed) ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [placed]);

  useDismiss(onClose, useCallback((target: Node) => ref.current?.contains(target) === true, []));

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const at = items.indexOf(event.target as HTMLElement);
    const focus = (i: number) => items[(i + items.length) % items.length]?.focus();
    if (event.key === 'Tab') return onClose();
    if (event.key === 'Escape') onClose();
    else if (event.key === 'ArrowDown') focus(at + 1);
    else if (event.key === 'ArrowUp') focus(at - 1);
    else if (event.key === 'Home') focus(0);
    else if (event.key === 'End') focus(items.length - 1);
    else return;
    // The menu's own keys: Escape here is not a prompt's or a gesture's.
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div
      ref={ref}
      className="card-menu ct-surface"
      role="menu"
      aria-label={label}
      data-testid="card-menu"
      data-for-card={ctx.card.id}
      style={place ?? { visibility: 'hidden' }}
      onKeyDown={onKeyDown}
    >
      {actions.map((action) => (
        <button
          key={action.id}
          type="button"
          role="menuitem"
          className="card-menu__item"
          data-action={action.id}
          tabIndex={-1}
          onClick={() => {
            action.run(ctx);
            onClose();
          }}
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}
