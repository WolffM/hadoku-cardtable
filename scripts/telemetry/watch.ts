/**
 * What cardtable's day looked like, from the edge's request log and the servers' service events
 * for a window, read with the repo's service key and summarised for a person, in two parts:
 *
 * - **Needs a look**, one line per event, oldest first: every service event at warn or above
 *   (seal refusals, rate limits, capacity refusals, the hosting alerts, each with its
 *   resolution), every edge 5xx, and every gate breach.
 * - **Traffic**, aggregates per site (prod, ppe; `unknown` for events posted before the servers
 *   tagged their site): requests, accounts, anonymous callers, usage, capacity, 4xx.
 *
 *   node scripts/telemetry/watch.ts [--hours 24] [--own-ip 187.15.91.*] [--json] [--post]
 *
 * Exits 2, after printing `ALERT: …` saying why, when something needs a look NOW: an anonymous
 * caller answered by cardtable itself rather than the edge's sign-in page (a hole in the gate), a
 * `seal-refused` event (a request the edge let through that the server's own floor refused — a
 * direct tunnel hit or an edge rule wider than ours), a critical event (a 🚨 hosting alert: a
 * failover or a lost match), or a stale backup: monitoring-api's job log holds no `succeeded` run
 * of `cardtable:state-backup` (hadoku_site's mgmt-api, nightly) in the last 36 h, or could not be
 * read. That job records `succeeded` only once the night's snapshot restores in full from the
 * fleet data store, so the row is the proof. The job pages when it runs and finds itself stale;
 * this catches it not running at all, on a different clock.
 *
 * `--own-ip` is our own egress, masked the way the log masks it; agents' probes
 * and e2e browsers come from it and are not visitors. Default: looked up once.
 *
 * `--post` also sends a digest to Discord, with the full report attached, through
 * the vault's `DISCORD_CARDTABLE_DAILY_WEBHOOK` (read from the broker with the same
 * service key). A failed post exits 3 after printing the report.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const TOUR = 'c8c59a87-f8af-4da7-9c99-d9e536b3fca8';
const UA = 'Mozilla/5.0 hadoku-agent';
const BASE = 'https://hadoku.me/health/api';
/** What each page asks for. A listing may answer fewer (service-events stops at 500) and still say `hasMore`. */
const PAGE = 1000;
/** The Discord message's budget (Discord's own limit is 2000). */
const DIGEST_MAX = 2000;
const BACKUP_JOB = 'cardtable:state-backup';
/** The backup is daily: over a day and a half means a night has been lost. */
const BACKUP_STALE_HOURS = 36;

export interface Backup {
	/** When the newest succeeded run in the window finished, or null when there is none. */
	at: string | null;
	ageHours: number | null;
	stale: boolean;
	/** Why the job log could not be read; a failed read is stale, never a pass. */
	error: string | null;
}

/** The newest `succeeded` run of the backup job within the stale window, from monitoring-api's job log. */
export async function latestBackup(get: Get, now: Date): Promise<Backup> {
	const since = new Date(now.getTime() - BACKUP_STALE_HOURS * 3_600_000).toISOString();
	try {
		const page = await get(`/jobs?job_name=${encodeURIComponent(BACKUP_JOB)}&state=succeeded&since=${since}&limit=1`);
		const row = ((page.jobs ?? []) as { timestamp?: string }[])[0];
		if (row?.timestamp === undefined) return { at: null, ageHours: null, stale: true, error: null };
		const ageHours = Math.floor((now.getTime() - Date.parse(row.timestamp)) / 3_600_000);
		return { at: row.timestamp, ageHours, stale: ageHours > BACKUP_STALE_HOURS, error: null };
	} catch (err) {
		return { at: null, ageHours: null, stale: true, error: (err as Error).message };
	}
}

export interface Row {
	id?: string;
	timestamp: string;
	method: string;
	path: string;
	status: number;
	backend: string;
	user_id: string | null;
	user_type: string;
	ip_address: string | null;
	user_agent: string | null;
	country: string | null;
}
export interface Event {
	id?: string;
	timestamp: string;
	event: string | null;
	level: string;
	context_json?: string;
	context?: Record<string, unknown>;
}
export type Get = (path: string) => Promise<Record<string, unknown>>;

export class HttpError extends Error {
	readonly status: number;
	constructor(message: string, status: number) {
		super(message);
		this.status = status;
	}
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * `get`, retrying a 5xx after each wait. monitoring-api answers a burst of large listings with
 * 500 "Failed to query logs" and serves the same call again seconds later; one of those used to
 * end the day's report. Anything else, and the last 5xx, throws.
 */
export function retrying(get: Get, waitsMs = [5_000, 15_000, 45_000], wait = sleep): Get {
	return async (path) => {
		for (const ms of waitsMs) {
			try {
				return await get(path);
			} catch (err) {
				if (!(err instanceof HttpError && err.status >= 500)) throw err;
				await wait(ms);
			}
		}
		return get(path);
	};
}

/**
 * Every row of a paged monitoring-api listing (newest first). The next page starts after the rows
 * that came, not after the limit asked: service-events caps a page at 500 and still says `hasMore`,
 * so stepping by the limit skipped rows 500–999 of every thousand. A row posted while paging pushes
 * the rest down one, so a row already read can come again; it is kept once, by id.
 */
export async function pages<T extends { id?: string }>(get: Get, path: string, key: string): Promise<T[]> {
	const out: T[] = [];
	const seen = new Set<string>();
	for (let offset = 0; ; ) {
		const page = await get(`${path}&limit=${PAGE}&offset=${offset}`);
		const rows = (page[key] ?? []) as T[];
		offset += rows.length;
		for (const r of rows) {
			if (r.id !== undefined) {
				if (seen.has(r.id)) continue;
				seen.add(r.id);
			}
			out.push(r);
		}
		if (page.hasMore !== true || rows.length === 0) return out;
	}
}

const BOT =
	/bot|crawl|spider|slurp|semrush|ahrefs|bing|yandex|baidu|facebookexternalhit|preview|lookup|headless|python|curl|wget|go-http|java\/|okhttp|axios|node-fetch|scrapy|httpclient|libwww/i;
const kind = (ua: string | null): string => (ua === null ? 'no-ua' : BOT.test(ua) ? 'bot/script' : 'browser');
const shape = (p: string): string =>
	p.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/g, ':uuid').replace(/\b[a-z]-[0-9a-z]{8,}\b/g, ':id');

/** The site a request went to: `/cardtable-<site>/…` is that site, `/cardtable/…` prod (as `siteOf` in the server's `telemetry.ts`). */
const siteOfPath = (p: string): string => /^\/cardtable-([^/]+)/.exec(p)?.[1] ?? 'prod';

const ctx = (e: Event): Record<string, unknown> =>
	e.context ?? (e.context_json ? (JSON.parse(e.context_json) as Record<string, unknown>) : {});

/**
 * The site the server tagged an event with. mgmt-api's `deploy.finished` names the pm2 service
 * instead (`cardtable`, `cardtable-ppe`); events from before the tag are `unknown`.
 */
function siteOfEvent(e: Event): string {
	const c = ctx(e);
	if (typeof c.site === 'string') return c.site;
	return typeof c.pm2Service === 'string' ? siteOfPath(`/${c.pm2Service}`) : 'unknown';
}

/** An event's level: its `severity` when the server set one (critical, which monitoring-api cannot store), else the column. */
function levelOfEvent(e: Event): string {
	const severity = ctx(e).severity;
	return typeof severity === 'string' ? severity : e.level;
}

const isTraffic = (level: string): boolean => level === 'info' || level === 'debug';
const isAnonymous = (r: Row): boolean => r.user_id === null || r.user_type === 'public';

function count<T>(xs: T[], key: (x: T) => string): [string, number][] {
	const m = new Map<string, number>();
	for (const x of xs) m.set(key(x), (m.get(key(x)) ?? 0) + 1);
	return [...m].sort((a, b) => b[1] - a[1]);
}

/** One line of the first section. `what` groups lines alike (the digest counts by it); `detail` is this one's own. */
export interface Incident {
	at: string;
	site: string;
	level: string;
	what: string;
	detail: string;
}

const TAGS = new Set(['service', 'site', 'severity', 'suppressed']);
const text = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v));

function eventIncident(e: Event): Incident {
	const c = ctx(e);
	const alert = e.event === 'alert';
	// One line each, whatever an alert's text holds.
	const fields = alert
		? text(c.text).replace(/\s*\n\s*/g, ' ')
		: Object.entries(c)
				.filter(([k]) => !TAGS.has(k))
				.map(([k, v]) => `${k}=${text(v)}`)
				.join(' ');
	return {
		at: e.timestamp,
		site: siteOfEvent(e),
		level: levelOfEvent(e),
		what: alert ? `alert ${text(c.key)}` : (e.event ?? '(no event)'),
		detail: typeof c.suppressed === 'number' ? `${fields} (suppressed ${c.suppressed})` : fields,
	};
}

/**
 * The first section: every service event at warn or above and every hosting alert (an alert's
 * resolution is info, and stands beside the alert it closes), every edge 5xx whoever caused it, and
 * every gate breach. Oldest first.
 */
function needsALook(rows: Row[], events: Event[], breaches: Row[], ownIp: string): Incident[] {
	const who = (r: Row): string =>
		`${r.user_type} ${r.user_id ?? '-'}${r.user_id === TOUR ? ' (tour)' : r.ip_address === ownIp ? ' (own egress)' : ''}`;
	return [
		...events.filter((e) => !isTraffic(levelOfEvent(e)) || e.event === 'alert').map(eventIncident),
		...rows
			.filter((r) => r.status >= 500)
			.map((r) => ({
				at: r.timestamp,
				site: siteOfPath(r.path),
				level: 'error',
				what: `edge ${r.status} ${r.method} ${shape(r.path)}`,
				detail: `${r.backend} answered ${r.method} ${r.path} for ${who(r)}`,
			})),
		...breaches.map((r) => ({
			at: r.timestamp,
			site: siteOfPath(r.path),
			level: 'critical',
			what: 'gate-breach',
			detail: `${r.status} ${r.backend} ${r.method} ${r.path} ${r.ip_address} ${r.user_agent}`,
		})),
	].sort((a, b) => a.at.localeCompare(b.at));
}

/** One site's normal traffic: `rows` are its visitors' requests, `events` its info events. */
function aggregate(rows: Row[], events: Event[]) {
	const anon = rows.filter(isAnonymous);
	const named = rows.filter((r) => !isAnonymous(r));

	// Per account: requests, the busiest minute, and first/last seen in the window.
	const perUser = new Map<string, { tier: string; n: number; minutes: Map<string, number>; first: string; last: string; uas: Set<string> }>();
	for (const r of named) {
		const id = r.user_id as string;
		const u = perUser.get(id) ?? { tier: r.user_type, n: 0, minutes: new Map(), first: r.timestamp, last: r.timestamp, uas: new Set() };
		u.n += 1;
		const min = r.timestamp.slice(0, 16);
		u.minutes.set(min, (u.minutes.get(min) ?? 0) + 1);
		if (r.timestamp < u.first) u.first = r.timestamp;
		if (r.timestamp > u.last) u.last = r.timestamp;
		if (r.user_agent) u.uas.add(kind(r.user_agent));
		perUser.set(id, u);
	}
	const accounts = [...perUser]
		.map(([id, u]) => ({
			id,
			tier: u.tier,
			requests: u.n,
			peakPerMin: Math.max(...u.minutes.values()),
			first: u.first,
			last: u.last,
			ua: [...u.uas].join('+'),
		}))
		.sort((a, b) => b.requests - a.requests);

	const contexts = (name: string) => events.filter((e) => e.event === name).map(ctx);

	// Usage: the windows' counts summed; people as the busiest window's count (a person spans windows).
	const usage = contexts('usage');
	const usageTop = new Map<string, number>();
	for (const u of usage)
		for (const [k, n] of Object.entries((u.top ?? {}) as Record<string, number>)) usageTop.set(k, (usageTop.get(k) ?? 0) + n);

	// Capacity: each gauge's highest peak over the period, the worst latency and loop delay.
	const capacity = contexts('capacity');
	const peaksOf = (key: string): number[] =>
		capacity.map((c) => (c.peak as Record<string, unknown> | undefined)?.[key]).filter((x): x is number => typeof x === 'number');
	const worst = (key: string): number | null => {
		const xs = capacity.map((c) => c[key]).filter((x): x is number => typeof x === 'number');
		return xs.length ? Math.max(...xs) : null;
	};
	const gauges = [...new Set(capacity.flatMap((c) => Object.keys((c.peak ?? {}) as object)))];
	const forgeFree = peaksOf('forgeFree');
	const p95 = worst('p95Ms');

	return {
		requests: rows.length,
		byTier: count(rows, (r) => r.user_type),
		newAccounts: events.filter((e) => e.event === 'caller-first-seen').map((e) => ({ at: e.timestamp, ...ctx(e) })),
		anonymous: {
			requests: anon.length,
			byKind: count(anon, (r) => kind(r.user_agent)),
			byAgent: count(anon, (r) => r.user_agent ?? 'no-ua').slice(0, 15),
			byIp: count(anon, (r) => `${r.ip_address} ${r.country}`).slice(0, 15),
			byPath: count(anon, (r) => `${r.status} ${r.method} ${shape(r.path)}`).slice(0, 15),
		},
		accounts: {
			byTier: count(accounts, (a) => a.tier),
			top: accounts.slice(0, 20),
			scripted: accounts.filter((a) => a.ua.includes('bot/script')),
		},
		costlyActs: count(
			events.filter((e) => e.event === 'costly-act'),
			(e) => `${text(ctx(e).act)} ${text(ctx(e).tier)} ${text(ctx(e).userId)}`,
		).slice(0, 20),
		usage: {
			windows: usage.length,
			peakPeople: usage.reduce((m, u) => Math.max(m, Number(u.users ?? 0)), 0),
			views: usage.reduce((n, u) => n + Number(u.views ?? 0), 0),
			clicks: usage.reduce((n, u) => n + Number(u.clicks ?? 0), 0),
			dropped: usage.reduce((n, u) => n + Number(u.dropped ?? 0), 0),
			top: [...usageTop].sort((a, b) => b[1] - a[1]).slice(0, 30),
		},
		capacity: {
			windows: capacity.length,
			peaks: Object.fromEntries(gauges.map((g) => [g, Math.max(...peaksOf(g))])),
			/** Free match slots on eligible claws at the emptiest window's peak; null where the server places on no claws. */
			lowestForgeFree: forgeFree.length ? Math.min(...forgeFree) : null,
			peakRequestsPerMin: worst('perMin'),
			worstP95Ms: p95 === null ? null : Math.round(p95),
			worstLoopMaxMs: worst('loopMaxMs'),
			errors5xx: capacity.reduce((n, c) => n + Number(c.errors5xx ?? 0), 0),
		},
		errors4xx: count(
			rows.filter((r) => r.status >= 400 && r.status < 500 && !(r.backend === 'auth' && r.status === 401)),
			(r) => `${r.status} ${r.method} ${shape(r.path)}`,
		).slice(0, 20),
		eventsByName: count(events, (e) => e.event ?? '(no event)'),
	};
}
export type SiteSummary = ReturnType<typeof aggregate>;

const LEVEL_ORDER = ['critical', 'error', 'warn', 'info'];
const SITE_ORDER = ['prod', 'ppe'];
const rank = (order: string[], x: string): number => (order.includes(x) ? order.indexOf(x) : order.length);

export function summarise(rows: Row[], events: Event[], ownIp: string, since: string, backup: Backup | null = null) {
	const visitors = rows.filter((r) => r.user_id !== TOUR && r.ip_address !== ownIp);
	// The edge answers an anonymous caller itself (backend 'auth': the sign-in page or a 401).
	// Anything else reached cardtable's own server without an account.
	const breaches = visitors.filter((r) => isAnonymous(r) && r.backend !== 'auth' && r.status < 400);
	const incidents = needsALook(rows, events, breaches, ownIp);
	const traffic = events.filter((e) => isTraffic(levelOfEvent(e)));
	const sites = [...new Set([...visitors.map((r) => siteOfPath(r.path)), ...traffic.map(siteOfEvent)])].sort(
		(a, b) => rank(SITE_ORDER, a) - rank(SITE_ORDER, b) || (a === 'unknown' ? 1 : b === 'unknown' ? -1 : a.localeCompare(b)),
	);
	return {
		window: { since, rows: rows.length, events: events.length, ownIp },
		levels: Object.fromEntries(LEVEL_ORDER.map((l) => [l, incidents.filter((i) => i.level === l).length])),
		alerts: {
			gateBreaches: breaches.length,
			sealRefused: events.filter((e) => e.event === 'seal-refused').length,
			critical: incidents.filter((i) => i.level === 'critical' && i.what !== 'gate-breach').length,
			staleBackup: backup?.stale === true,
		},
		backup,
		incidents,
		sites: Object.fromEntries(
			sites.map((s) => [
				s,
				aggregate(
					visitors.filter((r) => siteOfPath(r.path) === s),
					traffic.filter((e) => siteOfEvent(e) === s),
				),
			]),
		) as Record<string, SiteSummary>,
	};
}
export type Summary = ReturnType<typeof summarise>;

/** Why the run exits 2, or null when nothing needs a look now. */
export function alertLine(s: Summary): string | null {
	const a = s.alerts;
	return a.gateBreaches + a.sealRefused + a.critical === 0 && !a.staleBackup
		? null
		: `ALERT: ${a.gateBreaches} gate breach(es), ${a.sealRefused} seal-refused, ${a.critical} critical event(s)` +
				(a.staleBackup ? `, backup ${s.backup?.error ? `unreadable (${s.backup.error})` : 'stale'}` : '');
}

const backupText = (b: Backup): string =>
	b.error !== null
		? `job log unreadable: ${b.error}`
		: b.at === null
			? `no succeeded ${BACKUP_JOB} in ${BACKUP_STALE_HOURS}h (STALE)`
			: `last succeeded ${stamp(b.at)} (${b.ageHours}h${b.stale ? ', STALE' : ''})`;
const levelsLine = (s: Summary): string =>
	`${s.levels.critical} critical, ${s.levels.error} error, ${s.levels.warn} warn${s.levels.info ? `, ${s.levels.info} resolved` : ''}`;
const stamp = (at: string): string => at.slice(0, 19).replace('T', ' ');

export function render(s: Summary): string {
	const out: string[] = [];
	const section = (title: string, lines: string[]) => out.push(`\n## ${title}\n${lines.length ? lines.join('\n') : '  (none)'}`);
	// A site's block lists only what happened there.
	const sub = (title: string, lines: string[]) => {
		if (lines.length) out.push(`\n### ${title}\n${lines.join('\n')}`);
	};
	const table = (xs: [string, number][]) => xs.map(([k, n]) => `${String(n).padStart(6)}  ${k}`);

	out.push(
		`cardtable telemetry since ${s.window.since}: ${s.window.rows} edge rows, ${s.window.events} server events (own egress ${s.window.ownIp} excluded from traffic)`,
	);
	const alert = alertLine(s);
	if (alert !== null) out.push(alert);
	if (s.backup) out.push(`\n## Backup: ${backupText(s.backup)}`);
	const sw = Math.max(4, ...s.incidents.map((i) => i.site.length));
	section(
		`Needs a look: ${levelsLine(s)} (each one, oldest first)`,
		s.incidents.map((i) => `  ${stamp(i.at)}  ${i.site.padEnd(sw)}  ${i.level.padEnd(8)}  ${i.what}  ${i.detail}`),
	);

	for (const [site, a] of Object.entries(s.sites)) {
		const c = a.capacity;
		const u = a.usage;
		out.push(
			`\n## ${site}: ${a.requests} requests from ${a.accounts.byTier.reduce((n, [, k]) => n + k, 0)} account(s), ${a.anonymous.requests} anonymous; ${c.windows} capacity samples, ${u.windows} usage windows`,
		);
		sub('Requests by tier', table(a.byTier));
		sub(
			'New accounts (caller-first-seen)',
			a.newAccounts.map((e) => `  ${JSON.stringify(e)}`),
		);
		sub('Anonymous: by kind', table(a.anonymous.byKind));
		sub('Anonymous: by agent', table(a.anonymous.byAgent));
		sub('Anonymous: by ip', table(a.anonymous.byIp));
		sub('Anonymous: by path', table(a.anonymous.byPath));
		sub(
			'Busiest accounts',
			a.accounts.top.map(
				(x) =>
					`${String(x.requests).padStart(6)}  ${x.tier.padEnd(7)} ${x.id}  peak ${x.peakPerMin}/min  ${x.ua}  ${x.first.slice(5, 16)}..${x.last.slice(5, 16)}`,
			),
		);
		sub(
			'Accounts sending script/bot user agents',
			a.accounts.scripted.map((x) => `  ${x.tier} ${x.id} (${x.requests} requests)`),
		);
		sub('Costly acts', table(a.costlyActs));
		sub(
			"Capacity (peaks over the period, from the server's 5-minute samples)",
			c.windows === 0
				? []
				: [
						`  ${Object.entries(c.peaks)
							.map(([k, v]) => `${k} ${v}`)
							.join(', ')}`,
						`  lowest Forge headroom (free match slots on eligible claws, at a window's peak) ${c.lowestForgeFree ?? 'n/a: no claws'}`,
						`  busiest ${c.peakRequestsPerMin} requests/min, worst p95 ${c.worstP95Ms} ms, worst event-loop stall ${c.worstLoopMaxMs} ms, ${c.errors5xx} 5xx`,
					],
		);
		sub(
			'Usage (screens shown and controls pressed)',
			u.windows === 0
				? []
				: [
						`  ${u.views} views, ${u.clicks} clicks, at most ${u.peakPeople} people in a 5-minute window${u.dropped ? `, ${u.dropped} batches dropped as floods` : ''}`,
						...table(u.top),
					],
		);
		sub('4xx (excluding the edge sign-in 401s)', table(a.errors4xx));
		sub('Info events by name', table(a.eventsByName));
	}
	return out.join('\n');
}

/** The Discord message: what needs a look first, counted by level, then one line per site; the report rides along as a file. */
export function digest(s: Summary): string {
	const cut = (line: string, n: number) => (line.length <= n ? line : `${line.slice(0, n - 1)}…`);
	const sum = (xs: [string, number][]) => xs.reduce((t, [, k]) => t + k, 0);
	const top = (xs: [string, number][], k = 3) =>
		xs
			.slice(0, k)
			.map(([key, c]) => `${c} × ${key}`)
			.join(', ');
	const sites = Object.entries(s.sites);
	const alert = alertLine(s);

	// Lines alike as one: by level, then how many.
	const groups = new Map<string, { level: string; n: number; last: Incident }>();
	for (const i of s.incidents) {
		const key = `${i.level} ${i.site} ${i.what}`;
		const g = groups.get(key) ?? { level: i.level, n: 0, last: i };
		g.n += 1;
		g.last = i;
		groups.set(key, g);
	}
	const ranked = [...groups].sort(([, a], [, b]) => rank(LEVEL_ORDER, a.level) - rank(LEVEL_ORDER, b.level) || b.n - a.n);
	const SHOWN = 6;

	const lines = [
		`**cardtable daily** · ${s.window.since.slice(0, 16).replace('T', ' ')} UTC → now · ${s.window.rows} edge rows, ${s.window.events} server events`,
		`**Needs a look:** ${levelsLine(s)}`,
		alert === null ? '✅ no gate breaches, no seal refusals, nothing critical' : `🚨 **${alert.replace('ALERT: ', '')}** — see the report`,
		...ranked
			.slice(0, SHOWN)
			.map(([key, g]) => cut(`· ${g.n} × ${key} — ${g.n > 1 ? 'last: ' : ''}${stamp(g.last.at).slice(5, 16)} ${g.last.detail}`, 150)),
		...(ranked.length > SHOWN ? [`· … ${ranked.length - SHOWN} more in the report`] : []),
		`**New accounts:** ${
			sites.every(([, a]) => a.newAccounts.length === 0)
				? 'none'
				: sites
						.flatMap(([site, a]) => a.newAccounts.map((x: Record<string, unknown>) => `${text(x.tier)} \`${text(x.userId).slice(0, 8)}\` (${site})`))
						.slice(0, 10)
						.join(', ')
		}`,
		...sites.map(([site, a]) => {
			const c = a.capacity;
			const u = a.usage;
			return [
				`**${site}:** ${a.requests} requests (${top(a.byTier) || 'none'})`,
				u.windows === 0 ? null : `usage ${u.views} views, ${u.clicks} clicks, peak ${u.peakPeople} people`,
				c.windows === 0
					? null
					: `capacity busiest ${c.peakRequestsPerMin}/min, p95 ${c.worstP95Ms} ms, stall ${c.worstLoopMaxMs} ms${c.lowestForgeFree === null ? '' : `, Forge headroom ≥ ${c.lowestForgeFree}`}, ${c.errors5xx} 5xx`,
				sum(a.costlyActs) === 0 ? null : `${sum(a.costlyActs)} costly acts`,
				sum(a.errors4xx) === 0 ? null : `4xx ${top(a.errors4xx, 2)}`,
			]
				.filter((x) => x !== null)
				.join(' · ');
		}),
		...(s.backup ? [`**Backup:** ${backupText(s.backup)}${s.backup.stale ? ' ⚠️' : ''}`] : []),
		`**Anonymous:** ${
			sites.every(([, a]) => a.anonymous.requests === 0)
				? 'none'
				: sites
						.filter(([, a]) => a.anonymous.requests > 0)
						.map(([site, a]) => `${site} ${top(a.anonymous.byKind)}`)
						.join('; ')
		}`,
		`**Scripted accounts:** ${
			sites.every(([, a]) => a.accounts.scripted.length === 0)
				? 'none'
				: sites.flatMap(([site, a]) => a.accounts.scripted.map((x) => `${x.tier} \`${x.id.slice(0, 8)}\` (${x.requests}, ${site})`)).join(', ')
		}`,
	];
	return cut(lines.join('\n'), DIGEST_MAX);
}

function serviceKey(): string {
	if (process.env.CARDTABLE_TELEMETRY_KEY) return process.env.CARDTABLE_TELEMETRY_KEY;
	const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
		encoding: 'utf8',
	}).trim();
	for (const dir of [process.cwd(), join(common, '..')]) {
		const file = join(dir, '.devvault.local.json');
		if (existsSync(file)) return (JSON.parse(readFileSync(file, 'utf8')) as { key: string }).key;
	}
	throw new Error('no service key: set CARDTABLE_TELEMETRY_KEY or run from a checkout with .devvault.local.json');
}

async function ownIp(given: string | undefined): Promise<string> {
	if (given) return given;
	const ip = (await (await fetch('https://api.ipify.org', { headers: { 'User-Agent': UA } })).text()).trim();
	return ip.includes(':') ? ip : `${ip.split('.').slice(0, 3).join('.')}.*`;
}

async function post(key: string, message: string, report: string): Promise<void> {
	let hook = process.env.DISCORD_CARDTABLE_DAILY_WEBHOOK;
	if (!hook) {
		const res = await fetch('http://127.0.0.1:4000/api/secrets/get/DISCORD_CARDTABLE_DAILY_WEBHOOK', {
			headers: { 'User-Agent': UA, 'X-User-Key': key },
		});
		const body = (await res.json()) as { success?: boolean; value?: string; error?: string };
		if (!body.value) throw new Error(`vault: DISCORD_CARDTABLE_DAILY_WEBHOOK: ${body.error ?? `HTTP ${res.status}`}`);
		hook = body.value;
	}
	const form = new FormData();
	form.append('payload_json', JSON.stringify({ content: message, allowed_mentions: { parse: [] } }));
	form.append('files[0]', new Blob([report], { type: 'text/plain' }), `cardtable-${new Date().toISOString().slice(0, 10)}.txt`);
	const res = await fetch(hook, { method: 'POST', body: form });
	if (!res.ok) throw new Error(`discord: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
}

async function main(): Promise<void> {
	const { values: args } = parseArgs({
		options: {
			hours: { type: 'string', default: '24' },
			'own-ip': { type: 'string' },
			json: { type: 'boolean', default: false },
			post: { type: 'boolean', default: false },
		},
	});
	const since = new Date(Date.now() - Number(args.hours) * 3_600_000).toISOString();
	const key = serviceKey();
	const get = retrying(async (path) => {
		const res = await fetch(`${BASE}${path}`, { headers: { 'User-Agent': UA, 'X-User-Key': key } });
		if (!res.ok) throw new HttpError(`${path}: HTTP ${res.status}`, res.status);
		return (await res.json()) as Record<string, unknown>;
	});
	const [rows, events, mine, backup] = await Promise.all([
		pages<Row>(get, `/logs/query?path=/cardtable&since=${since}`, 'logs'),
		pages<Event>(get, `/service-events?service=cardtable&since=${since}`, 'events'),
		ownIp(args['own-ip']),
		latestBackup(get, new Date()),
	]);
	const summary = summarise(rows, events, mine, since, backup);
	const report = args.json ? JSON.stringify(summary, null, 2) : render(summary);
	console.log(report);

	if (args.post) {
		try {
			await post(key, digest(summary), report);
		} catch (err) {
			console.error(`PostError: ${(err as Error).message}`);
			process.exit(3);
		}
	}
	if (alertLine(summary) !== null) process.exit(2);
}

if (import.meta.main) await main();
