/*
 * The pod's 8 seats, as a strip of avatars (AF305 §B — the operator: "the
 * draft room look ugly at the moment", picking "B - Cube Gallery"). Was the
 * 1v1 table's seat ROWS, ported verbatim (wave 72 §R.1); a strip of 8 rows
 * read as a long list, so this redesign keeps every seat ACTION (Sit, AI,
 * Close/Open, Remove AI) but draws each seat as a round avatar with
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
 * Past 8, the room is still ONE list of seats (the operator, 2026-10-31:
 * *"several pods: we dont need to show this in the lobby screen"*): pods are
 * decided only by the leader's Split & randomize (`PodSplit.tsx`). A full room
 * offers someone who has not sat (and the owner, for an AI) one seat more,
 * which grows the room by that seat (`apps/server/src/room/lobby.ts`'s
 * `sitPod`/`aiPod`).
 *
 * No Stand: giving a seat back is the spectators' open slot under the strip
 * (`../RoomSpectators.tsx`), and an open seat here moves a seated player to it
 * (the operator, 2026-11-02: "click back and forth between player and
 * spectator … we dont need a stand button at all").
 *
 * Purely presentational: a parent (`PodLobby.tsx`) owns the fetch and the
 * sit calls, which is what makes this unit-testable with fixtures
 * (`PodSeats.test.ts`) instead of a mocked server.
 */

import { ActionButton } from '../../components/ActionButton.tsx';
import { Avatar, type Face } from '../../components/Avatar.tsx';
import { PlayerName } from '../../room/look.tsx';
import { StatusPill } from '../../components/StatusPill.tsx';
import { CROWN } from '../ConstructedScreen.tsx';
import { isPodAi, POD_CLOSED, POD_MAX_SEATS, type PodSeats as PodSeatsValue } from './wire.ts';
import './PodSeats.css';

export interface PodSeatsProps {
  /** 8, or one more for each seat a room past 8 has grown by. */
  seats: PodSeatsValue;
  /** The viewer's own member id, or `null` before identity resolves. */
  myMemberId: string | null;
  leaderId: string;
  /** Looks up a seated member's readiness — the room's own `Ready` flag, unaffected by seating. */
  readyOf: (memberId: string) => boolean;
  /** Looks up a seated member's own watchparty avatar id (`undefined` for none) — the same id `Avatar` draws everywhere else. */
  faceOf: (memberId: string) => Face;
  /**
   * A Challenge's AI seat carries the `deckId` of its real player's list, public because the event
   * published it; this names that player on the seat. Absent, or `undefined` for a deck, names none:
   * a live tournament's deck stays its chooser's secret, and this component never guesses one.
   */
  playerOf?: (deckId: string) => string | undefined;
  /** A Challenge's field is the event's: no seat is grown, given to the AI, taken from it or closed. */
  fieldFixed?: boolean;
  onSit: (seat: number) => void;
  /** The AI button on an open seat (`on`), or the AI's own seat given back. */
  onAi: (seat: number, on: boolean) => void;
  /** The owner's: close an open seat (`closed`), or open a closed one. */
  onClose: (seat: number, closed: boolean) => void;
}

export function PodSeats({ seats, myMemberId, leaderId, readyOf, faceOf, playerOf = () => undefined, fieldFixed = false, onSit, onAi, onClose }: PodSeatsProps) {
  const iLead = myMemberId !== null && myMemberId === leaderId;
  const mySeat = myMemberId === null ? null : seats.findIndex((s) => s?.memberId === myMemberId);
  const iAmSeated = mySeat !== null && mySeat >= 0;
  // A full room: one seat more, for someone who has not sat yet, and for the owner's AI.
  const grows = !fieldFixed && (iLead || (!iAmSeated && myMemberId !== null)) && seats.length < POD_MAX_SEATS && seats.every((s) => s !== null);
  const drawn = seats.length + (grows ? 1 : 0);

  return (
    <ul className="pod-seats" data-testid="pod-seats">
      {Array.from({ length: drawn }, (_, seat) => {
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
                disabled={iAmSeated && seat >= seats.length}
                onPress={() => onSit(seat)}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </ActionButton>
              <span className="pod-seats__label">Open</span>
              {!fieldFixed && (
                <span className="pod-seats__actions">
                  <ActionButton action="ai" className="pod-seats__action" data-testid="pod-seat-ai" data-seat={seat} aria-label={`Fill seat ${seat + 1} with AI`} onPress={() => onAi(seat, true)}>
                    AI
                  </ActionButton>
                  {iLead && seat < seats.length && (
                    <ActionButton action="close" className="pod-seats__action" data-testid="pod-seat-close" data-seat={seat} aria-label={`Close seat ${seat + 1}`} onPress={() => onClose(seat, true)}>
                      Close
                    </ActionButton>
                  )}
                </span>
              )}
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
        if (isPodAi(occupant.memberId)) {
          const player = occupant.deckId === undefined ? undefined : playerOf(occupant.deckId);
          return (
            <li key={seat} className="pod-seats__seat" data-testid={`pod-seat-${seat}`} data-ai="" data-player={player}>
              <span className="pod-seats__avatar pod-seats__avatar--ai">
                {/* The seat's own character (`PodMember.avatarId`); the mark only for a server that sends none. */}
                <Avatar id={occupant.avatarId} fallback="mark" className="pod-seats__avatar-img" fallbackClassName="pod-seats__avatar-fallback" />
              </span>
              <span className="pod-seats__label">{player ?? occupant.name}</span>
              {!fieldFixed && (
                <span className="pod-seats__actions">
                  <ActionButton action="ai-remove" className="pod-seats__action" data-testid="pod-seat-ai-remove" data-seat={seat} aria-label={`Remove AI from seat ${seat + 1}`} onPress={() => onAi(seat, false)}>
                    Remove
                  </ActionButton>
                </span>
              )}
            </li>
          );
        }
        const mine = occupant.memberId === myMemberId;
        const leads = occupant.memberId === leaderId && leaderId !== '';
        const ready = readyOf(occupant.memberId);
        return (
          <li key={seat} className="pod-seats__seat" data-testid={`pod-seat-${seat}`} data-mine={mine ? '' : undefined}>
            <span className="pod-seats__avatar-wrap">
              <span className="pod-seats__avatar" data-ready={ready ? 'true' : 'false'}>
                <Avatar
                  {...faceOf(occupant.memberId)}
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
            <PlayerName name={occupant.name} face={faceOf(occupant.memberId)} className="pod-seats__label" />
            <StatusPill testId={`pod-seat-${seat}-ready`} state={ready ? 'yes' : 'no'} mark={ready ? 'tick' : 'ring'} label={ready ? 'ready' : 'not ready'} />
          </li>
        );
      })}
    </ul>
  );
}
