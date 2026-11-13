/**
 * A table's two seats and each seat's Ready: the one record of who sits where
 * (`room/lobby.ts` keeps one per table). A seat is a place, as a pod's seats
 * are: someone sits in the seat they pick (the first open one when they pick
 * none), and a seat someone stands up from stays empty — nobody moves up into
 * it. A Ready belongs to the player in the seat: it leaves with them.
 *
 * The game reads the seated players in seat order with the empty seat skipped
 * (`seatList`, `seatOrder`): that order is a match's seat order, a series' and
 * a Gauntlet's, so a player alone in the second seat is still the match's
 * first seat against the AI.
 */

export type SeatPair = [string | null, string | null];

export interface TableSeats {
	seats: SeatPair;
	ready: [boolean, boolean];
}

/** A seat's holder, their Ready, and which of the table's seats they sit in. */
export interface TableSeat {
	memberId: string;
	ready: boolean;
	seat: number;
}

/** The seated players, in seat order. */
export function seatList(table: TableSeats): TableSeat[] {
	return table.seats.flatMap((memberId, seat) => (memberId === null ? [] : [{ memberId, ready: table.ready[seat]!, seat }]));
}

/** The seated players as a match, a series and a Gauntlet number them: seat order, the empty seat skipped. */
export function seatOrder(table: TableSeats): SeatPair {
	const [first, second] = seatList(table);
	return [first?.memberId ?? null, second?.memberId ?? null];
}

/**
 * `memberId` sits at `table` — in `seat` when it is given, else the first open
 * one — giving up a seat held anywhere else in the room's `tables`, this table
 * included (a move, as a pod's seats allow). True when they hold the seat
 * afterwards (one already held is left as it is); false when it is someone
 * else's, or no seat is open.
 */
export function sitAt(tables: readonly TableSeats[], table: TableSeats, memberId: string, seat?: number): boolean {
	const held = table.seats.indexOf(memberId);
	if (seat === undefined ? held !== -1 : held === seat) return true;
	const target = seat ?? table.seats.indexOf(null);
	if (target === -1 || table.seats[target] !== null) return false;
	for (const other of tables) leaveSeat(other, memberId);
	table.seats[target] = memberId;
	table.ready[target] = false;
	return true;
}

/** Give a seat back, Ready and all; it stays empty. False when `memberId` held no seat here. */
export function leaveSeat(table: TableSeats, memberId: string): boolean {
	const at = table.seats.indexOf(memberId);
	if (at === -1) return false;
	table.seats[at] = null;
	table.ready[at] = false;
	return true;
}

/** A seated player's Ready. False when `memberId` holds no seat here. */
export function readySeat(table: TableSeats, memberId: string, ready: boolean): boolean {
	const at = table.seats.indexOf(memberId);
	if (at === -1) return false;
	table.ready[at] = ready;
	return true;
}
