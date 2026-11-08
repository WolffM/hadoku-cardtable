/*
 * A pod's lobby, for a draft room and a Constructed tournament alike: the
 * seat strip (`PodSeats`, with its Sit, AI and Close), my Ready, a refused
 * seat change, and the spectators (`../RoomSpectators.tsx`), whose open slot
 * gives my seat back. `children` is the one per-type
 * input under the strip: a draft's pool picker, Classic's deck chooser.
 *
 * A draft room of more than 8 splits into pods before its draft (`PodSplit`):
 * the leader's button beside Ready, then the pods in the seats' place, Ready
 * locked on, and the leader's Start draft.
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
import { RoomSpectators } from '../RoomSpectators.tsx';
import { PodSplit, PodSplitAction, standingPods } from './PodSplit.tsx';
import { ReadyToggle } from './ReadyToggle.tsx';
import { podPlayers, type PodView } from './wire.ts';
import { faceOf } from '../../components/Avatar.tsx';

export interface PodLobbyProps {
  testId: string;
  roomId: string;
  /** `null` for the one frame before the room's own read lands: Ready alone. */
  pod: PodView | null;
  members: RoomMember[];
  leaderId: string;
  myMemberId: string | null;
  /**
   * A historical replay seat's deck name, by the `deckId` its seat carries —
   * the parent owns the library decks (`GET /api/tables/decks`) and joins the
   * id to the name here, so the seat strip needs no fetch of its own.
   * `undefined` for every seat that is not a replay's public list.
   */
  deckNameOf: (deckId: string) => string | undefined;
  iAmReady: boolean;
  readyDisabled: boolean;
  onReady: (ready: boolean) => void;
  /** Beside Ready: where the room stands (a draft's "Dealing"). */
  note?: ReactNode;
  children?: ReactNode;
}

export function PodLobby({ testId, roomId, pod, members, leaderId, myMemberId, deckNameOf, iAmReady, readyDisabled, onReady, note, children }: PodLobbyProps) {
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

  const splitStands = pod !== null && standingPods(pod) !== null;
  // The leader's Split, then Start draft, sit with Ready; once split, every position is locked, Ready included.
  const side = (
    <ReadyToggle
      ready={iAmReady}
      disabled={readyDisabled || splitStands}
      onReady={onReady}
      note={
        <>
          {note}
          {pod !== null && (
            <PodSplitAction
              pod={pod}
              members={members}
              leaderId={leaderId}
              myMemberId={myMemberId}
              onSplit={() => act(() => splitPod(roomId))}
              onStart={() => act(() => startSplitDraft(roomId))}
            />
          )}
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
              <PodSplit pod={pod} members={members} myMemberId={myMemberId} />
            ) : (
              <div className="table-side">
                <h3 className="table-side__heading">Players</h3>
                <PodSeats
                  seats={pod.seats}
                  myMemberId={myMemberId}
                  leaderId={leaderId}
                  readyOf={(id) => members.find((m) => m.id === id)?.ready === true}
                  faceOf={(id) => faceOf(members.find((m) => m.id === id))}
                  deckNameOf={deckNameOf}
                  onSit={(seat) => act(() => sitPod(roomId, seat))}
                  onAi={(seat, on) => act(() => aiPod(roomId, seat, on))}
                  onClose={(seat, closed) => act(() => closePod(roomId, seat, closed))}
                />
              </div>
            )}
            {side}
          </div>
          {seatError !== null && (
            <p className="ct-error" role="alert" data-testid="pod-seat-error">
              {seatError}
            </p>
          )}
          {!splitStands && (
            <RoomSpectators
              under
              spectators={members.filter((m) => !podPlayers(pod).has(m.id))}
              myId={myMemberId}
              leaderId={leaderId}
              {...(myMemberId !== null && podPlayers(pod).has(myMemberId) ? { onWatch: () => act(() => standPod(roomId)) } : {})}
            />
          )}
        </>
      )}
      {children}
    </section>
  );
}
