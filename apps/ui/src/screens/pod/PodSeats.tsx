/*
 * The pod's 8 seats — wave 72 §R.1.
 *
 * Reuses the 1v1 table's seat-row classes verbatim (`.tables__row`,
 * `.tables__who`, `.tables__who--seat`, `.tables__name`, `.tables__crown`,
 * `.tables__sit`, `.tables__stand` — `screens.css`, `ConstructedScreen.tsx`'s
 * `PlayerRow` and its empty-seat branch), per the brief: "the 8 pod seats on
 * the same seat-row components the 1v1 table uses… port, don't redraw."
 * `ConstructedScreen.tsx` is not this lane's to import a component FROM
 * (it is Q's file), so this is new JSX wearing the same classes rather than
 * a shared export — a port of the look, not a literal re-export.
 *
 * Unlike a 1v1 seat, a pod seat carries no deck/legal state (drafting has
 * not happened yet) — just who is there, whether they are ready, and
 * whether they lead the room. Readiness itself is unaffected by seating
 * (`apps/server/src/room/lobby.ts`'s `startDraft`: the gate counts seated
 * members once anyone has sat, and every member before that — the exact
 * gate a room without pod seats always had), so this draws a ready pill for
 * whoever is seated but never toggles it — `ready-toggle` stays the single,
 * global control it already is.
 *
 * Purely presentational: a parent (`DraftLobby.tsx`) owns the fetch and the
 * sit/stand calls, which is what makes this unit-testable with fixtures
 * (`PodSeats.test.ts`) instead of a mocked server — the same discipline
 * `BoardStrip.tsx` already keeps.
 */

import { StatusPill } from '../ConstructedScreen.tsx';
import { POD_AI, POD_SEATS, type PodSeats as PodSeatsValue } from './wire.ts';
import './PodSeats.css';

export interface PodSeatsProps {
  /** Always `POD_SEATS` long. */
  seats: PodSeatsValue;
  /** The viewer's own member id, or `null` before identity resolves. */
  myMemberId: string | null;
  leaderId: string;
  /** Looks up a seated member's readiness — the room's own `ready` flag, unaffected by seating. */
  readyOf: (memberId: string) => boolean;
  busy: boolean;
  onSit: (seat: number) => void;
  onStand: () => void;
  /** The AI button on an open seat (`on`), or the AI's own seat given back. */
  onAi: (seat: number, on: boolean) => void;
}

export function PodSeats({ seats, myMemberId, leaderId, readyOf, busy, onSit, onStand, onAi }: PodSeatsProps) {
  const mySeat = myMemberId === null ? null : seats.findIndex((s) => s?.memberId === myMemberId);
  const iAmSeated = mySeat !== null && mySeat >= 0;

  return (
    <ul className="pod-seats" data-testid="pod-seats">
      {Array.from({ length: POD_SEATS }, (_, seat) => {
        const occupant = seats[seat] ?? null;
        if (occupant === null) {
          return (
            <li key={seat} className="tables__row tables__row--empty" data-testid={`pod-seat-${seat}`}>
              <span className="tables__who tables__who--seat">
                <span className="tables__name">Open seat</span>
                <span className="tables__actions">
                  <button
                    type="button"
                    className="tables__sit"
                    data-testid="pod-seat-sit"
                    data-seat={seat}
                    disabled={busy || iAmSeated}
                    onClick={() => onSit(seat)}
                  >
                    Sit here
                  </button>
                  {/* The same AI button as the 1v1 table's empty seat. */}
                  <button type="button" className="tables__sit" data-testid="pod-seat-ai" data-seat={seat} disabled={busy} onClick={() => onAi(seat, true)}>
                    AI
                  </button>
                </span>
              </span>
            </li>
          );
        }
        if (occupant.memberId === POD_AI) {
          return (
            <li key={seat} className="tables__row" data-testid={`pod-seat-${seat}`} data-ai="">
              <span className="tables__who tables__who--seat">
                <strong className="tables__name">AI</strong>
                <button type="button" className="tables__stand" data-testid="pod-seat-ai-remove" data-seat={seat} disabled={busy} onClick={() => onAi(seat, false)}>
                  Remove
                </button>
              </span>
            </li>
          );
        }
        const mine = occupant.memberId === myMemberId;
        const leads = occupant.memberId === leaderId && leaderId !== '';
        const ready = readyOf(occupant.memberId);
        return (
          <li key={seat} className="tables__row" data-testid={`pod-seat-${seat}`}>
            <span className="tables__who tables__who--seat">
              <strong className="tables__name">{mine ? `${occupant.name} (you)` : occupant.name}</strong>
              {leads && (
                <svg className="tables__crown" data-testid={`pod-seat-${seat}-leader`} viewBox="0 0 12 12" role="img" aria-label="Room owner">
                  <title>Room owner</title>
                  <path d="M1 9.5 2 4l2.3 2.3L6 3l1.7 3.3L10 4l1 5.5z" />
                </svg>
              )}
              {mine && (
                <button type="button" className="tables__stand" data-testid="pod-seat-stand" disabled={busy} onClick={() => onStand()}>
                  Stand up
                </button>
              )}
            </span>
            <StatusPill
              kind="ready"
              testId={`pod-seat-${seat}-ready`}
              state={ready ? 'yes' : 'no'}
              mark={ready ? 'tick' : 'ring'}
              label={ready ? 'ready' : 'not ready'}
            />
          </li>
        );
      })}
    </ul>
  );
}
