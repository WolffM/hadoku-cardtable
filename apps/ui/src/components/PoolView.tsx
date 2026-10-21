/**
 * The picked pool — everything this seat has taken, and only this seat.
 *
 * Grouped by colour or by mana value, the drafter's choice (the operator,
 * 2026-10-21: *"choose between CMC vs color sorting during drafting"*) —
 * `deck/cardOrder.ts`'s groups, the ones the deck builder's piles use, so a
 * card sits under the same heading in both. Colour counts sit above.
 *
 * ## The deck in progress and its sideboard
 *
 * Picks are the deck in progress, and the drafter drags the ones they will not
 * play onto the sideboard pile at the end of the row, or back (the operator,
 * 2026-10-21, Arena-style). The split is not this view's: it is the drafter's
 * one build (`draftBuild`, saved as the pod's deck), which the deck builder
 * opens on. The drag is `deck/dragMove.tsx`'s, the builder's own.
 *
 * ## Fitted, never scrolled
 *
 * The piles are drawn at the largest card size at which every one fits the
 * box (`cardFit.ts`'s `fitPiles`); a pile taller than the box splits into
 * side-by-side columns under its one heading.
 *
 * Pool cards are not pickable and render without a button, so a stray click on
 * your own pool cannot send anything.
 *
 * ## The shared inspector, without teaching it a second vocabulary
 *
 * `play/inspect/index.ts`'s `TILE_ID` only matches a tile's own `data-card-id`
 * against `w<digits>` — the board's convention for a live Forge id — and this
 * file may not edit that module to add one for a drafted card's real id (`c0`,
 * `c1`, …). So each tile sits inside its own wrapper carrying a synthetic
 * `w<n>` id of this view's own numbering; the tile underneath keeps its real
 * id, which is what `e2e/draft.spec.ts` and `DraftScreen.test.ts` read. The
 * wrapper is display-only and never a key anything picks or saves by. The
 * mount itself is the caller's (`PodScreen.tsx`'s), the same way `DeckEditor`
 * and `DeckPeek` each mount their own.
 *
 * `PackView.tsx`'s pack slots number their own tiles `w0, w1, …` on the SAME
 * screen (`DraftScreen` renders both at once), so this view starts numbering
 * at `POOL_ID_OFFSET` rather than 0 — two different cards sharing one id would
 * make the inspector's own id lookup (`inspectedCardFrom`, by `querySelector`)
 * find whichever the DOM happens to list first. `POOL_ID_OFFSET` is well past
 * any pack size a cube deals (15 is the largest in this repo's recipes).
 *
 * ## A pick is a FLIP, on this view's own tile
 *
 * `recentlyAdded` names the card that just arrived and where its pack slot
 * was; `PoolTile` reads both once, at mount, in a layout effect — see its own
 * header for the mechanics. `DraftScreen.tsx`'s header has the rest.
 */

import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';

import type { DraftCard, ManaColor } from '../draft/types.ts';
import { MV_SPAN, groupCards, mvLabel, type GroupBy, type GroupId } from '../deck/cardOrder.ts';
import { DraggableCard, DropArea, useCardSplit, type Area } from '../deck/dragMove.tsx';
import { uiPx } from '../settings/ui-scale.ts';
import { CardPile, pileChrome } from './CardPile.tsx';
import { CardTile } from './CardTile.tsx';
import { cssPx, fitPiles, useBox } from './cardFit.ts';
import { ColorSymbol, type ColorSymbolId } from './ColorSymbol.tsx';
import { ManaPip } from './ManaPip.tsx';

const COLORS: readonly ManaColor[] = ['W', 'U', 'B', 'R', 'G'];

/** The largest a pick is drawn, at 100%. */
const MAX_POOL_W = 140;

function GroupHead({ id }: { id: GroupId }) {
  if (id === 'L') return <i className="ms ms-land" aria-label="lands" />;
  if (/^[WUBRGMC]$/.test(id)) return <ColorSymbol symbol={id as ColorSymbolId} />;
  return <>{mvLabel(id)}</>;
}

/** See the header: disjoint from `PackView.tsx`'s `w0..w14`-ish numbering. */
const POOL_ID_OFFSET = 1000;

/**
 * How long a tile's entrance FLIP runs — the one duration `styles.css`'s
 * `pool__tile--enter` transition, this file's own cleanup timer, and
 * `DraftScreen.tsx`'s own (which clears `recentlyAdded` so the NEXT pick can
 * set it again) all read, so the three can never drift apart.
 */
export const POOL_ENTER_MS = 280;

/** The corner of `DOMRect` a FLIP needs — plain numbers, so a test can build one without a real layout. */
export interface PoolEnterRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PoolViewProps {
  cards: readonly DraftCard[];
  /** The drafter a watcher is looking at, or null for the viewer's own pool. */
  owner?: string | null;
  /**
   * The card that just arrived, and where its pack slot was — `null` turns
   * the FLIP off entirely (a snapshot restore, a reduced-motion viewer; see
   * `DraftScreen.tsx`).
   */
  recentlyAdded: { cardId: string; from: PoolEnterRect } | null;
  /** How the picks are grouped. */
  groupBy?: GroupBy;
  /** Absent: no choice offered (a watcher's view keeps the drafter's default). */
  onGroupBy?: (by: GroupBy) => void;
  /** The picks in the sideboard, when the viewer's own picks are split; absent draws every pick as one pool. */
  sideboard?: readonly DraftCard[];
  /** Move a pick to the deck or the sideboard, by its `cardId`. Absent: nothing drags. */
  onMove?: (cardId: string, to: Area) => void;
}

export function PoolView({ cards, recentlyAdded, owner = null, groupBy = 'color', onGroupBy, sideboard, onMove }: PoolViewProps) {
  const counts = COLORS.map(
    (c) => [c, cards.filter((card) => card.colors.includes(c)).length] as const,
  );
  const [measure, box, curve] = useBox<HTMLDivElement>();

  // The whole pool takes a drop: a pick let go anywhere off its own area moves to the other.
  const split = useCardSplit((cardId, to) => onMove?.(cardId, to));

  const side = new Set((sideboard ?? []).map((c) => c.cardId));
  const groups = groupCards(
    cards.filter((c) => !side.has(c.cardId)),
    groupBy,
    (c) => c,
  );
  const piles = sideboard === undefined ? groups : [...groups, ['side', [...sideboard]] as [GroupId, DraftCard[]]];
  const measured = box.width > 0 && box.height > 0;
  // The gap between piles and what a pile adds to its cards, as the stylesheet draws them (at the UI scale).
  const fit = measured
    ? fitPiles(
        piles.map(([, pile]) => pile.length),
        { width: box.width, height: box.height - pileChrome(curve) },
        cssPx(curve, 'column-gap', 12),
        uiPx(MAX_POOL_W, curve),
      )
    : null;
  const style = fit === null ? undefined : ({ '--cw': `${fit.cardW.toFixed(1)}px` } as CSSProperties);

  // The synthetic inspector id is a running count over every tile this view
  // draws, in the ORDER THEY RENDER — not a index derived from `cards`, which
  // would collide once a bucket skips the first few indices.
  let tileAt = POOL_ID_OFFSET;
  const pile = (id: GroupId, bucket: readonly DraftCard[], at: number, from: Area) => (
    <CardPile
      key={id}
      testid={id === 'side' ? 'pool-side' : `pool-bucket-${id}`}
      head={id === 'side' ? 'Sideboard' : <GroupHead id={id} />}
      items={bucket}
      cols={fit?.cols[at] ?? 1}
      render={(card) => (
        <PoolTile
          key={card.cardId}
          card={card}
          tileId={`w${tileAt++}`}
          enterFrom={card.cardId === recentlyAdded?.cardId ? recentlyAdded.from : null}
          from={onMove === undefined ? null : from}
        />
      )}
    />
  );

  return (
    <section className="pool" data-testid="pool" data-group-by={groupBy} aria-label="Your picked pool" {...(onMove === undefined ? {} : split.handlers)}>
      <header className="pool__head">
        <h2 className="pool__title">
          {owner === null ? 'Your pool' : `${owner}'s pool`} <span data-testid="pool-count">{cards.length}</span>
        </h2>
        <div className="pool__colors">
          {counts.map(([color, n]) => (
            <span
              key={color}
              className={n === 0 ? 'pool__color pool__color--none' : 'pool__color'}
              data-testid={`pool-color-${color}`}
            >
              <ManaPip token={color} />
              <span className="pool__color-n">{n}</span>
            </span>
          ))}
        </div>
        {onGroupBy && (
          <div className="segmented pool__sort" role="group" aria-label="group picks">
            {(
              [
                ['mv', <span key="mv">{MV_SPAN}</span>, 'by mana value'],
                ['color', <ColorSymbol key="c" symbol="M" />, 'by colour'],
              ] as const
            ).map(([by, glyph, label]) => (
              <button
                key={by}
                type="button"
                className={groupBy === by ? 'segmented__on' : ''}
                data-testid={`pool-sort-${by}`}
                aria-pressed={groupBy === by}
                aria-label={label}
                title={label}
                onClick={() => onGroupBy(by)}
              >
                {glyph}
              </button>
            ))}
          </div>
        )}
      </header>

      {cards.length === 0 ? (
        <p className="pool__note">Nothing picked yet.</p>
      ) : (
        <div className="pool__curve" ref={measure} style={style}>
          {onMove === undefined ? (
            groups.map(([id, bucket], at) => pile(id, bucket, at, 'deck'))
          ) : (
            <>
              <DropArea area="deck" over={split.over} className="pool__main" testid="pool-main">
                {groups.map(([id, bucket], at) => pile(id, bucket, at, 'deck'))}
              </DropArea>
              <DropArea area="pool" over={split.over} className="pool__sideboard" testid="pool-sideboard">
                {pile('side', sideboard ?? [], groups.length, 'pool')}
              </DropArea>
            </>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * One pool tile, and the FLIP that plays once if it just arrived.
 *
 * `enterFrom` is read in a LAYOUT effect — before the browser paints the tile
 * where it now sits — so the FIRST frame ever painted already shows the
 * INVERTED position: transform set to slide it back to the pack slot's rect,
 * transition off. The next frame (`requestAnimationFrame`, after that paint
 * has had a chance to happen) turns the transition back on and clears the
 * transform, so the browser PLAYs the move from there to here. A card is
 * never visible at its real position without having been asked to animate
 * into it first.
 *
 * `enterFrom` is read once — `useRef` so a later render (the `null` that
 * clears `DraftScreen`'s own state after `POOL_ENTER_MS`) does not restart it.
 * `pool__tile--enter` carries the transition and lets a click through the
 * tile in flight (`styles.css`); nothing reads the class once React drops it
 * on the state-driven re-render.
 */
function PoolTile({ card, tileId, enterFrom, from }: { card: DraftCard; tileId: string; enterFrom: PoolEnterRect | null; from: Area | null }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [entering, setEntering] = useState(enterFrom !== null);
  const playedFor = useRef<PoolEnterRect | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    // Already played for this arrival (or there was none): the `null` that
    // follows a real `enterFrom` must not undo anything or restart a timer.
    if (el === null || enterFrom === null || playedFor.current === enterFrom) return;
    playedFor.current = enterFrom;

    const to = el.getBoundingClientRect();
    const dx = enterFrom.left - to.left;
    const dy = enterFrom.top - to.top;
    const scale = to.width > 0 ? enterFrom.width / to.width : 1;

    el.style.transition = 'none';
    el.style.transform = `translate(${dx}px, ${dy}px) scale(${scale})`;
    // Force the browser to commit the line above before the next one asks it
    // to animate away from it — without this the two writes coalesce into one
    // frame and nothing ever appears to move.
    void el.getBoundingClientRect();

    const raf = requestAnimationFrame(() => {
      el.style.transition = '';
      el.style.transform = '';
    });
    const timer = setTimeout(() => setEntering(false), POOL_ENTER_MS);
    // Cut short (the arrival cleared before this frame or timer ran — a
    // loaded browser, or a remount late in the window), the tile still ends
    // at its own place: left inverted, it sits over the pack slot and takes
    // the next pick's click.
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      el.style.transition = '';
      el.style.transform = '';
      setEntering(false);
    };
  }, [enterFrom]);

  return (
    <DraggableCard ref={ref} className={entering ? 'pool__tile pool__tile--enter' : 'pool__tile'} data-card-id={tileId} from={from} dragKey={card.cardId}>
      <CardTile card={card} />
    </DraggableCard>
  );
}
