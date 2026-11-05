/*
 * One Rally pick option, drawn for Rally's frame (cardtable#24; hadoku-rally
 * `docs/requests/CARDTABLE_PICK_CATALOGUES.md`).
 *
 *   `#/embed/<catalogue>/<id>/cards`  every card a source drafts from, a stacked column per colour
 *   `#/embed/<catalogue>/<id>/pack`   a pack opened fresh on every load, fan or grid
 *
 * `App.tsx` draws this with no header, no room and no music: Rally frames it under its ranking
 * row, 330–720 px wide. The frame's height is ours to say: every change of this page's height is
 * posted to the parent as `hadoku-embed:size` (`useFrameHeight`), so nothing here scrolls inside
 * the frame unless Rally's cap (`FRAME_MAX`) makes it.
 *
 * The pack is the draft screen's own `PackView` and layout control, read-only: no `onPick`, so a
 * card opens in the fan and is never taken, and in either layout hovering a card opens the shared
 * inspector, whose wheel turns a double-faced card (`PackView.tsx`'s header). Both pages hold the
 * screen's `TopLayer`, where the inspector draws. Each layout is given a box sized from the frame's
 * width (`packBox`), since `PackView` fits its cards to the box it is drawn in.
 */

import { useEffect, useState, type CSSProperties } from 'react';

import type { RallyCardGroup, RallyCatalogue, RallyView } from '@hadoku/shared';

import { groupCards } from '../deck/cardOrder.ts';
import { CardPile } from '../components/CardPile.tsx';
import { CardTile } from '../components/CardTile.tsx';
import { PackLayoutControl, usePackLayout } from '../components/DraftScreen.tsx';
import { FAN_MIN_WIDTH, MAX_CARD_H, PackView, type PackLayout } from '../components/PackView.tsx';
import { GroupHead } from '../components/PoolView.tsx';
import { CARD_RATIO, useBox } from '../components/cardFit.ts';
import { mountInspector } from '../play/inspect/index.ts';
import { TopLayer } from '../topLayer.tsx';
import { fetchRallyView, type RallyViewData } from './api.ts';
import './RallyEmbed.css';

export interface RallyEmbedProps {
  catalogue: RallyCatalogue;
  id: string;
  view: RallyView;
}

/** Rally's own message name. */
const SIZE_MESSAGE = 'hadoku-embed:size';
/** The tallest Rally draws the frame (hadoku-rally `EMBED_HEIGHT.max`); past it, this page scrolls in its frame. */
export const FRAME_MAX = 8000;

/**
 * Tell the framing page this element's height, now and whenever it changes, and keep the page's
 * own scrollbar off while the frame grows to fit it. Nothing when the page is not framed.
 *
 * The scrollbar is off because a frame fitted to its page has nothing to scroll, but the page
 * overflows for the moment between posting a new height and the frame taking it, and a scrollbar
 * drawn in that moment narrows the page. A narrower page fits its cards differently (the colour
 * columns wrap), so its height changes, and on the cards page the two heights chased each other
 * for good: 2295 px one row, 4085 px two, a second scrollbar flickering beside Rally's (ohmusama,
 * 2026-11-05). Only past Rally's cap does the page scroll, in a gutter kept from the start.
 */
function useFrameHeight(el: HTMLElement | null): void {
  useEffect(() => {
    if (el === null || window.parent === window || typeof ResizeObserver === 'undefined') return;
    const page = document.documentElement.style;
    page.setProperty('scrollbar-gutter', 'stable');
    let last = -1;
    const post = (): void => {
      const height = Math.ceil(el.getBoundingClientRect().height);
      if (height === last) return;
      last = height;
      page.setProperty('overflow-y', height > FRAME_MAX ? 'auto' : 'hidden');
      window.parent.postMessage({ type: SIZE_MESSAGE, height }, location.origin);
    };
    const observer = new ResizeObserver(post);
    observer.observe(el);
    post();
    return () => {
      observer.disconnect();
      page.removeProperty('scrollbar-gutter');
      page.removeProperty('overflow-y');
    };
  }, [el]);
}

/** The fan's own constants (`PackView.tsx`): room for the open card's rise, and the narrowest share of a card the row shows. */
const FAN_LIFT = 22 + 8;
const FAN_MIN_SHOW = 0.17;
const FAN_SLOTS = 7;
/** `.pack--grid`'s gap. */
const GRID_GAP = 10;

/**
 * The height a pack of `count` cards needs at `width` in `layout`: the fan's tallest card that
 * still fits its seven places across, or a grid of three to five columns, every row whole.
 */
export function packBox(layout: PackLayout, width: number, count: number): number {
  if (layout === 'fan' && width >= FAN_MIN_WIDTH) {
    const cardW = width / (1 + FAN_MIN_SHOW * (FAN_SLOTS - 1));
    return Math.round(Math.min(MAX_CARD_H, cardW / CARD_RATIO) + FAN_LIFT);
  }
  const cols = width < 420 ? 3 : width < 600 ? 4 : 5;
  const cardW = Math.min(MAX_CARD_H * CARD_RATIO, (width - GRID_GAP * (cols - 1)) / cols);
  const rows = Math.max(1, Math.ceil(count / cols));
  return Math.ceil(rows * (cardW / CARD_RATIO) + (rows - 1) * GRID_GAP) + 1;
}

function PackGroup({ group, layout }: { group: RallyCardGroup; layout: PackLayout }) {
  const [measure, box] = useBox<HTMLDivElement>();
  const height = box.width > 0 ? packBox(layout, box.width, group.cards.length) : undefined;
  return (
    <section className="rally-embed__group">
      {group.label !== null && <h3 className="rally-embed__label">{group.label}</h3>}
      <div className="rally-embed__pack" ref={measure} style={height === undefined ? undefined : { height }}>
        <PackView cards={group.cards} layout={layout} disabled={false} emptyNote="" />
      </div>
    </section>
  );
}

function PackPage({ packs, onRedraw }: { packs: readonly RallyCardGroup[]; onRedraw: () => void }) {
  const [layout, setLayout] = usePackLayout();
  return (
    <>
      <div className="rally-embed__bar">
        <PackLayoutControl layout={layout} onLayout={setLayout} />
        <button type="button" className="button" data-testid="rally-redraw" onClick={onRedraw}>
          New pack
        </button>
      </div>
      {packs.map((group, i) => (
        <PackGroup key={i} group={group} layout={layout} />
      ))}
    </>
  );
}

/** The widest and narrowest a card is drawn in the colour columns, and the gap between columns. */
const COLUMN_MAX_W = 140;
const COLUMN_MIN_W = 92;
const COLUMN_GAP = 8;

/**
 * How many colour columns stand side by side at `width`, and each card's width: every colour in one
 * row when they fit at `COLUMN_MIN_W`, as wide as the row allows up to `COLUMN_MAX_W`; otherwise the
 * columns wrap onto as many rows as they need.
 */
export function colourColumns(width: number, columns: number): { perRow: number; cardW: number } {
  const fits = Math.max(1, Math.floor((width + COLUMN_GAP) / (COLUMN_MIN_W + COLUMN_GAP)));
  const perRow = Math.max(1, Math.min(columns, fits));
  return { perRow, cardW: Math.min(COLUMN_MAX_W, Math.floor((width - COLUMN_GAP * (perRow - 1)) / perRow)) };
}

/**
 * Every card a source drafts from, laid out as Cube Cobra lays out a cube (the operator, 2026-11-01:
 * "vertical columns for the colors sorted by CMC and stacked cards that can be hovered and inspected"):
 * a column per colour, then multicolour, colourless and lands, each the picks' own `CardPile`, sorted
 * by mana value, every card's name strip showing and the shared inspector on hover.
 */
function CardsPage({ groups }: { groups: readonly RallyCardGroup[] }) {
  const [measure, box] = useBox<HTMLDivElement>();
  // One numbering across the page: the inspector reads a tile by its `w<n>` wrapper (`PoolView.tsx`'s header).
  let n = 0;
  return (
    <div ref={measure}>
      {groups.map((group, g) => {
        const columns = groupCards(group.cards, 'color', (card) => card);
        const fit = box.width > 0 ? colourColumns(box.width, columns.length) : null;
        return (
          <section key={g} className="rally-embed__group">
            {group.label !== null && <h3 className="rally-embed__label">{group.label}</h3>}
            <div
              className="rally-embed__columns"
              data-testid="rally-columns"
              style={fit === null ? undefined : ({ '--cw': `${fit.cardW}px`, '--pile-gap': `${COLUMN_GAP}px` } as CSSProperties)}
            >
              {columns.map(([id, cards]) => (
                <CardPile
                  key={id}
                  testid={`rally-column-${id}`}
                  head={<GroupHead id={id} />}
                  items={cards}
                  cols={1}
                  render={(card) => (
                    <div key={card.cardId} className="rally-embed__tile" data-card-id={`w${n++}`}>
                      <CardTile card={card} />
                    </div>
                  )}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

type Load = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; result: RallyViewData };

export function RallyEmbed({ catalogue, id, view }: RallyEmbedProps) {
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  /** Bumped by "New pack": the same read again, which the server deals fresh. */
  const [draw, setDraw] = useState(0);
  useFrameHeight(root);
  useEffect(() => (root === null ? undefined : mountInspector(root)), [root]);

  useEffect(() => {
    let live = true;
    setLoad((was) => (was.state === 'ready' && was.result.view === view ? was : { state: 'loading' }));
    fetchRallyView(catalogue, id, view).then(
      (result) => live && setLoad({ state: 'ready', result }),
      (err: Error) => live && setLoad({ state: 'error', message: err.message }),
    );
    return () => {
      live = false;
    };
  }, [catalogue, id, view, draw]);

  const name = load.state === 'ready' ? load.result.data.name : null;
  return (
    <div className="rally-embed" data-testid="rally-embed" data-view={view} data-state={load.state} ref={setRoot}>
      {name !== null && <h2 className="rally-embed__name">{name}</h2>}
      {load.state === 'error' && <p className="ct-error">{load.message}</p>}
      {load.state === 'ready' &&
        (load.result.view === 'cards' ? <CardsPage groups={load.result.data.groups} /> : <PackPage packs={load.result.data.packs} onRedraw={() => setDraw((d) => d + 1)} />)}
      {/* Where the inspector draws, over everything on the page (`../topLayer.tsx`). */}
      <TopLayer fixed />
    </div>
  );
}
