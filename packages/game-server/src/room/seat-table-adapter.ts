/**
 * `GameSeats` (`record.ts`'s plain `(string | null)[]` with `AI_SEAT`/`CLOSED_SEAT` markers in
 * place), as a `@wolffm/rooms-protocol` `SeatTable` the library's own ops can act on — and back.
 * Replaces wave 119 §S's own hand-rolled array code for these two ops, now that
 * `@wolffm/rooms-protocol@0.45.99` (watchparty P2, wave 120) gives `SeatTable` the closed-seat
 * idea cardtable's own array always had:
 * `closeSeat`/`isClosed`, and `Seat.closed?: boolean` that keeps a seat in place — never truncating
 * `seats.length` — exactly the shape `GameSeats` already stores on disk and sends over the wire.
 *
 * Stateless and discarded after each call: a `GameSeats` array has never carried a reservation or
 * a remembered seat (nothing to lose by building a fresh `SeatTable` with `remembered: {}`,
 * `reservations: {}`, `reservationTtlMs: 0` each time), and the round trip back to `GameSeats`
 * drops them again — so `record.ts`'s stored and wire shape is UNCHANGED by this file existing;
 * only the two operations that used to be hand-rolled array code now call the published functions.
 */
import { closeSeat, isClosed, occupantOf, removeFromSeat, replaceWithBot as libReplaceWithBot, seatBot, unseatBot, type SeatTable } from '@wolffm/rooms-protocol';

import { AI_SEAT, CLOSED_SEAT, type GameSeats } from './record.ts';

function gameSeatsToTable(seats: GameSeats): SeatTable {
	return {
		capacity: seats.length,
		seats: seats.map((holder, id) => ({
			id,
			occupant: holder === null || holder === CLOSED_SEAT ? null : holder === AI_SEAT ? { kind: 'bot', botId: AI_SEAT } : { kind: 'human', participantId: holder },
			...(holder === CLOSED_SEAT ? { closed: true } : {}),
		})),
		remembered: {},
		reservations: {},
		reservationTtlMs: 0,
	};
}

function tableToGameSeats(table: SeatTable): GameSeats {
	return table.seats.map((seat) => {
		if (seat.closed === true) return CLOSED_SEAT;
		if (seat.occupant === null) return null;
		return seat.occupant.kind === 'bot' ? AI_SEAT : seat.occupant.participantId;
	});
}

/**
 * Close seats from the TOP down until `count` are open, evicting any occupant first (a human —
 * returned, for the caller to tell they are now watching — an AI simply gone). Mirrors the
 * library's own `setSeatCapacity`, which this does NOT call: that function TRUNCATES
 * `seats.length`, while cardtable keeps every seat's index stable (a closed seat stays addressable
 * — P2's op-mapping gap, "composing `closeSeat` plus eviction is the likely fit"). Eviction is
 * always highest seat first, never a caller-chosen one — same reasoning as `setSeatCapacity`'s own
 * doc. A seat already closed is skipped, never counted against `count` twice.
 */
export function lowerCapacity(seats: GameSeats, count: number): { seats: GameSeats; evicted: readonly string[] } {
	const table = gameSeatsToTable(seats);
	const evicted: string[] = [];
	let open = table.seats.filter((s) => s.closed !== true).length;
	for (let id = table.seats.length - 1; id >= 0 && open > count; id--) {
		if (isClosed(table, id)) continue;
		const occupant = occupantOf(table, id);
		if (occupant?.kind === 'human') {
			removeFromSeat(table, occupant.participantId);
			evicted.push(occupant.participantId);
		} else if (occupant?.kind === 'bot') {
			unseatBot(table, id);
		}
		closeSeat(table, id);
		open--;
	}
	return { seats: tableToGameSeats(table), evicted };
}

/**
 * The AI takes `seat`, evicting its human occupant first (returned, for the caller to tell they
 * are now watching). Addressed by SEAT, not by the human's id — cardtable's leader picks a seat,
 * empty or occupied, the same way `aiSeat` always has, and an empty seat has no occupant id to
 * address by. P2's own op mapping: `occupantOf` + `replaceWithBot` for an occupied seat,
 * `seatBot` for an empty one (the library's `replaceWithBot` answers null with nobody to replace).
 */
export function replaceWithBot(seats: GameSeats, seat: number): { seats: GameSeats; evicted: string | null } {
	const table = gameSeatsToTable(seats);
	const occupant = occupantOf(table, seat);
	if (occupant?.kind === 'bot') return { seats, evicted: null };
	if (occupant?.kind === 'human') {
		libReplaceWithBot(table, occupant.participantId);
		return { seats: tableToGameSeats(table), evicted: occupant.participantId };
	}
	seatBot(table, seat);
	return { seats: tableToGameSeats(table), evicted: null };
}
