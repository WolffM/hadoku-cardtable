/**
 * Each friend's own key, by the participant id it derives — in memory only.
 *
 * prefs-api names a human seat by that PLAYER's key (it resolves it through
 * the registry and never stores it), and a match starts on ONE player's
 * request: the other player's key is on their own requests, not this one. So
 * every request on the api router, and every play-socket handshake, leaves its
 * key here under the id the room already knows that member by
 * (`identityFromHeaders`, the same derivation `RoomMember.id` is minted with),
 * and a match's game over looks both players up.
 *
 * The handshake is the half a restart needs. The book is empty after one, and a
 * player whose tab is hidden makes no api request before their match ends — but
 * their match socket reconnects after every restart, and the edge stamps the
 * same headers on that handshake. Both transports read them through
 * {@link KeyBook.learn}, after `edgeProvenance` has sanitized them, so a key the
 * edge did not vouch for has already been deleted.
 *
 * The key is a credential. It is never logged, never written to disk, never put
 * in a match spec (`jvm.json` persists those), and the book is bounded: the
 * least recently seen id goes first once it is full.
 */

import type { IncomingHttpHeaders } from 'node:http';
import type { NextFunction, Request, Response } from 'express';

import { identityFromHeaders } from '../room/identity.js';

export interface KeyBook {
	/** Remember the key on these SANITIZED headers, if the edge stamped one. */
	learn(headers: IncomingHttpHeaders): void;
	/** Express middleware: {@link learn} from the request's headers. */
	remember(req: Request, res: Response, next: NextFunction): void;
	/** The key a participant last made a request with, or null. */
	keyOf(participantId: string): string | null;
}

/** Comfortably more than the friend group; a bound, not a budget. */
const DEFAULT_CAPACITY = 256;

export function createKeyBook(capacity = DEFAULT_CAPACITY): KeyBook {
	const keys = new Map<string, string>();
	function learn(headers: IncomingHttpHeaders): void {
		const raw = headers['x-user-key'];
		if (typeof raw !== 'string' || raw === '') return;
		// The socket id is only reached when there is no key, and there is one.
		const id = identityFromHeaders(headers, '');
		keys.delete(id);
		keys.set(id, raw);
		if (keys.size > capacity) keys.delete(keys.keys().next().value as string);
	}
	return {
		learn,
		remember(req, _res, next) {
			learn(req.headers);
			next();
		},
		keyOf: (participantId) => keys.get(participantId) ?? null,
	};
}
