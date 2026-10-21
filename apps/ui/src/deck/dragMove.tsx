/**
 * Moving a card between a build's two areas by dragging it — one mechanism for
 * every screen that splits a pool: the deck builder (its pool over its deck)
 * and the draft's picks (the deck in progress beside its sideboard).
 *
 * `pool` is what is not played (the sideboard), `deck` the main deck. A drag
 * names the area the card left, so a drop target takes a card from the OTHER
 * area only, and dropping a card back where it came from does nothing.
 */

import { useState, type DragEvent, type ReactNode } from 'react';

export type Area = 'pool' | 'deck';

const DRAG_FROM_POOL = 'application/x-cardtable-from-pool';
const DRAG_FROM_DECK = 'application/x-cardtable-from-deck';
const dragType = (from: Area): string => (from === 'pool' ? DRAG_FROM_POOL : DRAG_FROM_DECK);
/** The area a card dropped on `area` must have come from. */
const other = (area: Area): Area => (area === 'pool' ? 'deck' : 'pool');

/** A card's drag, from `from`, carrying `key` (whatever the screen moves cards by). */
export function startCardDrag(e: DragEvent, from: Area, key: string): void {
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData(dragType(from), key);
}

/** A drop target for `area`: it takes a card dragged from the other one. */
export function DropArea({
  area,
  onDropKey,
  className,
  testid,
  children,
}: {
  area: Area;
  onDropKey: (key: string) => void;
  className: string;
  testid: string;
  children: ReactNode;
}) {
  const [over, setOver] = useState(false);
  const from = dragType(other(area));
  const carries = (e: DragEvent): boolean => [...(e.dataTransfer?.types ?? [])].includes(from);
  return (
    <section
      className={className}
      data-testid={testid}
      data-drop-over={over ? '' : undefined}
      onDragOver={(e) => {
        if (!carries(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(e) => {
        setOver(false);
        e.preventDefault();
        // Only a drag from the other area carries this type; anything else reads ''.
        const key = e.dataTransfer.getData(from);
        if (key !== '') onDropKey(key);
      }}
    >
      {children}
    </section>
  );
}
