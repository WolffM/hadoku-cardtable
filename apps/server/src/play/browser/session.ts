/**
 * One browser connection, with no WebSocket in it.
 *
 * Socket-free for the reason `match.ts` gives: the hazards here — which seat
 * this connection holds, which frames it may be handed, what a second join
 * does — are tested by calling functions, not by racing sockets. `ws.ts` is the
 * half that owns bytes and `index.ts` is the half that owns the HTTP upgrade.
 *
 * ## This is a client TYPE, not a second play stack
 *
 * Everything it does is a call into the existing `Match`:
 *
 *   join    `match.claim(participantId)` → `match.snapshot(seat)` →
 *           `match.resendAfterSnapshot(seat)`
 *   resync  `match.snapshot(seat)` for the seat already held
 *   c2s     `match.fromClient(seat, frame)`
 *   close   `match.seatDisconnected(seat)`, only when no other connection holds it
 *
 * There is no path from a message to Forge that does not go through `Match`,
 * and no path from Forge to this connection that does not go through
 * `Match.sendState`'s per-seat projector. `push` is the only writer of match
 * data, it takes an envelope already built for one named seat, and it refuses
 * one built for a seat this connection does not hold.
 *
 * ## The seat comes from the claim, never from the message
 *
 * `parseBrowserRequest` is strict and has no seat field, so a browser cannot
 * name one. `claim` binds a participant to a seat permanently for the match —
 * a reconnect gets the same seat, a stranger gets `match-full`, and an
 * ephemeral identity is refused outright because it could never come back.
 *
 * ## Requests are serialized
 *
 * A join awaits `whenRunning`. Two joins arriving back to back on one
 * connection must not interleave inside that await, or the second could claim
 * while the first is still binding. Each message is chained onto the previous
 * one's promise; the socket already delivers them in order, and this keeps them
 * that way through the awaits.
 */

import type { ParticipantId } from '@wolffm/rooms-protocol';

import type { MatchRegistry } from '../match.js';
import type { MatchError, MatchSnapshot, ServerEnvelope } from '@hadoku/shared';
import type { BrowserFanout, SeatBound } from './fanout.js';
import { parseBrowserRequest, type BrowserMessage, type BrowserRequest } from './protocol.js';

export interface BrowserSessionDeps {
	/** The SAME registry `attachPlay` built. A second one would be a second play stack. */
	matches: () => MatchRegistry | null;
	participantId: ParticipantId;
	/** Write one message to the browser. */
	send(message: BrowserMessage): void;
	log(entry: Record<string, unknown>): void;
	fanout: BrowserFanout;
	/** How long a join waits for a starting match. `attachPlay` uses 8 s. */
	joinWaitMs?: number;
}

export class BrowserSession implements SeatBound {
	/** matchId → the seat this connection holds. Never more than one per match. */
	private readonly seats = new Map<string, number>();
	private queue: Promise<void> = Promise.resolve();
	private closed = false;

	constructor(private readonly deps: BrowserSessionDeps) {}

	seatIn(matchId: string): number | null {
		return this.seats.get(matchId) ?? null;
	}

	/**
	 * The only writer of match data on this connection. The envelope was built
	 * by `Match` for one named seat; this refuses it unless that is the seat
	 * this connection holds, and refuses the match id it was not built for.
	 */
	push(envelope: ServerEnvelope): boolean {
		if (this.closed) return false;
		if (this.seats.get(envelope.matchId) === undefined) return false;
		this.deps.send({ t: 's2c', ...envelope });
		return true;
	}

	/** Queue one inbound text frame. Resolves when it has been handled. */
	handle(text: string): Promise<void> {
		this.queue = this.queue.then(() => this.dispatch(text));
		return this.queue;
	}

	private async dispatch(text: string): Promise<void> {
		if (this.closed) return;
		const parsed = parseBrowserRequest(text);
		if (!parsed.ok) {
			this.deps.log({ evt: 'browser-malformed', participantId: this.deps.participantId, errors: parsed.errors.slice(0, 3) });
			this.deps.send({ t: 'error', rid: null, error: `malformed: ${parsed.errors[0]?.path ?? '$'} ${parsed.errors[0]?.message ?? ''}` });
			return;
		}
		const request = parsed.value;
		if (request.t === 'c2s') {
			this.act(request);
			return;
		}
		const result = await this.snapshotFor(request);
		if (this.closed) return;
		if ('error' in result) {
			this.deps.send({ t: 'error', rid: request.rid, error: result.error });
			return;
		}
		this.deps.send({ t: 'snapshot', rid: request.rid, ...result });
		// After the snapshot, so the client has adopted its cursor before the
		// prompt, buttons and any open ask arrive on the next cursors.
		this.deps.matches()?.get(result.matchId)?.resendAfterSnapshot(result.seat);
	}

	/** `socket.ts`'s `snapshotFor`, with this connection's seat map instead of a socket's. */
	private async snapshotFor(request: Extract<BrowserRequest, { t: 'join' | 'resync' }>): Promise<MatchSnapshot | MatchError> {
		const registry = this.deps.matches();
		if (registry === null) return { error: 'play is not configured on this server' };
		const match = registry.get(request.matchId);
		if (match === undefined) return { error: 'unknown-match' };

		let seat = this.seats.get(match.id) ?? null;
		if (seat === null) {
			if (request.t !== 'join') return { error: 'not-joined' };
			const claim = match.claim(this.deps.participantId);
			if (!claim.ok) return { error: claim.error };
			seat = claim.seat;
			this.seats.set(match.id, seat);
			this.deps.log({
				evt: 'browser-joined',
				matchId: match.id,
				seat,
				participantId: this.deps.participantId,
				fresh: claim.fresh,
			});
			// A refresh: the old connection's close armed an abort of this seat's asks.
			match.seatConnected(seat);
		}
		if (match.status === 'starting') {
			const running = await match.whenRunning(this.deps.joinWaitMs ?? 8000);
			if (!running.ok) return { error: running.error };
		}
		return match.snapshot(seat);
	}

	private act(request: Extract<BrowserRequest, { t: 'c2s' }>): void {
		const match = this.deps.matches()?.get(request.matchId);
		const seat = match === undefined ? undefined : this.seats.get(match.id);
		if (match === undefined || seat === undefined) {
			this.deps.log({ evt: 'browser-c2s-not-joined', participantId: this.deps.participantId, matchId: request.matchId });
			return;
		}
		const outcome = match.fromClient(seat, request.frame);
		if (!outcome.ok) {
			this.deps.log({
				evt: 'browser-c2s-refused',
				participantId: this.deps.participantId,
				matchId: match.id,
				seat,
				error: outcome.error,
				kind: request.frame.kind,
			});
		}
	}

	/**
	 * The connection is gone. Each seat it held is told — unless another
	 * connection still holds it, which is what a refresh looks like while both
	 * sockets briefly exist.
	 */
	disconnect(reason: string): void {
		if (this.closed) return;
		this.closed = true;
		const registry = this.deps.matches();
		for (const [matchId, seat] of this.seats) {
			const stillHere = this.deps.fanout.holders(matchId, seat, this) > 0;
			this.deps.log({ evt: 'browser-left', matchId, seat, participantId: this.deps.participantId, reason, stillHere });
			if (!stillHere) registry?.get(matchId)?.seatDisconnected(seat);
		}
		this.seats.clear();
	}
}
