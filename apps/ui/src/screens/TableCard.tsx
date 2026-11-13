/*
 * A table's game, one card wherever a room has games (`docs/planning/table-card-plan.md`; the operator,
 * 2026-10-23: *"a half/half box showing the decks that each person is currently playing, and the
 * current score, and the current phase of the game"*, *"consistent across all rooms that can have
 * games in them"*, then on the design, *"looks awesome, love it"*).
 *
 * Half and half, one side per table seat: the deck's art across the top (a card of the deck, by name,
 * through the art lookup), the player's face and name, the deck's name and colours, and while a game
 * runs, life and cards in hand. The series' score in the middle. A phase across the top — Start, Mid,
 * End, Sideboard — with the game and, while one runs, its turn and whose it is. The foot is the way
 * in: Return to game, Sideboard, Play or Watch, as the screen drawing it says. Beside it, a seated
 * player's own ways to resolve the game, each confirmed with the score it leaves: Concede game (any
 * room), Abandon (a constructed room: the series ends with no result) and Drop match (a pod or
 * tournament: the match is forfeited). The room leader's, seated or watching (the operator, 2026-10-30:
 * *"the room leader is the admin"*): Reset game (the game in play starts again, the score stands) and
 * DQ a player (their match is forfeited and they are out of the rounds), confirmed the same way.
 *
 * A room's own table between games, or a player's own. A pod's or tournament's hub draws its matches in the
 * bracket instead (`pod/PodBracket.tsx`), with the same ways to resolve (`tableResolve.tsx`). What the card
 * shows comes from the room body: the table (`RoomTable`) and its game (`tableGames`, `@hadoku/shared`'s
 * `TableGameSchema`).
 */
import type { SeriesPhase, TableGame, TableSeatDeck } from '@hadoku/shared';

import { Avatar, type Face } from '@hadoku/game-ui/components/Avatar.tsx';
import { PlayerName } from '@hadoku/game-ui/room/look.tsx';
import { DeckColors } from '../components/DeckView.tsx';
import { DeckArt } from './ConstructedScreen.tsx';
import { deckCardArtId, useNamedArt } from './libraryPeek.ts';
import { useTableResolve, type TableResolveHandlers } from './tableResolve.tsx';
import './TableCard.css';

/** The four moments of a game a card can be in. */
export type TablePhase = 'start' | 'mid' | 'end' | 'sideboard';

const PHASE_LABEL: Readonly<Record<TablePhase, string>> = { start: 'Start', mid: 'Mid', end: 'End', sideboard: 'Sideboard' };
const PHASES: readonly TablePhase[] = ['start', 'mid', 'end', 'sideboard'];

/** A game's turns 1 and 2 are its opening (each seat's first turn); past them it is under way. */
const OPENING_TURNS = 2;

/** Where a table's game stands, from its series and its game. */
export function tablePhase(series: SeriesPhase, matchId: string | null, game: TableGame | undefined): TablePhase {
  if (series === 'sideboarding' || series === 'between') return 'sideboard';
  if (series === 'done') return 'end';
  const live = game?.live ?? null;
  if (matchId === null || live === null) return 'start';
  return live.turn > OPENING_TURNS ? 'mid' : 'start';
}

export interface TableCardSeries {
  length: number;
  wins: readonly [number, number];
  /** Games played so far. */
  played: number;
  phase: SeriesPhase;
}

/** The card's way in, or none. */
export interface TableCardGo {
  label: string;
  href: string;
  testId: string;
}

export interface TableCardProps extends TableResolveHandlers {
  /** By table seat. */
  players: readonly [string, string];
  nameOf: (memberId: string) => string;
  avatarOf: (memberId: string) => Face;
  myMemberId: string | null;
  series: TableCardSeries;
  matchId: string | null;
  game: TableGame | undefined;
  go: TableCardGo | null;
  testId: string;
  tableId?: string | undefined;
}

export function TableCard({ players, nameOf, avatarOf, myMemberId, series, matchId, game, go, testId, tableId, ...handlers }: TableCardProps) {
  const phase = tablePhase(series.phase, matchId, game);
  const live = phase === 'mid' || phase === 'start' ? (game?.live ?? null) : null;
  const mine = myMemberId !== null && players.includes(myMemberId);
  const finished = series.phase === 'done';
  const gameNo = series.played + 1;
  const title = finished ? 'Match over' : phase === 'sideboard' ? `Game ${gameNo} next` : `Game ${gameNo}`;
  const detail = live === null ? null : `Turn ${live.turn}${live.active === null ? '' : ` · ${nameOf(players[live.active])}`}`;
  const resolve = useTableResolve({ testId, players, nameOf, myMemberId, series, matchId, phase, menu: false, ...handlers });
  const side = (seat: 0 | 1) => {
    const id = players[seat];
    const deck = game?.decks[seat] ?? null;
    const won = finished && series.wins[seat] > series.wins[1 - seat]!;
    return (
      <div className="table-card__side" data-side={seat === 0 ? 'left' : 'right'} data-won={won ? '' : undefined} data-lost={finished && !won ? '' : undefined}>
        <SeatArt deck={deck} />
        <div className="table-card__who">
          <Avatar {...avatarOf(id)} fallback="initial" name={nameOf(id)} className="table-card__face" fallbackClassName="table-card__face table-card__face--none" width={32} height={32} />
          <PlayerName name={nameOf(id)} face={avatarOf(id)} className="table-card__name" />
        </div>
        {deck !== null && (
          <div className="table-card__deck">
            <span className="table-card__deck-name">{deck.name}</span>
            <DeckColors colors={deck.colors} />
          </div>
        )}
        {live !== null && (
          <div className="table-card__counts" data-testid={`${testId}-counts-${seat}`}>
            <span>
              Life <strong>{live.life[seat] ?? '–'}</strong>
            </span>
            <span>{live.hand[seat]} in hand</span>
          </div>
        )}
      </div>
    );
  };
  const goLink = go !== null && (
    <a className="table-card__go" data-testid={go.testId} href={go.href}>
      {go.label}
    </a>
  );
  const attrs = { 'data-testid': testId, 'data-table-id': tableId, 'data-phase': series.phase, 'data-moment': phase, 'data-mine': mine ? '' : undefined };
  return (
    <section className="table-card table-card--full ct-panel" {...attrs}>
      <header className="table-card__head">
        <span className="table-card__game">
          <strong>{title}</strong>
          {detail !== null && <span className="table-card__detail">{detail}</span>}
        </span>
        <ol className="table-card__phases" aria-label="Phase">
          {PHASES.map((p) => (
            <li key={p} className="table-card__phase" data-at={p === phase ? '' : undefined} data-past={PHASES.indexOf(p) < PHASES.indexOf(phase) ? '' : undefined}>
              {PHASE_LABEL[p]}
            </li>
          ))}
        </ol>
      </header>
      <div className="table-card__body">
        {side(0)}
        <div className="table-card__score" aria-label={`${series.wins[0]} to ${series.wins[1]}`}>
          <span className="table-card__wins">
            {series.wins[0]}–{series.wins[1]}
          </span>
          {series.length > 1 && <span className="table-card__of">Best of {series.length}</span>}
        </div>
        {side(1)}
      </div>
      {(go !== null || resolve.offers.length > 0) && (
        <footer className="table-card__foot">
          {goLink}
          {resolve.offers}
        </footer>
      )}
      {resolve.panel}
    </section>
  );
}

/** A seat's deck art: a card of the deck by name, looked up; a plain band when there is none. */
function SeatArt({ deck }: { deck: TableSeatDeck | null }) {
  useNamedArt();
  return (
    <span className="table-card__art">
      <DeckArt artId={deck?.art == null ? undefined : deckCardArtId(deck.art)} />
    </span>
  );
}
