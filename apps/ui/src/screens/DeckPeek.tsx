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
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEventHandler } from 'react';

import type { DraftCard, ManaColor } from '@hadoku/shared';
import { BACK_FACE } from '@hadoku/carddata/art';

import { CardTile } from '../components/CardTile.tsx';
import { mountInspector } from '../play/inspect/index.ts';

import { DeckColors } from '../components/DeckView.tsx';
import { ManaCost } from '../components/ManaPip.tsx';
import type { DeckColor } from '@hadoku/deck';
import type { DeckStyle } from '@hadoku/deck/library';

import { DeckStyleTag } from './DeckStyleTag.tsx';

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

const GAP = 8;
const LINE_PX = 18;
/** The rows a list column takes before the main deck splits into two. */
const ROWS_RESERVED = 5;

/** Costed cards by mana value then name, then the cost-free ones by name. */
export function peekOrder(lines: readonly PeekLine[]): { spells: PeekLine[]; free: PeekLine[] } {
  const byName = (a: PeekLine, b: PeekLine) => a.name.localeCompare(b.name);
  return {
    spells: lines.filter((l) => l.cost.length > 0).sort((a, b) => a.manaValue - b.manaValue || byName(a, b)),
    free: lines.filter((l) => l.cost.length === 0).sort(byName),
  };
}

const total = (lines: readonly PeekLine[]) => lines.reduce((n, l) => n + l.count, 0);

const COLORS: readonly ManaColor[] = ['W', 'U', 'B', 'R', 'G'];

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
): DraftCard {
  const symbols = new Set(cost.flatMap((token) => token.split('/')));
  const printed = { manaCost: [], manaValue: 0, colors: [], typeLine: '', oracleText: '', setCode: '', collectorNumber: '', rarity: 'special' } as const;
  return {
    ...printed,
    cardId: name,
    name,
    manaCost: [...cost],
    manaValue,
    colors: COLORS.filter((c) => symbols.has(c)),
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
}) {
  const ref = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<CSSProperties>({ visibility: 'hidden', left: 0, top: 0 });
  const { spells, free } = peekOrder(list.main);
  const mainLines = [...spells, ...free];
  // One column when the main deck fits the screen's height, two when it does not.
  const rows = Math.max(8, Math.floor(bounds.height / LINE_PX) - ROWS_RESERVED);
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

  return (
    <div ref={host} className="peek-host">
      <div
        ref={ref}
        id={id}
        role="tooltip"
        className="peek"
        data-testid="deck-peek"
        style={place}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
      >
        <header className="peek__head">
          <span className="peek__who">
            <span className="peek__title">{name ?? label}</span>
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
      <div className="peek__zoom" data-board-zoom="" />
    </div>
  );
}
