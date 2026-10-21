/*
 * The room's spectators, under its seats: every member who holds no seat, one
 * row each, and after them one open row to take (the operator, 2026-10-21:
 * *"spectator seats should be takable in any room. whenever one spectator seat
 * is taken, just add another row so theres always one to click on."*).
 *
 * One rule for every room kind — a 1v1 table (`ConstructedScreen`), a draft
 * pod's lobby (`DraftLobby`) and the pod after its draft (`PodScreen`) draw
 * this same list. A spectator holds no seat (the
 * 2026-10-12 contract; `docs/planning/draft-pods-plan.md` ruling 4), so there
 * is nothing for the server to count: every member of a room who is not seated
 * IS a spectator, and the room's member list has no cap. Taking the open row is
 * giving your seat back, so its Watch is the caller's Stand up, live exactly
 * when that is.
 *
 * The rows are the seat list's own one-line rows (`.tables__row--line`), so a
 * spectator row, an open one and a pod seat are one shape and one height.
 */

import { CROWN, StatusPill } from './ConstructedScreen.tsx';

export interface SpectatorRowsProps {
  /** The room's members who hold no seat, in the room's order. */
  spectators: { id: string; name: string }[];
  /** My member id here, or `null` before the room has said. */
  myId: string | null;
  leaderId: string;
  /** A room whose deal waits on every member (a draft room read with no pod) shows their readiness. */
  readyOf?: (memberId: string) => boolean;
  /** Take the open row: give my seat back. Absent where no seat is ever given back (a pod past its draft). */
  onWatch?: () => void;
  /** No seat of mine to give back, or the table will not let me stand. */
  watchDisabled: boolean;
}

/** The room's members who hold none of these seats, in the room's order. */
export function spectatorsOf<M extends { id: string }>(members: readonly M[], seated: ReadonlySet<string>): M[] {
  return members.filter((m) => !seated.has(m.id));
}

export function SpectatorRows({ spectators, myId, leaderId, readyOf, onWatch, watchDisabled }: SpectatorRowsProps) {
  return (
    <ul className="tables__players tables__spectators" data-testid="spectators">
      {spectators.map((member) => {
        const ready = readyOf?.(member.id);
        return (
          <li key={member.id} className="tables__row tables__row--line" data-testid="spectator-row" data-member={member.id}>
            <span className="tables__who tables__who--seat">
              <strong className="tables__name">{member.id === myId ? `${member.name} (you)` : member.name}</strong>
              {member.id === leaderId && leaderId !== '' && (
                <svg className="tables__crown" viewBox="0 0 12 12" role="img" aria-label="Room owner">
                  <title>Room owner</title>
                  <path d={CROWN} />
                </svg>
              )}
            </span>
            {ready !== undefined && (
              <StatusPill
                kind="ready"
                testId="spectator-ready"
                state={ready ? 'yes' : 'no'}
                mark={ready ? 'tick' : 'ring'}
                label={ready ? 'ready' : 'not ready'}
              />
            )}
          </li>
        );
      })}
      <li className="tables__row tables__row--line tables__row--empty" data-testid="spectator-open">
        <span className="tables__who tables__who--seat">
          <span className="tables__name">Spectator</span>
          <span className="tables__actions">
            <button type="button" className="tables__sit" data-testid="spectator-watch" disabled={watchDisabled} onClick={onWatch}>
              Watch
            </button>
          </span>
        </span>
      </li>
    </ul>
  );
}
