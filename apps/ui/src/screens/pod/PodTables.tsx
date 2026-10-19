/*
 * The pod's current round — wave 72 §R.2: "rounds: this round's tables
 * (players, series score, a link to watch each), your own table
 * highlighted with its Play link, and the bye named."
 *
 * Reads `RoomView.tables: RoomTable[]` (`@hadoku/shared`'s `room-tables.ts`,
 * landed on `main` since wave 71), NOT `PodView.pairings` — a table already
 * carries its players' resolved names, its series score and its live match
 * id, which is strictly more than a pairing's bare member-id tuple. See
 * `wire.ts`'s own header for why `pairings` is not mirrored there either.
 *
 * **"Play" starts the game, when it has not started yet.** `pod/rounds`
 * only seats a pairing (`matchId: null`, `series.phase: 'seating'`) —
 * nothing else begins round 1's first game, confirmed against the real
 * server (`t.matchId` stayed `null` 30 s after the leader started rounds).
 * So a seated player's OWN row shows a button, not a link, while their
 * table has no match: clicking it calls `onPlay` (`PodScreen.tsx` wires it
 * to `startTableMatch`), which is exactly `e2e/w71-boards.spec.ts`'s own
 * `POST /api/play/matches` for a constructed room's second table. Once a
 * match exists, `PodScreen.tsx`'s own effect carries a seated player to it;
 * this component never navigates on its own.
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

/** "Alice 1–0 Bob", from whichever seats are filled — no explanatory text, same rule `BoardStrip` keeps. */
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
      </ul>
      {byeId !== null && (
        <p className="pod-tables__bye" data-testid="pod-tables-bye">
          {byeId === myMemberId ? `${nameOf(byeId)} (you)` : nameOf(byeId)} has the bye
        </p>
      )}
    </div>
  );
}
