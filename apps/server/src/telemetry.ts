/**
 * Security telemetry: who got in, who was turned away, and who is spending the
 * costly acts, posted to monitoring-api's `service_events` so a reader holding
 * this repo's service key can see it (`AGENTS.md` § Telemetry). The edge's
 * `request_logs` already hold every finished request; what they cannot hold is
 * what only this server knows — that a caller is new, that the second seal
 * refused one the edge let through, that a socket handshake was below the
 * floor, that a member is making rooms as fast as the limiter allows.
 *
 * Everything here is fire-and-forget. A post that fails is logged on stdout
 * (pm2 keeps it), never retried, and never delays the request that caused it.
 * One event per (name, caller) per window goes out; the rest are counted and
 * ride on the next one as `suppressed`, so a scanner hammering the seal costs
 * monitoring one row a minute, not one per request.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { NextFunction, Request, Response } from 'express';

import type { JsonLog } from './log.js';

export type TelemetryValue = string | number | boolean | null | TelemetryValue[] | { [key: string]: TelemetryValue };
export type TelemetryContext = Record<string, TelemetryValue>;
export type Report = (event: string, context: TelemetryContext) => void;

/** What `report` does before boot installs a sink, and in every test that installs none. */
const NOOP: Report = () => {};
let installed: Report = NOOP;

/** The process's reporter. `index.ts` installs the monitoring sink once at boot. */
export function installTelemetry(sink: Report): void {
	installed = sink;
}

/** Report one security event. A no-op until a sink is installed. */
export function report(event: string, context: TelemetryContext): void {
	installed(event, context);
}

export interface SinkOptions {
	/** `https://hadoku.me` — the telemetry route is `/health/api/telemetry` under it. */
	baseUrl: string;
	serviceKey: string;
	log: JsonLog;
	/** One post per (event, caller) per this many ms. */
	windowMs?: number;
	now?: () => number;
	fetch?: typeof fetch;
}

/** The throttle forgets keys past this many, oldest first, so it cannot grow without bound. */
const MAX_KEYS = 5000;

/**
 * A reporter that posts to monitoring-api. Without a service key it posts
 * nothing and says so once, the way the stats reporter does.
 */
export function monitoringSink(opts: SinkOptions): Report {
	const { log } = opts;
	if (opts.serviceKey === '') {
		log({
			evt: 'telemetry-disabled',
			reason: 'CARDTABLE_SERVICE_KEY is not set',
		});
		return NOOP;
	}
	const windowMs = opts.windowMs ?? 60_000;
	const now = opts.now ?? Date.now;
	const doFetch = opts.fetch ?? fetch;
	const url = `${opts.baseUrl}/health/api/telemetry`;
	const last = new Map<string, { at: number; suppressed: number }>();

	return (event, context) => {
		const key = `${event}\u0000${String(context.userId ?? '')}`;
		const t = now();
		const seen = last.get(key);
		if (seen !== undefined && t - seen.at < windowMs) {
			seen.suppressed += 1;
			return;
		}
		const suppressed = seen?.suppressed ?? 0;
		last.delete(key);
		last.set(key, { at: t, suppressed: 0 });
		if (last.size > MAX_KEYS) last.delete(last.keys().next().value as string);

		const level = event.endsWith('-refused') || event === 'rate-limited' ? 'warn' : 'info';
		const body = {
			source: 'service',
			level,
			type: 'log',
			message: `event=${event}`,
			context: {
				service: 'cardtable',
				...context,
				...(suppressed > 0 ? { suppressed } : {}),
			},
		};
		doFetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'User-Agent': 'Mozilla/5.0 hadoku-cardtable',
				'X-User-Key': opts.serviceKey,
			},
			body: JSON.stringify(body),
		})
			.then((res) => {
				if (!res.ok) log({ evt: 'telemetry-post-failed', event, status: res.status });
			})
			.catch((err: unknown) =>
				log({
					evt: 'telemetry-post-failed',
					event,
					error: err instanceof Error ? err.message : String(err),
				}),
			);
	};
}

type Headers = Request['headers'];

function header(headers: Headers, name: string): string | null {
	const v = headers[name];
	return typeof v === 'string' && v !== '' ? v : null;
}

/** The caller's user agent, cut short: enough to tell a browser from a script. */
export function userAgentOf(headers: Headers): string | null {
	return header(headers, 'user-agent')?.slice(0, 160) ?? null;
}

/**
 * Who a request or handshake says it is, from the edge's headers AFTER
 * `sanitizeHeaders` — so a spoofed caller reports as public/anon, exactly what
 * the handlers saw.
 */
export function callerContext(headers: Headers): TelemetryContext {
	return {
		userId: header(headers, 'x-user-id') ?? 'anon',
		tier: header(headers, 'x-hadoku-tier') ?? 'public',
		ua: userAgentOf(headers),
	};
}

/**
 * A seal below the edge refused a caller. With the edge in front this should
 * never fire: one means a direct hit on the tunnel host, or an edge rule wider
 * than this server's floor — both worth a look.
 */
export function reportSealRefused(
	surface: 'http' | 'draft-socket' | 'play-socket' | 'browser' | 'stream',
	headers: Headers,
	path: string | null,
): void {
	report('seal-refused', { surface, path, ...callerContext(headers) });
}

export interface FirstSeenOptions {
	/** The JSON list of every user id this server has admitted, kept across restarts. */
	file: string;
	userIdOf: (req: Request) => string;
	tierOf: (req: Request) => string;
	log: JsonLog;
}

/**
 * Middleware, mounted below the tier floor: the first request this server ever
 * admits from a user id reports `caller-first-seen` with its tier and user
 * agent — the "who is getting in" signal, once per account, not per visit.
 * Callers the edge named nobody (`anon`) are not accounts and are skipped.
 */
export function firstSeen(opts: FirstSeenOptions): (req: Request, res: Response, next: NextFunction) => void {
	const seen = new Set<string>(readSeen(opts.file, opts.log));
	return (req, _res, next) => {
		const userId = opts.userIdOf(req);
		if (userId !== 'anon' && !seen.has(userId)) {
			seen.add(userId);
			writeSeen(opts.file, seen, opts.log);
			report('caller-first-seen', {
				userId,
				tier: opts.tierOf(req),
				ua: userAgentOf(req.headers),
				path: req.path,
			});
		}
		next();
	};
}

function readSeen(file: string, log: JsonLog): string[] {
	if (!existsSync(file)) return [];
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
		if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) return parsed;
		log({ evt: 'first-seen-unreadable', file, reason: 'not a list of ids' });
	} catch (err) {
		log({
			evt: 'first-seen-unreadable',
			file,
			reason: err instanceof Error ? err.message : String(err),
		});
	}
	return [];
}

function writeSeen(file: string, seen: Set<string>, log: JsonLog): void {
	try {
		writeFileSync(`${file}.tmp`, JSON.stringify([...seen]));
		renameSync(`${file}.tmp`, file);
	} catch (err) {
		log({
			evt: 'first-seen-write-failed',
			file,
			reason: err instanceof Error ? err.message : String(err),
		});
	}
}
