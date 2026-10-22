/*
 * Who is watching the draft: every room member who is not one of its players,
 * as one quiet line in the pod strip (AF305 §B — the operator: "i like
 * showing that there are spectators in the draft process. for in the room
 * its not necessary since we have the chat"). Watching takes no seat and no
 * button; this only names them.
 *
 * The draft lobby, the drafting screen's side column and the pod after its
 * draft all draw this one list, against `podPlayers`.
 */

import { CROWN } from '../ConstructedScreen.tsx';
import { podPlayers, type PodView } from './wire.ts';

export interface PodSpectatorsProps {
  pod: PodView;
  /** The room's members, in the room's order. */
  members: readonly { id: string; name: string }[];
  /** My member id here, or `null` before the room has said. */
  myId: string | null;
  leaderId: string;
}

export function PodSpectators({ pod, members, myId, leaderId }: PodSpectatorsProps) {
  const players = podPlayers(pod);
  const spectators = members.filter((m) => !players.has(m.id));
  if (spectators.length === 0) return null;
  return (
    <p className="pod-spectators" data-testid="pod-spectators">
      {spectators.map((member) => (
        <span key={member.id} className="pod-spectators__name" data-testid="pod-spectator" data-member={member.id}>
          {member.id === myId ? `${member.name} (you)` : member.name}
          {member.id === leaderId && leaderId !== '' && (
            <svg className="tables__crown" viewBox="0 0 12 12" role="img" aria-label="Room owner">
              <title>Room owner</title>
              <path d={CROWN} />
            </svg>
          )}
        </span>
      ))}
    </p>
  );
}
