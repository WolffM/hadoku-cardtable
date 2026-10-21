/*
 * The draft room's lobby — who is here, who is ready, and the Ready toggle
 * that becomes the pod once everyone has pressed it.
 *
 * Moved out of `ConstructedScreen.tsx` by wave 72 §Q, unchanged (a pure move,
 * per the wave file's "Ordering, not sharing"): `ConstructedScreen` still
 * renders this for a draft room whose `draftStartedAt` is null, and nothing
 * about what it draws or how it behaves changed in the move. From here on
 * lane R owns this file, and wave 72 §R.1 is where the 8 pod seats arrive.
 *
 * ## Seats are additive, not a new gate (wave 72 §R.1)
 *
 * `apps/server/src/room/lobby.ts`'s `startDraft`: "the pod's ready gate
 * counts SEATED members only… nobody having sat yet… falls back to 'every
 * member' — the exact gate this had before the pod lobby existed, byte for
 * byte." So `ready-toggle` keeps its exact current meaning (the CALLER's own
 * `ready` flag, global, unaffected by seating) and this draws it exactly as
 * before for whoever holds no seat. Seats only matter once at least one is
 * taken — the 3+-human pod this wave exists for — and that is `PodSeats`'
 * own job, not a second readiness mechanism. This is what keeps a 2-person
 * room's existing "join, ready, draft" path (`e2e/draft.spec.ts`) working
 * with nobody ever touching a seat.
 *
 * ## The pod comes with the room
 *
 * `pod` is the room read's own `RoomView.pod` (`ConstructedScreen`'s `view`),
 * so the seats are drawn in the same frame as the room's name and members. A
 * second read of its own landed a beat later and pushed the seats in above
 * the member list (the operator, 2026-10-19: *"elements quickly shift around
 * as things are loaded"*). Which seat is mine comes from `myId`, the server's
 * own `you.id` for this room — never whoami's id, which for an admin session
 * is not the member id the pod's seats name.
 */

import { useEffect, useRef, useState } from 'react';

import type { RoomMember } from '../rooms/api.ts';
import { preloadCubeArt } from '../play/live/art-preload.ts';
import { aiPod, closePod, sitPod, standPod } from './pod/client.ts';
import { PodSeats } from './pod/PodSeats.tsx';
import { POD_AI, POD_CLOSED, podDealable, type PodView } from './pod/wire.ts';

export { podDealable };

export function DraftLobby({
  roomId,
  pod,
  members,
  leaderId,
  myId,
  iAmReady,
  allReady,
  dealing,
  error,
  onReady,
  onRetry,
}: {
  roomId: string;
  /** The room read's `RoomView.pod`; null for a body that carried none. */
  pod: PodView | null;
  members: RoomMember[];
  leaderId: string;
  /** My member id here (`RoomView.you.id`); `''` while unknown. */
  myId: string;
  iAmReady: boolean;
  allReady: boolean;
  dealing: boolean;
  error: string | null;
  onReady: (ready: boolean) => void;
  onRetry: () => void;
}) {
  const myMemberId = myId === '' ? null : myId;
  // The cube's art warms while the room fills, so the first pack — and every one after — draws at once.
  useEffect(() => void preloadCubeArt(), []);

  const [seatError, setSeatError] = useState<string | null>(null);
  /**
   * One seat change at a time, held here and not drawn: disabling every seat's
   * buttons for the round trip made the whole list blink on each press (the
   * operator, 2026-10-19: *"whenever i click sit here or ai, i notice all the
   * buttons flash"*). A press while one is in flight goes out once it has answered.
   */
  const inFlight = useRef(false);
  const later = useRef<(() => Promise<{ ok: boolean; message: string | null }>)[]>([]);

  const act = (call: () => Promise<{ ok: boolean; message: string | null }>): void => {
    if (inFlight.current) {
      later.current.push(call);
      return;
    }
    inFlight.current = true;
    setSeatError(null);
    call()
      .then((r) => {
        if (!r.ok) setSeatError(r.message);
      })
      .finally(() => {
        inFlight.current = false;
        const next = later.current.shift();
        if (next !== undefined) act(next);
      });
  };
  const doSit = (seat: number): void => act(() => sitPod(roomId, seat));
  const doAi = (seat: number, on: boolean): void => act(() => aiPod(roomId, seat, on));
  const doClose = (seat: number, closed: boolean): void => act(() => closePod(roomId, seat, closed));
  const doStand = (): void => act(() => standPod(roomId));

  return (
    <section className="lobby__card" data-testid="draft-lobby">
      {pod !== null && (
        <>
          <h2>Seats</h2>
          <PodSeats
            seats={pod.seats}
            myMemberId={myMemberId}
            leaderId={leaderId}
            readyOf={(id) => members.find((m) => m.id === id)?.ready === true}
            onSit={doSit}
            onStand={doStand}
            onAi={doAi}
            onClose={doClose}
          />
          {seatError !== null && (
            <p className="lobby__error" role="alert" data-testid="pod-seat-error">
              {seatError}
            </p>
          )}
        </>
      )}

      <p className="lobby__note" data-testid="draft-state">
        {draftStateText(pod, members, dealing)}
      </p>

      <button
        type="button"
        className="lobby__go"
        data-testid="ready-toggle"
        aria-pressed={iAmReady}
        disabled={dealing || members.length === 0}
        onClick={() => onReady(!iAmReady)}
      >
        {iAmReady ? 'Stand down' : 'Ready'}
      </button>

      {error !== null && (
        <div className="lobby__error" role="alert" data-testid="draft-error">
          <p>{error}</p>
          {/* Only while everyone still is ready: a refusal because somebody
              stood down in the meantime fixes itself when they ready again, and
              the deal is asked for on its own then. */}
          {allReady && (
            <button type="button" data-testid="draft-retry" onClick={onRetry}>
              Try again
            </button>
          )}
        </div>
      )}

    </section>
  );
}

/** Who the draft is waiting on, in one line: the seated members not ready, else the open seats. */
function draftStateText(pod: PodView | null, members: RoomMember[], dealing: boolean): string {
  if (dealing) return 'Dealing the draft…';
  const seats = pod?.seats ?? [];
  const seatedIds = seats.filter((s) => s !== null && s.memberId !== POD_AI && s.memberId !== POD_CLOSED).map((s) => s!.memberId);
  const waiting = members.filter((m) => seatedIds.includes(m.id) && !m.ready).map((m) => m.name);
  if (waiting.length > 0) return `Waiting for ${listOf(waiting)}.`;
  const open = seats.filter((s) => s === null).length;
  if (open > 0) return open === 1 ? '1 open seat' : `${open} open seats`;
  return seatedIds.length === 0 ? 'Nobody is seated.' : 'Everyone is ready.';
}

/** `a`, `a and b`, `a, b and c`. */
function listOf(names: string[]): string {
  if (names.length <= 2) return names.join(' and ');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
