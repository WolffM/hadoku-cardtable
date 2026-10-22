/**
 * A table's two seats and each seat's Ready: the one record of who sits where
 * (`room/lobby.ts` keeps one per table). Seats fill in the order people sit and
 * close up when one stands, so seat 0 is always whoever has sat longest. A
 * Ready belongs to the player in the seat: it leaves with them.
 */

export type SeatPair = [string | null, string | null];

export interface TableSeats {
	seats: SeatPair;
	ready: [boolean, boolean];
}

/** A seat's holder and their Ready, as the seats are read out. */
export interface TableSeat {
	memberId: string;
	ready: boolean;
}

/** The seated players, in seat order. */
export function seatList(table: TableSeats): TableSeat[] {
	return table.seats.flatMap((memberId, i) => (memberId === null ? [] : [{ memberId, ready: table.ready[i]! }]));
}

/**
 * `memberId` takes the first open seat at `table`, giving up a seat held at
 * any other of the room's `tables`. True when they hold a seat at `table`
 * afterwards (one already held is left as it is); false when both are taken
 * by others.
 */
export function sitAt(tables: readonly TableSeats[], table: TableSeats, memberId: string): boolean {
	if (table.seats.includes(memberId)) return true;
	const open = table.seats.indexOf(null);
	if (open === -1) return false;
	for (const other of tables) leaveSeat(other, memberId);
	table.seats[open] = memberId;
	table.ready[open] = false;
	return true;
}

/** Give a seat back, Ready and all; the other player moves up. False when `memberId` held no seat here. */
export function leaveSeat(table: TableSeats, memberId: string): boolean {
	const at = table.seats.indexOf(memberId);
	if (at === -1) return false;
	const kept = seatList(table).filter((s) => s.memberId !== memberId);
	table.seats = [kept[0]?.memberId ?? null, null];
	table.ready = [kept[0]?.ready ?? false, false];
	return true;
}

/** A seated player's Ready. False when `memberId` holds no seat here. */
export function readySeat(table: TableSeats, memberId: string, ready: boolean): boolean {
	const at = table.seats.indexOf(memberId);
	if (at === -1) return false;
	table.ready[at] = ready;
	return true;
}
