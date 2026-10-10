/**
 * Each friend's own key, by the participant id it derives — in memory only.
 *
 * prefs-api names a human seat by that PLAYER's key (it resolves it through
 * the registry and never stores it), and a match starts on ONE player's
 * request: the other player's key is on their own requests, not this one. So
 * every request on the api router leaves its key here under the id the room
 * already knows that member by (`identityFromHeaders`, the same derivation
 * `RoomMember.id` is minted with), and a match start looks both players up.
 *
 * The key is a credential. It is never logged, never written to disk, never put
 * in a match spec (`jvm.json` persists those), and the book is bounded: the
 * least recently seen id goes first once it is full. A restart empties it,
 * which costs nothing — loading a deck and readying up are requests, so both
 * players are back in it before their next match can start.
 */

import type { NextFunction, Request, Response } from 'express';

import { identityFromHeaders } from '../room/identity.js';

export interface KeyBook {
	/** Express middleware: remember the caller's key, if the edge stamped one. */
	remember(req: Request, res: Response, next: NextFunction): void;
	/** The key a participant last made a request with, or null. */
	keyOf(participantId: string): string | null;
}

/** Comfortably more than the friend group; a bound, not a budget. */
const DEFAULT_CAPACITY = 256;

export function createKeyBook(capacity = DEFAULT_CAPACITY): KeyBook {
	const keys = new Map<string, string>();
	return {
		remember(req, _res, next) {
			const raw = req.headers['x-user-key'];
			if (typeof raw === 'string' && raw !== '') {
				// The socket id is only reached when there is no key, and there is one.
				const id = identityFromHeaders(req.headers, '');
				keys.delete(id);
				keys.set(id, raw);
				if (keys.size > capacity) keys.delete(keys.keys().next().value as string);
			}
			next();
		},
		keyOf: (participantId) => keys.get(participantId) ?? null,
	};
}
