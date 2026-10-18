/**
 * The picked pool — everything this seat has taken, and only this seat.
 *
 * Grouped by colour, because the question a drafter asks of their own pool
 * mid-pack is "what am I actually in", and a flat list in pick order answers a question nobody
 * asks. Colour counts sit above it for the same reason. Within a colour, cards
 * sort by mana value then name, so each group still reads as a mini curve.
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

import { useLayoutEffect, useRef, useState } from 'react';

import type { DraftCard, ManaColor } from '../draft/types.ts';
import { CardTile } from './CardTile.tsx';
import { ManaPip } from './ManaPip.tsx';

const COLORS: readonly ManaColor[] = ['W', 'U', 'B', 'R', 'G'];

/** A pool card's bucket: one of the five colours, or off to either side of them. */
type ColorGroup = ManaColor | 'multi' | 'colorless';

const GROUP_ORDER: readonly ColorGroup[] = ['W', 'U', 'B', 'R', 'G', 'multi', 'colorless'];
const GROUP_LABEL: Record<'multi' | 'colorless', string> = { multi: 'Multicolor', colorless: 'Colorless' };

function colorGroupOf(card: DraftCard): ColorGroup {
  if (card.colors.length === 0) return 'colorless';
  if (card.colors.length > 1) return 'multi';
  return card.colors[0]!;
}

function byColor(cards: readonly DraftCard[]): Array<[ColorGroup, DraftCard[]]> {
  const buckets = new Map<ColorGroup, DraftCard[]>();
  for (const card of cards) {
    const key = colorGroupOf(card);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(card);
    else buckets.set(key, [card]);
  }
  for (const bucket of buckets.values()) bucket.sort((a, b) => a.manaValue - b.manaValue || a.name.localeCompare(b.name));
  return GROUP_ORDER.filter((g) => buckets.has(g)).map((g) => [g, buckets.get(g)!]);
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
  /**
   * The card that just arrived, and where its pack slot was — `null` turns
   * the FLIP off entirely (a snapshot restore, a reduced-motion viewer; see
   * `DraftScreen.tsx`).
   */
  recentlyAdded: { cardId: string; from: PoolEnterRect } | null;
}

export function PoolView({ cards, recentlyAdded }: PoolViewProps) {
  const counts = COLORS.map(
    (c) => [c, cards.filter((card) => card.colors.includes(c)).length] as const,
  );

  // The synthetic inspector id is a running count over every tile this view
  // draws, in the ORDER THEY RENDER — not a index derived from `cards`, which
  // would collide once a bucket skips the first few indices.
  let tileAt = POOL_ID_OFFSET;

  return (
    <section className="pool" data-testid="pool" aria-label="Your picked pool">
      <header className="pool__head">
        <h2 className="pool__title">
          Your pool <span data-testid="pool-count">{cards.length}</span>
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
      </header>

      {cards.length === 0 ? (
        <p className="pool__note">Nothing picked yet.</p>
      ) : (
        <div className="pool__curve">
          {byColor(cards).map(([group, bucket]) => (
            <div key={group} className="pool__bucket" data-testid={`pool-bucket-${group}`}>
              <h3 className="pool__bucket-title">
                {group === 'multi' || group === 'colorless' ? GROUP_LABEL[group] : <ManaPip token={group} />}{' '}
                <span className="pool__bucket-n">({bucket.length})</span>
              </h3>
              <div className="pool__bucket-cards">
                {bucket.map((card) => {
                  const tileId = `w${tileAt++}`;
                  return (
                    <PoolTile
                      key={card.cardId}
                      card={card}
                      tileId={tileId}
                      enterFrom={card.cardId === recentlyAdded?.cardId ? recentlyAdded.from : null}
                    />
                  );
                })}
              </div>
            </div>
          ))}
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
 * `pool__tile--enter` only exists to give the wrapper a real box for the
 * transform to apply to (`display: contents` normally, `styles.css`); nothing
 * reads the class once React drops it on the state-driven re-render.
 */
function PoolTile({ card, tileId, enterFrom }: { card: DraftCard; tileId: string; enterFrom: PoolEnterRect | null }) {
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
    // at its own place as `display: contents`: left inverted and `display:
    // block`, it sits over the pack slot and takes the next pick's click.
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      el.style.transition = '';
      el.style.transform = '';
      setEntering(false);
    };
  }, [enterFrom]);

  return (
    <div ref={ref} className={entering ? 'pool__tile pool__tile--enter' : 'pool__tile'} data-card-id={tileId}>
      <CardTile card={card} />
    </div>
  );
}
