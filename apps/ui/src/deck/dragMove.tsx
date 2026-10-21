/**
 * Moving a card between a build's two areas by dragging it — one mechanism for
 * every screen that splits a pool: the deck builder (its pool over its deck)
 * and the draft's picks (the deck in progress beside its sideboard).
 *
 * `pool` is what is not played (the sideboard), `deck` the main deck. A drag
 * names the area the card left. The whole split takes the drop
 * (`useCardSplit`, spread on the element holding both areas), so a card
 * dragged out of its area and let go anywhere off it — on the other area, in
 * the space between or beside them, on a heading — moves to the other area,
 * and one let go over its own area stays. Either direction is the same rule:
 * the draft's sideboard is a narrow pile at the end of the picks' row, and a
 * card dragged back out of it was let go in the open row beside the piles,
 * which no area covered (the operator, 2026-10-21: "i am not able to drag
 * cards back out of the side-board in drafting view").
 */

import { useState, type ComponentProps, type DragEvent, type ReactNode } from 'react';

export type Area = 'pool' | 'deck';

const DRAG_FROM: Record<Area, string> = {
  pool: 'application/x-cardtable-from-pool',
  deck: 'application/x-cardtable-from-deck',
};
const other = (area: Area): Area => (area === 'pool' ? 'deck' : 'pool');

/**
 * A card a split's drag picks up, from `from`, carrying `dragKey` (whatever the
 * screen moves cards by); marked `data-lifted` while it is dragged. `from`
 * null: it does not drag.
 */
export function DraggableCard({ from, dragKey, ...rest }: { from: Area | null; dragKey: string } & ComponentProps<'div'>) {
  return (
    <div
      {...rest}
      draggable={from !== null}
      onDragStart={
        from === null
          ? undefined
          : (e) => {
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData(DRAG_FROM[from], dragKey);
              e.currentTarget.setAttribute('data-lifted', '');
            }
      }
      onDragEnd={(e) => e.currentTarget.removeAttribute('data-lifted')}
    />
  );
}

/** The area a card drag left, read off its types (a drag's data is unreadable until the drop); null for any other drag. */
function draggedFrom(e: DragEvent): Area | null {
  const types = [...(e.dataTransfer?.types ?? [])];
  if (types.includes(DRAG_FROM.pool)) return 'pool';
  if (types.includes(DRAG_FROM.deck)) return 'deck';
  return null;
}

/** Where a card drag over `e.target` would go: the other area, unless it is over its own. */
function destination(e: DragEvent): { from: Area; to: Area } | null {
  const from = draggedFrom(e);
  if (from === null) return null;
  const over = (e.target as Element | null)?.closest?.('[data-drop-area]')?.getAttribute('data-drop-area');
  return over === from ? null : { from, to: other(from) };
}

export interface CardSplit {
  /** Spread on the element that holds both areas: it takes every card drop inside it. */
  handlers: {
    onDragOver: (e: DragEvent) => void;
    onDragLeave: (e: DragEvent) => void;
    onDrop: (e: DragEvent) => void;
    onDragEnd: () => void;
  };
  /** The area a card let go here now would land in, for its highlight. */
  over: Area | null;
}

/** The drop half of a split: `onMove(key, to)` for a card let go anywhere in it off its own area. */
export function useCardSplit(onMove: (key: string, to: Area) => void): CardSplit {
  const [over, setOver] = useState<Area | null>(null);
  return {
    over,
    handlers: {
      onDragOver: (e) => {
        if (draggedFrom(e) === null) return;
        const to = destination(e)?.to ?? null;
        setOver(to);
        if (to === null) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      },
      onDragLeave: (e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null);
      },
      onDrop: (e) => {
        setOver(null);
        const move = destination(e);
        if (move === null) return;
        e.preventDefault();
        const key = e.dataTransfer.getData(DRAG_FROM[move.from]);
        if (key !== '') onMove(key, move.to);
      },
      onDragEnd: () => setOver(null),
    },
  };
}

/** One of a split's two areas: where its cards are drawn, lit while a card let go would land in it. */
export function DropArea({
  area,
  over,
  className,
  testid,
  children,
}: {
  area: Area;
  over: Area | null;
  className: string;
  testid: string;
  children: ReactNode;
}) {
  return (
    <section className={className} data-testid={testid} data-drop-area={area} data-drop-over={over === area ? '' : undefined}>
      {children}
    </section>
  );
}
