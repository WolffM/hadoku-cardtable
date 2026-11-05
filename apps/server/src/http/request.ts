/** What every HTTP route reads off a request before its own work: who is asking, and what the body says. */

import { randomUUID } from 'node:crypto';
import type { ParticipantId } from '@wolffm/rooms-protocol';
import { MultiRateLimiter, type RateLimitConfig } from '@wolffm/rooms-server';
import type { ErrorRequestHandler, Request, Response } from 'express';

import { accountIdOf, userNameOf, vouchedOf } from '../edge-auth.js';
import { identityFromHeaders } from '../room/identity.js';
import { callerContext, report } from '../telemetry.js';
import { UNNAMED, type Caller } from '../room/lobby.js';

/**
 * The caller, by the edge's headers. A request the edge named nobody on gets a
 * fresh ephemeral id, which matches no seat and no member — the right answer
 * for someone the edge could not name.
 */
export function httpCaller(req: Request): ParticipantId {
	return identityFromHeaders(req.headers, `http-${randomUUID()}`);
}

/**
 * Who is asking, for a lobby call: the id, the DISPLAY NAME (`X-User-Name`, never the opaque
 * userId — a roster is for humans; a key the edge sent no name for gets `UNNAMED`), and the userId
 * a saved room keeps instead of the name (R12), and whether the operator vouches for them.
 */
export function callerOf(req: Request): Caller {
	return { id: httpCaller(req), name: userNameOf(req) ?? UNNAMED, userId: accountIdOf(req), vouched: vouchedOf(req) };
}

/**
 * A per-caller token bucket for a costly step: each pass reports `costly-act` and each refusal
 * `rate-limited`, both named by `act`, so telemetry shows who is spending the expensive steps and
 * who hit the ceiling (`telemetry.ts` throttles the posts). `headers` are the caller's own, for
 * the report. `null` is no limit — the e2e stacks' `CARDTABLE_E2E_NO_RATE_LIMITS`, where one test
 * identity makes every room and starts every match of a run.
 */
export function costlyActLimit(
	cfg: RateLimitConfig | null,
	opts: { act: string; now?: () => number; onRefused?: () => void },
): (caller: ParticipantId, headers: Parameters<typeof callerContext>[0]) => boolean {
	if (cfg === null) return () => true;
	const limiter = new MultiRateLimiter<ParticipantId>(cfg);
	const now = opts.now ?? Date.now;
	return (caller, headers) => {
		if (limiter.allow(caller, 1, now())) {
			report('costly-act', { act: opts.act, ...callerContext(headers) });
			return true;
		}
		report('rate-limited', { act: opts.act, ...callerContext(headers) });
		opts.onRefused?.();
		return false;
	};
}

/**
 * {@link costlyActLimit} for a route: false once the 429 (with `Retry-After`) is sent. A route
 * asks AFTER reading its body, so only a request that would do the work spends a token.
 */
export function perCallerLimit(
	cfg: RateLimitConfig | null,
	refusal: string,
	opts: { act: string; now?: () => number; onRefused?: () => void },
): (req: Request, res: Response) => boolean {
	if (cfg === null) return () => true;
	const allow = costlyActLimit(cfg, opts);
	const retryAfter = String(Math.ceil(cfg.refillIntervalMs / 1000));
	return (req, res) => {
		if (allow(httpCaller(req), req.headers)) return true;
		res.setHeader('Retry-After', retryAfter);
		res.status(429).json({ error: refusal });
		return false;
	};
}

/** A `@hadoku/shared` request schema, as this file reads one. */
interface BodySchema<T> {
	safeParse(body: unknown):
		| { success: true; data: T }
		| { success: false; error: { issues: readonly { code: string; path: readonly PropertyKey[]; message: string }[] } };
}

/**
 * A request body by its shared schema, or null once the 400 is sent. The
 * answer is the schema's first refusal, a field nobody named before anything
 * else, in the `{ error }` body every route answers with.
 */
export function parseBody<T>(schema: BodySchema<T>, req: Request, res: Response): T | null {
	const parsed = readBody(schema, req.body);
	if (parsed.ok) return parsed.value;
	res.status(400).json({ error: parsed.error });
	return null;
}

/** A body by its shared schema, or the refusal `parseBody` would answer with. */
export function readBody<T>(schema: BodySchema<T>, body: unknown): { ok: true; value: T } | { ok: false; error: string } {
	const parsed = schema.safeParse(body);
	if (parsed.success) return { ok: true, value: parsed.data };
	const { issues } = parsed.error;
	const issue = issues.find((i) => i.code === 'unrecognized_keys' && i.path.length === 0) ?? issues[0];
	return { ok: false, error: issue?.message ?? 'the request body could not be read' };
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
