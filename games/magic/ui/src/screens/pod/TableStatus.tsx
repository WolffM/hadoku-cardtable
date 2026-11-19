/*
 * What a table is doing when no game of it is on (the operator, 2026-11-19, of a tournament room
 * between games: *"whats happening in this room? who is it waiting on? what phase are they in?"*):
 * the step it is at and who it waits on, each with how long they have been away when they have no
 * screen open (the room body's `away`); the games its series has played; and, in a tournament,
 * how far the round has got. Facts only: a live game has its own card (`TableCard.tsx`).
 */

import type { PodView, RoomTable } from '@hadoku/shared';

import './TableStatus.css';

export interface TableStatusInput {
  table: RoomTable;
  /** Each table seat's entrant, as the page orders them (an AI's place included). */
  seats: readonly string[];
  pod: PodView | null;
  myMemberId: string | null;
  /** Each seat's Ready, while the table's start waits on it. */
  ready?: readonly [boolean, boolean];
  /** The room body's `away`: members with no screen open, since when (ISO), or `null` when unknown. */
  away: Readonly<Record<string, string | null>>;
  nameOf: (memberId: string) => string;
  now: number;
}

export interface Waiting {
  id: string;
  name: string;
  /** `away 2h`; absent for someone with a screen open. */
  away?: string;
}

export interface TableStatusLines {
  /** `Before game 1` / `Sideboarding before game 2` / `Before game 2`; null while a game is on or the series is over. */
  step: string | null;
  /** Who the next game waits on: the table's people who have not readied, never me. */
  waiting: Waiting[];
  /** Each game played: its number and how it went. */
  games: { label: string; result: string }[];
  /** `Round 1 · 3 of 4 matches done`, in a tournament's rounds. */
  round: string | null;
}

/** `away 5m`, `away 2h`, `away 3d`; bare `away` when the server has not seen them since it started. */
export function awayLabel(since: string | null, now: number): string {
  if (since === null) return 'away';
  const minutes = Math.max(1, Math.floor((now - Date.parse(since)) / 60_000));
  if (minutes < 60) return `away ${String(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `away ${String(hours)}h` : `away ${String(Math.floor(hours / 24))}d`;
}

/** The current round's matches: done (a result on record) and all (those plus the ones still on). */
function roundProgress(pod: PodView): { done: number; all: number } {
  const results = pod.results.filter((r) => r.round === pod.round && r.playerB !== null);
  const played = (a: string, b: string): boolean => results.some((r) => (r.playerA === a && r.playerB === b) || (r.playerA === b && r.playerB === a));
  const open = pod.pairings.filter((p) => !played(p.players[0], p.players[1])).length + (pod.botGames?.length ?? 0);
  return { done: results.length, all: results.length + open };
}

export function tableStatus({ table, seats, pod, myMemberId, ready, away, nameOf, now }: TableStatusInput): TableStatusLines {
  const { series } = table;
  const next = series.games.length + 1;
  const between = table.matchId === null && (series.phase === 'seating' || series.phase === 'sideboarding' || series.phase === 'between');
  const step = !between ? null : series.phase === 'seating' ? 'Before game 1' : series.phase === 'sideboarding' ? `Sideboarding before game ${String(next)}` : `Before game ${String(next)}`;
  const people = new Set(table.players.map((p) => p.memberId));
  const waiting = !between
    ? []
    : seats.flatMap((id, seat): Waiting[] => {
        if (!people.has(id) || id === myMemberId || ready?.[seat] === true) return [];
        const since = away[id];
        return [{ id, name: nameOf(id), ...(since === undefined ? {} : { away: awayLabel(since, now) }) }];
      });
  const games = series.games.map((g, i) => ({ label: `Game ${String(i + 1)}`, result: g.winner === null ? 'Draw' : `${nameOf(seats[g.winner] ?? '')} won` }));
  let round: string | null = null;
  if (pod !== null && pod.phase === 'rounds' && pod.round > 0) {
    const { done, all } = roundProgress(pod);
    round = `Round ${String(pod.round)} · ${String(done)} of ${String(all)} matches done`;
  }
  return { step, waiting, games, round };
}

export function TableStatus(props: TableStatusInput) {
  const { step, waiting, games, round } = tableStatus(props);
  if (step === null && games.length === 0 && round === null) return null;
  return (
    <section className="table-status" data-testid="table-status">
      {step !== null && (
        <p className="table-status__step" data-testid="table-status-step">
          <span>{step}</span>
          {waiting.length > 0 && (
            <>
              <span className="table-status__sep">·</span>
              <span>waiting on</span>
              {waiting.map((w, i) => (
                <span key={w.id} className="table-status__who" data-testid="table-status-waiting">
                  {i > 0 && <span className="table-status__sep">,</span>}
                  <strong>{w.name}</strong>
                  {w.away !== undefined && (
                    <span className="table-status__away" data-testid="table-status-away">
                      {w.away}
                    </span>
                  )}
                </span>
              ))}
            </>
          )}
        </p>
      )}
      {games.length > 0 && (
        <ol className="table-status__games" data-testid="table-status-games">
          {games.map((g) => (
            <li key={g.label}>
              <span className="table-status__game">{g.label}</span> {g.result}
            </li>
          ))}
        </ol>
      )}
      {round !== null && (
        <p className="table-status__round" data-testid="table-status-round">
          {round}
        </p>
      )}
    </section>
  );
}
