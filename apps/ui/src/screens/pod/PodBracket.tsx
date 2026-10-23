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
 * yet paired as a dashed box. Each match is its table's card (`TableCard.tsx`):
 * both players, their decks, the score and where the game stands; a live one is
 * the way to its table page (`TablePage.tsx`) — Play on my own table, Watch on
 * anybody else's.
 *
 * A finished round comes from `PodView.results` (one per table, recorded as
 * its series ends, `room/lobby.ts`'s `#finishPodTable`), the round in play
 * from `PodView.pairings` and the tables they name. Each result is matched to
 * the table its two players sat at, oldest first, so a finished card still
 * carries its table's id.
 */

import type { RoomTable, SeriesPhase, TableGame } from '@hadoku/shared';

import { Avatar } from '../../components/Avatar.tsx';
import { routeHash } from '../route.ts';
import { TableCard } from '../TableCard.tsx';
import { resolveTable } from '../tableActions.ts';
import { isPodAi, type PodView } from './wire.ts';
import './PodBracket.css';

export interface BracketMatch {
  /** Seat order: `players[0]` is the table's first seat. An AI (`isPodAi`) is `'ai'` for a draft pod, `ai:<seat>` for a tournament's own entrant. */
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
  // A table against an AI (either shape, `isPodAi`) seats one player; the AI holds no seat at it.
  const want = players.filter((id) => !isPodAi(id));
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
  roomId: string;
  pod: PodView;
  tables: readonly RoomTable[];
  myMemberId: string | null;
  nameOf: (memberId: string) => string;
  /** A player's watchparty character, or `null` for none. */
  avatarOf: (memberId: string) => string | null;
  /** Each table's game (the room body's `tableGames`), by table id. */
  games?: Readonly<Record<string, TableGame>> | undefined;
}

/** The player's watchparty character, or their initial without one — or when it will not load. */
function Face({ id, nameOf, avatarOf }: { id: string; nameOf: (id: string) => string; avatarOf: (id: string) => string | null }) {
  return <Avatar id={avatarOf(id)} fallback="initial" name={nameOf(id)} className="pod-bracket__face" fallbackClassName="pod-bracket__face pod-bracket__face--none" width={32} height={32} />;
}

export function PodBracket({ roomId, pod, tables, myMemberId, nameOf, avatarOf, games }: PodBracketProps) {
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
              {r.matches.map((m, i) => {
                const mine = myMemberId !== null && m.players.includes(myMemberId);
                const matchId = m.table?.matchId ?? null;
                // A live card is the way in, the whole card (the operator, 2026-10-23: *"make sure we dont lose the
                // functionality of being able to click on the standings boxes to let people return to their games"*):
                // my own table's running game straight back into it, otherwise my table page (`TablePage.tsx`);
                // anybody else's table, Watch, through its table page.
                const go =
                  r.state !== 'now' || m.phase === 'done' || m.table === null
                    ? null
                    : mine
                      ? matchId !== null
                        ? { label: 'Return to game', href: routeHash({ kind: 'match', matchId }), testId: 'pod-tables-play' }
                        : { label: 'Play', href: routeHash({ kind: 'room', roomId, tableId: m.table.id }), testId: 'pod-tables-play' }
                      : { label: 'Watch', href: routeHash({ kind: 'room', roomId, tableId: m.table.id }), testId: 'pod-tables-watch' };
                return (
                  <TableCard
                    key={m.table?.id ?? i}
                    size="compact"
                    testId="pod-tables-row"
                    tableId={m.table?.id}
                    players={m.players}
                    nameOf={nameOf}
                    avatarOf={avatarOf}
                    myMemberId={myMemberId}
                    series={{ length: m.table?.series.length ?? 1, wins: m.wins, played: m.table?.series.games.length ?? m.wins[0] + m.wins[1], phase: m.phase }}
                    matchId={r.state === 'now' ? matchId : null}
                    game={m.table === null ? undefined : games?.[m.table.id]}
                    go={go}
                    onConcede={go !== null && mine && matchId !== null && m.table !== null ? () => resolveTable('concede', roomId, m.table!.id) : undefined}
                    onDrop={mine && r.state === 'now' && m.table !== null ? () => resolveTable('drop', roomId, m.table!.id) : undefined}
                  />
                );
              })}
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
