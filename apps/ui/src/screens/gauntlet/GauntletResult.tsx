/* The Gauntlet's end: the winner, crowned, and each game's two decks. */
import type { GauntletView } from '@hadoku/shared';

import { CROWN, type DeckOption } from '../ConstructedScreen.tsx';
import { RevealedGame } from './GauntletChoose.tsx';
import { useTilePeek } from './peek.tsx';
import { seatOrder } from './seats.tsx';

export function GauntletResult({ view, options }: { view: GauntletView; options: ReadonlyMap<string, DeckOption> }) {
  const { bind, peek } = useTilePeek(options);
  const wins = (seat: number): number => view.games.filter((g) => g.winner === seat).length;
  const [p1, p2] = seatOrder(view);
  return (
    <section className="gauntlet gauntlet--result" data-testid="gauntlet-result" data-phase={view.phase}>
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
            {wins(p1)}–{wins(p2)}
          </span>
        </p>
      )}
      <div className="gauntlet__games">
        {view.games.map((game, i) => (
          <RevealedGame key={i} view={view} game={game} options={options} bind={bind} index={i} />
        ))}
      </div>
      {peek}
    </section>
  );
}
