/*
 * A pod's lobby, for a draft room and a Constructed tournament alike: the
 * seat strip (`PodSeats`, with its Sit, Stand, AI and Close), my Ready, a
 * refused seat change, and who is watching. `children` is the one per-type
 * input under the strip: a draft's pool picker, Classic's deck chooser.
 *
 * A draft room of more than 8 splits into pods before its draft (`PodSplit`):
 * the leader's button beside Ready, then the pods in the seats' place.
 *
 * Seat changes go out one at a time, held here and not drawn: disabling every
 * seat's buttons for the round trip made the whole list blink on each press
 * (the operator, 2026-10-19: *"whenever i click sit here or ai, i notice all
 * the buttons flash"*). A press while one is in flight goes out once it has
 * answered.
 */

import { useRef, useState, type ReactNode } from 'react';

import type { RoomMember } from '../../rooms/api.ts';
import { aiPod, closePod, sitPod, splitPod, standPod, startSplitDraft, type PodActionOutcome } from './client.ts';
import { PodSeats } from './PodSeats.tsx';
import { PodSpectators } from './PodSpectators.tsx';
import { PodSplit } from './PodSplit.tsx';
import { ReadyToggle } from './ReadyToggle.tsx';
import type { PodView } from './wire.ts';

export interface PodLobbyProps {
  testId: string;
  roomId: string;
  /** `null` for the one frame before the room's own read lands: Ready alone. */
  pod: PodView | null;
  members: RoomMember[];
  leaderId: string;
  myMemberId: string | null;
  iAmReady: boolean;
  readyDisabled: boolean;
  onReady: (ready: boolean) => void;
  /** Beside Ready: where the room stands (a draft's "Dealing"). */
  note?: ReactNode;
  children?: ReactNode;
}

export function PodLobby({ testId, roomId, pod, members, leaderId, myMemberId, iAmReady, readyDisabled, onReady, note, children }: PodLobbyProps) {
  const [seatError, setSeatError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const later = useRef<(() => Promise<PodActionOutcome>)[]>([]);
  const act = (call: () => Promise<PodActionOutcome>): void => {
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

  const split =
    pod === null ? null : (
      <PodSplit
        pod={pod}
        members={members}
        leaderId={leaderId}
        myMemberId={myMemberId}
        onSplit={() => act(() => splitPod(roomId))}
        onStart={() => act(() => startSplitDraft(roomId))}
      />
    );
  const splitStands = pod?.pods !== undefined;
  // Before a split, its button sits with Ready; once it stands, the pods take the seats' place.
  const side = (
    <ReadyToggle
      ready={iAmReady}
      disabled={readyDisabled}
      onReady={onReady}
      note={
        <>
          {note}
          {!splitStands && split}
        </>
      }
    />
  );

  return (
    <section className="lobby__card" data-testid={testId}>
      {pod === null ? (
        side
      ) : (
        <>
          <div className="pod-strip">
            {splitStands ? (
              split
            ) : (
              <PodSeats
                seats={pod.seats}
                myMemberId={myMemberId}
                leaderId={leaderId}
                readyOf={(id) => members.find((m) => m.id === id)?.ready === true}
                avatarIdOf={(id) => members.find((m) => m.id === id)?.avatarId}
                onSit={(seat) => act(() => sitPod(roomId, seat))}
                onStand={() => act(() => standPod(roomId))}
                onAi={(seat, on) => act(() => aiPod(roomId, seat, on))}
                onClose={(seat, closed) => act(() => closePod(roomId, seat, closed))}
              />
            )}
            {side}
          </div>
          {seatError !== null && (
            <p className="ct-error" role="alert" data-testid="pod-seat-error">
              {seatError}
            </p>
          )}
          <PodSpectators pod={pod} members={members} myId={myMemberId} leaderId={leaderId} />
        </>
      )}
      {children}
    </section>
  );
}
