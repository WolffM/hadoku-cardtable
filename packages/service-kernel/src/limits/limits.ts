/**
 * What every HTTP route reads off a request before its own work: who is asking, and what the
 * body says. Knows no game's identity scheme — a caller's id comes from an injected deriver
 * (`makeCallerId`), never a direct import, so a second game can bring its own.
 */

import { randomUUID } from 'node:crypto';
import type { ParticipantId } from '@wolffm/rooms-protocol';
import { MultiRateLimiter, type RateLimitConfig } from '@wolffm/rooms-server';
import type { ErrorRequestHandler, Request, Response } from 'express';

import { callerContext, report } from '../telemetry/telemetry.ts';

/**
 * A request's caller id, from an injected deriver over the request's headers (the app's own
 * identity scheme — platform, but a parameter here rather than an import). A request the
 * deriver can't place gets a fresh ephemeral fallback, which matches no seat and no member —
 * the right answer for someone the edge could not name.
 */
export function makeCallerId(
	deriveId: (headers: Request['headers'], fallback: string) => ParticipantId,
): (req: Request) => ParticipantId {
	return (req) => deriveId(req.headers, `http-${randomUUID()}`);
}

/**
 * A per-caller token bucket for a costly step: each pass reports `costly-act` and each refusal
 * `rate-limited`, both named by `act`, so telemetry shows who is spending the expensive steps and
 * who hit the ceiling (the telemetry sink throttles the posts). `headers` are the caller's own,
 * for the report. `null` is no limit — an e2e stack that disables rate limits for one test identity
 * so it can make every room and start every match of a run.
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
 * `callerId` is the request's caller id — see {@link makeCallerId}.
 */
export function perCallerLimit(
	cfg: RateLimitConfig | null,
	refusal: string,
	opts: { act: string; callerId: (req: Request) => ParticipantId; now?: () => number; onRefused?: () => void },
): (req: Request, res: Response) => boolean {
	if (cfg === null) return () => true;
	const allow = costlyActLimit(cfg, opts);
	const retryAfter = String(Math.ceil(cfg.refillIntervalMs / 1000));
	return (req, res) => {
		if (allow(opts.callerId(req), req.headers)) return true;
		res.setHeader('Retry-After', retryAfter);
		res.status(429).json({ error: refusal });
		return false;
	};
}

/** A request-body schema, as this module reads one — a minimal structural shape, never `@hadoku/shared` itself. */
export interface BodySchema<T> {
	safeParse(body: unknown):
		| { success: true; data: T }
		| { success: false; error: { issues: readonly { code: string; path: readonly PropertyKey[]; message: string }[] } };
}

/**
 * A request body by its schema, or null once the 400 is sent. The
 * answer is the schema's first refusal, a field nobody named before anything
 * else, in the `{ error }` body every route answers with.
 */
export function parseBody<T>(schema: BodySchema<T>, req: Request, res: Response): T | null {
	const parsed = readBody(schema, req.body);
	if (parsed.ok) return parsed.value;
	res.status(400).json({ error: parsed.error });
	return null;
}

/** A body by its schema, or the refusal `parseBody` would answer with. */
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
