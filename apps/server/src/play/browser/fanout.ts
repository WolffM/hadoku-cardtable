/**
 * The set of live browser connections, and the ONE call the existing match
 * server has to make for them to receive anything.
 *
 * ## Why this exists at all
 *
 * `match.ts` hands each projected envelope to `MatchDeps.emit`, which
 * `createMatchRegistry` fixes at construction; `socket.ts` sets it to
 * `emitPerRecipient` over the socket.io room. There is no later seam — a
 * `Match` cannot be subscribed to after it is built. So a second client type
 * has to be reached from inside that same `emit`, and this is the object it is
 * reached through.
 *
 * `socket.ts` is not this lane's file (Wave 15, lane C owns `browser/**` and
 * `package.json` and nothing else), so the call is NOT made yet. It is one
 * statement, and it goes first in the registry's `emit`:
 *
 * ```ts
 * emit: (match, seat, envelope) => {
 *     browserFanout.deliver(match.id, seat, envelope);   // ← the missing line
 *     emitPerRecipient<PlayApp, PlayClient, typeof envelope>(…);
 * },
 * ```
 *
 * Until it lands, `browser.test.ts` makes that call itself, so the line is
 * exercised rather than assumed.
 *
 * ## The seat check is here, and it is the last one
 *
 * `deliver` takes the seat the envelope was BUILT for and gives it only to
 * connections that hold that seat. `match.ts` never builds one envelope for two
 * seats, and `emitPerRecipient` already returns `SKIP` for everyone else on the
 * socket.io side; this is the same rule restated at the second transport's
 * edge, because "the new client type inherits the old one's filter" is an
 * assumption and this is a check.
 */

import type { ServerEnvelope } from '@hadoku/shared';

/** What the fanout needs of a connection. `BrowserSession` is the implementation. */
export interface SeatBound {
	/** The seat this connection holds in that match, or null. */
	seatIn(matchId: string): number | null;
	/** Write one server→client envelope. Returns false if it could not be written. */
	push(envelope: ServerEnvelope): boolean;
}

export class BrowserFanout {
	private readonly bound = new Set<SeatBound>();

	add(session: SeatBound): void {
		this.bound.add(session);
	}

	remove(session: SeatBound): void {
		this.bound.delete(session);
	}

	get size(): number {
		return this.bound.size;
	}

	/** Is any OTHER connection still holding this seat? A refresh is not a departure. */
	holders(matchId: string, seat: number, except?: SeatBound): number {
		let n = 0;
		for (const session of this.bound) {
			if (session !== except && session.seatIn(matchId) === seat) n += 1;
		}
		return n;
	}

	/** Deliver to every connection holding `seat` in `matchId`. Returns how many got it. */
	deliver(matchId: string, seat: number, envelope: ServerEnvelope): number {
		let n = 0;
		for (const session of this.bound) {
			if (session.seatIn(matchId) !== seat) continue;
			if (session.push(envelope)) n += 1;
		}
		return n;
	}

	/** Close every connection. `attachBrowserBridge`'s `close()`. */
	clear(): void {
		this.bound.clear();
	}
}

/**
 * The process-wide instance. A singleton because the call site above is inside
 * a closure in a file this lane does not own, and passing an object into
 * `attachPlay` would mean widening `PlayDeps` — three edits instead of one.
 * `attachBrowserBridge` takes a `fanout` option so a test can use its own.
 */
export const browserFanout = new BrowserFanout();
