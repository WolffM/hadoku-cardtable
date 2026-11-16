/**
 * The leader's three atomic "evict, then act" seat operations (wave 119 §S), isolated here so a
 * future swap is a one-file edit.
 *
 * `@wolffm/rooms-protocol@0.45.95` (watchparty d02dbdfb, published while this lane ran) gives its
 * own `SeatTable` the same three operations: `removeFromSeat(table, participantId)`,
 * `replaceWithBot(table, participantId)`, and the pre-existing `setSeatCapacity(table, capacity)`
 * for "lower capacity under occupants, evicting someone" — its own doc calls that the one and
 * only way to do it on a `SeatTable`.
 *
 * Cardtable's rooms are NOT on `SeatTable`. They are `GameSeats` (`record.ts`): a plain
 * `(string | null)[]` with `AI_SEAT`/`CLOSED_SEAT` markers IN PLACE, because a leader can close
 * one specific seat (`CLOSED_SEAT`, `closeSeat`) while every seat around it, including a HIGHER
 * one, stays open — Magic's draft pods do this (`pods.ts`'s `POD_CLOSED`). `SeatTable.capacity`
 * has no such idea: its own `setSeatCapacity` doc says so explicitly — "this table has no concept
 * of a specific seat that is closed while a higher one stays open… inventing one would be a
 * second notion of capacity." That is not a gap to fix here; it is a different, deliberate design
 * for a different shape of room, and reconciling the two (or deciding cardtable keeps its own) is
 * a separate, larger item than this wave's (the survey's §7 "two parallel seat implementations"
 * open risk).
 *
 * So this file does not call `@wolffm/rooms-protocol` at all. It gives `GameSeats` the SAME
 * contract those three operations have — evict first, in the same call, so there is never a tick
 * with a stale seat and a fresh one both claiming the member — against cardtable's own array.
 * `room/lobby.ts`'s `removeFromSeat` method needs no function of its own here: `record.ts`'s
 * `leaveGameSeat` already IS this contract (vacate one seat, remembered nowhere since `GameSeats`
 * has no sticky memory, which is fine — a stood member re-sits through `sitSeat` like anyone
 * else). `lowerCapacity` and `replaceWithBot` below are the two that are genuinely new.
 *
 * If cardtable's seat storage is ever migrated onto `SeatTable` (resolving the `CLOSED_SEAT` gap
 * first), THIS file is what gets replaced with calls to the published functions — `room/lobby.ts`'s
 * three methods would not need to change at all, since they already call through here.
 */
import { AI_SEAT, CLOSED_SEAT, type GameSeats } from './record.ts';

/**
 * Close seats from the TOP down until `count` are open, evicting any occupant first (a human —
 * returned, for the caller to tell they are now watching — an AI simply gone). Mirrors
 * `@wolffm/rooms-protocol`'s `setSeatCapacity`: eviction is always highest seat first, never a
 * caller-chosen one — same reasoning as that function's own doc.
 */
export function lowerCapacity(seats: GameSeats, count: number): { seats: GameSeats; evicted: readonly string[] } {
	const result = [...seats];
	const evicted: string[] = [];
	let open = result.filter((s) => s !== CLOSED_SEAT).length;
	for (let seat = result.length - 1; seat >= 0 && open > count; seat--) {
		const holder = result[seat] ?? null;
		if (holder === CLOSED_SEAT) continue;
		if (holder !== null && holder !== AI_SEAT) evicted.push(holder);
		result[seat] = CLOSED_SEAT;
		open--;
	}
	return { seats: result, evicted };
}

/**
 * The AI takes `seat`, evicting its human occupant first (returned, for the caller to tell they
 * are now watching). Addressed by SEAT, not by the human's id (`@wolffm/rooms-protocol`'s
 * `replaceWithBot` takes the participant) — cardtable's leader picks a seat, empty or occupied,
 * the same way `aiSeat` always has, and an empty seat has no occupant id to address by.
 */
export function replaceWithBot(seats: GameSeats, seat: number): { seats: GameSeats; evicted: string | null } {
	const holder = seats[seat] ?? null;
	if (holder === AI_SEAT) return { seats, evicted: null };
	const evicted = holder !== null && holder !== CLOSED_SEAT ? holder : null;
	return { seats: seats.map((s, i) => (i === seat ? AI_SEAT : s)), evicted };
}
