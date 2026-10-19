/*
 * The pod's tables, as cards along the bottom of the pod room — the
 * operator, 2026-10-19: *"for tournament rooms we always keep the bottom
 * section of the room open to cards where game rooms can be joined"*.
 *
 * Every table the pod has played at, the current round's first (the caller
 * orders them): names, series score, and the way in — Play on your own table
 * while its game is live, Watch on anybody else's. A finished table stays as
 * its result. The bye is a card of its own.
 *
 * Reads `RoomView.tables: RoomTable[]` (`@hadoku/shared`'s `room-tables.ts`),
 * NOT `PodView.pairings` — a table already carries its players' resolved
 * names, its series score and its live match id.
 *
 * **"Play" starts the game only when a start failed.** The pod screen starts
 * a seated player's table on its own (`PodScreen.tsx`) and carries them to the
 * game once it exists; this button is the retry after a refusal, and this
 * component never navigates on its own.
 */

import type { RoomTable } from '@hadoku/shared';

import { routeHash } from '../route.ts';
import './PodTables.css';

export interface PodTablesProps {
  tables: RoomTable[];
  myMemberId: string | null;
  byeId: string | null;
  nameOf: (memberId: string) => string;
  /** Starts the game at a seated table with no live match yet. Absent for a read-only view (none today). */
  onPlay?: (tableId: string) => void;
  /** Disables every "Play" button while a start is already in flight. */
  starting?: boolean;
}

function isMine(table: RoomTable, myMemberId: string | null): boolean {
  return myMemberId !== null && table.players.some((p) => p.memberId === myMemberId);
}

/** "Alice 1–0 Bob", from whichever seats are filled — no explanatory text. */
function label(t: RoomTable): string {
  const [p0, p1] = t.players;
  // A pod table with one player is against the AI (`room/lobby.ts`'s `POD_AI`).
  return `${p0?.name ?? ''} ${t.series.wins[0]}–${t.series.wins[1]} ${p1?.name ?? (t.players.length === 1 ? 'AI' : '')}`.trim();
}

export function PodTables({ tables, myMemberId, byeId, nameOf, onPlay, starting = false }: PodTablesProps) {
  return (
    <div className="pod-tables" data-testid="pod-tables">
      <ul className="pod-tables__list">
        {tables.map((t) => {
          const mine = isMine(t, myMemberId);
          return (
            <li
              key={t.id}
              className={mine ? 'pod-tables__row pod-tables__row--mine' : 'pod-tables__row'}
              data-testid="pod-tables-row"
              data-table-id={t.id}
              data-phase={t.series.phase}
              data-mine={mine ? '' : undefined}
            >
              <span className="pod-tables__who">{label(t)}</span>
              {t.matchId !== null ? (
                <a
                  className="pod-tables__link"
                  data-testid={mine ? 'pod-tables-play' : 'pod-tables-watch'}
                  href={routeHash({ kind: 'match', matchId: t.matchId })}
                >
                  {mine ? 'Play' : 'Watch'}
                </a>
              ) : (
                mine &&
                onPlay !== undefined && (
                  <button type="button" className="pod-tables__link pod-tables__link--button" data-testid="pod-tables-play" disabled={starting} onClick={() => onPlay(t.id)}>
                    Play
                  </button>
                )
              )}
            </li>
          );
        })}
        {byeId !== null && (
          <li className="pod-tables__row pod-tables__bye" data-testid="pod-tables-bye">
            {byeId === myMemberId ? `${nameOf(byeId)} (you)` : nameOf(byeId)} has the bye
          </li>
        )}
      </ul>
    </div>
  );
}
