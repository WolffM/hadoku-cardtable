/*
 * One Rally pick option, drawn for Rally's frame (cardtable#24; hadoku-rally
 * `docs/requests/CARDTABLE_PICK_CATALOGUES.md`).
 *
 *   `#/embed/<catalogue>/<id>/cards`  every card the option drafts from, by colour
 *   `#/embed/<catalogue>/<id>/pack`   a pack opened fresh on every load, fan or grid
 *
 * `App.tsx` draws this with no header, no room and no music: Rally frames it under its ranking
 * row, 330–720 px wide. The frame's height is ours to say: every change of this page's height is
 * posted to the parent as `hadoku-embed:size` (`useFrameHeight`), so nothing here scrolls inside
 * the frame unless Rally's 900 px cap makes it.
 *
 * The pack is the draft screen's own `PackView` and layout control, read-only: no `onPick`, so a
 * card opens in the fan and is never taken. Each layout is given a box sized from the frame's
 * width (`packBox`), since `PackView` fits its cards to the box it is drawn in.
 */

import { useEffect, useState } from 'react';

import type { RallyCardGroup, RallyCatalogue, RallyView } from '@hadoku/shared';

import { groupCards } from '../deck/cardOrder.ts';
import { CardTile } from '../components/CardTile.tsx';
import { PackLayoutControl, usePackLayout } from '../components/DraftScreen.tsx';
import { FAN_MIN_WIDTH, MAX_CARD_H, PackView, type PackLayout } from '../components/PackView.tsx';
import { GroupHead } from '../components/PoolView.tsx';
import { CARD_RATIO, useBox } from '../components/cardFit.ts';
import { mountInspector } from '../play/inspect/index.ts';
import { fetchRallyView, type RallyViewData } from './api.ts';
import './RallyEmbed.css';

export interface RallyEmbedProps {
  catalogue: RallyCatalogue;
  id: string;
  view: RallyView;
}

/** Rally's own message name and clamp: it draws the frame between these heights. */
const SIZE_MESSAGE = 'hadoku-embed:size';

/** Tell the framing page this element's height, now and whenever it changes. Nothing when the page is not framed. */
function useFrameHeight(el: HTMLElement | null): void {
  useEffect(() => {
    if (el === null || window.parent === window || typeof ResizeObserver === 'undefined') return;
    let last = -1;
    const post = (): void => {
      const height = Math.ceil(el.getBoundingClientRect().height);
      if (height === last) return;
      last = height;
      window.parent.postMessage({ type: SIZE_MESSAGE, height }, location.origin);
    };
    const observer = new ResizeObserver(post);
    observer.observe(el);
    post();
    return () => observer.disconnect();
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

function CardsPage({ groups }: { groups: readonly RallyCardGroup[] }) {
  // One numbering across the page: the inspector reads a tile by its `w<n>` wrapper (`PoolView.tsx`'s header).
  let n = 0;
  return (
    <>
      {groups.map((group, g) => (
        <section key={g} className="rally-embed__group">
          {group.label !== null && <h3 className="rally-embed__label">{group.label}</h3>}
          {groupCards(group.cards, 'color', (card) => card).map(([id, cards]) => (
            <div key={id} className="rally-embed__colour">
              <h4 className="rally-embed__colour-head">
                <GroupHead id={id} /> <span className="rally-embed__count">{cards.length}</span>
              </h4>
              <div className="rally-embed__grid">
                {cards.map((card) => (
                  <div key={card.cardId} className="rally-embed__tile" data-card-id={`w${n++}`}>
                    <CardTile card={card} />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </section>
      ))}
    </>
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
    </div>
  );
}
