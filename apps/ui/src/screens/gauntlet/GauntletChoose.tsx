/*
 * Before each game, each seat chooses one of its own unplayed picks in secret (rulings 2 and 9).
 * The viewer's own picks are pressable and their choice wears the room's `chosen` chip; the other
 * seat's picks are drawn as available, but which one they chose never is — the view carries only
 * that they have (`choice.chosen`), and this draws only that. A deck is played, and greyed on both
 * sides, once its game is over. From the choice to the board, and while the game is played, this
 * screen stays as it was when both had chosen: no screen of the game's own comes between (the
 * operator, 2026-10-21).
 */
import type { GauntletChoice, GauntletSeatIndex, GauntletView } from '@hadoku/shared';

import { StatusPill } from '../../components/StatusPill.tsx';
import type { DeckOption } from '../ConstructedScreen.tsx';
import { DeckTile } from '../DeckTile.tsx';
import { playRole } from '../../sound/index.ts';
import { useTilePeek, type TileBinding } from './peek.tsx';
import { PlayerName, seatOrder } from './seats.tsx';

/**
 * The choice as this screen draws it: the view's own while choosing; once the game is dealt
 * (`playing`), both seats have chosen and the viewer's own is the game's deck at their seat.
 */
function choiceOf(view: GauntletView): GauntletChoice | null {
  if (view.phase !== 'playing') return view.choice;
  return { mine: view.you === null ? null : (view.games.at(-1)?.decks[view.you] ?? null), chosen: [true, true] };
}

function ChoosingSeat({
  view,
  choice,
  seat,
  player,
  options,
  bind,
  onChoose,
}: {
  view: GauntletView;
  choice: GauntletChoice | null;
  seat: GauntletSeatIndex;
  player: 'p1' | 'p2';
  options: ReadonlyMap<string, DeckOption>;
  bind: (id: string) => TileBinding;
  onChoose: (deckId: string) => void;
}) {
  const mine = view.you === seat;
  const chosen = choice?.chosen[seat] ?? false;
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
          const press =
            mine && !d.played && view.phase === 'choose'
              ? () => {
                  playRole('ui.gauntlet-choose');
                  onChoose(d.id);
                }
              : undefined;
          return (
            <DeckTile
              key={d.id}
              option={option}
              className="gauntlet-tile"
              data-testid="gauntlet-deck"
              data-status={d.status}
              data-played={d.played || undefined}
              role={mine ? 'radio' : undefined}
              checked={mine ? choice?.mine === d.id : undefined}
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
  const choice = choiceOf(view);
  return (
    <section className="gauntlet gauntlet--choose" data-testid="gauntlet-choose" data-phase={view.phase}>
      <h2 className="gauntlet__title" data-testid="gauntlet-title">
        {view.era?.title}
        <span className="gauntlet__game">Game {view.games.length + (view.phase === 'playing' ? 0 : 1)}</span>
      </h2>
      <div className="gauntlet__seats">
        <ChoosingSeat view={view} choice={choice} seat={p1} player="p1" options={options} bind={bind} onChoose={onChoose} />
        <ChoosingSeat view={view} choice={choice} seat={p2} player="p2" options={options} bind={bind} onChoose={onChoose} />
      </div>
      {peek}
    </section>
  );
}
