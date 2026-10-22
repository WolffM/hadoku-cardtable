/*
 * A Constructed room's tournament lobby — the pod seat strip and the
 * leader's Lock seats, `docs/planning/tournament-mode-plan.md`'s "Seats" and
 * "Lock" rulings.
 *
 * REUSES `PodSeats` verbatim (the brief's own instruction: "the same
 * component, actions and Ready, not a copy") — the strip, its AI/Close/Sit/
 * Stand actions and the ready ring are exactly a draft pod's. This file only
 * adds what a tournament's lobby needs beside it: the global Ready toggle
 * (the same `ready-toggle` id `DraftLobby.tsx` uses) and the leader's Lock.
 * No "who is this waiting on" text line — `DraftLobby.tsx`'s own
 * `draftStateText` was deleted the same way (the operator, 2026-10-22:
 * "neither room writes who it is waiting on"); the seat ring's ready pill
 * already says it, same as every other pod lobby now.
 *
 * ## AI entrants (the operator, 2026-10-22)
 *
 * *"AI can sit in the tournament, but we can also allow byes… no additional
 * AI will be added to a tournament once it's started."* `PodSeats` already
 * draws the AI button on every open seat unconditionally, so showing it here
 * costs nothing; it stops existing the moment this component stops being
 * rendered, which `ConstructedScreen.tsx` already arranges by phase (no AI
 * action exists anywhere once `pod.phase !== 'lobby'`, because this is the
 * only place one is drawn). Lock seats needs ≥ 2 entrants seated, including
 * at least one human, with every human ready — AI are always ready, so an
 * AI's own seat never blocks it.
 *
 * `isPodAi` (`@hadoku/shared`'s `pod.ts`, re-exported from `./wire.ts`) is
 * the one test for "is this seat AI", true for both the draft pod's single
 * shared `POD_AI` (`'ai'`) and a tournament pod's own per-seat entrants
 * (`` `ai:${seat}` ``, one per AI seat, so several can be seated and
 * distinguished in pairings/standings) — `PodSeats.tsx`/`PodBracket.tsx`
 * (reused, unedited) now draw the AI look and the Remove action for either
 * shape too (tour-s's own fix), so there is nothing left to work around here.
 *
 * ## Lock seats' own gate is mode-aware, and the client cannot see all of it
 *
 * `room/lobby.ts`'s `#lockTournament`: Classic's own human-ready test is
 * `hasLegalSeatDeck` (a legal deck already held via the EXISTING
 * `PUT …/deck`), never the room's `ready` flag; Random's is that flag.
 * `members[].ready` therefore answers "is this human ready to lock" for
 * Random but NOT for Classic — and for Classic the CLIENT can see its own
 * seat's legality (`ConstructedScreen.tsx`'s `myLegal`) but has no way to
 * see anyone else's, since a member's own `deck` is caller-scoped on the
 * wire. So `lockReadyOf` is the caller's OWN answer to "is this human ready
 * to lock" — Random passes `members[].ready` through unchanged; Classic
 * passes a function that is honest about what it cannot know (`() => true`
 * for every human but the caller's own) and leaves the real gate to the
 * server's refusal, shown here in its own words (`lockError`). It is
 * DELIBERATELY separate from `readyOf`, which still drives the seat ring's
 * ready pill (PodSeats' own, unaffected display of the room's `ready` flag).
 *
 * ## Classic's deck chooser, and why it is a slot
 *
 * *"Classic needs a deck chosen"* (the plan's Design section) is Classic's
 * OWN readiness condition, checked by `ConstructedScreen.tsx` before it ever
 * enables the Ready toggle (`canReady`, passed in — the SAME `canReady` the
 * 1v1 table already computes, since Classic's gate is identical: a legal
 * deck via the EXISTING `PUT …/deck`) — this file draws whatever that screen
 * hands it as `children` (the reused `DeckChooser` grid, for Classic) under
 * the strip, same position `DraftLobby.tsx` draws its pool picker. Gauntlet
 * and All Random pass nothing: ruling 4, "need only Ready" (Gauntlet is
 * refused server-side while Tournament is on — `ConstructedScreen.tsx`'s own
 * header on `tournament-mode-unsupported` — so this never actually draws for it).
 */

import { ActionButton } from '../../components/ActionButton.tsx';
import type { RoomMember } from '../../rooms/api.ts';
import { PodSeats } from '../pod/PodSeats.tsx';
import { isPodAi, POD_CLOSED, type PodView } from '../pod/wire.ts';
import type { ReactNode } from 'react';

/** ≥ 2 entrants seated (AI counted), at least one of them human, every human ready — AI are always ready. */
export function canLockSeats(pod: PodView, readyOf: (memberId: string) => boolean): boolean {
  const occupants = pod.seats.filter((s) => s !== null && s.memberId !== POD_CLOSED);
  const humans = occupants.filter((o) => !isPodAi(o!.memberId));
  return occupants.length >= 2 && humans.length >= 1 && humans.every((h) => readyOf(h!.memberId));
}

export function TournamentPodLobby({
  pod,
  members,
  leaderId,
  myMemberId,
  iAmReady,
  canReady,
  lockReadyOf,
  onSit,
  onStand,
  onAi,
  onClose,
  onReady,
  onLock,
  seatError,
  lockError,
  children,
}: {
  pod: PodView;
  members: RoomMember[];
  leaderId: string;
  myMemberId: string | null;
  iAmReady: boolean;
  /** The mode's own readiness condition (Classic: a legal deck; Random: nothing extra) — gates the Ready toggle, same as the 1v1 table's `canReady`. */
  canReady: boolean;
  /** See the file header: whether a HUMAN entrant counts toward Lock seats — mode-aware, and honest about what the caller cannot see of anyone but itself. */
  lockReadyOf: (memberId: string) => boolean;
  onSit: (seat: number) => void;
  onStand: () => void;
  onAi: (seat: number, on: boolean) => void;
  onClose: (seat: number, closed: boolean) => void;
  onReady: (ready: boolean) => void;
  onLock: () => void;
  seatError: string | null;
  lockError: string | null;
  /** Classic's deck chooser, drawn under the strip. Nothing for All Random. */
  children?: ReactNode;
}) {
  const iLead = myMemberId !== null && myMemberId === leaderId;
  const readyOf = (id: string): boolean => members.find((m) => m.id === id)?.ready === true;
  const lockable = canLockSeats(pod, lockReadyOf);

  return (
    <section className="lobby__card" data-testid="tournament-lobby">
      <div className="pod-strip">
        <PodSeats
          seats={pod.seats}
          myMemberId={myMemberId}
          leaderId={leaderId}
          readyOf={readyOf}
          avatarIdOf={(id) => members.find((m) => m.id === id)?.avatarId}
          onSit={onSit}
          onStand={onStand}
          onAi={onAi}
          onClose={onClose}
        />
        <div className="pod-strip__side">
          <ActionButton
            action={iAmReady ? 'unready' : 'ready'}
            className="lobby__go"
            data-testid="ready-toggle"
            aria-pressed={iAmReady}
            disabled={!canReady}
            onPress={() => onReady(!iAmReady)}
          >
            {iAmReady ? 'Stand down' : 'Ready'}
          </ActionButton>
          {iLead && (
            <ActionButton action="lock-seats" className="lobby__go" data-testid="pod-lock-seats" disabled={!lockable} onPress={onLock}>
              Lock seats
            </ActionButton>
          )}
        </div>
      </div>
      {seatError !== null && (
        <p className="ct-error" role="alert" data-testid="pod-seat-error">
          {seatError}
        </p>
      )}
      {lockError !== null && (
        <p className="ct-error" role="alert" data-testid="pod-lock-error">
          {lockError}
        </p>
      )}
      {children}
    </section>
  );
}
