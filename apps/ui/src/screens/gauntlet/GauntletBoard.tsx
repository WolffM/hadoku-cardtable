/*
 * The Gauntlet's reveal and its ban/pick board, one surface: the era's title on top, P1's picks
 * in the left column and P2's in the right, the ten decks in the pool between them, and a banner
 * over the pool naming who acts and what.
 *
 * The reveal (`reveal.ts`) lands the title, flips the room's coin for P1 over the empty pool
 * (`CoinToss.tsx`), then deals the ten decks into their slots one by one. A ban greys its tile and
 * crosses it where it lies; a pick slides the tile from its slot to the picker's column (the
 * house glide, `lift.ts`'s `flip`), and its slot stays, empty, so nothing else in the pool moves.
 */
import { useLayoutEffect, useRef, type CSSProperties } from 'react';

import type { GauntletDeck, GauntletSeatIndex, GauntletView } from '@hadoku/shared';

import { CoinToss } from '../../play/live/CoinToss.tsx';
import { centreOf, flip, type At } from '../../play/lift.ts';
import { prefersReducedMotion } from '../../play/motion.ts';
import type { DeckOption } from '../ConstructedScreen.tsx';
import { DeckTile } from '../DeckTile.tsx';
import { useTilePeek } from './peek.tsx';
import { DEAL_MS, TITLE_MS, dealtAt, useReveal } from './reveal.ts';
import { PlayerName, seatOrder } from './seats.tsx';

/** Each player's picks: three. */
const PICKS = 3;

export function GauntletBoard({
  view,
  options,
  avatars,
  onBan,
  onPick,
}: {
  view: GauntletView;
  options: ReadonlyMap<string, DeckOption>;
  avatars?: readonly [string | undefined, string | undefined] | undefined;
  onBan: (deckId: string) => void;
  onPick: (deckId: string) => void;
}) {
  const reveal = useReveal(view.revealAt);
  const [p1, p2] = seatOrder(view);
  const step = view.phase === 'banpick' ? view.step : null;
  const acting = step !== null && reveal.done && view.you === step.seat;
  const { bind, tiles, peek } = useTilePeek(options);

  // A pick slides its tile from where it was drawn to where it is drawn now.
  const was = useRef<ReadonlyMap<string, At>>(new Map());
  const standing = useRef<string | null>(null);
  const standingNow = view.decks.map((d) => `${d.status}${d.by ?? ''}`).join();
  useLayoutEffect(() => {
    const now = new Map([...tiles].map(([id, el]) => [id, centreOf(el)] as const));
    if (standing.current !== null && standing.current !== standingNow && !prefersReducedMotion()) {
      flip([...tiles].flatMap(([id, el]) => {
        const from = was.current.get(id);
        return from === undefined ? [] : [[el, from] as const];
      }));
    }
    standing.current = standingNow;
    was.current = now;
  });

  const tile = (deck: GauntletDeck) => {
    const option = options.get(deck.id);
    if (option === undefined) return null;
    const press = acting && deck.status === 'open' ? () => (step.act === 'ban' ? onBan : onPick)(deck.id) : undefined;
    // Dealt during the reveal: it falls into its slot, joined part-way if it was already falling when this screen opened.
    const since = reveal.joinedAt - dealtAt(view.decks.indexOf(deck));
    const fresh = !reveal.done && since < DEAL_MS;
    return (
      <DeckTile
        key={deck.id}
        option={option}
        className="gauntlet-tile"
        data-testid="gauntlet-deck"
        data-status={deck.status}
        data-played={deck.played || undefined}
        data-dealing={fresh || undefined}
        style={fresh ? ({ '--deal-ms': `${DEAL_MS}ms`, '--deal-delay': `${-Math.max(0, since)}ms` } as CSSProperties) : undefined}
        disabled={press === undefined}
        onClick={press}
        {...bind(deck.id)}
      >
        {deck.status === 'banned' && (
          <svg className="gauntlet-tile__cross" data-testid="gauntlet-cross" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            <path d="M10 10 90 90" pathLength={1} />
            <path d="M90 10 10 90" pathLength={1} />
          </svg>
        )}
      </DeckTile>
    );
  };

  const column = (seat: GauntletSeatIndex, player: 'p1' | 'p2') => {
    const picks = view.decks.filter((d) => d.status === 'picked' && d.by === seat);
    return (
      <div className="gauntlet__column" data-testid="gauntlet-column" data-seat={seat} data-player={player} data-you={view.you === seat || undefined}>
        {picks.map(tile)}
        {Array.from({ length: Math.max(0, PICKS - picks.length) }, (_, i) => (
          <span key={i} className="gauntlet__slot" aria-hidden="true" />
        ))}
      </div>
    );
  };

  return (
    <section className="gauntlet" data-testid="gauntlet" data-phase={view.phase} data-revealing={!reveal.done || undefined}>
      <h2 className="gauntlet__title" data-testid="gauntlet-title" style={{ '--title-ms': `${TITLE_MS}ms`, '--title-delay': `${-reveal.joinedAt}ms` } as CSSProperties}>
        {view.era?.title}
      </h2>
      <div className="gauntlet__board">
        <PlayerName view={view} seat={p1} player="p1" unknown={reveal.dealt === 0} />
        <p
          className="gauntlet__turn"
          data-testid={step === null || !reveal.done ? undefined : 'gauntlet-turn'}
          data-seat={step?.seat}
          data-you={acting || undefined}
          data-idle={step === null || !reveal.done || undefined}
        >
          {step !== null && (
            <>
              <span className="gauntlet__who">{view.players?.[step.seat].name}</span>
              <span className="gauntlet__act">
                {step.act === 'ban' ? 'Ban' : 'Pick'} {step.count - step.taken}
              </span>
            </>
          )}
        </p>
        <PlayerName view={view} seat={p2} player="p2" unknown={reveal.dealt === 0} />
        {column(p1, 'p1')}
        <div className="gauntlet__pool" data-testid="gauntlet-pool">
          {view.decks.map((d, i) =>
            i >= reveal.dealt ? (
              <span key={d.id} className="gauntlet__slot gauntlet__slot--deal" aria-hidden="true" />
            ) : d.status === 'picked' ? (
              <span key={d.id} className="gauntlet__slot" data-testid="gauntlet-slot" aria-hidden="true" />
            ) : (
              tile(d)
            ),
          )}
          {reveal.coin && view.revealAt !== null && view.first !== null && (
            <div className="gauntlet__coin">
              <CoinToss
                winner={view.first}
                name={view.players?.[view.first].name ?? ''}
                avatarId={avatars?.[view.first]}
                loserAvatarId={avatars?.[view.first === 0 ? 1 : 0]}
                at={view.revealAt + TITLE_MS}
              />
            </div>
          )}
        </div>
        {column(p2, 'p2')}
      </div>
      {peek}
    </section>
  );
}
