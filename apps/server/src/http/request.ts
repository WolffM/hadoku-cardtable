/** What every HTTP route reads off a request before its own work: who is asking, and whether the body could be read. */

import { randomUUID } from 'node:crypto';
import type { ParticipantId } from '@wolffm/rooms-protocol';
import type { ErrorRequestHandler, Request } from 'express';

import { identityFromHeaders } from '../room/identity.js';

/**
 * The caller, by the edge's headers. A request the edge named nobody on gets a
 * fresh ephemeral id, which matches no seat and no member — the right answer
 * for someone the edge could not name.
 */
export function httpCaller(req: Request): ParticipantId {
	return identityFromHeaders(req.headers, `http-${randomUUID()}`);
}

/**
 * The error handler mounted after a router: chiefly `express.json()`'s parse
 * failure, raised on the api router before the router runs. Answered without
 * the parser's message, which quotes the body, and reported by name only.
 * Without `onError`, any other error goes on to the next handler.
 */
export function bodyErrors(onError?: (name: string) => void): ErrorRequestHandler {
	return (err: unknown, _req, res, next) => {
		if (res.headersSent) return next(err);
		const e = err as { type?: unknown; status?: unknown; name?: unknown };
		if (e.type === 'entity.parse.failed') {
			res.status(400).json({ error: 'body is not valid JSON' });
			return;
		}
		if (typeof e.status === 'number' && e.status >= 400 && e.status < 500) {
			res.status(400).json({ error: 'the request body could not be read' });
			return;
		}
		if (onError === undefined) return next(err);
		onError(typeof e.name === 'string' ? e.name : 'unknown');
		res.status(500).json({ error: 'internal error' });
	};
}
