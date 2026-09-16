/**
 * What the connection is doing, said out loud.
 *
 * ## The bug this is, which is not a bug in the code
 *
 * A drafter's socket drops. The server holds their seat for the reservation
 * TTL, the client re-joins on reconnect, the server answers with a full
 * snapshot and the draft carries on — every part of that works and is tested
 * (`draft/socket.test.ts`, `apps/server/src/room/draftRooms.ts`). What the
 * player sees is a table that stops moving for thirty seconds and then jumps.
 * They refresh, or they say it is broken, and both are reasonable responses to
 * a screen that said nothing.
 *
 * So this component renders the one thing the app was not saying. It holds no
 * state and starts no timers: it takes a `ConnectionState` computed by
 * `draft/connection.ts` from facts the driver already tracks, which is why the
 * banner can be tested without a socket and cannot drift from what the socket
 * is actually doing.
 *
 * ## `role="status"`, not `alert`
 *
 * None of these are errors. `alert` interrupts a screen reader mid-sentence and
 * is for something that has gone wrong; a reconnect is the system working. The
 * live region still announces it, politely, when the player reaches a pause.
 */

import { isWorthShowing, type ConnectionState } from '../draft/connection.ts';
import './spectate.css';

export interface ConnectionBannerProps {
  state: ConnectionState;
  /** Render even when there is nothing to report. Off by default. */
  always?: boolean;
}

export function ConnectionBanner({ state, always = false }: ConnectionBannerProps) {
  if (!always && !isWorthShowing(state)) return null;

  return (
    <aside
      className={`conn conn--${state.phase}`}
      data-testid="connection"
      data-phase={state.phase}
      data-seat-held={state.seatHeld ? 'true' : 'false'}
      data-stalled={state.stalled ? 'true' : 'false'}
      role="status"
      aria-live="polite"
    >
      <span className="conn__dot" aria-hidden="true" />
      <div className="conn__text">
        <strong className="conn__label" data-testid="connection-label">
          {state.label}
        </strong>
        <span className="conn__detail" data-testid="connection-detail">
          {state.detail}
        </span>
      </div>
    </aside>
  );
}
