/*
 * A deck's list, beside its tile in the room's picker, once the pointer rests
 * on the tile — the operator, 2026-10-10: *"i need a way to peek into the deck
 * maybe can we show a decklist when hovering for at least 1s?"*, and again on
 * 2026-10-14, *"when hovering deck show decklist"*, with the peek a full second
 * away and so never seen while browsing. It opens at {@link PEEK_DELAY_MS} now:
 * long enough that sweeping across the grid opens nothing, short enough that a
 * hover is answered.
 *
 * Spells by mana value with their costs, then the cards with no cost (lands,
 * mostly — a browser holds costs for this library, not types, so the line is
 * drawn by cost rather than labelled), then the sideboard.
 *
 * The pointer can move into it — the operator, 2026-10-16: *"remove the gap
 * between the deck grid button and the expanded decklist so i can actually
 * hover over things in there? also when hovering cards in the decklist let's
 * show the expanded card"*. It stands flush against the tile, and the picker
 * keeps it open while the pointer is on either (`ConstructedScreen.tsx`).
 * Hovering a line enlarges that card through the board's own inspector
 * (`../play/inspect/index.ts`), mounted on the peek for as long as it is open:
 * each line names a hidden `CardTile` with `data-inspect-ids`, exactly as a
 * log line names a board card, and the inspector stands the enlargement
 * beside the list rather than on it. No second big-card view exists.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEventHandler, type PointerEventHandler } from 'react';

import type { DraftCard } from '@hadoku/shared';
import { BACK_FACE } from '@hadoku/carddata/art';

import { CardTile } from '../components/CardTile.tsx';
import { mountInspector } from '../play/inspect/index.ts';

import { DeckColors } from '../components/DeckView.tsx';
import { ManaCost } from '../components/ManaPip.tsx';
import { DECK_COLORS, type DeckColor } from '@hadoku/deck';
import type { DeckStyle } from '@hadoku/deck/library';

import { sortCards } from '../deck/cardOrder.ts';
import { uiPx } from '../settings/ui-scale.ts';
import { DeckStyleTag } from './DeckStyleTag.tsx';
import { TopLayer } from '../topLayer.tsx';
import { OverPage } from '../components/OverPage.tsx';

/** One line of a list, with what the peek sorts and draws it by. */
export interface PeekLine {
  readonly name: string;
  readonly count: number;
  /** Cost tokens (`['1', 'R']`); empty for a card with no mana cost. */
  readonly cost: readonly string[];
  readonly manaValue: number;
  /** The card a hover on the line enlarges. */
  readonly face: DraftCard;
}

export interface PeekList {
  readonly main: readonly PeekLine[];
  readonly sideboard: readonly PeekLine[];
}

/** How long a pointer rests on a tile before its list opens. */
export const PEEK_DELAY_MS = 400;

/**
 * How long a list outlives the pointer leaving its tile or itself, so a path
 * from one to the other that cuts across a corner does not close it. Shorter
 * than {@link PEEK_DELAY_MS}, so a list never outlives the next one opening.
 */
export const PEEK_GRACE_MS = 200;

/** An open list: what it is for, and where its tile and the screen were when it opened. */
export interface OpenPeek<K> {
  readonly key: K;
  readonly anchor: DOMRect;
  readonly bounds: DOMRect;
}

/**
 * The hover a list opens and closes on, for every surface that shows one (the
 * room's picker, the stats page's deck rows): it opens once the pointer has
 * rested {@link PEEK_DELAY_MS} on a tile, and closes {@link PEEK_GRACE_MS}
 * after the pointer has left both the tile and the list, so the list can be
 * reached and hovered.
 *
 * `openSoon`'s `locate` is asked when the delay ends, not when the pointer
 * arrives, so the list opens beside where the tile is then.
 */
export function usePeekHover<K>(): PeekHover<K> {
  const [peek, setPeek] = useState<OpenPeek<K> | null>(null);
  /** The open list, for the handlers below: they stay one identity across renders. */
  const open = useRef<OpenPeek<K> | null>(null);
  open.current = peek;
  const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** The tile the timer is running for, so a pointer moving within it does not restart it. */
  const pending = useRef<{ key: K } | null>(null);
  /** The close that leaving the tile or the list starts, which entering either cancels. */
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => () => {
      clearTimeout(openTimer.current);
      clearTimeout(leaveTimer.current);
    },
    [],
  );
  const handlers = useMemo(() => {
    const cancelPending = (): void => {
      clearTimeout(openTimer.current);
      pending.current = null;
    };
    const isOpen = (key: K): boolean => open.current !== null && Object.is(open.current.key, key);
    return {
      close(): void {
        cancelPending();
        clearTimeout(leaveTimer.current);
        setPeek(null);
      },
      closeSoon(): void {
        cancelPending();
        clearTimeout(leaveTimer.current);
        leaveTimer.current = setTimeout(() => setPeek(null), PEEK_GRACE_MS);
      },
      hold(): void {
        cancelPending();
        clearTimeout(leaveTimer.current);
      },
      openSoon(key: K, locate: () => { anchor: DOMRect; bounds: DOMRect } | null): void {
        if (isOpen(key)) clearTimeout(leaveTimer.current);
        if ((pending.current !== null && Object.is(pending.current.key, key)) || isOpen(key)) return;
        clearTimeout(openTimer.current);
        pending.current = { key };
        openTimer.current = setTimeout(() => {
          pending.current = null;
          clearTimeout(leaveTimer.current);
          const at = locate();
          if (at !== null) setPeek({ key, ...at });
        }, PEEK_DELAY_MS);
      },
    };
  }, []);
  return { peek, ...handlers };
}

export interface PeekHover<K> {
  peek: OpenPeek<K> | null;
  close(): void;
  /** Off the tile or the list: closed once the grace passes without the pointer reaching either. */
  closeSoon(): void;
  /** On the list: it stays, and a tile crossed on the way there opens nothing. */
  hold(): void;
  openSoon(key: K, locate: () => { anchor: DOMRect; bounds: DOMRect } | null): void;
}

/** The props a tile's touch half of the peek needs — spread onto the SAME element a tile's own
 *  pointer-hover and click handlers already sit on; see {@link useTouchPeek} for why a click
 *  survives sharing the element with `onClickCapture` here. */
export interface TouchPeekHandlers {
  onPointerDown: PointerEventHandler<HTMLElement>;
  onPointerMove: PointerEventHandler<HTMLElement>;
  onPointerUp: PointerEventHandler<HTMLElement>;
  onPointerCancel: PointerEventHandler<HTMLElement>;
  onContextMenu: MouseEventHandler<HTMLElement>;
  onClickCapture: MouseEventHandler<HTMLElement>;
}

/**
 * Touch's own way into the same peek a pointer hover opens — the operator, 2026-10-30 (item 2c):
 * *"maybe 'long hold' can bring up the deck peek? and when finger is released it disappears
 * again?"* A touch has no hover to rest; this drives {@link PeekHover.openSoon} off a PRESS
 * instead, so the same {@link PEEK_DELAY_MS} that answers a mouse's rest answers a finger's hold.
 *
 * ## Closing has no grace
 *
 * A pointer hover's `closeSoon` waits {@link PEEK_GRACE_MS} so a path that crosses from the tile to
 * the list does not close it first. A finger that lifts is simply gone — there is nowhere left for
 * it to be heading — so lifting, or sliding off the tile the hold started on, closes the peek on
 * the spot (`hover.close()`, no timer).
 *
 * ## A hold that opened the peek must not also choose the tile
 *
 * `onClickCapture` runs on the SAME element React invokes a target's capture handler on BEFORE that
 * element's own bubble `onClick` — the deck-choosing handler every caller already wires separately
 * — so a click that would follow a long-enough hold is swallowed here before it reaches it.
 * A tap shorter than {@link PEEK_DELAY_MS} never opens the peek, so `suppress` is never armed for
 * it, and the click it still fires chooses exactly as it always has.
 */
export function useTouchPeek<K>(hover: PeekHover<K>): (key: K, locate: () => { anchor: DOMRect; bounds: DOMRect } | null) => TouchPeekHandlers {
  const held = useRef<{ key: K; rect: DOMRect | null } | null>(null);
  /** The key a hold just opened the peek for; armed only long enough to eat the one click it owns. */
  const suppress = useRef<K | null>(null);
  // Mirrored every render so the pointerup handler — attached once per render, same as any React
  // handler — reads the OPEN peek as of the moment the finger actually lifts, not as of whichever
  // render last attached the listener.
  const openRef = useRef(hover.peek);
  openRef.current = hover.peek;

  const release = (key: K): void => {
    const was = held.current;
    held.current = null;
    if (was === null || !Object.is(was.key, key)) return;
    const wasOpen = openRef.current !== null && Object.is(openRef.current.key, key);
    hover.close();
    if (wasOpen) suppress.current = key;
  };

  return (key, locate) => ({
    onPointerDown: (event) => {
      if (event.pointerType !== 'touch') return;
      held.current = { key, rect: locate()?.anchor ?? null };
      hover.openSoon(key, locate);
    },
    onPointerMove: (event) => {
      if (event.pointerType !== 'touch') return;
      const was = held.current;
      if (was === null || !Object.is(was.key, key)) return;
      const r = was.rect;
      const inside = r !== null && event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom;
      if (!inside) {
        held.current = null;
        hover.close();
      }
    },
    onPointerUp: (event) => {
      if (event.pointerType !== 'touch') return;
      release(key);
    },
    onPointerCancel: (event) => {
      if (event.pointerType !== 'touch') return;
      const was = held.current;
      held.current = null;
      if (was !== null && Object.is(was.key, key)) hover.close();
    },
    onContextMenu: (event) => {
      // The OS's own long-press menu, over a hold this is already answering with the peek.
      if (held.current !== null && Object.is(held.current.key, key)) event.preventDefault();
    },
    onClickCapture: (event) => {
      if (suppress.current !== null && Object.is(suppress.current, key)) {
        suppress.current = null;
        event.preventDefault();
        event.stopPropagation();
      }
    },
  });
}

const GAP = 8;
/** A list line's height at 100%, as `.peek__line` draws it. */
const LINE_PX = 18;
/** The rows a list column takes before the main deck splits into two. */
const ROWS_RESERVED = 5;

/** The builder's order (`sortCards` by mana value), the costed cards first, then the cost-free ones. */
export function peekOrder(lines: readonly PeekLine[]): { spells: PeekLine[]; free: PeekLine[] } {
  const sorted = sortCards(lines, 'mv', (l) => l.face);
  return { spells: sorted.filter((l) => l.cost.length > 0), free: sorted.filter((l) => l.cost.length === 0) };
}

const total = (lines: readonly PeekLine[]) => lines.reduce((n, l) => n + l.count, 0);

/**
 * A card known only by its name, cost and art id — a library deck's line: the
 * wire sends names. The inspector enlarges it as the art when there is an id,
 * and as the text tile (name and cost) when there is none.
 */
export function namedFace(
  name: string,
  cost: readonly string[],
  manaValue: number,
  scryfallId: string | undefined,
  backFaces: readonly string[] = [],
  setCode = '',
): DraftCard {
  const symbols = new Set(cost.flatMap((token) => token.split('/')));
  const printed = { manaCost: [], manaValue: 0, colors: [], typeLine: '', oracleText: '', setCode, collectorNumber: '', rarity: 'special' } as const;
  return {
    ...printed,
    cardId: name,
    name,
    manaCost: [...cost],
    manaValue,
    colors: DECK_COLORS.filter((c) => symbols.has(c)),
    ...(scryfallId === undefined ? {} : { scryfallId }),
    // Its back faces (`backFaceNames`), each drawn as its own back image.
    ...(scryfallId === undefined || backFaces.length === 0
      ? {}
      : { faces: backFaces.map((face) => ({ ...printed, manaCost: [], colors: [], name: face, scryfallId: `${scryfallId}${BACK_FACE}` })) }),
  };
}

function Lines({ lines, faceIds }: { lines: readonly PeekLine[]; faceIds: ReadonlyMap<string, number> }) {
  return (
    <ul className="peek__lines">
      {lines.map((l) => (
        <li key={l.name} className="peek__line" data-inspect-ids={faceIds.get(l.name)}>
          <span className="peek__n">{l.count}</span>
          <span className="peek__name">{l.name}</span>
          <ManaCost cost={l.cost} label={`${l.name} costs ${l.cost.join(' ')}`} />
        </li>
      ))}
    </ul>
  );
}

export function DeckPeek({
  id,
  label,
  name,
  pilot,
  colors,
  deckStyle,
  list,
  anchor,
  bounds,
  onPointerEnter,
  onPointerLeave,
  inPlace = false,
}: {
  id: string;
  label: string;
  /** A library deck's own name and its player, drawn on two lines in place of `label`. */
  name?: string | undefined;
  pilot?: string | undefined;
  colors: readonly DeckColor[];
  /** The library deck's play style, drawn beside its name; absent for any other deck. */
  deckStyle?: DeckStyle | undefined;
  list: PeekList;
  /** The tile's box, and the screen's: the peek sits beside one, inside the other. */
  anchor: DOMRect;
  bounds: DOMRect;
  onPointerEnter?: PointerEventHandler<HTMLDivElement>;
  onPointerLeave?: PointerEventHandler<HTMLDivElement>;
  /**
   * Drawn where it is rendered, not over the page (`../components/OverPage.tsx`): for a peek inside a
   * layer that already is, the board's moved list or the stats popout's. Placed in the window's
   * coordinates, a peek drawn inside a fit screen would be offset by it and widen its scroll extent.
   */
  inPlace?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<CSSProperties>({ visibility: 'hidden', left: 0, top: 0 });
  const { spells, free } = peekOrder(list.main);
  const mainLines = [...spells, ...free];
  // One column when the main deck fits the screen's height, two when it does not.
  const rows = Math.max(8, Math.floor(bounds.height / uiPx(LINE_PX, host.current)) - ROWS_RESERVED);
  const split = mainLines.length > rows ? Math.ceil(mainLines.length / 2) : mainLines.length;
  const columns = split < mainLines.length ? [mainLines.slice(0, split), mainLines.slice(split)] : [mainLines];
  const faces = [...new Map([...list.main, ...list.sideboard].map((l) => [l.name, l.face])).values()];
  const faceIds = new Map(faces.map((face, i) => [face.name, i]));

  useEffect(() => {
    const el = host.current;
    return el === null ? undefined : mountInspector(el);
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    // Flush beside the tile — right, else left — and only when neither side
    // has room, above it, else below it: never over the tile the pointer is
    // resting on, and with nothing between the two for the pointer to cross.
    // A screen with room for none of the four (a grid beside the room's chat)
    // lets the list out over whatever is beside it, on the tile's roomier side.
    const clampLeft = (x: number) => Math.max(bounds.left + GAP, Math.min(x, bounds.right - GAP - w));
    const clampTop = (y: number) => Math.max(bounds.top + GAP, Math.min(y, bounds.bottom - GAP - h));
    if (anchor.right + w <= bounds.right - GAP) {
      setPlace({ left: anchor.right, top: clampTop(anchor.top) });
    } else if (anchor.left - w >= bounds.left + GAP) {
      setPlace({ left: anchor.left - w, top: clampTop(anchor.top) });
    } else if (anchor.top - h >= bounds.top + GAP) {
      setPlace({ left: clampLeft(anchor.left), top: anchor.top - h });
    } else if (anchor.bottom + h <= bounds.bottom - GAP) {
      setPlace({ left: clampLeft(anchor.left), top: anchor.bottom });
    } else if (window.innerWidth - anchor.right >= anchor.left) {
      setPlace({ left: Math.min(anchor.right, window.innerWidth - GAP - w), top: clampTop(anchor.top) });
    } else {
      setPlace({ left: Math.max(GAP, anchor.left - w), top: clampTop(anchor.top) });
    }
  }, [anchor, bounds]);

  const drawn = (
    <div ref={host} className="peek-host">
      <div
        ref={ref}
        id={id}
        role="tooltip"
        className="peek ct-panel"
        data-testid="deck-peek"
        style={place}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
      >
        <header className="peek__head">
          <span className="peek__who">
            <span className="peek__title ct-panel__title">{name ?? label}</span>
            {pilot !== undefined && <span className="peek__pilot">{pilot}</span>}
          </span>
          {deckStyle !== undefined && <DeckStyleTag style={deckStyle} />}
          <DeckColors colors={colors} label={`${label}: ${colors.length === 0 ? 'colourless' : colors.join(' ')}`} />
        </header>
        <div className="peek__body">
          {columns.map((col, i) => (
            <section key={i} className="peek__col">
              {i === 0 && <h3 className="peek__h">Main {total(list.main)}</h3>}
              {i > 0 && <h3 className="peek__h" aria-hidden="true">&nbsp;</h3>}
              <Lines lines={col.filter((l) => l.cost.length > 0)} faceIds={faceIds} />
              {col.some((l) => l.cost.length === 0) && (
                <>
                  <hr className="peek__rule" />
                  <Lines lines={col.filter((l) => l.cost.length === 0)} faceIds={faceIds} />
                </>
              )}
            </section>
          ))}
          {list.sideboard.length > 0 && (
            <section className="peek__col peek__col--side">
              <h3 className="peek__h">Sideboard {total(list.sideboard)}</h3>
              <Lines lines={[...peekOrder(list.sideboard).spells, ...peekOrder(list.sideboard).free]} faceIds={faceIds} />
            </section>
          )}
        </div>
        <div hidden>
          {faces.map((face, i) => (
            <div key={face.name} data-card-id={i}>
              <CardTile card={face} />
            </div>
          ))}
        </div>
      </div>
      <TopLayer fixed />
    </div>
  );
  return inPlace ? drawn : <OverPage>{drawn}</OverPage>;
}
