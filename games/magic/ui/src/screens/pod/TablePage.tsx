/*
 * One table of a room, at `#/room/<id>/table/<table>` — a match of a draft
 * pod's or a Constructed tournament's rounds (ruling 8,
 * `docs/planning/tournament-mode-plan.md`), or a plain room's one table, whose
 * room links here between games.
 *
 * It is a doorway: its two players face to face (`FaceOff.tsx`, played as a reveal the first
 * time a round's player reaches it), where the table stands, and ONE way on (`tableDoor.ts`):
 * Enter game, Return to game or Sideboard for its players, Watch for anyone else. It never holds
 * the sideboard itself (that is its own full screen, `…/table/<id>/sideboard`) and never walks
 * anybody into a game (the operator, 2026-11-19: *"i just need a button to get back into the
 * game"*). Before the first game it also holds the mode's own step (`children`: Classic's
 * per-round deck pick, Gauntlet's board); the game's start needs nobody to press anything
 * (`useTableStart`), and the game it makes waits for each player's own Enter game.
 *
 * A table whose start waits on both seats' Ready (a Gauntlet's draw) passes `ready`: each seat shows
 * whether it is, and mine is the lobby's own Ready (`ReadyToggle`) under the two.
 *
 * Per-type differences are inputs only: the slot, `canStart` and `ready`.
 */

import { useEffect, useState, type ReactNode } from 'react';
import type { RoomTable, TableGame } from '@hadoku/shared';

import { navigate } from '@hadoku/game-ui/screens/route.ts';
import { BackLink } from '../BackLink.tsx';
import { TableCard } from '../TableCard.tsx';
import { resolveTable } from '../tableActions.ts';
import { doorGo, tableDoor } from '../tableDoor.ts';
import { useTableStart } from './client.ts';
import { startingText } from '../queue-place.ts';
import { ReadyToggle } from './ReadyToggle.tsx';
import { FaceOff, useOpponentReveal, type FaceOffSeat } from './FaceOff.tsx';
import { TableStatus } from './TableStatus.tsx';
import { isPodAi, type PodView } from './wire.ts';
import type { Face } from '@hadoku/game-ui/components/Avatar.tsx';
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
  avatarOf: (memberId: string) => Face;
  /** The mode's own gate on starting the next game (a re-picked deck, Gauntlet's banpick). */
  canStart?: boolean;
  /** The seats' Ready, while the table's start waits on it; mine is drawn for a player of this table only. */
  ready?: TableReady;
  /** The table's game (the room body's `tableGames`), for its card while one runs. */
  game?: TableGame | undefined;
  /** My own step before the game, for a player of this table only. */
  children?: ReactNode;
  /** The room body's `away`: who has no screen open, since when. */
  away?: Readonly<Record<string, string | null>>;
}

const NOBODY_AWAY: Readonly<Record<string, string | null>> = {};

/** How often an away time moves on while the page stays open. */
const AWAY_TICK_MS = 60_000;

/** The clock the away times read, a minute at a time. */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), AWAY_TICK_MS);
    return () => clearInterval(tick);
  }, []);
  return now;
}

export function TablePage({ roomId, pod, table, myMemberId, nameOf, avatarOf, canStart = true, ready, game, children, away = NOBODY_AWAY }: TablePageProps) {
  const now = useMinuteClock();
  const missing = table === undefined;
  useEffect(() => {
    if (missing) navigate({ kind: 'room', roomId }, { replace: true });
  }, [missing, roomId]);

  const mine = table !== undefined && table.players.some((p) => p.memberId === myMemberId);
  const current = table !== undefined && (pod === null || (pod.phase === 'rounds' && pod.pairings.some((p) => p.tableId === table.id)));
  const { error, retry, queuePlace } = useTableStart(roomId, mine && current ? table : undefined, canStart);
  const game1Unentered = table !== undefined && table.series.games.length === 0 && game?.entered[table.players.findIndex((p) => p.memberId === myMemberId)] !== true;
  // A round's opponent is revealed to its players before its first game; a player back from that game is not shown it again.
  const revealing = useOpponentReveal(pod !== null && mine && current && game1Unentered ? (table?.id ?? null) : null);

  const matchId = table?.matchId ?? null;

  if (table === undefined) return null;
  const pairing = pod?.pairings.find((p) => p.tableId === table.id)?.players;
  // A pairing names the AI too; a table seats only its humans, and its AI's place is always the last
  // seat (`room/lobby.ts`'s `#newPodTable`), which the series' wins and the seats' Ready are counted by.
  const seats = pairing === undefined ? table.players.map((p) => p.memberId) : isPodAi(pairing[0]) ? [pairing[1], pairing[0]] : pairing;
  const mySeat = seats.indexOf(myMemberId ?? '');
  // Mine on the left; a watcher sees the table in seat order.
  const left = mySeat === 1 ? 1 : 0;
  const door = tableDoor(table, game, mine && mySeat >= 0 ? mySeat : null);
  const faceOff = (seat: number): FaceOffSeat => {
    const id = seats[seat] ?? '';
    return { seat, name: nameOf(id), face: avatarOf(id), wins: table.series.wins[seat] ?? 0, ready: ready === undefined ? undefined : ready.seats[seat] === true, mine: id === myMemberId };
  };
  const heading = pod === null ? null : pod.phase === 'done' ? 'Standings' : `Round ${pod.round} of ${pod.rounds}`;
  return (
    <div className="pod__room">
      <div
        className="pod__rounds"
        data-testid="table-page"
        data-table-id={table.id}
        data-phase={table.series.phase}
        data-revealing={revealing || undefined}
      >
        <div className="lobby__deckhead">
          <span className="table-page__title">
            <BackLink to={{ kind: 'room', roomId }} label="Lobby" testId="table-hub" />
            {heading !== null && <h2 data-testid="table-round">{heading}</h2>}
          </span>
        </div>
        <div className="table-page__seats">
          <FaceOff left={faceOff(left)} right={faceOff(1 - left)} scored={table.series.length > 1} revealing={revealing} />
          {!revealing && ready !== undefined && mine && current && mySeat >= 0 && (
            <ReadyToggle ready={ready.seats[mySeat] === true} disabled={ready.disabled} onReady={ready.onReady} />
          )}
        </div>
        {!revealing && <TableStatus table={table} seats={seats} pod={pod} myMemberId={myMemberId} {...(ready === undefined ? {} : { ready: ready.seats })} away={away} nameOf={nameOf} now={now} />}
        {/* Where the table stands and its one way on (`tableDoor.ts`): a game under way, or the step between two. */}
        {!revealing && door !== null && (
          <TableCard
            testId="table-game-card"
            tableId={table.id}
            players={[seats[0] ?? '', seats[1] ?? '']}
            nameOf={nameOf}
            avatarOf={avatarOf}
            myMemberId={myMemberId}
            series={{ length: table.series.length, wins: table.series.wins, played: table.series.games.length, phase: table.series.phase }}
            matchId={matchId}
            game={game}
            go={doorGo(door, roomId, table.id, 'table-match-link')}
            onConcede={mine && matchId !== null ? () => resolveTable('concede', roomId, table.id) : undefined}
            onAbandon={mine && pod === null ? () => resolveTable('abandon', roomId, table.id) : undefined}
            onDrop={mine && pod !== null ? () => resolveTable('drop', roomId, table.id) : undefined}
          />
        )}
        {queuePlace !== null && (
          <p className="lobby__note" data-testid="start-state">
            {startingText(queuePlace)}
          </p>
        )}
        {error !== null && (
          <div className="ct-error" role="alert" data-testid="pod-table-start-error">
            <p>{error}</p>
            <button type="button" data-testid="table-start-retry" onClick={retry}>
              Try again
            </button>
          </div>
        )}
        {!revealing && door === null && mine && current && children}
      </div>
    </div>
  );
}
