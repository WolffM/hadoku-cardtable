/*
 * A deck's list, beside its tile in the room's picker, after a second's hover —
 * the operator, 2026-10-10: *"i need a way to peek into the deck maybe can we
 * show a decklist when hovering for at least 1s?"*
 *
 * Spells by mana value with their costs, then the cards with no cost (lands,
 * mostly — a browser holds costs for this library, not types, so the line is
 * drawn by cost rather than labelled), then the sideboard. It takes no pointer
 * events: it is something to read while the pointer stays on the tile, never
 * something to catch it.
 */
import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';

import { DeckColors } from '../components/DeckView.tsx';
import { ManaCost } from '../components/ManaPip.tsx';
import type { DeckColor } from '@hadoku/deck';

/** One line of a list, with what the peek sorts and draws it by. */
export interface PeekLine {
  readonly name: string;
  readonly count: number;
  /** Cost tokens (`['1', 'R']`); empty for a card with no mana cost. */
  readonly cost: readonly string[];
  readonly manaValue: number;
}

export interface PeekList {
  readonly main: readonly PeekLine[];
  readonly sideboard: readonly PeekLine[];
}

/** How long a pointer rests on a tile before its list opens. */
export const PEEK_DELAY_MS = 1000;

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

function Lines({ lines }: { lines: readonly PeekLine[] }) {
  return (
    <ul className="peek__lines">
      {lines.map((l) => (
        <li key={l.name} className="peek__line">
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
  colors,
  list,
  anchor,
  bounds,
}: {
  id: string;
  label: string;
  colors: readonly DeckColor[];
  list: PeekList;
  /** The tile's box, and the screen's: the peek sits beside one, inside the other. */
  anchor: DOMRect;
  bounds: DOMRect;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<CSSProperties>({ visibility: 'hidden', left: 0, top: 0 });
  const { spells, free } = peekOrder(list.main);
  const mainLines = [...spells, ...free];
  // One column when the main deck fits the screen's height, two when it does not.
  const rows = Math.max(8, Math.floor(bounds.height / LINE_PX) - ROWS_RESERVED);
  const split = mainLines.length > rows ? Math.ceil(mainLines.length / 2) : mainLines.length;
  const columns = split < mainLines.length ? [mainLines.slice(0, split), mainLines.slice(split)] : [mainLines];

  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    // Beside the tile — right, else left — and only when neither side has room,
    // above it, else below it: never over the tile the pointer is resting on.
    const clampLeft = (x: number) => Math.max(bounds.left + GAP, Math.min(x, bounds.right - GAP - w));
    const clampTop = (y: number) => Math.max(bounds.top + GAP, Math.min(y, bounds.bottom - GAP - h));
    if (anchor.right + GAP + w <= bounds.right - GAP) {
      setPlace({ left: anchor.right + GAP, top: clampTop(anchor.top) });
    } else if (anchor.left - GAP - w >= bounds.left + GAP) {
      setPlace({ left: anchor.left - GAP - w, top: clampTop(anchor.top) });
    } else if (anchor.top - GAP - h >= bounds.top + GAP) {
      setPlace({ left: clampLeft(anchor.left), top: anchor.top - GAP - h });
    } else {
      setPlace({ left: clampLeft(anchor.left), top: clampTop(anchor.bottom + GAP) });
    }
  }, [anchor, bounds]);

  return (
    <div ref={ref} id={id} role="tooltip" className="peek" data-testid="deck-peek" style={place}>
      <header className="peek__head">
        <span className="peek__title">{label}</span>
        <DeckColors colors={colors} label={`${label}: ${colors.length === 0 ? 'colourless' : colors.join(' ')}`} />
      </header>
      <div className="peek__body">
        {columns.map((col, i) => (
          <section key={i} className="peek__col">
            {i === 0 && <h3 className="peek__h">Main {total(list.main)}</h3>}
            {i > 0 && <h3 className="peek__h" aria-hidden="true">&nbsp;</h3>}
            <Lines lines={col.filter((l) => l.cost.length > 0)} />
            {col.some((l) => l.cost.length === 0) && (
              <>
                <hr className="peek__rule" />
                <Lines lines={col.filter((l) => l.cost.length === 0)} />
              </>
            )}
          </section>
        ))}
        {list.sideboard.length > 0 && (
          <section className="peek__col peek__col--side">
            <h3 className="peek__h">Sideboard {total(list.sideboard)}</h3>
            <Lines lines={[...peekOrder(list.sideboard).spells, ...peekOrder(list.sideboard).free]} />
          </section>
        )}
      </div>
    </div>
  );
}
