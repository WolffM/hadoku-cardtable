/*
 * The pod's rounds, as a Swiss bracket — the operator, 2026-10-20: *"a pretty visual here for the
 * bracket … clickable boxes that lets you enter the room … people's avatars in the boxes … past matches
 * greyed out"*; 2026-10-23: *"properly seperating winners from losers … a staggered visual"*, answered
 * by the canvas "Tournament over" artboard and built from it.
 *
 * `swiss.ts` places everything: each round a column, each match on the row of its record going in,
 * lines stepping winners up and losers down, a FINAL column with everyone by place once the pod is done.
 * A match is two rows, a player each: face, name, games won. Pressing a player (or focusing them from
 * the keyboard) lights their path through the rounds; pressing again lets it go. Never on hover.
 *
 * A live match is the way into its table, the whole card (the operator, 2026-10-23: *"make sure we dont
 * lose the functionality of being able to click on the standings boxes to let people return to their
 * games"*): my own running game straight back into it, otherwise my table page (`TablePage.tsx`);
 * anybody else's, Watch, through its table page. Its ways to resolve (`tableResolve.tsx`) sit behind ⋯.
 */

import { useState, type CSSProperties, type FocusEvent } from 'react';
import type { RoomTable, TableGame } from '@hadoku/shared';

import { Avatar, type Face as AvatarFace } from '../../components/Avatar.tsx';
import { PlayerName } from '../../room/look.tsx';
import { routeHash } from '../route.ts';
import { dqPlayer, resolveTable } from '../tableActions.ts';
import { tablePhase } from '../TableCard.tsx';
import { useTableResolve } from '../tableResolve.tsx';
import { onPath, recordText, SWISS, swissLayout, type SwissMatch } from './swiss.ts';
import { isPodAi, type PodView } from './wire.ts';
import './PodBracket.css';

export interface PodBracketProps {
  roomId: string;
  pod: PodView;
  tables: readonly RoomTable[];
  myMemberId: string | null;
  /** I lead the room: each live match offers Reset game and DQ, seated or watching. */
  leader?: boolean | undefined;
  nameOf: (memberId: string) => string;
  /** A player's watchparty character, or `null` for none. */
  avatarOf: (memberId: string) => AvatarFace;
  /** Each table's game (the room body's `tableGames`), by table id. */
  games?: Readonly<Record<string, TableGame>> | undefined;
}

interface Faces {
  nameOf: (id: string) => string;
  avatarOf: (id: string) => AvatarFace;
}

/** The player's watchparty character, or their initial without one — or when it will not load. */
function Face({ id, nameOf, avatarOf, size }: Faces & { id: string; size: number }) {
  return <Avatar {...avatarOf(id)} fallback="initial" name={nameOf(id)} className="swiss__face" fallbackClassName="swiss__face swiss__face--none" width={size} height={size} />;
}

const at = (x: number, y: number, extra: CSSProperties = {}): CSSProperties => ({ left: x, top: y, ...extra });

export function PodBracket({ roomId, pod, tables, myMemberId, leader = false, nameOf, avatarOf, games }: PodBracketProps) {
  const [picked, setPicked] = useState<string | null>(null);
  const layout = swissLayout(pod, tables);
  const entrants = new Set(pod.standings.map((r) => r.id));
  const focus = picked ?? (myMemberId !== null && entrants.has(myMemberId) ? myMemberId : null);
  const faces = { nameOf, avatarOf };
  // A player row takes a press (a second press lets go) and keyboard focus; leaving it lets the path go.
  // A press focuses the row first: only a keyboard's focus picks, or the press would undo its own pick.
  const pick = (id: string) => ({
    'aria-pressed': picked === id,
    onClick: () => setPicked(picked === id ? null : id),
    onFocus: (e: FocusEvent<HTMLButtonElement>) => {
      if (e.currentTarget.matches(':focus-visible')) setPicked(id);
    },
    onBlur: () => setPicked(null),
  });
  return (
    <div className="swiss" data-testid="pod-tables" data-picked={picked ?? undefined}>
      <div className="swiss__field" style={{ width: layout.width, height: layout.height }}>
        {layout.columns.map((c) => (
          <section
            key={c.round}
            className="swiss__column"
            data-testid={c.round === 'final' ? 'pod-bracket-final' : 'pod-bracket-round'}
            data-state={c.state}
            style={at(c.x, 0, { width: c.w, height: layout.height })}
          >
            {/* A label, not a heading: the room's one heading says the round, or Standings. */}
            <div className="swiss__head">{c.round === 'final' ? 'Final' : `Round ${c.round}`}</div>
            {c.state === 'next' && <div className="swiss__pending" />}
          </section>
        ))}
        <svg className="swiss__lines" width={layout.width} height={layout.height} aria-hidden="true">
          {layout.edges.map((e, i) => (
            <path key={i} d={e.d} className="swiss__edge" data-step={e.step} data-on={focus !== null && onPath(layout, e, focus) ? '' : undefined} />
          ))}
        </svg>
        {layout.groups.map((g) => (
          <div key={`${g.column}:${g.net}`} className="swiss__chip" style={at(g.x, g.top - SWISS.chipH, { width: g.column === pod.rounds ? SWISS.finalW : SWISS.cardW })}>
            {recordText(g.record)}
          </div>
        ))}
        {layout.cards.map((c, i) =>
          c.kind === 'bye' ? (
            <div key={`bye:${i}`} className="swiss__card swiss__card--bye" data-testid="pod-tables-bye" data-focus={c.player === focus ? '' : undefined} style={at(c.x, c.y, { width: SWISS.cardW, height: c.h })}>
              <button type="button" className="swiss__row" {...pick(c.player)}>
                <Face id={c.player} {...faces} size={24} />
                <PlayerName name={nameOf(c.player)} face={avatarOf(c.player)} className="swiss__name" />
                <span className="swiss__tag">Bye</span>
              </button>
            </div>
          ) : (
            <MatchCard
              key={c.match.table?.id ?? `m:${i}`}
              roomId={roomId}
              match={c.match}
              x={c.x}
              y={c.y}
              h={c.h}
              focus={focus}
              dim={picked !== null && !c.match.players.includes(picked)}
              myMemberId={myMemberId}
              leader={leader}
              dropped={pod.dropped ?? []}
              game={c.match.table === null ? undefined : games?.[c.match.table.id]}
              pick={pick}
              {...faces}
            />
          ),
        )}
        {layout.finals.map((f) => {
          const pts = pod.standings.find((r) => r.id === f.player)?.matchPoints ?? 0;
          return (
            <button
              key={f.player}
              type="button"
              className="swiss__final"
              data-testid="pod-final-row"
              data-place={f.place}
              data-focus={f.player === focus ? '' : undefined}
              data-dim={picked !== null && picked !== f.player ? '' : undefined}
              style={at(f.x, f.y, { width: SWISS.finalW, height: SWISS.finalRowH })}
              {...pick(f.player)}
            >
              <span className="swiss__place">#{f.place}</span>
              <Face id={f.player} {...faces} size={26} />
              <PlayerName name={nameOf(f.player)} face={avatarOf(f.player)} className="swiss__name" />
              <span className="swiss__pts">{pts} pts</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

interface MatchCardProps extends Faces {
  roomId: string;
  match: SwissMatch;
  x: number;
  y: number;
  h: number;
  focus: string | null;
  dim: boolean;
  myMemberId: string | null;
  leader: boolean;
  dropped: readonly string[];
  game: TableGame | undefined;
  pick: (id: string) => Record<string, unknown>;
}

function MatchCard({ roomId, match, x, y, h, focus, dim, myMemberId, leader, dropped, game, pick, nameOf, avatarOf }: MatchCardProps) {
  const { players, wins, table, phase } = match;
  const mine = myMemberId !== null && players.includes(myMemberId);
  const matchId = table?.matchId ?? null;
  const live = match.live && table !== null;
  const tableId = table?.id;
  const go = !live
    ? null
    : mine
      ? matchId !== null
        ? { label: 'Return to game', href: routeHash({ kind: 'match', matchId }), testId: 'pod-tables-play' }
        : { label: 'Play', href: routeHash({ kind: 'room', roomId, tableId: tableId! }), testId: 'pod-tables-play' }
      : { label: 'Watch', href: routeHash({ kind: 'room', roomId, tableId: tableId! }), testId: 'pod-tables-watch' };
  const series = { length: table?.series.length ?? 1, wins, played: table?.series.games.length ?? wins[0] + wins[1], phase };
  const resolve = useTableResolve({
    testId: 'pod-tables-row',
    players,
    nameOf,
    myMemberId,
    series,
    matchId,
    phase: tablePhase(phase, matchId, game),
    menu: true,
    ...(live && mine ? { onDrop: () => resolveTable('drop', roomId, tableId!) } : {}),
    ...(live && mine && matchId !== null ? { onConcede: () => resolveTable('concede', roomId, tableId!) } : {}),
    ...(live && leader ? { onReset: () => resolveTable('reset', roomId, tableId!), onDq: (id: string) => dqPlayer(roomId, id), dqable: (id: string) => !isPodAi(id) && !dropped.includes(id) } : {}),
  });
  const decided = phase === 'done';
  const gameNo = Math.min(series.played + 1, series.length);
  return (
    <div
      className="swiss__card"
      data-testid="pod-tables-row"
      data-table-id={tableId}
      data-phase={phase}
      data-mine={mine ? '' : undefined}
      data-live={live ? '' : undefined}
      data-focus={focus !== null && players.includes(focus) ? '' : undefined}
      data-dim={dim ? '' : undefined}
      style={at(x, y, { width: SWISS.cardW, minHeight: h })}
    >
      {([0, 1] as const).map((k) => {
        const id = players[k];
        const won = decided && wins[k] > wins[1 - k]!;
        const row = (
          <>
            <Face id={id} nameOf={nameOf} avatarOf={avatarOf} size={24} />
            <PlayerName name={nameOf(id)} face={avatarOf(id)} className="swiss__name" />
            <span className="swiss__score">{wins[k]}</span>
          </>
        );
        const attrs = { className: 'swiss__row', 'data-won': won ? '' : undefined, 'data-lost': decided && !won ? '' : undefined, 'data-focus': id === focus ? '' : undefined };
        // A live card is the way in, the whole of it: its rows take no press of their own.
        return live ? (
          <div key={k} {...attrs}>
            {row}
          </div>
        ) : (
          <button key={k} type="button" {...attrs} {...pick(id)}>
            {row}
          </button>
        );
      })}
      {go !== null && (
        <div className="swiss__foot">
          <a className="swiss__go" data-testid={go.testId} href={go.href}>
            {go.label}
          </a>
          <span className="swiss__game">Game {gameNo}</span>
          {resolve.more}
        </div>
      )}
      <div className="swiss__pop">{resolve.panel}</div>
    </div>
  );
}
