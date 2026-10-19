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
 * ## Fetched independently, not threaded through new props (wave 72 §R)
 *
 * The room id comes from the route itself (`useRoute()`), the same way
 * `MatchScreen.tsx` reads its own. Which seat is mine comes from `myId`, the
 * server's own `you.id` for this room — never whoami's id, which for an
 * admin session is not the member id the pod's seats name.
 * `RoomView.pod` is read past `rooms/api.ts`'s loose `unknown` the same way
 * `MatchScreen.tsx` reads `tables` past it — see `pod/client.ts`.
 *
 * `pod === null` (the fetch has not landed, `pod.ts` is not on the server
 * yet, or this really is an old server) draws nothing new: the lobby looks
 * exactly as it did before this wave, seats included nowhere, which is the
 * safe default while lane P's routes are still landing.
 */

import { useEffect, useState } from 'react';

import type { RoomMember } from '../rooms/api.ts';
import { StatusPill } from './ConstructedScreen.tsx';
import { useRoute } from './route.ts';
import { roomFeed } from '../rooms/feed.ts';
import { fetchPodView, sitPod, standPod } from './pod/client.ts';
import { PodSeats } from './pod/PodSeats.tsx';
import type { PodView } from './pod/wire.ts';

function roomIdOf(route: ReturnType<typeof useRoute>): string | null {
  if (route.kind === 'room') return route.roomId;
  if (route.kind === 'draft') return route.draftId;
  return null;
}

/** The pod view, followed without polling — the same mechanism `MatchScreen.tsx`'s table strip already uses. */
function usePodView(roomId: string | null): PodView | null {
  const [pod, setPod] = useState<PodView | null>(null);
  useEffect(() => {
    if (roomId === null) return;
    let live = true;
    const stop = roomFeed().follow({ room: roomId }, () => {
      fetchPodView(roomId).then((v) => {
        if (live) setPod(v);
      });
    });
    return () => {
      live = false;
      stop();
    };
  }, [roomId]);
  return pod;
}

export function DraftLobby({
  members,
  leaderId,
  myId,
  iAmReady,
  allReady,
  dealing,
  busy,
  error,
  onReady,
  onRetry,
}: {
  members: RoomMember[];
  leaderId: string;
  /** My member id here (`RoomView.you.id`); `''` while unknown. */
  myId: string;
  iAmReady: boolean;
  allReady: boolean;
  dealing: boolean;
  busy: boolean;
  error: string | null;
  onReady: (ready: boolean) => void;
  onRetry: () => void;
}) {
  const route = useRoute();
  const roomId = roomIdOf(route);
  const myMemberId = myId === '' ? null : myId;
  const pod = usePodView(roomId);

  const [seatBusy, setSeatBusy] = useState(false);
  const [seatError, setSeatError] = useState<string | null>(null);

  const seated = new Set((pod?.seats ?? []).filter((s) => s !== null).map((s) => s!.memberId));
  const spectators = members.filter((m) => !seated.has(m.id));

  const doSit = (seat: number): void => {
    if (roomId === null) return;
    setSeatBusy(true);
    setSeatError(null);
    sitPod(roomId, seat)
      .then((r) => {
        if (!r.ok) setSeatError(r.message);
      })
      .finally(() => setSeatBusy(false));
  };
  const doStand = (): void => {
    if (roomId === null) return;
    setSeatBusy(true);
    setSeatError(null);
    standPod(roomId)
      .then((r) => {
        if (!r.ok) setSeatError(r.message);
      })
      .finally(() => setSeatBusy(false));
  };

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
            busy={seatBusy}
            onSit={doSit}
            onStand={doStand}
          />
          {seatError !== null && (
            <p className="lobby__error" role="alert" data-testid="pod-seat-error">
              {seatError}
            </p>
          )}
        </>
      )}

      <h2>{pod !== null ? 'Spectators' : 'In the room'}</h2>
      <ul className="draft__members" data-testid="draft-members">
        {spectators.length === 0 ? (
          <li className="draft__member draft__member--empty" data-testid="draft-nobody">
            {members.length === 0 ? 'Nobody has joined yet.' : 'Everybody is seated.'}
          </li>
        ) : (
          spectators.map((member) => {
            const i = members.indexOf(member);
            return (
              <li key={member.id} className="draft__member" data-testid={`draft-member-${i}`}>
                <strong className="tables__who">{member.name}</strong>
                {member.id === leaderId && leaderId !== '' && (
                  <StatusPill kind="leader" testId={`draft-member-${i}-leader`} state="leader" mark="crown" label="leader" />
                )}
                <StatusPill
                  kind="ready"
                  testId={`draft-member-${i}-ready`}
                  state={member.ready ? 'yes' : 'no'}
                  mark={member.ready ? 'tick' : 'ring'}
                  label={member.ready ? 'ready' : 'not ready'}
                />
              </li>
            );
          })
        )}
      </ul>

      <p className="lobby__note" data-testid="draft-state">
        {draftStateText(members, dealing)}
      </p>

      <button
        type="button"
        className="lobby__go"
        data-testid="ready-toggle"
        aria-pressed={iAmReady}
        disabled={busy || dealing || members.length === 0}
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

      <p className="lobby__note" data-testid="draft-rule">
        The draft deals when every member of this room is ready. Bots take whatever is left of the eight
        seats at that moment — never before, so nobody who has not readied is played for.
      </p>
      <p className="lobby__note" data-testid="draft-restart-note">
        A draft does not survive a restart of the server. The room comes back to this lobby, with its ready
        marks, rather than to an empty table.
      </p>
    </section>
  );
}

/** Who the draft is waiting on, in one line. Names, because none of them is "you". */
function draftStateText(members: RoomMember[], dealing: boolean): string {
  if (dealing) return 'Dealing the draft…';
  if (members.length === 0) return 'Waiting for someone to join.';
  const waiting = members.filter((m) => !m.ready).map((m) => m.name);
  if (waiting.length === 0) return 'Everyone is ready.';
  return `Waiting for ${listOf(waiting)}.`;
}

/** `a`, `a and b`, `a, b and c`. */
function listOf(names: string[]): string {
  if (names.length <= 2) return names.join(' and ');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
