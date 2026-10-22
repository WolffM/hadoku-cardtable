/*
 * The pod's rounds, as a bracket — the operator, 2026-10-20: *"would be nice
 * to show a pretty visual here for the bracket. the bracket should also have
 * these clickable boxes that lets you enter the room"*, then *"i would want to
 * see people's avatars in the boxes. and also i would want to see past matches
 * greyed out"*.
 *
 * A pod is Swiss, not knockout: every player plays every round, paired by
 * score, so there is no tree to draw. One column per round, left to right:
 * finished rounds small and greyed, the round in play full size, rounds not
 * yet paired as a dashed box. Each match is a card with both players' faces,
 * names and games won; a live one is the way in — Play on my own table, Watch
 * on anybody else's.
 *
 * A finished round comes from `PodView.results` (one per table, recorded as
 * its series ends, `room/lobby.ts`'s `#finishPodTable`), the round in play
 * from `PodView.pairings` and the tables they name. Each result is matched to
 * the table its two players sat at, oldest first, so a finished card still
 * carries its table's id.
 *
 * **"Play" starts the game only when a start failed.** The pod screen starts a
 * seated player's table on its own (`PodScreen.tsx`) and carries them to it;
 * the button is the retry after a refusal, and nothing here navigates on its own.
 */

import type { RoomTable, SeriesPhase } from '@hadoku/shared';

import { Avatar } from '../../components/Avatar.tsx';
import { routeHash } from '../route.ts';
import { POD_AI, type PodView } from './wire.ts';
import './PodBracket.css';

export interface BracketMatch {
  /** Seat order: `players[0]` is the table's first seat. The AI is `POD_AI`. */
  players: [string, string];
  wins: [number, number];
  table: RoomTable | null;
  /** The table's series phase, or `done` for a recorded result. */
  phase: SeriesPhase;
}

export type BracketRound =
  | { round: number; state: 'past' | 'now'; matches: BracketMatch[]; bye: string | null }
  | { round: number; state: 'next' };

function sameTable(table: RoomTable, players: readonly [string, string]): boolean {
  const seated = table.players.map((p) => p.memberId);
  // A table against the AI seats one player; the AI holds no seat at it.
  const want = players.filter((id) => id !== POD_AI);
  return seated.length === want.length && want.every((id, i) => seated[i] === id);
}

/** Every round of the pod, from its results, its pairings and its tables. */
export function bracketRounds(pod: PodView, tables: readonly RoomTable[]): BracketRound[] {
  const done = pod.phase === 'done';
  const live = pod.phase === 'rounds' && pod.pairings.length > 0 ? pod.round : null;
  const claimed = new Set<string>();
  const tableFor = (players: [string, string]): RoomTable | null => {
    const t = tables.find((x) => !claimed.has(x.id) && sameTable(x, players)) ?? null;
    if (t !== null) claimed.add(t.id);
    return t;
  };
  return Array.from({ length: Math.max(1, pod.rounds) }, (_, i): BracketRound => {
    const round = i + 1;
    const results = pod.results.filter((r) => r.round === round);
    const bye = results.find((r) => r.playerB === null)?.playerA ?? (round === live ? pod.bye : null);
    if (round === live) {
      const matches = pod.pairings.map((p): BracketMatch => {
        const table = tables.find((t) => t.id === p.tableId) ?? null;
        if (table !== null) claimed.add(table.id);
        return { players: p.players, wins: table?.series.wins ?? [0, 0], table, phase: table?.series.phase ?? 'seating' };
      });
      return { round, state: 'now', matches, bye };
    }
    if (results.length > 0 || (done && round <= pod.rounds)) {
      const matches = results.flatMap((r): BracketMatch[] => {
        if (r.playerB === null) return [];
        const players: [string, string] = [r.playerA, r.playerB];
        return [{ players, wins: [r.gamesA, r.gamesB], table: tableFor(players), phase: 'done' }];
      });
      return { round, state: 'past', matches, bye };
    }
    return { round, state: 'next' };
  });
}

export interface PodBracketProps {
  pod: PodView;
  tables: readonly RoomTable[];
  myMemberId: string | null;
  nameOf: (memberId: string) => string;
  /** A player's watchparty character, or `null` for none. */
  avatarOf: (memberId: string) => string | null;
  /** Starts the game at my table with no live match yet — the retry after a refused start. */
  onPlay?: (tableId: string) => void;
}

/** The player's watchparty character, or their initial without one — or when it will not load. */
function Face({ id, nameOf, avatarOf }: { id: string; nameOf: (id: string) => string; avatarOf: (id: string) => string | null }) {
  return <Avatar id={avatarOf(id)} fallback="initial" name={nameOf(id)} className="pod-bracket__face" fallbackClassName="pod-bracket__face pod-bracket__face--none" width={32} height={32} />;
}

function Card({ match, live, myMemberId, nameOf, avatarOf, onPlay }: { match: BracketMatch; live: boolean } & Omit<PodBracketProps, 'pod' | 'tables'>) {
  const mine = myMemberId !== null && match.players.includes(myMemberId);
  const finished = match.phase === 'done';
  const matchId = match.table?.matchId ?? null;
  const side = (i: 0 | 1) => {
    const id = match.players[i];
    const won = finished && match.wins[i] > match.wins[1 - i]!;
    return (
      <span className="pod-bracket__side" data-won={won ? '' : undefined} data-lost={finished && !won ? '' : undefined}>
        <Face id={id} nameOf={nameOf} avatarOf={avatarOf} />
        <span className="pod-bracket__name">{nameOf(id)}</span>
        <span className="pod-bracket__wins">{match.wins[i]}</span>
      </span>
    );
  };
  const body = (
    <>
      {side(0)}
      {side(1)}
    </>
  );
  const foot = (label: string, live?: string) => (
    <span className="pod-bracket__foot">
      {live === undefined ? <span /> : <span className="pod-bracket__live">{live}</span>}
      <span className="pod-bracket__go">{label}</span>
    </span>
  );
  let inner = body;
  if (live && matchId !== null) {
    // The whole card is the way in.
    inner = (
      <a className="pod-bracket__hit" data-testid={mine ? 'pod-tables-play' : 'pod-tables-watch'} href={routeHash({ kind: 'match', matchId })}>
        {body}
        {foot(mine ? 'Play' : 'Watch', `Game ${match.wins[0] + match.wins[1] + 1}`)}
      </a>
    );
  } else if (live && mine && !finished && onPlay !== undefined && match.table !== null) {
    const tableId = match.table.id;
    inner = (
      <button type="button" className="pod-bracket__hit" data-testid="pod-tables-play" onClick={() => onPlay(tableId)}>
        {body}
        {foot('Play')}
      </button>
    );
  }
  return (
    <div className="pod-bracket__match ct-panel" data-testid="pod-tables-row" data-table-id={match.table?.id} data-phase={match.phase} data-mine={mine ? '' : undefined}>
      {inner}
    </div>
  );
}

export function PodBracket({ pod, tables, myMemberId, nameOf, avatarOf, onPlay }: PodBracketProps) {
  const rounds = bracketRounds(pod, tables);
  return (
    <div className="pod-bracket" data-testid="pod-tables">
      {rounds.map((r) => (
        <section key={r.round} className={`pod-bracket__round pod-bracket__round--${r.state}`} data-testid="pod-bracket-round" data-state={r.state}>
          {/* A label, not a heading: the room's one heading says the round, or Standings. */}
          <div className="pod-bracket__head">Round {r.round}</div>
          {r.state === 'next' ? (
            <div className="pod-bracket__pending" />
          ) : (
            <div className="pod-bracket__list">
              {r.matches.map((m, i) => (
                <Card key={m.table?.id ?? i} match={m} live={r.state === 'now'} myMemberId={myMemberId} nameOf={nameOf} avatarOf={avatarOf} onPlay={onPlay} />
              ))}
              {r.bye !== null && (
                <div className="pod-bracket__bye" data-testid="pod-tables-bye">
                  <Face id={r.bye} nameOf={nameOf} avatarOf={avatarOf} />
                  <span className="pod-bracket__name">{nameOf(r.bye)}</span>
                  <span className="pod-bracket__tag">Bye</span>
                </div>
              )}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
