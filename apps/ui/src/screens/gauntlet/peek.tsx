/*
 * The deck list beside a Gauntlet tile on hover — the room picker's own peek (`DeckPeek.tsx`,
 * `usePeekHover`), opened by deck id, and the registry of the tiles on screen that it and the
 * board's slide both measure.
 *
 * Touch opens the same peek on a long hold instead (`useTouchPeek`, item 2c): `bind` merges its
 * handlers in beside the pointer-hover ones above, on the SAME tile element every caller already
 * spreads `bind(id)` onto (`GauntletBoard.tsx`, `GauntletChoose.tsx`, `GauntletResult.tsx` — none
 * of them need a change for it).
 */
import { useRef, type MouseEvent, type PointerEvent, type ReactNode } from 'react';

import type { DeckOption } from '../ConstructedScreen.tsx';
import { DeckPeek, usePeekHover, useTouchPeek } from '../DeckPeek.tsx';

const PEEK_ID = 'gauntlet-peek';

export interface TileBinding {
  ref: (el: HTMLButtonElement | null) => void;
  onPointerEnter: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerLeave: () => void;
  onPointerDown: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerMove: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerUp: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerCancel: (event: PointerEvent<HTMLButtonElement>) => void;
  onContextMenu: (event: MouseEvent<HTMLButtonElement>) => void;
  onClickCapture: (event: MouseEvent<HTMLButtonElement>) => void;
  'aria-describedby': string | undefined;
}

/** `quiet`: tiles are travelling (`arrive.ts`), and one passing under a resting pointer is not a hover. */
export function useTilePeek(
  options: ReadonlyMap<string, DeckOption>,
  quiet = false,
): {
  bind: (id: string) => TileBinding;
  tiles: ReadonlyMap<string, HTMLButtonElement>;
  peek: ReactNode;
} {
  const hover = usePeekHover<string>();
  const touch = useTouchPeek<string>(hover);
  const tiles = useRef(new Map<string, HTMLButtonElement>());
  const open = hover.peek;
  const peeked = open === null ? undefined : options.get(open.key);
  const locate = (id: string) => (): { anchor: DOMRect; bounds: DOMRect } | null => {
    const tile = tiles.current.get(id);
    if (tile === undefined) return null;
    const screen = tile.closest('[data-testid="constructed"]') ?? document.documentElement;
    return { anchor: tile.getBoundingClientRect(), bounds: screen.getBoundingClientRect() };
  };
  const bind = (id: string): TileBinding => {
    const peekable = options.get(id)?.list !== undefined;
    const forTouch = touch(id, locate(id));
    return {
      ref: (el) => {
        if (el === null) tiles.current.delete(id);
        else tiles.current.set(id, el);
      },
      onPointerEnter: (event) => {
        if (event.pointerType === 'touch' || !peekable || quiet) return;
        hover.openSoon(id, locate(id));
      },
      onPointerLeave: hover.closeSoon,
      onPointerDown: (event) => {
        // A press is a choice made: the list it was read from goes, and comes back on the next
        // hover. For touch — the only pointer type `forTouch.onPointerDown` itself acts on — this
        // closes nothing open (a touch never opened the hover peek in the first place) before it
        // starts the hold timer below.
        hover.close();
        if (peekable) forTouch.onPointerDown(event);
      },
      onPointerMove: forTouch.onPointerMove,
      onPointerUp: forTouch.onPointerUp,
      onPointerCancel: forTouch.onPointerCancel,
      onContextMenu: forTouch.onContextMenu,
      onClickCapture: forTouch.onClickCapture,
      'aria-describedby': open?.key === id ? PEEK_ID : undefined,
    };
  };
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
