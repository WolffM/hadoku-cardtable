/*
 * The Gauntlet's reveal and its ban/pick board, one surface: the era's title on top, P1's picks
 * in the left column and P2's in the right, the ten decks in the pool between them, and a banner
 * over the pool naming who acts and what.
 *
 * The reveal (`reveal.ts`) lands the title, flips the room's coin for P1 over the empty pool
 * (`CoinToss.tsx`), then deals the ten decks into their slots one by one. A ban greys its tile and
 * crosses it where it lies; a pick slides the tile from its slot to the picker's column (the
 * house glide, `lift.ts`'s `flip`), and its slot stays, empty, so nothing else in the pool moves.
 *
 * `leaving`: the board as the snake's last pick left it, drawn under the choose screen while that
 * screen arrives (`arrive.ts`). Nothing on it can be pressed or found: no test ids, no peek, inert.
 * What the choose screen carries on from it (each surviving deck, the names, the title) steps aside
 * here at once, and under `prefers-reduced-motion` all of it stays for the crossfade instead.
 */
import { useContext, useLayoutEffect, useRef, type CSSProperties } from 'react';

import type { GauntletDeck, GauntletSeatIndex, GauntletView } from '@hadoku/shared';

import { TossCoin } from '../../play/live/CoinToss.tsx';
import { centreOf, flip, type At } from '../../play/lift.ts';
import { prefersReducedMotion } from '../../play/motion.ts';
import type { DeckOption } from '../ConstructedScreen.tsx';
import { DeckTile } from '../DeckTile.tsx';
import { useTilePeek } from './peek.tsx';
import { DEAL_MS, TITLE_MS, dealtAt, useReveal } from './reveal.ts';
import { PlayerName, SeatFaces, seatOrder } from './seats.tsx';
import { useGauntletSounds } from './sounds.ts';

/** Each player's picks: three. */
const PICKS = 3;

export function GauntletBoard({
  view,
  options,
  onBan,
  onPick,
  leaving = false,
}: {
  view: GauntletView;
  options: ReadonlyMap<string, DeckOption>;
  onBan: (deckId: string) => void;
  onPick: (deckId: string) => void;
  leaving?: boolean;
}) {
  const faces = useContext(SeatFaces);
  const reveal = useReveal(view.revealAt);
  useGauntletSounds(view.decks, reveal);
  const [p1, p2] = seatOrder(view);
  const step = view.phase === 'banpick' ? view.step : null;
  const acting = !leaving && step !== null && reveal.done && view.you === step.seat;
  // The board being left is found by nothing: the choose screen it lies under holds every id.
  const tid = (id: string): string | undefined => (leaving ? undefined : id);
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
        data-testid={tid('gauntlet-deck')}
        data-status={deck.status}
        data-played={deck.played || undefined}
        data-dealing={fresh || undefined}
        style={fresh ? ({ '--deal-ms': `${DEAL_MS}ms`, '--deal-delay': `${-Math.max(0, since)}ms` } as CSSProperties) : undefined}
        disabled={press === undefined}
        onClick={press}
        {...bind(deck.id)}
      >
        {deck.status === 'banned' && (
          <svg className="gauntlet-tile__cross" data-testid={tid('gauntlet-cross')} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
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
      <div className="gauntlet__column" data-testid={tid('gauntlet-column')} data-seat={seat} data-player={player} data-you={view.you === seat || undefined}>
        {picks.map(tile)}
        {Array.from({ length: Math.max(0, PICKS - picks.length) }, (_, i) => (
          <span key={i} className="gauntlet__slot" aria-hidden="true" />
        ))}
      </div>
    );
  };

  return (
    <section
      className={leaving ? 'gauntlet gauntlet--leaving' : 'gauntlet'}
      data-testid={tid('gauntlet')}
      data-phase={view.phase}
      data-revealing={!reveal.done || undefined}
      data-leaving={leaving ? (prefersReducedMotion() ? 'fade' : 'move') : undefined}
      inert={leaving || undefined}
      aria-hidden={leaving || undefined}
    >
      <div className="gauntlet__head">
        <h2 className="gauntlet__title" data-testid={tid('gauntlet-title')} style={{ '--title-ms': `${TITLE_MS}ms`, '--title-delay': `${-reveal.joinedAt}ms` } as CSSProperties}>
          <span className="gauntlet__era">{view.era?.title}</span>
        </h2>
        <p
          className="gauntlet__turn"
          data-testid={step === null || !reveal.done ? undefined : tid('gauntlet-turn')}
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
      </div>
      <div className="gauntlet__board">
        <PlayerName view={view} seat={p1} player="p1" unknown={reveal.dealt === 0} />
        <PlayerName view={view} seat={p2} player="p2" unknown={reveal.dealt === 0} />
        {column(p1, 'p1')}
        <div className="gauntlet__pool" data-testid={tid('gauntlet-pool')}>
          {view.decks.map((d, i) =>
            i >= reveal.dealt ? (
              <span key={d.id} className="gauntlet__slot gauntlet__slot--deal" aria-hidden="true" />
            ) : d.status === 'picked' ? (
              <span key={d.id} className="gauntlet__slot" data-testid={tid('gauntlet-slot')} aria-hidden="true" />
            ) : (
              tile(d)
            ),
          )}
          {reveal.coin && view.revealAt !== null && view.first !== null && (
            <div className="gauntlet__coin">
              <TossCoin
                toss={{
                  winner: view.first,
                  name: view.players?.[view.first].name ?? '',
                  face: faces[view.first],
                  loserFace: faces[view.first === 0 ? 1 : 0],
                  at: view.revealAt + TITLE_MS,
                }}
              />
            </div>
          )}
        </div>
        {column(p2, 'p2')}
      </div>
      {!leaving && peek}
    </section>
  );
}
