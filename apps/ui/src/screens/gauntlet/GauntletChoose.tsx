/*
 * Before each game, each seat chooses one of its own unplayed picks in secret (rulings 2 and 9).
 * The viewer's own picks are pressable and their choice wears the room's `chosen` chip; the other
 * seat's picks are drawn as available, but which one they chose never is — the view carries only
 * that they have (`choice.chosen`), and this draws only that. A deck is played, and greyed on both
 * sides, once its game is over. `RevealedGame` draws a game's two decks face to face; while it is
 * played the view names only the viewer's own, and the other is face down.
 */
import type { GauntletGame, GauntletSeatIndex, GauntletView } from '@hadoku/shared';

import { StatusPill, type DeckOption } from '../ConstructedScreen.tsx';
import { DeckTile } from '../DeckTile.tsx';
import { useTilePeek, type TileBinding } from './peek.tsx';
import { PlayerName, seatOrder } from './seats.tsx';

function ChoosingSeat({
  view,
  seat,
  player,
  options,
  bind,
  onChoose,
}: {
  view: GauntletView;
  seat: GauntletSeatIndex;
  player: 'p1' | 'p2';
  options: ReadonlyMap<string, DeckOption>;
  bind: (id: string) => TileBinding;
  onChoose: (deckId: string) => void;
}) {
  const mine = view.you === seat;
  const chosen = view.choice?.chosen[seat] ?? false;
  const picks = view.decks.filter((d) => d.status === 'picked' && d.by === seat);
  return (
    <div
      className="gauntlet__seat"
      data-testid={view.you === null ? 'gauntlet-choose-seat' : mine ? 'gauntlet-choose-mine' : 'gauntlet-choose-theirs'}
      data-seat={seat}
      data-chosen={chosen}
      role={mine ? 'radiogroup' : undefined}
    >
      <div className="gauntlet__seat-head">
        <PlayerName view={view} seat={seat} player={player} />
        <StatusPill testId="gauntlet-chosen" state={chosen ? 'yes' : 'no'} mark={chosen ? 'tick' : 'ring'} label={chosen ? 'Chosen' : 'Choosing'} />
      </div>
      <div className="gauntlet__picks">
        {picks.map((d) => {
          const option = options.get(d.id);
          if (option === undefined) return null;
          const press = mine && !d.played ? () => onChoose(d.id) : undefined;
          return (
            <DeckTile
              key={d.id}
              option={option}
              className="gauntlet-tile"
              data-testid="gauntlet-deck"
              data-status={d.status}
              data-played={d.played || undefined}
              role={mine ? 'radio' : undefined}
              checked={mine ? view.choice?.mine === d.id : undefined}
              disabled={press === undefined}
              onClick={press}
              {...bind(d.id)}
            />
          );
        })}
      </div>
    </div>
  );
}

export function GauntletChoose({ view, options, onChoose }: { view: GauntletView; options: ReadonlyMap<string, DeckOption>; onChoose: (deckId: string) => void }) {
  const [p1, p2] = seatOrder(view);
  const { bind, peek } = useTilePeek(options);
  return (
    <section className="gauntlet gauntlet--choose" data-testid="gauntlet-choose" data-phase={view.phase}>
      <h2 className="gauntlet__title" data-testid="gauntlet-title">
        {view.era?.title}
        <span className="gauntlet__game">Game {view.games.length + 1}</span>
      </h2>
      <div className="gauntlet__seats">
        <ChoosingSeat view={view} seat={p1} player="p1" options={options} bind={bind} onChoose={onChoose} />
        <ChoosingSeat view={view} seat={p2} player="p2" options={options} bind={bind} onChoose={onChoose} />
      </div>
      {peek}
    </section>
  );
}

/** One game's two decks, face to face, P1's first; a deck the view does not name is face down. */
export function RevealedGame({ view, game, options, bind, index }: { view: GauntletView; game: GauntletGame; options: ReadonlyMap<string, DeckOption>; bind: (id: string) => TileBinding; index: number }) {
  const order = seatOrder(view);
  return (
    <div className="gauntlet__match" data-testid="gauntlet-game" data-game={index + 1} data-winner={game.winner ?? undefined}>
      <span className="gauntlet__game">Game {index + 1}</span>
      {order.map((seat, i) => {
        const id = game.decks[seat];
        const option = id === null ? undefined : options.get(id);
        return (
          <div key={seat} className="gauntlet__match-seat" data-seat={seat} data-won={game.winner === seat || undefined}>
            <PlayerName view={view} seat={seat} player={i === 0 ? 'p1' : 'p2'} />
            {id === null ? (
              <span className="gauntlet__slot gauntlet__slot--hidden" data-testid="gauntlet-hidden" aria-hidden="true" />
            ) : (
              option !== undefined && <DeckTile option={option} className="gauntlet-tile" data-testid="gauntlet-deck" tabIndex={-1} {...bind(option.value)} />
            )}
          </div>
        );
      })}
    </div>
  );
}
