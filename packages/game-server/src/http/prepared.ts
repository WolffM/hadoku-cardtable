/**
 * A JSON answer serialized once and sent many times, for a body read far more often than it
 * changes: Express would stringify the value and hash the whole body again for its ETag on every
 * request. The ETag is the body's own, so a revalidation still answers 304 — `res.send` keeps an
 * ETag already set and checks the request's freshness against it.
 */

import { createHash } from 'node:crypto';
import type { Response } from 'express';

export interface PreparedJson {
	readonly body: string;
	readonly etag: string;
}

/** `value` as the bytes `sendPrepared` answers with; `tag` names the route in the ETag. */
export function prepareJson(value: unknown, tag: string): PreparedJson {
	const body = JSON.stringify(value);
	return { body, etag: `"${tag}-${createHash('sha1').update(body).digest('base64url').slice(0, 16)}"` };
}

export function sendPrepared(res: Response, answer: PreparedJson): void {
	res.setHeader('ETag', answer.etag);
	res.type('json').send(answer.body);
}
