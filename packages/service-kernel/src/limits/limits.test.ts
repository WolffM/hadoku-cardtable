import type { Request, Response } from 'express';
import type { ParticipantId } from '@wolffm/rooms-protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { installTelemetry, type TelemetryContext } from '../telemetry/telemetry.ts';
import { bodyErrors, costlyActLimit, makeCallerId, parseBody, perCallerLimit, readBody, type BodySchema } from './limits.ts';

function recorder(): { events: [string, TelemetryContext][] } {
	const events: [string, TelemetryContext][] = [];
	installTelemetry((event, context) => events.push([event, context]));
	return { events };
}

function req(headers: Record<string, string>): Request {
	return { headers } as unknown as Request;
}

afterEach(() => installTelemetry(() => {}));

describe('makeCallerId', () => {
	it('derives from the injected deriver over the request headers, with a fresh fallback each call', () => {
		const calls: Array<[Request['headers'], string]> = [];
		const deriveId = (headers: Request['headers'], fallback: string): ParticipantId => {
			calls.push([headers, fallback]);
			return (headers['x-user-id'] as string | undefined) ?? fallback;
		};
		const callerId = makeCallerId(deriveId);
		expect(callerId(req({ 'x-user-id': 'u-1' }))).toBe('u-1');
		const a = callerId(req({}));
		const b = callerId(req({}));
		expect(a).toMatch(/^http-/);
		expect(a).not.toBe(b);
	});
});

describe('perCallerLimit / costlyActLimit', () => {
	it('costlyActLimit takes an already-derived caller id directly (no request needed)', () => {
		const { events } = recorder();
		const allow = costlyActLimit({ capacity: 1, refillAmount: 1, refillIntervalMs: 60_000 }, { act: 'match-restart', now: () => 0 });
		expect(allow('c-1', { 'x-hadoku-tier': 'member' })).toBe(true);
		expect(allow('c-1', { 'x-hadoku-tier': 'member' })).toBe(false);
		expect(events.map(([e]) => e)).toEqual(['costly-act', 'rate-limited']);
	});

	it('a rate limiter reports each pass as a costly act and each refusal as rate-limited', () => {
		const { events } = recorder();
		const limit = perCallerLimit({ capacity: 1, refillAmount: 1, refillIntervalMs: 60_000 }, 'slow down', {
			act: 'room-create',
			callerId: () => '7a6e2deb-cc0a-4342-9334-02c701fcabb4',
			now: () => 0,
		});
		const res = {
			setHeader: () => {},
			status: () => ({ json: () => {} }),
		} as unknown as Response;
		const caller = req({
			'x-user-id': '7a6e2deb-cc0a-4342-9334-02c701fcabb4',
			'x-hadoku-tier': 'member',
			'user-agent': 'curl/8',
		});

		expect(limit(caller, res)).toBe(true);
		expect(limit(caller, res)).toBe(false);
		const who = { userId: '7a6e2deb-cc0a-4342-9334-02c701fcabb4', tier: 'member', ua: 'curl/8' };
		expect(events).toEqual([
			['costly-act', { act: 'room-create', ...who }],
			['rate-limited', { act: 'room-create', ...who }],
		]);
	});

	it('answers 429 with Retry-After once the bucket is spent', () => {
		let status: number | undefined;
		let retryAfter: string | undefined;
		let body: unknown;
		const res = {
			setHeader: (name: string, value: string) => {
				if (name === 'Retry-After') retryAfter = value;
			},
			status: (s: number) => {
				status = s;
				return { json: (b: unknown) => (body = b) };
			},
		} as unknown as Response;
		const limit = perCallerLimit({ capacity: 1, refillAmount: 1, refillIntervalMs: 60_000 }, 'slow down', {
			act: 'room-create',
			callerId: () => 'c-1',
			now: () => 0,
		});
		expect(limit(req({}), res)).toBe(true);
		expect(limit(req({}), res)).toBe(false);
		expect(status).toBe(429);
		expect(retryAfter).toBe('60');
		expect(body).toEqual({ error: 'slow down' });
	});

	it('`null` is no limit at all', () => {
		const limit = perCallerLimit(null, 'slow down', { act: 'room-create', callerId: () => 'c-1' });
		expect(limit(req({}), {} as Response)).toBe(true);
		expect(limit(req({}), {} as Response)).toBe(true);
	});

	/**
	 * Mutation: with the limiter removed (the bucket check short-circuited to always allow), this
	 * must fail. Restoring the check must pass it again.
	 */
	it('MUTATION — removing the limiter check makes every call succeed (this test must then fail)', () => {
		const limit = perCallerLimit({ capacity: 1, refillAmount: 1, refillIntervalMs: 60_000 }, 'slow down', {
			act: 'room-create',
			callerId: () => 'c-1',
			now: () => 0,
		});
		const res = { setHeader: () => {}, status: () => ({ json: () => {} }) } as unknown as Response;
		expect(limit(req({}), res)).toBe(true);
		// The second call MUST be refused — this is exactly what the mutation (removing the limiter
		// from `perCallerLimit`) breaks. See this lane's report for the revert/restore run.
		expect(limit(req({}), res)).toBe(false);
	});
});

describe('readBody / parseBody', () => {
	const schema: BodySchema<{ x: number }> = {
		safeParse: (body) =>
			typeof body === 'object' && body !== null && typeof (body as { x?: unknown }).x === 'number'
				? { success: true, data: body as { x: number } }
				: { success: false, error: { issues: [{ code: 'invalid_type', path: ['x'], message: 'x must be a number' }] } },
	};

	it('reads a valid body', () => {
		expect(readBody(schema, { x: 1 })).toEqual({ ok: true, value: { x: 1 } });
	});

	it('answers the schema\'s first refusal', () => {
		expect(readBody(schema, {})).toEqual({ ok: false, error: 'x must be a number' });
	});

	it('parseBody answers 400 and returns null on a bad body', () => {
		let status: number | undefined;
		let body: unknown;
		const res = {
			status: (s: number) => {
				status = s;
				return { json: (b: unknown) => (body = b) };
			},
		} as unknown as Response;
		expect(parseBody(schema, { body: {} } as unknown as Request, res)).toBeNull();
		expect(status).toBe(400);
		expect(body).toEqual({ error: 'x must be a number' });
	});

	it('parseBody returns the parsed value on a good body', () => {
		expect(parseBody(schema, { body: { x: 2 } } as unknown as Request, {} as Response)).toEqual({ x: 2 });
	});
});

describe('bodyErrors', () => {
	it('answers 400 for a JSON parse failure, never quoting the body', () => {
		let status: number | undefined;
		let body: unknown;
		const res = {
			headersSent: false,
			status: (s: number) => {
				status = s;
				return { json: (b: unknown) => (body = b) };
			},
		} as unknown as Response;
		bodyErrors()({ type: 'entity.parse.failed' }, {} as Request, res, () => {});
		expect(status).toBe(400);
		expect(body).toEqual({ error: 'body is not valid JSON' });
	});

	it('answers 500 and names the error, through onError, for anything else', () => {
		let status: number | undefined;
		const names: string[] = [];
		const res = {
			headersSent: false,
			status: (s: number) => {
				status = s;
				return { json: () => {} };
			},
		} as unknown as Response;
		bodyErrors((name) => names.push(name))(new TypeError('boom'), {} as Request, res, () => {});
		expect(status).toBe(500);
		expect(names).toEqual(['TypeError']);
	});

	it('passes through to `next` without `onError`', () => {
		let passed: unknown;
		const res = { headersSent: false } as unknown as Response;
		bodyErrors()(new Error('x'), {} as Request, res, (err) => (passed = err));
		expect(passed).toBeInstanceOf(Error);
	});
});
