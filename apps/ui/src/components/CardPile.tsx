/**
 * A pile of cards: its heading (what it holds, and how many), then its cards
 * overlapped in a column, each showing its name strip, the last one whole — the
 * draft's picks and the deck builder's piles are both this, drawn by
 * `.pile` in `styles.css`. A pile taller than its box is split into `cols`
 * side-by-side columns under its one heading (`cardFit.ts`'s `pilesAt`), and
 * its card width is the `--cw` of whatever holds it.
 */

import type { ReactNode } from 'react';

import { columnsOf, cssPx, outerHeight } from './cardFit.ts';

export function CardPile<T>({
  head,
  items,
  n = items.length,
  cols,
  testid,
  mv,
  render,
}: {
  head: ReactNode;
  items: readonly T[];
  /** The count in the heading, when an item stands for more than one card (a land with its ×N). */
  n?: number;
  cols: number;
  testid: string;
  mv?: number;
  /** One item, keyed. */
  render: (item: T) => ReactNode;
}) {
  return (
    <div className="pile" data-testid={testid} data-mv={mv} data-empty={items.length === 0 ? '' : undefined}>
      <h3 className="pile__head">
        <span className="pile__label">{head}</span>
        <span className="pile__n">{n}</span>
      </h3>
      <div className="pile__cols">
        {columnsOf(items, cols).map((column, i) => (
          <div key={i} className="pile__stack">
            {column.map(render)}
          </div>
        ))}
      </div>
    </div>
  );
}

/** What a pile adds to its cards' height inside `piles`, as the stylesheet draws it: its heading, and the room under its last card. */
export function pileChrome(piles: Element | null | undefined): number {
  return outerHeight(piles?.querySelector('.pile__head'), 18) + cssPx(piles?.querySelector('.pile__stack'), 'padding-bottom', 4);
}
