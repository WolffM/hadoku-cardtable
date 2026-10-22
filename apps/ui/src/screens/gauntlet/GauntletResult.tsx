/* The Gauntlet's end: the winner, crowned, and each game's two decks, one game to a row under the players' names. */
import type { GauntletView } from '@hadoku/shared';

import { CROWN, type DeckOption } from '../ConstructedScreen.tsx';
import { RevealedGame } from './GauntletChoose.tsx';
import { useTilePeek } from './peek.tsx';
import { PlayerName, seatOrder } from './seats.tsx';

export function GauntletResult({ view, options }: { view: GauntletView; options: ReadonlyMap<string, DeckOption> }) {
  const { bind, peek } = useTilePeek(options);
  const wins = (seat: number): number => view.games.filter((g) => g.winner === seat).length;
  return (
    <section className="gauntlet gauntlet--result" data-testid="gauntlet-result" data-phase={view.phase}>
      <div className="gauntlet__resulthead">
      <h2 className="gauntlet__title" data-testid="gauntlet-title">
        {view.era?.title}
      </h2>
      {view.winner !== null && (
        <p className="gauntlet__winner" data-testid="gauntlet-winner" data-seat={view.winner}>
          <svg className="gauntlet__crown" viewBox="0 0 12 12" aria-hidden="true">
            <path d={CROWN} />
          </svg>
          {view.players?.[view.winner].name}
          <span className="gauntlet__score" data-testid="gauntlet-score">
            {wins(view.winner)}–{wins(view.winner === 0 ? 1 : 0)}
          </span>
        </p>
      )}
      </div>
      <div className="gauntlet__games">
        <div className="gauntlet__match gauntlet__match--names">
          {seatOrder(view).map((seat, i) => (
            <div key={seat} className="gauntlet__match-seat">
              <PlayerName view={view} seat={seat} player={i === 0 ? 'p1' : 'p2'} />
            </div>
          ))}
        </div>
        {view.games.map((game, i) => (
          <RevealedGame key={i} view={view} game={game} options={options} bind={bind} index={i} names={false} />
        ))}
      </div>
      {peek}
    </section>
  );
}
