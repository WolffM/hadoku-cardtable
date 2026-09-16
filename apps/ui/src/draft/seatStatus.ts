/*
 * Telling an EMPTY seat from a HELD one, which the envelope does not say in so
 * many words.
 *
 * ## The thing this file exists to make visible
 *
 * Seat reservations shipped in `@wolffm/rooms-protocol@0.38.111`: a
 * disconnecting drafter's seat is released with `unseatParticipant(table, pid,
 * { hold: true })` and held against everyone else for a TTL, so a refresh
 * returns you to the seat you were in rather than appending you to the end of
 * the pod (`apps/server/src/room/draftRooms.ts`, `releaseSeat` and the
 * reconnect guard in `leaveDraftRoom`).
 *
 * The payload carries none of that. `DraftSeatView` is `{ id, occupant,
 * displayName, pickedCount }` and there is no `reserved` or `heldUntil` field
 * on it (`packages/shared/src/draft.ts`). So for the other seven seats at the
 * table, a player who dropped thirty seconds ago and a chair nobody ever sat in
 * are the same four fields — and that is exactly the draft that "silently
 * freezes and looks broken while working perfectly".
 *
 * ## What it is derived from, and why that is sound
 *
 * `occupant` comes from the live seat table (`occupantOf`, `packages/draft/src/
 * view.ts:33`) and goes to `null` the moment a seat is released. `displayName`
 * comes from `state.displayNames[id]`, which is written once when a participant
 * is seated (`draftRooms.ts:225`, `engine.ts:177`) and — verified by grep over
 * `apps/server/src` and `packages/draft/src` — is **never cleared**. A seat that
 * has never held anybody falls through to the literal `Seat ${id}` default at
 * `view.ts:37`.
 *
 * So `occupant === null` with a remembered name is a seat the table is holding
 * for someone, and `occupant === null` with the default name is a free chair.
 *
 * **This is a derivation, not a declared field, and it is the weaker half of
 * this lane.** It reports "held" for the whole draft rather than for the
 * reservation's TTL, because the TTL is not on the wire either; once it
 * expires, the seat reads as held until somebody else takes it. The fix is a
 * `reserved: boolean` on `DraftSeatView`, which is `packages/shared`'s to add
 * and nobody's this wave. Until then this is honest about being inferred —
 * `SEAT_HELD_NOTE` is the sentence the UI puts on screen.
 */

import type { DraftSeatView, DraftView } from './types.ts';

export type SeatStatus =
  /** A connected person. */
  | 'human'
  /** A bot filling the pod. */
  | 'bot'
  /** Nobody in the chair, but the table remembers a name for it. */
  | 'held'
  /** A free chair. */
  | 'empty';

/** What `view.ts:37` writes when no participant has ever been seated here. */
export function defaultSeatName(id: number): string {
  return `Seat ${id}`;
}

/** Status of one seat, from the four fields the envelope actually carries. */
export function seatStatus(seat: DraftSeatView): SeatStatus {
  if (seat.occupant !== null) return seat.occupant.kind;
  return seat.displayName === defaultSeatName(seat.id) ? 'empty' : 'held';
}

/** Every seat the table is holding for an absent player, in seat order. */
export function heldSeats(view: DraftView): DraftSeatView[] {
  return view.seats.filter((seat) => seatStatus(seat) === 'held');
}

/**
 * The caveat, in one sentence, so a player is not told something firmer than
 * the payload supports. Rendered next to a held seat.
 */
export const SEAT_HELD_NOTE =
  'The table is holding this seat for a player who dropped. It is inferred from the seat keeping its name — the payload carries no reservation clock.';
