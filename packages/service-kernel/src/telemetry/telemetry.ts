/**
 * Security telemetry: who got in, who was turned away, and who is spending the costly acts — the
 * platform half. Knows no game: the service id, the deployment site and the refusal surface are
 * all parameters, so an app that posts under `service: 'cardtable'` and one that posts under a
 * second game's id read apart in the same monitoring store. See the app's own adapter (this
 * wave's `apps/server/src/telemetry.ts`) for the one place those values get bound.
 *
 * Everything here is fire-and-forget. A post that fails is logged on stdout (pm2 keeps it), never
 * retried, and never delays the request that caused it. One event per (name, caller, incident
 * key) per window goes out; the rest are counted and ride on the next one as `suppressed`, so a
 * scanner hammering the seal costs monitoring one row a minute, not one per request.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { NextFunction, Request, Response } from 'express';

/**
 * A log line: one object a reader can grep by its own fields. This module never imports a
 * concrete logger (another lane owns that), so it takes whatever shape fits.
 */
export type JsonLog = (entry: Record<string, unknown>) => void;

export type TelemetryValue = string | number | boolean | null | TelemetryValue[] | { [key: string]: TelemetryValue };
export type TelemetryContext = Record<string, TelemetryValue>;
/**
 * How much an event needs a person. monitoring-api stores `debug | info | warn | error` and
 * answers 400 to anything else, so `critical` goes out as `error` with `severity: 'critical'`
 * in its context; a reader takes `severity` over the level column.
 */
export type Level = 'info' | 'warn' | 'error' | 'critical';
/** `level` overrides the name rule (`levelOf`). */
export type Report = (event: string, context: TelemetryContext, level?: Level) => void;

/** What `report` does before boot installs a sink, and in every test that installs none. */
const NOOP: Report = () => {};
let installed: Report = NOOP;

/** The process's reporter. The app's boot installs the monitoring sink once. */
export function installTelemetry(sink: Report): void {
	installed = sink;
}

/** Report one event. A no-op until a sink is installed. */
export function report(event: string, context: TelemetryContext, level?: Level): void {
	installed(event, context, level);
}

/** An event's level when its reporter names none: a refusal or a rate limit is a warning, the rest is traffic. */
function levelOf(event: string): Level {
	return event.endsWith('-refused') || event === 'rate-limited' ? 'warn' : 'info';
}

/**
 * Which deployment a base path is: `/<service>` is prod, `/<service>-<site>` that site (a PPE
 * wrapper's prefix, e.g. `/<service>-ppe`). Any other prefix names itself.
 */
export function siteOf(basePrefix: string, service: string): string {
	const m = new RegExp(`^/${service}(?:-([^/]+))?/?$`).exec(basePrefix);
	return m === null ? basePrefix : (m[1] ?? 'prod');
}

/**
 * A hosting alert's level, from what it says: 🚨 is critical; a resolution (the alerts post one
 * under `<key>:resolved`) or a ✅ is info; every other alert is a warning.
 */
function alertLevel(key: string, text: string): Level {
	if (text.startsWith('🚨')) return 'critical';
	if (key.endsWith(':resolved') || text.startsWith('✅')) return 'info';
	return 'warn';
}

/**
 * The hosting alerts (`play/placement/alerts.ts`) as service events, so the daily report lists
 * each one beside the seal refusals. Wraps the log the alerts are given: every entry still goes
 * to it, and each `alert` entry — one per message the alerts post to Discord — is also reported
 * as `alert` with its key and text, at `alertLevel`. Every key is reported, so an alert kind
 * added later needs nothing here.
 */
export function reportingAlerts(log: JsonLog, sink: Report = report): JsonLog {
	return (entry) => {
		log(entry);
		if (entry.evt === 'alert' && typeof entry.key === 'string' && typeof entry.text === 'string') {
			sink('alert', { key: entry.key, text: entry.text }, alertLevel(entry.key, entry.text));
		}
	};
}

export interface SinkOptions {
	/** `https://hadoku.me` — the telemetry route is `/health/api/telemetry` under it. */
	baseUrl: string;
	serviceKey: string;
	/** The env var named in the disabled-reason log line, when `serviceKey` is empty (e.g. `CARDTABLE_SERVICE_KEY`). */
	serviceKeyEnvVar: string;
	log: JsonLog;
	/** Stamped on every event's `context.service`, and in the posting User-Agent. */
	service: string;
	/** This deployment (`siteOf`), on every event. */
	site: string;
	/** One post per (event, caller, incident key) per this many ms. */
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
			reason: `${opts.serviceKeyEnvVar} is not set`,
		});
		return NOOP;
	}
	const windowMs = opts.windowMs ?? 60_000;
	const now = opts.now ?? Date.now;
	const doFetch = opts.fetch ?? fetch;
	const url = `${opts.baseUrl}/health/api/telemetry`;
	const last = new Map<string, { at: number; suppressed: number }>();

	return (event, context, explicit) => {
		const key = `${event}\u0000${String(context.userId ?? '')}\u0000${String(context.key ?? '')}`;
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

		const level = explicit ?? levelOf(event);
		const body = {
			source: 'service',
			level: level === 'critical' ? 'error' : level,
			type: 'log',
			message: `event=${event}`,
			context: {
				service: opts.service,
				site: opts.site,
				...context,
				...(level === 'critical' ? { severity: level } : {}),
				...(suppressed > 0 ? { suppressed } : {}),
			},
		};
		doFetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'User-Agent': `Mozilla/5.0 hadoku-${opts.service}`,
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
 * `sanitizeHeaders` — so a spoofed caller reports as public with a null userId,
 * exactly what the handlers saw.
 */
export function callerContext(headers: Headers): TelemetryContext {
	return {
		userId: header(headers, 'x-user-id'),
		tier: header(headers, 'x-hadoku-tier') ?? 'public',
		ua: userAgentOf(headers),
	};
}

/**
 * A seal below the edge refused a caller. With the edge in front this should
 * never fire: one means a direct hit on the tunnel host, or an edge rule wider
 * than this server's floor — both worth a look. `Surface` is an open string:
 * this module knows no game's surface names, so the app's own adapter narrows
 * it to a closed set.
 */
export function reportSealRefused<Surface extends string>(surface: Surface, headers: Headers, path: string | null): void {
	report('seal-refused', { surface, path, ...callerContext(headers) });
}

export interface FirstSeenOptions {
	/** The JSON list of every user id this server has admitted, kept across restarts. */
	file: string;
	userIdOf: (req: Request) => string | null;
	tierOf: (req: Request) => string;
	log: JsonLog;
}

export interface FirstSeen {
	(req: Request, res: Response, next: NextFunction): void;
	/** Drop one account from the list (account erase); 1 when it was there, else 0. */
	forget(userId: string): number;
}

/**
 * Middleware, mounted below the tier floor: the first request this server ever
 * admits from a user id reports `caller-first-seen` with its tier and user
 * agent — the "who is getting in" signal, once per account, not per visit.
 * Callers the edge named nobody (a null userId) are not accounts and are skipped.
 */
export function firstSeen(opts: FirstSeenOptions): FirstSeen {
	const seen = new Set<string>(readSeen(opts.file, opts.log));
	const middleware = (req: Request, _res: Response, next: NextFunction): void => {
		const userId = opts.userIdOf(req);
		if (userId !== null && !seen.has(userId)) {
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
	return Object.assign(middleware, {
		forget(userId: string): number {
			if (!seen.delete(userId)) return 0;
			writeSeen(opts.file, seen, opts.log);
			return 1;
		},
	});
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
