/*
 * One match of a room's rounds, at `#/room/<id>/table/<table>` — a draft pod's
 * and a Constructed tournament's alike (ruling 8,
 * `docs/planning/tournament-mode-plan.md`).
 *
 * Its two players, and for a player of it everything before the game: the
 * mode's own step (`children`: Classic's per-round deck pick, Gauntlet's
 * board), the sideboard between games (`TableSideboard`, full size), and the
 * start, which needs nobody to press anything (`useTableStart`). Once the table
 * has a game, the page follows into it, for its players and anyone watching
 * (`followMatchOnce`); back here by choice, the card is the way in again.
 *
 * Per-type differences are inputs only: the slot, and `canStart`.
 */

import { useEffect, type ReactNode } from 'react';
import type { RoomTable } from '@hadoku/shared';

import { Avatar } from '../../components/Avatar.tsx';
import { followMatchOnce } from '../../play/live/matchStart.ts';
import { navigate, routeHash } from '../route.ts';
import { TableSideboard } from '../TableSideboard.tsx';
import type { TablesClient } from '../tables.ts';
import { useTableStart } from './client.ts';
import type { PodView } from './wire.ts';

export interface TablePageProps {
  roomId: string;
  pod: PodView;
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
  /** My own step before the game, for a player of this table only. */
  children?: ReactNode;
}

export function TablePage({ roomId, pod, table, myMemberId, nameOf, avatarOf, canStart = true, refresh, tables, children }: TablePageProps) {
  const missing = table === undefined;
  useEffect(() => {
    if (missing) navigate({ kind: 'room', roomId }, { replace: true });
  }, [missing, roomId]);

  const mine = table !== undefined && table.players.some((p) => p.memberId === myMemberId);
  const current = table !== undefined && pod.phase === 'rounds' && pod.pairings.some((p) => p.tableId === table.id);
  const { error, retry } = useTableStart(roomId, mine && current ? table : undefined, canStart);

  const matchId = table?.matchId ?? null;
  useEffect(() => {
    if (matchId !== null) followMatchOnce(matchId, false);
  }, [matchId]);

  if (table === undefined) return null;
  const sideboarding = mine && matchId === null && table.series.phase === 'sideboarding';
  const pairing = pod.pairings.find((p) => p.tableId === table.id)?.players;
  // A pairing names the AI too; a table seats only its humans.
  const seats = pairing ?? table.players.map((p) => p.memberId);
  return (
    <div className="pod__room">
      <div className="pod__rounds" data-testid="table-page" data-table-id={table.id} data-phase={table.series.phase}>
        <div className="lobby__deckhead">
          <a
            className="shell__link"
            data-testid="table-hub"
            href={routeHash({ kind: 'room', roomId })}
            onClick={(e) => {
              e.preventDefault();
              navigate({ kind: 'room', roomId });
            }}
          >
            {pod.phase === 'done' ? 'Standings' : `Round ${pod.round} of ${pod.rounds}`}
          </a>
          {matchId !== null && (
            <a className="lobby__go" data-testid="table-match-link" href={routeHash({ kind: 'match', matchId })}>
              {mine ? 'Play' : 'Watch'}
            </a>
          )}
        </div>
        <ul className="pod-seats pod-seats--table" data-testid="table-seats">
          {seats.map((id, seat) => (
            <li key={seat} className="pod-seats__seat" data-testid={`table-seat-${seat}`} data-mine={id === myMemberId ? '' : undefined}>
              <span className="pod-seats__avatar">
                <Avatar id={avatarOf(id)} fallback="initial" name={nameOf(id)} className="pod-seats__avatar-img" fallbackClassName="pod-seats__avatar-fallback" />
              </span>
              <span className="pod-seats__label">{nameOf(id)}</span>
              <span className="pod-seats__wins" data-testid={`table-seat-${seat}-wins`}>
                {table.series.wins[seat] ?? 0}
              </span>
            </li>
          ))}
        </ul>
        {error !== null && (
          <div className="ct-error" role="alert" data-testid="pod-table-start-error">
            <p>{error}</p>
            <button type="button" data-testid="table-start-retry" onClick={retry}>
              Try again
            </button>
          </div>
        )}
        {sideboarding ? (
          <TableSideboard key={`${table.id}:${table.series.games.length}`} roomId={roomId} tableId={table.id} refresh={refresh} tables={tables} />
        ) : (
          mine && current && matchId === null && children
        )}
      </div>
    </div>
  );
}
