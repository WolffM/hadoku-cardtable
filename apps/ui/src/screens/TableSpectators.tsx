/*
 * The 1v1 table's spectators: every room member who holds no seat, drawn the way the seats are
 * (`pod-seats`), beside them. Everyone in the room is on one side or the other, and moving is a
 * click on the side you want: an open seat sits you, the open slot here gives your seat back
 * (the operator, 2026-11-02: "show a separate section for spectators and you can just click back
 * and forth between player and spectator … we dont need a stand button at all").
 */

import { ActionButton } from '../components/ActionButton.tsx';
import { Avatar } from '../components/Avatar.tsx';
import { CROWN } from './ConstructedScreen.tsx';

export interface TableSpectatorsProps {
  /** The room's members who hold no seat, in the room's order. */
  spectators: readonly { id: string; name: string; avatarId?: string }[];
  myId: string | null;
  leaderId: string;
  /** Given while I hold a seat: the open slot that gives it back. */
  onWatch?: () => void;
  /** The seat cannot be given back now: the table is locked or a match is under way. */
  watchDisabled: boolean;
}

export function TableSpectators({ spectators, myId, leaderId, onWatch, watchDisabled }: TableSpectatorsProps) {
  if (spectators.length === 0 && onWatch === undefined) return null;
  return (
    <div className="table-side" data-testid="room-spectators">
      <h3 className="table-side__heading">Spectators</h3>
      <ul className="pod-seats">
        {spectators.map((member) => (
          <li key={member.id} className="pod-seats__seat" data-testid="room-spectator" data-member={member.id} data-mine={member.id === myId ? '' : undefined}>
            <span className="pod-seats__avatar-wrap">
              <span className="pod-seats__avatar">
                <Avatar id={member.avatarId} fallback="initial" name={member.name} className="pod-seats__avatar-img" fallbackClassName="pod-seats__avatar-fallback" />
              </span>
              {member.id === leaderId && leaderId !== '' && (
                <svg className="pod-seats__crown" viewBox="0 0 12 12" role="img" aria-label="Room owner">
                  <title>Room owner</title>
                  <path d={CROWN} />
                </svg>
              )}
            </span>
            <span className="pod-seats__label">{member.name}</span>
          </li>
        ))}
        {onWatch !== undefined && (
          <li className="pod-seats__seat">
            <ActionButton action="stand" className="pod-seats__avatar pod-seats__avatar--open" data-testid="seat-stand" aria-label="Spectate" disabled={watchDisabled} onPress={onWatch}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </ActionButton>
            <span className="pod-seats__label">Open</span>
          </li>
        )}
      </ul>
    </div>
  );
}
