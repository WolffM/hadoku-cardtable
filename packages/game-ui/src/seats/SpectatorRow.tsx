/*
 * L3a, shared: the spectator row — every member who holds no seat, drawn the way the seats are
 * (`pod-seats`), beside or under them. Lifted from
 * `games/magic/ui/src/screens/RoomSpectators.tsx` (wave 119 §U). Platform: the caller still
 * decides WHO is a spectator (a member not found among the room's seats — today three separate,
 * not-yet-unified derivations across Magic's own files; see this lane's closing note) and hands
 * this component the finished list.
 *
 * Every class name and `data-testid` this draws is unchanged from `RoomSpectators.tsx`'s own —
 * `table-side`, `pod-seats`, `room-spectators`, `room-spectator`, `seat-stand` — so cardtable's
 * existing CSS and its callers' own tests key off the identical DOM this always drew.
 */

import { ActionButton } from '../components/ActionButton.tsx';
import { Avatar, faceOf } from '../components/Avatar.tsx';
import { PlayerName } from '../room/look.tsx';
import type { Look } from '@hadoku/platform-wire/look';
import { SEAT_CROWN_PATH } from './SeatChip.tsx';

export interface SpectatorRowProps {
  /** The room's members who hold no seat, in the room's order. */
  spectators: readonly { id: string; name: string; avatarId?: string; look?: Look }[];
  myId: string | null;
  leaderId: string;
  /** Given while I hold a seat: the open slot that gives it back. */
  onWatch?: () => void;
  /** The seat cannot be given back now: the table is locked or a match is under way. */
  watchDisabled?: boolean;
  /** Drawn under the seats rather than beside them (a pod's strip). */
  under?: boolean;
  /** Given to the leader only: hands the room to a spectator. Drawn on everyone but the viewer. */
  onMakeLeader?: (memberId: string) => void;
}

export function SpectatorRow({ spectators, myId, leaderId, onWatch, watchDisabled = false, under = false, onMakeLeader }: SpectatorRowProps) {
  if (spectators.length === 0 && onWatch === undefined) return null;
  return (
    <div className={under ? 'table-side table-side--under' : 'table-side'} data-testid="room-spectators">
      <h3 className="table-side__heading">Spectators</h3>
      <ul className="pod-seats">
        {spectators.map((member) => (
          <li key={member.id} className="pod-seats__seat" data-testid="room-spectator" data-member={member.id} data-mine={member.id === myId ? '' : undefined}>
            <span className="pod-seats__avatar-wrap">
              <span className="pod-seats__avatar">
                <Avatar {...faceOf(member)} fallback="initial" name={member.name} className="pod-seats__avatar-img" fallbackClassName="pod-seats__avatar-fallback" />
              </span>
              {member.id === leaderId && leaderId !== '' && (
                <svg className="pod-seats__crown" viewBox="0 0 12 12" role="img" aria-label="Room owner">
                  <title>Room owner</title>
                  <path d={SEAT_CROWN_PATH} />
                </svg>
              )}
            </span>
            <PlayerName name={member.name} face={faceOf(member)} className="pod-seats__label" />
            {onMakeLeader !== undefined && member.id !== myId && (
              <span className="pod-seats__actions">
                <ActionButton action="make-leader" className="pod-seats__action" data-testid="spectator-make-leader" data-member={member.id} aria-label={`Make ${member.name} the room leader`} onPress={() => onMakeLeader(member.id)}>
                  <svg className="pod-seats__action-icon" viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d={SEAT_CROWN_PATH} /></svg>
                </ActionButton>
              </span>
            )}
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
