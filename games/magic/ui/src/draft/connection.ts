/*
 * The six things a connection can be doing, as a value.
 *
 * ## Why this is a separate module and not three ternaries in a component
 *
 * "A draft that silently freezes for 30 seconds looks broken even when it is
 * working perfectly" is the whole §B.2 brief, and the freeze is not a bug to
 * fix — it is a socket reconnecting and a server holding your seat, both
 * working. What is missing is that nothing on screen says so.
 *
 * Every fact needed to say so is ALREADY on `SocketDraft` (`socket.ts`):
 * `connected`, `everConnected`, `resyncPending`, `lastVerdict` and a `stats`
 * object counting joins and applied payloads. So this is a projection of state
 * that exists, not new state — which matters, because a second copy of "are we
 * connected" is a second thing that can be wrong.
 *
 * It takes a plain record rather than a `SocketDraft` so it is testable without
 * a transport, and so the in-process and fixture sources can render the same
 * banner by describing themselves honestly (they are never offline).
 *
 * ## The one derived counter
 *
 * Telling "reconnected, waiting" from "reconnected, back in business" needs to
 * know whether a payload has landed SINCE the re-join, which no single counter
 * answers. `appliedAtLastJoin` is `stats.applied` sampled when the re-join goes
 * out; the difference is the answer. It is one number in the driver rather than
 * a timer in a component, because a timer makes the banner untestable and lies
 * on a slow connection.
 *
 * `recovered` is deliberately BOUNDED to the first payload after the re-join.
 * An unbounded one would leave "Reconnected" on screen for the remaining forty
 * minutes of the draft, which is noise, and noise is what gets banners ignored.
 */

import type { SeqVerdict } from '@wolffm/rooms-protocol';
import type { ConnectionState } from '@hadoku/game-ui/components/connection-state.ts';
export { isWorthShowing, type ConnectionPhase, type ConnectionState } from '@hadoku/game-ui/components/connection-state.ts';

/** Everything a phase is decided from. All of it already exists on the driver. */
export interface ConnectionFacts {
  connected: boolean;
  /** Whether a connection has EVER been established. Distinguishes first-connect from a drop. */
  everConnected: boolean;
  /** Join messages sent. `> 1` means at least one reconnect has happened. */
  joins: number;
  /** Payloads applied, in total. */
  applied: number;
  /** `applied` as it stood when the most recent RE-join went out. */
  appliedAtLastJoin: number;
  /** A resync request is outstanding and unanswered. */
  resyncPending: boolean;
  /** The seat this client holds, or null while spectating or unseated. */
  seatId: number | null;
  /** The verdict on the most recent envelope. Diagnostic only. */
  lastVerdict: SeqVerdict | null;
}

/** How many payloads after a re-join still count as "recovered". */
const RECOVERY_WINDOW = 1;

function seatPhrase(seatId: number | null): string {
  return seatId === null ? 'Your place' : `Seat ${seatId}`;
}

/** What the connection is doing, and what to say about it. */
export function connectionState(facts: ConnectionFacts): ConnectionState {
  const seated = facts.seatId !== null;

  if (!facts.connected && !facts.everConnected) {
    return {
      phase: 'connecting',
      seatHeld: false,
      stalled: true,
      label: 'Connecting',
      detail: 'Joining…',
    };
  }

  if (!facts.connected) {
    return {
      phase: 'offline',
      seatHeld: seated,
      stalled: true,
      label: seated ? `${seatPhrase(facts.seatId)} is held for you` : 'Disconnected',
      detail: seated
        ? 'Connection dropped — seat held. Reconnecting.'
        : 'The connection dropped. Reconnecting.',
    };
  }

  if (facts.resyncPending) {
    return {
      phase: 'resyncing',
      seatHeld: false,
      stalled: true,
      label: 'Catching up',
      detail:
        'Resyncing.',
    };
  }

  const sinceJoin = facts.applied - facts.appliedAtLastJoin;
  const reconnected = facts.joins > 1;

  if (reconnected && sinceJoin <= 0) {
    return {
      phase: 'reconnecting',
      seatHeld: false,
      stalled: true,
      label: 'Reconnected — waiting for the table',
      detail:
        'Reconnected — resyncing.',
    };
  }

  if (reconnected && sinceJoin <= RECOVERY_WINDOW) {
    return {
      phase: 'recovered',
      seatHeld: false,
      stalled: false,
      label: seated ? `Back in ${seatPhrase(facts.seatId).toLowerCase()}` : 'Back',
      detail: 'Recovered.',
    };
  }

  return {
    phase: 'live',
    seatHeld: false,
    stalled: false,
    label: 'Live',
    detail: 'Connected.',
  };
}
