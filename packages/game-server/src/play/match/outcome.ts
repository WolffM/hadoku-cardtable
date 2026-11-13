export type MatchStatus = 'starting' | 'running' | 'over' | 'failed' | 'stopped';

/** What {@link gameOutcome} reads off a match. */
export interface OutcomeFacts {
	endedAt: number | null;
	winner: string | null;
	winnerSeat: 0 | 1 | null;
	concededBy: number | null;
	/** The seat whose chess clock ran out; its concede is the server's ({@link Match.timedOut}). */
	timedOut?: number | null;
	spec: { seats: readonly { name: string }[] };
}

/**
 * Which of two seats won, from Forge's `losers` (player ids): a seat whose
 * player id is among them lost, so the other won; with only one seat's id
 * known (an AI game — the AI never opens a view), that seat won exactly when
 * somebody lost and it was not that seat. Null for anything else: no losers,
 * both or neither known seat lost, or more than two seats.
 */
export function winnerSeatFromLosers(seats: readonly { seat: number; playerId: number | null }[], losers: readonly number[] | undefined): 0 | 1 | null {
	if (losers === undefined || losers.length === 0 || seats.length !== 2) return null;
	const known = seats.filter((s) => s.playerId !== null);
	const lost = known.filter((s) => losers.includes(s.playerId!));
	const other = (seat: number): 0 | 1 | null => (seat === 0 ? 1 : seat === 1 ? 0 : null);
	if (known.length === 2) return lost.length === 1 ? other(lost[0]!.seat) : null;
	if (known.length === 1) {
		const only = known[0]!.seat;
		return lost.length === 1 ? other(only) : only === 0 || only === 1 ? only : null;
	}
	return null;
}
