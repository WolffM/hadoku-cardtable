/*
 * One table of a room, at `#/room/<id>/table/<table>` — a match of a draft
 * pod's or a Constructed tournament's rounds (ruling 8,
 * `docs/planning/tournament-mode-plan.md`), or a plain room's one table, whose
 * room links here between games instead of drawing the sideboard itself.
 *
 * Its two players, and for a player of it everything before the game: the
 * mode's own step (`children`: Classic's per-round deck pick, Gauntlet's
 * board), the sideboard between games (`TableSideboard`, full size), and the
 * start, which needs nobody to press anything (`useTableStart`). Once the table
 * has a game, the page follows into it, for its players and anyone watching
 * (`followMatchOnce`); back here by choice, the card is the way in again.
 *
 * A table whose start waits on both seats' Ready (a Gauntlet's draw) passes `ready`: each seat shows
 * whether it is, and mine is the lobby's own Ready (`ReadyToggle`) beside the seats.
 *
 * Per-type differences are inputs only: the slot, `canStart` and `ready`.
 */

import { useEffect, type CSSProperties, type ReactNode } from 'react';
import type { RoomTable } from '@hadoku/shared';

import { Avatar } from '../../components/Avatar.tsx';
import { StatusPill } from '../../components/StatusPill.tsx';
import { followMatchOnce } from '../../play/live/matchStart.ts';
import { navigate, routeHash } from '../route.ts';
import { TableSideboard } from '../TableSideboard.tsx';
import type { TablesClient } from '../tables.ts';
import { useTableStart } from './client.ts';
import { ReadyToggle } from './ReadyToggle.tsx';
import { REVEAL_ME_AT_MS, REVEAL_SEAT_MS, REVEAL_THEM_AT_MS, REVEAL_TITLE_MS, useOpponentReveal } from './opponentReveal.ts';
import { isPodAi, type PodView } from './wire.ts';
import '../gauntlet/gauntlet.css';
import './PodSeats.css';

/** A table's start that waits on its seats' Ready, by table seat. */
export interface TableReady {
  seats: readonly [boolean, boolean];
  disabled: boolean;
  onReady: (ready: boolean) => void;
}

export interface TablePageProps {
  roomId: string;
  /** The room's rounds; `null` for a plain room's one table, which is always the current one. */
  pod: PodView | null;
  /** The route's table, or `undefined` when the room has no such table. */
  table: RoomTable | undefined;
  myMemberId: string | null;
  nameOf: (memberId: string) => string;
  avatarOf: (memberId: string) => string | null;
  /** The mode's own gate on starting the next game (a re-picked deck, Gauntlet's banpick). */
  canStart?: boolean;
  /** The room screen's last read of the room: `TableSideboard` reads the table again on each. */
  refresh: unknown;
  /** Tests pass a client over a stub fetch. */
  tables?: TablesClient;
  /** The seats' Ready, while the table's start waits on it; mine is drawn for a player of this table only. */
  ready?: TableReady;
  /** My own step before the game, for a player of this table only. */
  children?: ReactNode;
}

export function TablePage({ roomId, pod, table, myMemberId, nameOf, avatarOf, canStart = true, refresh, tables, ready, children }: TablePageProps) {
  const missing = table === undefined;
  useEffect(() => {
    if (missing) navigate({ kind: 'room', roomId }, { replace: true });
  }, [missing, roomId]);

  const mine = table !== undefined && table.players.some((p) => p.memberId === myMemberId);
  const current = table !== undefined && (pod === null || (pod.phase === 'rounds' && pod.pairings.some((p) => p.tableId === table.id)));
  const { error, retry } = useTableStart(roomId, mine && current ? table : undefined, canStart);
  // A round's opponent is revealed to its players; a plain room's one table has no round to reveal.
  const revealing = useOpponentReveal(pod !== null && mine && current ? (table?.id ?? null) : null);

  const matchId = table?.matchId ?? null;
  useEffect(() => {
    if (matchId !== null && !revealing) followMatchOnce(matchId, false);
  }, [matchId, revealing]);

  if (table === undefined) return null;
  const sideboarding = mine && matchId === null && table.series.phase === 'sideboarding';
  const pairing = pod?.pairings.find((p) => p.tableId === table.id)?.players;
  // A pairing names the AI too; a table seats only its humans, and its AI's place is always the last
  // seat (`room/lobby.ts`'s `#newPodTable`), which the series' wins and the seats' Ready are counted by.
  const seats = pairing === undefined ? table.players.map((p) => p.memberId) : isPodAi(pairing[0]) ? [pairing[1], pairing[0]] : pairing;
  const mySeat = seats.indexOf(myMemberId ?? '');
  const heading = pod === null ? null : pod.phase === 'done' ? 'Standings' : `Round ${pod.round} of ${pod.rounds}`;
  return (
    <div className="pod__room">
      <div
        className="pod__rounds"
        data-testid="table-page"
        data-table-id={table.id}
        data-phase={table.series.phase}
        data-revealing={revealing || undefined}
        style={{ '--title-ms': `${REVEAL_TITLE_MS}ms`, '--reveal-me-at': `${REVEAL_ME_AT_MS}ms`, '--reveal-them-at': `${REVEAL_THEM_AT_MS}ms`, '--reveal-seat-ms': `${REVEAL_SEAT_MS}ms` } as CSSProperties}
      >
        <div className="lobby__deckhead">
          <span className="table-page__title">
            {heading !== null && <h2 data-testid="table-round">{heading}</h2>}
            <a
              className="shell__link"
              data-testid="table-hub"
              href={routeHash({ kind: 'room', roomId })}
              onClick={(e) => {
                e.preventDefault();
                navigate({ kind: 'room', roomId });
              }}
            >
              ← Lobby
            </a>
          </span>
          {matchId !== null && (
            <a className="lobby__go" data-testid="table-match-link" href={routeHash({ kind: 'match', matchId })}>
              {mine ? 'Play' : 'Watch'}
            </a>
          )}
        </div>
        <div className="pod-strip">
          <ul className="pod-seats pod-seats--table" data-testid="table-seats">
            {seats.map((id, seat) => {
              const isReady = ready?.seats[seat] === true;
              return (
                <li key={seat} className="pod-seats__seat" data-testid={`table-seat-${seat}`} data-mine={id === myMemberId ? '' : undefined}>
                  <span className="pod-seats__avatar" data-ready={ready === undefined ? undefined : isReady ? 'true' : 'false'}>
                    <Avatar id={avatarOf(id)} fallback="initial" name={nameOf(id)} className="pod-seats__avatar-img" fallbackClassName="pod-seats__avatar-fallback" />
                  </span>
                  <span className="pod-seats__label">{nameOf(id)}</span>
                  <span className="pod-seats__wins" data-testid={`table-seat-${seat}-wins`}>
                    {table.series.wins[seat] ?? 0}
                  </span>
                  {ready !== undefined && (
                    <StatusPill testId={`table-seat-${seat}-ready`} state={isReady ? 'yes' : 'no'} mark={isReady ? 'tick' : 'ring'} label={isReady ? 'ready' : 'not ready'} />
                  )}
                </li>
              );
            })}
          </ul>
          {!revealing && ready !== undefined && mine && current && mySeat >= 0 && (
            <ReadyToggle ready={ready.seats[mySeat] === true} disabled={ready.disabled} onReady={ready.onReady} />
          )}
        </div>
        {error !== null && (
          <div className="ct-error" role="alert" data-testid="pod-table-start-error">
            <p>{error}</p>
            <button type="button" data-testid="table-start-retry" onClick={retry}>
              Try again
            </button>
          </div>
        )}
        {revealing ? null : sideboarding ? (
          <TableSideboard key={`${table.id}:${table.series.games.length}`} roomId={roomId} tableId={table.id} refresh={refresh} tables={tables} />
        ) : (
          mine && current && matchId === null && children
        )}
      </div>
    </div>
  );
}
