/*
 * The deck list beside a Gauntlet tile on hover — the room picker's own peek (`DeckPeek.tsx`,
 * `usePeekHover`), opened by deck id, and the registry of the tiles on screen that it and the
 * board's slide both measure.
 */
import { useRef, type PointerEvent, type ReactNode } from 'react';

import type { DeckOption } from '../ConstructedScreen.tsx';
import { DeckPeek, usePeekHover } from '../DeckPeek.tsx';

const PEEK_ID = 'gauntlet-peek';

export interface TileBinding {
  ref: (el: HTMLButtonElement | null) => void;
  onPointerEnter: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerLeave: () => void;
  onPointerDown: () => void;
  'aria-describedby': string | undefined;
}

export function useTilePeek(options: ReadonlyMap<string, DeckOption>): {
  bind: (id: string) => TileBinding;
  tiles: ReadonlyMap<string, HTMLButtonElement>;
  peek: ReactNode;
} {
  const hover = usePeekHover<string>();
  const tiles = useRef(new Map<string, HTMLButtonElement>());
  const open = hover.peek;
  const peeked = open === null ? undefined : options.get(open.key);
  const bind = (id: string): TileBinding => ({
    ref: (el) => {
      if (el === null) tiles.current.delete(id);
      else tiles.current.set(id, el);
    },
    onPointerEnter: (event) => {
      if (event.pointerType === 'touch' || options.get(id)?.list === undefined) return;
      hover.openSoon(id, () => {
        const tile = tiles.current.get(id);
        if (tile === undefined) return null;
        const screen = tile.closest('[data-testid="constructed"]') ?? document.documentElement;
        return { anchor: tile.getBoundingClientRect(), bounds: screen.getBoundingClientRect() };
      });
    },
    onPointerLeave: hover.closeSoon,
    // A press is a choice made: the list it was read from goes, and comes back on the next hover.
    onPointerDown: hover.close,
    'aria-describedby': open?.key === id ? PEEK_ID : undefined,
  });
  const peek =
    open !== null && peeked?.list !== undefined ? (
      <DeckPeek
        id={PEEK_ID}
        label={peeked.label}
        name={peeked.name}
        pilot={peeked.pilot}
        colors={peeked.colors}
        deckStyle={peeked.deckStyle}
        list={peeked.list}
        anchor={open.anchor}
        bounds={open.bounds}
        onPointerEnter={hover.hold}
        onPointerLeave={hover.closeSoon}
      />
    ) : null;
  return { bind, tiles: tiles.current, peek };
}
