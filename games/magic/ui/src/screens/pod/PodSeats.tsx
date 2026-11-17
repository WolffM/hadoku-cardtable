/*
 * The pod's 8 seats, as a strip of avatars (AF305 §B — the operator: "the
 * draft room look ugly at the moment", picking "B - Cube Gallery"). Was the
 * 1v1 table's seat ROWS, ported verbatim (wave 72 §R.1); a strip of 8 rows
 * read as a long list, so this redesign keeps every seat ACTION (Sit, AI,
 * Close/Open, Remove AI) but draws each seat as a round avatar with
 * its name underneath and its actions beside it, rather than a line in a
 * table. None of that is hover-only: a phone has no hover, so every action
 * is its own always-visible, labelled button — an `ActionButton`, because a
 * seat's AI and the Remove the room draws in its place are one position.
 *
 * The ready ring (`data-ready` on the avatar, the success token) replaces
 * the `StatusPill` as the seat's OWN at-a-glance signal, but the pill stays
 * too — `pod-seat-<n>-ready` is in the id contract, and colour alone is not
 * a status (a third of the operator's friends could not read it — the same
 * reasoning `ConstructedScreen.tsx`'s `StatusPill` was built for).
 *
 * Unlike a 1v1 seat, a pod seat carries no deck/legal state (drafting has
 * not happened yet) — just who is there, whether they are ready, and
 * whether they lead the room. Readiness itself is unaffected by seating
 * (`games/magic/server/src/room/lobby.ts`'s `startDraft`: the gate counts seated
 * members once anyone has sat, and every member before that), so this draws
 * a ready ring for whoever is seated but never toggles it — `ready-toggle`
 * stays the single, global control it already is.
 *
 * Past 8, the room is still ONE list of seats (the operator, 2026-10-31:
 * *"several pods: we dont need to show this in the lobby screen"*): pods are
 * decided only by the leader's Split & randomize (`PodSplit.tsx`). A full room
 * offers someone who has not sat (and the owner, for an AI) one seat more,
 * which grows the room by that seat (`games/magic/server/src/room/lobby.ts`'s
 * `sitPod`/`aiPod`).
 *
 * No Stand: giving a seat back is the spectators' open slot under the strip
 * (`../RoomSpectators.tsx`), and an open seat here moves a seated player to it
 * (the operator, 2026-11-02: "click back and forth between player and
 * spectator … we dont need a stand button at all").
 *
 * Purely presentational: a parent (`PodLobby.tsx`) owns the fetch and the
 * sit calls, which is what makes this unit-testable with fixtures
 * (`PodSeats.test.ts`) instead of a mocked server.
 *
 * ## Wave 119 §U: the rendering itself is now `@hadoku/game-ui/seats/SeatChip.tsx`'s `SeatList`
 *
 * This file is the Magic-pod ADAPTER: it still owns the two things that are genuinely Magic's
 * own (`isPodAi`/`POD_CLOSED`/`POD_MAX_SEATS` from `./wire.ts`, and the "a full room grows one
 * seat" business rule), and classifies each seat into the generic `SeatOccupant` the platform
 * component draws. Every prop on `PodSeats` and every class name/`data-testid` the generic
 * component emits are unchanged — `PodSeats.test.ts` is the DOM contract this lift must not
 * break, and it is proved against this file exactly as it was before (wave 119's own closing
 * note has the before/after render diff).
 */

import { SeatList, type SeatOccupant } from '@hadoku/game-ui/seats/SeatChip.tsx';
import type { Face } from '@hadoku/game-ui/components/Avatar.tsx';
import { isPodAi, POD_CLOSED, POD_MAX_SEATS, type PodSeats as PodSeatsValue } from './wire.ts';

export interface PodSeatsProps {
  /** 8, or one more for each seat a room past 8 has grown by. */
  seats: PodSeatsValue;
  /** The viewer's own member id, or `null` before identity resolves. */
  myMemberId: string | null;
  leaderId: string;
  /** Looks up a seated member's readiness — the room's own `ready` flag, unaffected by seating. */
  readyOf: (memberId: string) => boolean;
  /** Looks up a seated member's own watchparty avatar id (`undefined` for none) — the same id `Avatar` draws everywhere else. */
  faceOf: (memberId: string) => Face;
  /** A Challenge's field is the event's: no seat is grown, given to the AI, taken from it or closed. */
  fieldFixed?: boolean;
  /** An event's room before its seats open (`../../room/seatsOpen.tsx`): nobody sits, nor gives a seat to the AI. */
  shut?: boolean;
  onSit: (seat: number) => void;
  /** The AI button on an open seat (`on`), or the AI's own seat given back. */
  onAi: (seat: number, on: boolean) => void;
  /** The owner's: close an open seat (`closed`), or open a closed one. */
  onClose: (seat: number, closed: boolean) => void;
  /** The leader removes a seated human to the spectator row (wave 120 §S2). Absent draws no Remove button. */
  onRemoveMember?: (seat: number, memberId: string) => void;
  /** The leader puts the bot in a seated human's place, one action (wave 120 §S2). Absent draws no Bot button. */
  onBotReplace?: (seat: number, memberId: string) => void;
}

export function PodSeats({ seats, myMemberId, leaderId, readyOf, faceOf, fieldFixed = false, shut = false, onSit, onAi, onClose, onRemoveMember, onBotReplace }: PodSeatsProps) {
  const iLead = myMemberId !== null && myMemberId === leaderId;
  const mySeat = myMemberId === null ? null : seats.findIndex((s) => s?.memberId === myMemberId);
  const iAmSeated = mySeat !== null && mySeat >= 0;
  // A full room: one seat more, for someone who has not sat yet, and for the owner's AI.
  const grows = !fieldFixed && (iLead || (!iAmSeated && myMemberId !== null)) && seats.length < POD_MAX_SEATS && seats.every((s) => s !== null);
  const drawn = seats.length + (grows ? 1 : 0);

  const slots = Array.from({ length: drawn }, (_, seat) => {
    const occupant = seats[seat] ?? null;
    let classified: SeatOccupant;
    if (occupant === null) {
      classified = { kind: 'open' };
    } else if (occupant.memberId === POD_CLOSED) {
      classified = { kind: 'closed' };
    } else if (isPodAi(occupant.memberId)) {
      classified = { kind: 'bot', name: occupant.name, avatarId: occupant.avatarId };
    } else {
      const face = faceOf(occupant.memberId);
      classified = {
        kind: 'member',
        id: occupant.memberId,
        name: occupant.name,
        avatarId: face.id ?? undefined,
        look: face.look,
        ready: readyOf(occupant.memberId),
        leader: occupant.memberId === leaderId && leaderId !== '',
        mine: occupant.memberId === myMemberId,
      };
    }
    return { seat, occupant: classified };
  });

  return (
    <SeatList
      slots={slots}
      iLead={iLead}
      shut={shut}
      fieldFixed={fieldFixed}
      realSeatCount={seats.length}
      mySeat={iAmSeated ? mySeat : null}
      onSit={onSit}
      onBotOn={(seat) => onAi(seat, true)}
      onBotOff={(seat) => onAi(seat, false)}
      onCloseSeat={(seat) => onClose(seat, true)}
      onOpenSeat={(seat) => onClose(seat, false)}
      onRemoveMember={onRemoveMember}
      onBotReplace={onBotReplace}
    />
  );
}
