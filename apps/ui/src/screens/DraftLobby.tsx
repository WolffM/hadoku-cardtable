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
 *
 * ## The pool picker (wave 73 §B)
 *
 * The leader picks the cube the pod drafts from here, in the "Cube" tab (Set
 * and Custom are wave 74). `PoolPicker` is purely presentational; every
 * write — the pick itself, an import, a refresh, a delete — is made right
 * here, the same way the seat actions above already are (`pod/client.ts`'s
 * functions, called directly rather than threaded through `ConstructedScreen`
 * as a prop) — `ConstructedScreen.tsx` is untouched this wave.
 *
 * A pick is NOT the same round trip as a seat action: the server runs the
 * verdict first (`PUT /api/rooms/:id/pod/plan`), and a refusal leaves the
 * room's plan exactly as it was. So the refused attempt is never visible on
 * `pod.plan` — it is held here, locally, only until the next attempt (or a
 * reload) — which is what `attempt` below is for.
 *
 * ## Pre-deal art, from the plan's own cube (wave 73 §B follow-up)
 *
 * `GET /api/pools/cubes/:id/cards` (lane C's follow-up, landed `de2f79e3`)
 * lists a cube's whole `DraftCard[]`, so the lobby can warm its art before
 * anything is dealt — `cubeIdsOf` names every distinct cube-kind source the
 * plan's rounds hold (one today; a future Custom round could differ), and
 * `preloadCubeArt` (`art-preload.ts`) is called once per id, each time the
 * set changes. `PodScreen.tsx` does the same, for a reload mid-draft that
 * never passes back through here.
 */

import { useEffect, useRef, useState } from 'react';

import type { CubeSummary, DraftPlan } from '@hadoku/shared';

import { poolsClient, roomsClient, type PoolsClient, type RoomsClient, type RoomMember } from '../rooms/api.ts';
import { PoolPicker, type Refusal } from '../draft/PoolPicker.tsx';
import { preloadCubeArt } from '../play/live/art-preload.ts';
import { aiPod, closePod, sitPod, standPod } from './pod/client.ts';
import { PodSeats } from './pod/PodSeats.tsx';
import { PodSpectators } from './pod/PodSpectators.tsx';
import { POD_AI, POD_CLOSED, podDealable, type PodView } from './pod/wire.ts';

export { podDealable };

/**
 * Round 1's cube — the Cube tab fills all three rounds with one choice, so
 * this is the whole plan's cube for now. `undefined` reads as "no plan at
 * all" (a constructed room, whose `pod` is null and never reaches this).
 */
function cubeIdOf(plan: DraftPlan | undefined): string | null {
  if (plan === undefined) return null;
  const round1 = plan.rounds[0];
  return round1.kind === 'cube' ? round1.cubeId : null;
}

/**
 * Every distinct cube `plan`'s rounds hold, in round order — not just round
 * 1 — so a future Custom round with a different cube per round warms every
 * one of them rather than only the first. Exported for `PodScreen.tsx`'s own
 * reload-mid-draft case. `undefined` reads as no plan at all: nothing to warm.
 */
export function cubeIdsOf(plan: DraftPlan | undefined): string[] {
  if (plan === undefined) return [];
  return [...new Set(plan.rounds.flatMap((r) => (r.kind === 'cube' ? [r.cubeId] : [])))];
}

const defaultPools = poolsClient();
const defaultRooms = roomsClient();

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
  pools = defaultPools,
  rooms = defaultRooms,
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
  /** Tests inject a stub. Production leaves it undefined. */
  pools?: PoolsClient;
  rooms?: Pick<RoomsClient, 'setPlan'>;
}) {
  const myMemberId = myId === '' ? null : myId;
  const amLeader = myId !== '' && myId === leaderId;

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

  /* ── the pool picker: the room's cube list, and the plan write ───────── */
  const planCubeId = cubeIdOf(pod?.plan);
  const verdict = pod?.verdict ?? null;

  // The plan's own cube(s), warmed before the deal — joined so the effect's dependency is one stable string, not a new array each render.
  const planCubeIdsKey = cubeIdsOf(pod?.plan).join(',');
  useEffect(() => {
    if (planCubeIdsKey === '') return;
    let cancelled = false;
    for (const id of planCubeIdsKey.split(',')) {
      pools.cubeCards(id).then((cards) => {
        if (!cancelled && cards !== null) preloadCubeArt(cards);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [planCubeIdsKey]);

  const [cubes, setCubes] = useState<CubeSummary[]>([]);
  const [cubesError, setCubesError] = useState<string | null>(null);
  const loadCubes = (): void => {
    pools
      .listCubes()
      .then((list) => {
        setCubes(list);
        setCubesError(null);
      })
      .catch((e: unknown) => setCubesError(e instanceof Error ? e.message : String(e)));
  };
  useEffect(() => void loadCubes(), []);

  const [planBusy, setPlanBusy] = useState(false);
  /**
   * The last attempted pick's own refusal, and which cube it tried. A
   * refusal never changes `pod.plan` (the contract: "Refused… the plan is
   * unchanged"), so this is the one place that attempt is remembered —
   * local to this browser, and cleared by the next attempt.
   */
  const [attempt, setAttempt] = useState<{ cubeId: string; refusal: Refusal } | null>(null);

  const pickCube = (cubeId: string): void => {
    if (cubeId === planCubeId && attempt === null) return;
    setPlanBusy(true);
    setAttempt(null);
    const plan: DraftPlan = { rounds: [{ kind: 'cube', cubeId }, { kind: 'cube', cubeId }, { kind: 'cube', cubeId }] };
    rooms.setPlan(roomId, plan).then((r) => {
      setPlanBusy(false);
      if (!r.ok) setAttempt({ cubeId, refusal: r.verdict !== null && !r.verdict.ok ? r.verdict : { ok: false, unplayable: [], missingText: [r.message] } });
    });
  };

  const withCubes = (call: () => Promise<{ ok: true } | { ok: false; message: string }>): void => {
    setPlanBusy(true);
    call().then((r) => {
      setPlanBusy(false);
      if (r.ok) loadCubes();
      else setCubesError(r.message);
    });
  };
  const importCube = (link: string): void => withCubes(() => pools.importCube(link));
  const refreshCube = (id: string): void => withCubes(() => pools.refreshCube(id));
  const deleteCube = (id: string): void => withCubes(() => pools.deleteCube(id));

  const selectedId = attempt?.cubeId ?? planCubeId;
  const checking = pod !== null && attempt === null && verdict === null;
  const planOk = verdict !== null && verdict.ok;
  const readyCards = verdict !== null && verdict.ok ? verdict.cards : null;
  /**
   * What the picker shows refused: a local attempt's own refusal, else the
   * CURRENT plan's own background verdict when THAT is refused (no jar yet,
   * or a Forge pin change that re-failed a once-good cube) — never defaulted
   * to "ready" just because nobody locally attempted anything. Found live:
   * without this, `readyCards === null` (verdict refused) but `refusal` (the
   * old, attempt-only field) stayed `null` too, so the verdict line showed
   * `data-state="ready"` with no text while Ready stayed correctly disabled
   * — a driver waiting on "ready" by state got stuck forever (draft.spec.ts's
   * jar-less tests, 2026-10-22).
   */
  const refusal = attempt?.refusal ?? (verdict !== null && !verdict.ok ? verdict : null);

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
            <p className="ct-error" role="alert" data-testid="pod-seat-error">
              {seatError}
            </p>
          )}

          <h2>Cube</h2>
          <PoolPicker
            cubes={cubes}
            cubesError={cubesError}
            selectedId={selectedId}
            leader={amLeader}
            busy={planBusy}
            checking={checking}
            refusal={refusal}
            readyCards={readyCards}
            myId={myMemberId ?? ''}
            onPick={pickCube}
            onImport={importCube}
            onRefresh={refreshCube}
            onDelete={deleteCube}
          />

          <PodSpectators pod={pod} members={members} myId={myMemberId} leaderId={leaderId} />
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
        disabled={dealing || members.length === 0 || (pod !== null && (planBusy || attempt !== null || !planOk))}
        onClick={() => onReady(!iAmReady)}
      >
        {iAmReady ? 'Stand down' : 'Ready'}
      </button>

      {error !== null && (
        <div className="ct-error" role="alert" data-testid="draft-error">
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
