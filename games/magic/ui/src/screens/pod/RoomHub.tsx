/*
 * A room's rounds, for a draft pod and a Constructed tournament alike — the
 * operator, 2026-10-23: *"in the top level lobby room i would prefer to just
 * show standings and links to the open rooms. then players can enter their
 * game rooms and perform the game room actions there"* (ruling 8,
 * `docs/planning/tournament-mode-plan.md`).
 *
 * The round, the bracket (each live match a link to its table page,
 * `TablePage.tsx`) and the standings under it; once the pod is done, its podium
 * over them. Who is watching is the chat's to say, not this page's. Nothing
 * here starts a game: the table page does.
 */

import type { RoomTable, TableGame } from '@hadoku/shared';

import { PodBracket } from './PodBracket.tsx';
import { PodPodium } from './PodPodium.tsx';
import { PodStandings } from './PodStandings.tsx';
import type { PodView } from './wire.ts';
import type { Face } from '@hadoku/game-ui/components/Avatar.tsx';

export interface RoomHubProps {
  roomId: string;
  pod: PodView;
  tables: readonly RoomTable[];
  myMemberId: string | null;
  nameOf: (memberId: string) => string;
  avatarOf: (memberId: string) => Face;
  leaderId: string;
  /** Each table's game (the room body's `tableGames`), for its card. */
  games?: Readonly<Record<string, TableGame>> | undefined;
}

export function RoomHub({ roomId, pod, tables, myMemberId, nameOf, avatarOf, leaderId, games }: RoomHubProps) {
  return (
    <div className="pod__room">
      <div className="pod__rounds" data-testid={pod.phase === 'rounds' ? 'pod-rounds' : 'pod-final'}>
        {pod.phase === 'done' ? (
          <>
            <PodPodium rows={pod.standings} results={pod.results} nameOf={nameOf} avatarOf={avatarOf} myMemberId={myMemberId} />
            <h1>Standings</h1>
          </>
        ) : (
          <h2 data-testid="pod-round">
            Round {pod.round} of {pod.rounds}
          </h2>
        )}
        <PodBracket roomId={roomId} pod={pod} tables={tables} myMemberId={myMemberId} leader={myMemberId !== null && myMemberId === leaderId} nameOf={nameOf} avatarOf={avatarOf} games={games} />
        <PodStandings rows={pod.standings} results={pod.results} nameOf={nameOf} avatarOf={avatarOf} myMemberId={myMemberId} dropped={pod.dropped} />
      </div>
    </div>
  );
}
