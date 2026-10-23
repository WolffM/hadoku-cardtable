/*
 * A room's rounds, for a draft pod and a Constructed tournament alike — the
 * operator, 2026-10-23: *"in the top level lobby room i would prefer to just
 * show standings and links to the open rooms. then players can enter their
 * game rooms and perform the game room actions there"* (ruling 8,
 * `docs/planning/tournament-mode-plan.md`).
 *
 * The round, the bracket (each live match a link to its table page,
 * `TablePage.tsx`), the standings and who is watching. Nothing here starts a
 * game: the table page does. `children` is the one per-type slot: a draft pod's
 * building phase (who is ready, Edit deck).
 */

import type { ReactNode } from 'react';
import type { RoomTable } from '@hadoku/shared';

import { PodBracket } from './PodBracket.tsx';
import { PodSpectators } from './PodSpectators.tsx';
import { PodStandings } from './PodStandings.tsx';
import type { PodView } from './wire.ts';

export interface RoomHubProps {
  roomId: string;
  pod: PodView;
  tables: readonly RoomTable[];
  myMemberId: string | null;
  nameOf: (memberId: string) => string;
  avatarOf: (memberId: string) => string | null;
  members: readonly { id: string; name: string }[];
  leaderId: string;
  children?: ReactNode;
}

export function RoomHub({ roomId, pod, tables, myMemberId, nameOf, avatarOf, members, leaderId, children }: RoomHubProps) {
  const building = pod.phase === 'building';
  return (
    <div className="pod__room">
      <div className="pod__rounds" data-testid={building ? 'pod-ready' : pod.phase === 'rounds' ? 'pod-rounds' : 'pod-final'}>
        {pod.phase === 'done' ? (
          <h1>Standings</h1>
        ) : (
          <h2 data-testid="pod-round">
            Round {building ? 1 : pod.round} of {pod.rounds}
          </h2>
        )}
        {children}
        <div className="pod__board">
          <PodBracket roomId={roomId} pod={pod} tables={tables} myMemberId={myMemberId} nameOf={nameOf} avatarOf={avatarOf} />
          {!building && <PodStandings rows={pod.standings} nameOf={nameOf} myMemberId={myMemberId} />}
        </div>
        <PodSpectators pod={pod} members={members} myId={myMemberId} leaderId={leaderId} />
      </div>
    </div>
  );
}
