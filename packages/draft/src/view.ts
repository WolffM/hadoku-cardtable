/*
 * Projecting engine state into the per-recipient envelope.
 *
 * **This is where hidden information is enforced.** Not in the UI, and not by a
 * filter applied on the way out of a broadcast — here, by building each
 * recipient's payload from their own slice and nothing else.
 *
 * The envelope makes the guarantee structural rather than procedural: the
 * `spectator` arm of `ViewerView` has no card fields at all, and `DraftSeatView`
 * carries `pickedCount` — a number — instead of the picks. So there is nowhere
 * on a payload that another seat's cards *could* go. Leaking one requires adding
 * a field, which a reviewer sees, rather than forgetting a filter, which nobody
 * sees. `apps/ui/src/draft/hiddenInfo.ts` then walks whole serialised payloads
 * and fails if a card-shaped object appears anywhere but `viewer.pack` and
 * `viewer.pool`.
 *
 * ## Built one recipient at a time, on purpose
 *
 * `viewFor(state, seatId)` is shaped to be the body of
 * `emitPerRecipient(io, room, 'draft', (client) => viewFor(state, seatOf(...)))`
 * — `@wolffm/rooms-server`'s per-recipient emit, which exists precisely because
 * "broadcast one payload and let clients ignore what is not theirs" is not
 * privacy. Wiring that up is a later wave's job; producing a payload that can be
 * driven that way is this one's.
 */

import { seatRows, type SeatId, type SeatOccupant } from '@wolffm/rooms-protocol';
import type { DraftSeatView, DraftView } from '@hadoku/shared';
import { directionFor, waitingOn, type DraftState } from './engine.ts';

/** One row as `seatRows` hands it over: a seat that exists, occupied or not. */
type SeatRow = { id: SeatId; occupant: SeatOccupant | null };

/**
 * The public row for one seat — everything everyone may know, nothing more.
 *
 * Takes the row rather than a bare id so the occupant is whatever `seatRows`
 * decided it was. A padded row and a vacant one are then the same thing here,
 * which is the point: nothing downstream has to know which it was looking at.
 */
function seatView(state: DraftState, row: SeatRow): DraftSeatView {
  const { id, occupant } = row;
  return {
    id,
    occupant,
    displayName: state.displayNames[id] ?? `Seat ${id}`,
    // Optional index on purpose. A row is a SEAT, and the engine only has a
    // pool for a seat it dealt to, so a row can legitimately have no pool
    // entry — a padded seat nobody has taken, or a seat the table carries past
    // what was dealt. `viewFor` below has always guarded the same index; this
    // was the one place that did not, and it threw rather than reporting zero.
    pickedCount: state.pools[id]?.length ?? 0,
  };
}

/** The part of a payload that is the same for everybody. */
function common(state: DraftState): Omit<DraftView, 'viewer'> {
  return {
    draftId: state.draftId,
    epoch: state.epoch,
    seq: state.seq,
    packNumber: state.packNumber,
    pickNumber: state.pickNumber,
    packCount: state.packCount,
    packSize: state.packSize,
    passDirection: directionFor(state.packNumber),
    capacity: state.table.capacity,
    // `seatRows` and not `Array.from({ length: ... })`. A seat table GROWS with
    // arrivals rather than being pre-allocated, so rendering it verbatim draws
    // a four-seat pod holding two players as a two-seat pod; and a hand-rolled
    // loop to `capacity` is one `seats.length > capacity` away from dropping an
    // occupied seat out of the view entirely. The package owns that loop
    // (`@wolffm/rooms-protocol` `seatRows`) so every bounded-table renderer
    // gets the same answer, and `apps/server` asserts row-for-row agreement
    // with it on the wire.
    seats: seatRows(state.table).map((row) => seatView(state, row)),
    waitingOn: waitingOn(state),
  };
}

/**
 * The payload for one seated player.
 *
 * `pack` and `pool` are copied, so a caller that mutates what it was handed
 * cannot reach back into engine state.
 */
export function viewFor(state: DraftState, seatId: SeatId): DraftView {
  return {
    ...common(state),
    viewer: {
      kind: 'seat',
      seatId,
      pack: state.packs[seatId]?.slice() ?? [],
      pool: state.pools[seatId]?.slice() ?? [],
    },
  };
}

/** The payload for someone watching. Carries no cards, structurally. */
export function spectatorView(state: DraftState): DraftView {
  return { ...common(state), viewer: { kind: 'spectator' } };
}

/**
 * Every seated player's payload, keyed by seat.
 *
 * Useful for tests that need to assert across all of them at once — for
 * example, that no two seats were handed the same card object.
 */
export function viewsForAllSeats(state: DraftState): Map<SeatId, DraftView> {
  const out = new Map<SeatId, DraftView>();
  for (let s = 0; s < state.seatCount; s++) out.set(s, viewFor(state, s));
  return out;
}
