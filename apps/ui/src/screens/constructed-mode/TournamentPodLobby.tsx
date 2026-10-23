/*
 * A Constructed room's tournament lobby — the pod seat strip,
 * `docs/planning/tournament-mode-plan.md`'s "Seats" ruling.
 *
 * REUSES `PodSeats` verbatim (the brief's own instruction: "the same
 * component, actions and Ready, not a copy") — the strip, its AI/Close/Sit/
 * Stand actions and the ready ring are exactly a draft pod's. This file only
 * adds what a tournament's lobby needs beside it: the global Ready toggle
 * (the same `ready-toggle` id `DraftLobby.tsx` uses). No "who is this
 * waiting on" text line — `DraftLobby.tsx`'s own `draftStateText` was
 * deleted the same way (the operator, 2026-10-22: "neither room writes who
 * it is waiting on"); the seat ring's ready pill already says it, same as
 * every other pod lobby now.
 *
 * ## No Lock seats button (ruling 7)
 *
 * The operator, 2026-10-22: *"why is there a 'lock seats' button? that
 * seems pointless the seats lock when all players are ready and the games
 * start."* The lock fires BY ITSELF, server-side, the instant the field is
 * valid (`room/lobby.ts`'s `#maybeLockTournament`, called from every
 * Ready/sit/stand/AI write) — there is nothing left for the leader to
 * press, and no "is it lockable yet" to compute here: the round simply
 * starts, which `ConstructedScreen.tsx` already shows by switching from
 * this lobby to `TournamentRounds` the moment `pod.phase` says `rounds`.
 *
 * ## AI entrants (the operator, 2026-10-22)
 *
 * *"AI can sit in the tournament, but we can also allow byes… no additional
 * AI will be added to a tournament once it's started."* `PodSeats` already
 * draws the AI button on every open seat unconditionally, so showing it here
 * costs nothing; it stops existing the moment this component stops being
 * rendered, which `ConstructedScreen.tsx` already arranges by phase (no AI
 * action exists anywhere once `pod.phase !== 'lobby'`, because this is the
 * only place one is drawn).
 *
 * `isPodAi` (`@hadoku/shared`'s `pod.ts`, re-exported from `./wire.ts`) is
 * the one test for "is this seat AI", true for both the draft pod's single
 * shared `POD_AI` (`'ai'`) and a tournament pod's own per-seat entrants
 * (`` `ai:${seat}` ``, one per AI seat, so several can be seated and
 * distinguished in pairings/standings) — `PodSeats.tsx`/`PodBracket.tsx`
 * (reused, unedited) now draw the AI look and the Remove action for either
 * shape too (tour-s's own fix), so there is nothing left to work around here.
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
 * and All Random pass nothing: ruling 4, "need only Ready".
 */

import { ActionButton } from '../../components/ActionButton.tsx';
import type { RoomMember } from '../../rooms/api.ts';
import { PodSeats } from '../pod/PodSeats.tsx';
import type { PodView } from '../pod/wire.ts';
import type { ReactNode } from 'react';

export function TournamentPodLobby({
  pod,
  members,
  leaderId,
  myMemberId,
  iAmReady,
  canReady,
  onSit,
  onStand,
  onAi,
  onClose,
  onReady,
  seatError,
  children,
}: {
  pod: PodView;
  members: RoomMember[];
  leaderId: string;
  myMemberId: string | null;
  iAmReady: boolean;
  /** The mode's own readiness condition (Classic: a legal deck; Random: nothing extra) — gates the Ready toggle, same as the 1v1 table's `canReady`. */
  canReady: boolean;
  onSit: (seat: number) => void;
  onStand: () => void;
  onAi: (seat: number, on: boolean) => void;
  onClose: (seat: number, closed: boolean) => void;
  onReady: (ready: boolean) => void;
  seatError: string | null;
  /** Classic's deck chooser, drawn under the strip. Nothing for All Random. */
  children?: ReactNode;
}) {
  const readyOf = (id: string): boolean => members.find((m) => m.id === id)?.ready === true;

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
        </div>
      </div>
      {seatError !== null && (
        <p className="ct-error" role="alert" data-testid="pod-seat-error">
          {seatError}
        </p>
      )}
      {children}
    </section>
  );
}
