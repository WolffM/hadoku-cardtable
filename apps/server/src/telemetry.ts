/**
 * Adapter: cardtable's binding of `@hadoku/service-kernel/telemetry` (w93-K3).
 *
 * Every export and signature below is unchanged from before this moved into the kernel:
 * `index.ts`, `gate.ts`, `edge-auth.ts`, `erase/index.ts`, `play/match.ts` and `play/socket.ts`
 * import this path exactly as they did. The cardtable-specific bits are the service id
 * (`cardtable`, stamped on every event's `context.service` and in the posting User-Agent), the
 * env var named in the disabled-reason log line (`CARDTABLE_SERVICE_KEY`), and the closed set of
 * surfaces a seal refusal ever names — the kernel's own `reportSealRefused` takes an open string,
 * since it knows no game's surface names.
 */
import type { Request } from 'express';

import type { JsonLog } from '@hadoku/service-kernel/log';
import {
	callerContext,
	firstSeen as kernelFirstSeen,
	installTelemetry,
	monitoringSink as kernelMonitoringSink,
	report,
	reportingAlerts,
	reportSealRefused as kernelReportSealRefused,
	siteOf as kernelSiteOf,
	userAgentOf,
	type FirstSeen,
	type Level,
	type Report,
	type TelemetryContext,
	type TelemetryValue,
} from '@hadoku/service-kernel/telemetry';

export { callerContext, installTelemetry, report, reportingAlerts, userAgentOf };
export type { FirstSeen, Level, Report, TelemetryContext, TelemetryValue };

/**
 * Which deployment a base path is: `/cardtable` is prod, `/cardtable-<site>` that site
 * (`/cardtable-ppe` is ppe, as the PPE wrapper sets `CARDTABLE_BASE_PREFIX`). Any other
 * prefix names itself.
 */
export function siteOf(basePrefix: string): string {
	return kernelSiteOf(basePrefix, 'cardtable');
}

export interface SinkOptions {
	/** `https://hadoku.me` — the telemetry route is `/health/api/telemetry` under it. */
	baseUrl: string;
	serviceKey: string;
	log: JsonLog;
	/** This deployment (`siteOf`), on every event. */
	site: string;
	/** One post per (event, caller, incident key) per this many ms. */
	windowMs?: number;
	now?: () => number;
	fetch?: typeof fetch;
}

/**
 * A reporter that posts to monitoring-api. Without a service key it posts
 * nothing and says so once, the way the stats reporter does.
 */
export function monitoringSink(opts: SinkOptions): Report {
	return kernelMonitoringSink({ ...opts, service: 'cardtable', serviceKeyEnvVar: 'CARDTABLE_SERVICE_KEY' });
}

type Headers = Request['headers'];

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
	kernelReportSealRefused(surface, headers, path);
}

export interface FirstSeenOptions {
	/** The JSON list of every user id this server has admitted, kept across restarts. */
	file: string;
	userIdOf: (req: Request) => string | null;
	tierOf: (req: Request) => string;
	log: JsonLog;
}

/**
 * Middleware, mounted below the tier floor: the first request this server ever
 * admits from a user id reports `caller-first-seen` with its tier and user
 * agent — the "who is getting in" signal, once per account, not per visit.
 * Callers the edge named nobody (a null userId) are not accounts and are skipped.
 */
export function firstSeen(opts: FirstSeenOptions): FirstSeen {
	return kernelFirstSeen(opts);
}
