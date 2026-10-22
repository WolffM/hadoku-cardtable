/*
 * The pod's 8 seats, as a strip of avatars (AF305 §B — the operator: "the
 * draft room look ugly at the moment", picking "B - Cube Gallery"). Was the
 * 1v1 table's seat ROWS, ported verbatim (wave 72 §R.1); a strip of 8 rows
 * read as a long list, so this redesign keeps every seat ACTION (Sit, AI,
 * Close/Open, Remove AI, Stand) but draws each seat as a round avatar with
 * its name underneath and its actions beside it, rather than a line in a
 * table. None of that is hover-only: a phone has no hover, so every action
 * is its own always-visible, labelled button — an `ActionButton`, because a
 * seat's AI and the Remove the room draws in its place are one position.
 *
 * The ready ring (`data-ready` on the avatar, the success token) replaces
 * the `StatusPill` as the seat's OWN at-a-glance signal, but the pill stays
 * too — `pod-seat-<n>-ready` is in the id contract, and colour alone is not
 * a status (a third of the operator's friends could not read it — the same
 * reasoning `ConstructedScreen.tsx`'s `StatusPill` was built for).
 *
 * Unlike a 1v1 seat, a pod seat carries no deck/legal state (drafting has
 * not happened yet) — just who is there, whether they are ready, and
 * whether they lead the room. Readiness itself is unaffected by seating
 * (`apps/server/src/room/lobby.ts`'s `startDraft`: the gate counts seated
 * members once anyone has sat, and every member before that), so this draws
 * a ready ring for whoever is seated but never toggles it — `ready-toggle`
 * stays the single, global control it already is.
 *
 * Purely presentational: a parent (`DraftLobby.tsx`) owns the fetch and the
 * sit/stand calls, which is what makes this unit-testable with fixtures
 * (`PodSeats.test.ts`) instead of a mocked server.
 */

import { ActionButton } from '../../components/ActionButton.tsx';
import { Avatar } from '../../components/Avatar.tsx';
import { CROWN, StatusPill } from '../ConstructedScreen.tsx';
import { POD_AI, POD_CLOSED, POD_SEATS, type PodSeats as PodSeatsValue } from './wire.ts';
import './PodSeats.css';

export interface PodSeatsProps {
  /** Always `POD_SEATS` long. */
  seats: PodSeatsValue;
  /** The viewer's own member id, or `null` before identity resolves. */
  myMemberId: string | null;
  leaderId: string;
  /** Looks up a seated member's readiness — the room's own `ready` flag, unaffected by seating. */
  readyOf: (memberId: string) => boolean;
  /** Looks up a seated member's own watchparty avatar id (`undefined` for none) — the same id `Avatar` draws everywhere else. */
  avatarIdOf: (memberId: string) => string | undefined;
  onSit: (seat: number) => void;
  onStand: () => void;
  /** The AI button on an open seat (`on`), or the AI's own seat given back. */
  onAi: (seat: number, on: boolean) => void;
  /** The owner's: close an open seat (`closed`), or open a closed one. */
  onClose: (seat: number, closed: boolean) => void;
}

export function PodSeats({ seats, myMemberId, leaderId, readyOf, avatarIdOf, onSit, onStand, onAi, onClose }: PodSeatsProps) {
  const iLead = myMemberId !== null && myMemberId === leaderId;
  const mySeat = myMemberId === null ? null : seats.findIndex((s) => s?.memberId === myMemberId);
  const iAmSeated = mySeat !== null && mySeat >= 0;

  return (
    <ul className="pod-seats" data-testid="pod-seats">
      {Array.from({ length: POD_SEATS }, (_, seat) => {
        const occupant = seats[seat] ?? null;
        if (occupant === null) {
          return (
            <li key={seat} className="pod-seats__seat" data-testid={`pod-seat-${seat}`}>
              <ActionButton
                action="sit"
                className="pod-seats__avatar pod-seats__avatar--open"
                data-testid="pod-seat-sit"
                data-seat={seat}
                aria-label={`Sit in seat ${seat + 1}`}
                disabled={iAmSeated}
                onPress={() => onSit(seat)}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </ActionButton>
              <span className="pod-seats__label">Open</span>
              <span className="pod-seats__actions">
                <ActionButton action="ai" className="pod-seats__action" data-testid="pod-seat-ai" data-seat={seat} aria-label={`Fill seat ${seat + 1} with AI`} onPress={() => onAi(seat, true)}>
                  AI
                </ActionButton>
                {iLead && (
                  <ActionButton action="close" className="pod-seats__action" data-testid="pod-seat-close" data-seat={seat} aria-label={`Close seat ${seat + 1}`} onPress={() => onClose(seat, true)}>
                    Close
                  </ActionButton>
                )}
              </span>
            </li>
          );
        }
        if (occupant.memberId === POD_CLOSED) {
          return (
            <li key={seat} className="pod-seats__seat" data-testid={`pod-seat-${seat}`} data-closed="">
              <span className="pod-seats__avatar pod-seats__avatar--closed" aria-hidden="true">
                ×
              </span>
              <span className="pod-seats__label">Closed</span>
              {iLead && (
                <span className="pod-seats__actions">
                  <ActionButton action="open" className="pod-seats__action" data-testid="pod-seat-open" data-seat={seat} aria-label={`Open seat ${seat + 1}`} onPress={() => onClose(seat, false)}>
                    Open
                  </ActionButton>
                </span>
              )}
            </li>
          );
        }
        if (occupant.memberId === POD_AI) {
          return (
            <li key={seat} className="pod-seats__seat" data-testid={`pod-seat-${seat}`} data-ai="">
              <span className="pod-seats__avatar pod-seats__avatar--ai">
                {/* No AI persona avatar exists yet (`podAi` carries no id) — the mark is the fallback by design, not a stand-in for one. */}
                <Avatar id={undefined} fallback="mark" fallbackClassName="pod-seats__avatar-fallback" />
              </span>
              <span className="pod-seats__label">{occupant.name}</span>
              <span className="pod-seats__actions">
                <ActionButton action="ai-remove" className="pod-seats__action" data-testid="pod-seat-ai-remove" data-seat={seat} aria-label={`Remove AI from seat ${seat + 1}`} onPress={() => onAi(seat, false)}>
                  Remove
                </ActionButton>
              </span>
            </li>
          );
        }
        const mine = occupant.memberId === myMemberId;
        const leads = occupant.memberId === leaderId && leaderId !== '';
        const ready = readyOf(occupant.memberId);
        return (
          <li key={seat} className="pod-seats__seat" data-testid={`pod-seat-${seat}`}>
            <span className="pod-seats__avatar-wrap">
              <span className="pod-seats__avatar" data-ready={ready ? 'true' : 'false'}>
                <Avatar
                  id={avatarIdOf(occupant.memberId)}
                  fallback="initial"
                  name={occupant.name}
                  className="pod-seats__avatar-img"
                  fallbackClassName="pod-seats__avatar-fallback"
                />
              </span>
              {leads && (
                <svg className="pod-seats__crown" data-testid={`pod-seat-${seat}-leader`} viewBox="0 0 12 12" role="img" aria-label="Room owner">
                  <title>Room owner</title>
                  <path d={CROWN} />
                </svg>
              )}
            </span>
            <span className="pod-seats__label">{mine ? `${occupant.name} (you)` : occupant.name}</span>
            <StatusPill testId={`pod-seat-${seat}-ready`} state={ready ? 'yes' : 'no'} mark={ready ? 'tick' : 'ring'} label={ready ? 'ready' : 'not ready'} />
            {mine && (
              <span className="pod-seats__actions">
                <ActionButton action="stand" className="pod-seats__action" data-testid="pod-seat-stand" aria-label="Stand up" onPress={onStand}>
                  Stand
                </ActionButton>
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
