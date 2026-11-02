/**
 * Who is reaching cardtable, and is anyone abusing it: the edge's request log
 * and this server's security events for a window, read with the repo's service
 * key and summarised for a person.
 *
 *   node scripts/telemetry/watch.ts [--hours 24] [--own-ip 187.15.91.*] [--json] [--post]
 *
 * Exits 2 when something needs a look NOW: an anonymous caller answered by
 * cardtable itself rather than the edge's sign-in page (a hole in the gate), or
 * a `seal-refused` event (a request the edge let through that the server's own
 * floor refused — a direct tunnel hit or an edge rule wider than ours).
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

interface Row {
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
interface Event {
	timestamp: string;
	event: string | null;
	level: string;
	context_json?: string;
	context?: Record<string, unknown>;
}

const { values: args } = parseArgs({
	options: {
		hours: { type: 'string', default: '24' },
		'own-ip': { type: 'string' },
		json: { type: 'boolean', default: false },
		post: { type: 'boolean', default: false },
	},
});
const since = new Date(Date.now() - Number(args.hours) * 3_600_000).toISOString();

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
const KEY = serviceKey();

async function get(path: string): Promise<Record<string, unknown>> {
	const res = await fetch(`${BASE}${path}`, {
		headers: { 'User-Agent': UA, 'X-User-Key': KEY },
	});
	if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
	return (await res.json()) as Record<string, unknown>;
}

async function pages<T>(path: string, key: string): Promise<T[]> {
	const out: T[] = [];
	for (let offset = 0; ; offset += 1000) {
		const page = await get(`${path}&limit=1000&offset=${offset}`);
		const rows = (page[key] ?? page.rows ?? page.data ?? []) as T[];
		out.push(...rows);
		if (page.hasMore !== true || rows.length === 0) return out;
	}
}

async function ownIp(): Promise<string> {
	if (args['own-ip']) return args['own-ip'];
	const ip = (await (await fetch('https://api.ipify.org', { headers: { 'User-Agent': UA } })).text()).trim();
	return ip.includes(':') ? ip : `${ip.split('.').slice(0, 3).join('.')}.*`;
}

const BOT =
	/bot|crawl|spider|slurp|semrush|ahrefs|bing|yandex|baidu|facebookexternalhit|preview|lookup|headless|python|curl|wget|go-http|java\/|okhttp|axios|node-fetch|scrapy|httpclient|libwww/i;
const kind = (ua: string | null): string => (ua === null ? 'no-ua' : BOT.test(ua) ? 'bot/script' : 'browser');
const shape = (p: string): string =>
	p.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/g, ':uuid').replace(/\b[a-z]-[0-9a-z]{8,}\b/g, ':id');
const site = (p: string): string => (p.startsWith('/cardtable-ppe') ? 'ppe' : 'prod');

function count<T>(xs: T[], key: (x: T) => string): [string, number][] {
	const m = new Map<string, number>();
	for (const x of xs) m.set(key(x), (m.get(key(x)) ?? 0) + 1);
	return [...m].sort((a, b) => b[1] - a[1]);
}

const [rows, events, mine] = await Promise.all([
	pages<Row>(`/logs/query?path=/cardtable&since=${since}`, 'logs'),
	pages<Event>(`/service-events?service=cardtable&since=${since}`, 'events'),
	ownIp(),
]);
const ctx = (e: Event): Record<string, unknown> =>
	e.context ?? (e.context_json ? (JSON.parse(e.context_json) as Record<string, unknown>) : {});

const visitors = rows.filter((r) => r.user_id !== TOUR && r.ip_address !== mine);
const anon = visitors.filter((r) => r.user_id === null || r.user_type === 'public');
// The edge answers an anonymous caller itself (backend 'auth': the sign-in page or a 401).
// Anything else reached cardtable's own server without an account.
const breaches = anon.filter((r) => r.backend !== 'auth' && r.status < 400);
const named = visitors.filter((r) => r.user_id !== null && r.user_type !== 'public');
const sealRefused = events.filter((e) => e.event === 'seal-refused');

// Per account: requests, the busiest minute, and first/last seen in the window.
const perUser = new Map<
	string,
	{
		tier: string;
		n: number;
		minutes: Map<string, number>;
		first: string;
		last: string;
		uas: Set<string>;
	}
>();
for (const r of named) {
	const id = r.user_id as string;
	const u = perUser.get(id) ?? {
		tier: r.user_type,
		n: 0,
		minutes: new Map(),
		first: r.timestamp,
		last: r.timestamp,
		uas: new Set(),
	};
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

// Usage: the windows' counts summed; people as the busiest window's count (a person spans windows).
const usageEvents = events.filter((e) => e.event === 'usage').map(ctx);
const usageTop = new Map<string, number>();
for (const u of usageEvents)
	for (const [k, n] of Object.entries((u.top ?? {}) as Record<string, number>))
		usageTop.set(k, (usageTop.get(k) ?? 0) + n);

// Capacity: each gauge's highest peak over the period, the worst latency and loop delay, and
// every start turned away because the server was full.
const capacityEvents = events.filter((e) => e.event === 'capacity').map(ctx);
const peakOf = (key: string): number | null => {
	const xs = capacityEvents
		.map((c) => (c.peak as Record<string, number> | undefined)?.[key])
		.filter((x): x is number => typeof x === 'number');
	return xs.length ? Math.max(...xs) : null;
};
const worst = (key: string): number | null => {
	const xs = capacityEvents.map((c) => c[key]).filter((x): x is number => typeof x === 'number');
	return xs.length ? Math.max(...xs) : null;
};
const gaugeNames = [...new Set(capacityEvents.flatMap((c) => Object.keys((c.peak ?? {}) as object)))];

const summary = {
	window: { since, rows: rows.length, events: events.length, ownIp: mine },
	traffic: count(visitors, (r) => `${site(r.path)} ${r.user_type}`),
	newAccounts: events.filter((e) => e.event === 'caller-first-seen').map((e) => ({ at: e.timestamp, ...ctx(e) })),
	alerts: {
		gateBreaches: breaches.map(
			(r) => `${r.timestamp} ${r.status} ${r.backend} ${r.method} ${r.path} ${r.ip_address} ${r.user_agent}`,
		),
		sealRefused: sealRefused.map((e) => ({ at: e.timestamp, ...ctx(e) })),
	},
	anonymous: {
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
	acts: count(
		events.filter((e) => e.event === 'costly-act' || e.event === 'rate-limited'),
		(e) => {
			const c = ctx(e);
			return `${e.event} ${c.act} ${c.tier} ${c.userId}`;
		},
	).slice(0, 20),
	usage: {
		windows: usageEvents.length,
		peakPeople: usageEvents.reduce((m, u) => Math.max(m, Number(u.users ?? 0)), 0),
		views: usageEvents.reduce((n, u) => n + Number(u.views ?? 0), 0),
		clicks: usageEvents.reduce((n, u) => n + Number(u.clicks ?? 0), 0),
		dropped: usageEvents.reduce((n, u) => n + Number(u.dropped ?? 0), 0),
		top: [...usageTop].sort((a, b) => b[1] - a[1]).slice(0, 30),
	},
	capacity: {
		windows: capacityEvents.length,
		peaks: Object.fromEntries(gaugeNames.map((g) => [g, peakOf(g)])),
		lowestForgeFree: capacityEvents.length
			? Math.min(
					...capacityEvents.map((c) => Number((c.peak as Record<string, number> | undefined)?.forgeFree ?? Infinity)),
				)
			: null,
		peakRequestsPerMin: worst('perMin'),
		worstP95Ms: worst('p95Ms'),
		worstLoopMaxMs: worst('loopMaxMs'),
		errors5xx: capacityEvents.reduce((n, c) => n + Number(c.errors5xx ?? 0), 0),
		refused: count(
			events.filter((e) => e.event === 'capacity-refused'),
			(e) => `${ctx(e).act} ${ctx(e).tier} ${ctx(e).userId}`,
		),
	},
	errors: count(
		visitors.filter((r) => r.status >= 400 && !(r.backend === 'auth' && r.status === 401)),
		(r) => `${r.status} ${r.method} ${shape(r.path)}`,
	).slice(0, 20),
};

const out: string[] = [];
if (args.json) {
	out.push(JSON.stringify(summary, null, 2));
} else {
	const section = (title: string, lines: string[]) =>
		out.push(`\n## ${title}\n${lines.length ? lines.join('\n') : '  (none)'}`);
	const table = (xs: [string, number][]) => xs.map(([k, n]) => `${String(n).padStart(6)}  ${k}`);
	out.push(
		`cardtable telemetry since ${since}: ${rows.length} edge rows, ${events.length} server events (own egress ${mine} excluded)`,
	);
	section('ALERT: anonymous callers cardtable itself answered', summary.alerts.gateBreaches);
	section(
		'ALERT: seal-refused (the server floor refused what the edge passed)',
		summary.alerts.sealRefused.map((e) => `  ${JSON.stringify(e)}`),
	);
	section('Traffic by site and tier', table(summary.traffic));
	section(
		'New accounts (caller-first-seen)',
		summary.newAccounts.map((e) => `  ${JSON.stringify(e)}`),
	);
	section('Anonymous: by kind', table(summary.anonymous.byKind));
	section('Anonymous: by agent', table(summary.anonymous.byAgent));
	section('Anonymous: by ip', table(summary.anonymous.byIp));
	section('Anonymous: by path', table(summary.anonymous.byPath));
	section('Accounts by tier', table(summary.accounts.byTier));
	section(
		'Busiest accounts',
		summary.accounts.top.map(
			(a) =>
				`${String(a.requests).padStart(6)}  ${a.tier.padEnd(7)} ${a.id}  peak ${a.peakPerMin}/min  ${a.ua}  ${a.first.slice(5, 16)}..${a.last.slice(5, 16)}`,
		),
	);
	section(
		'Accounts sending script/bot user agents',
		summary.accounts.scripted.map((a) => `  ${a.tier} ${a.id} (${a.requests} requests)`),
	);
	section('Costly acts and rate limits', table(summary.acts));
	const c = summary.capacity;
	section(
		"Capacity (peaks over the period, from the server's 5-minute samples)",
		c.windows === 0
			? []
			: [
					`  ${Object.entries(c.peaks)
						.map(([k, v]) => `${k} ${v}`)
						.join(', ')}`,
					`  lowest Forge headroom (free match slots on eligible claws, at a window's peak) ${c.lowestForgeFree}`,
					`  busiest ${c.peakRequestsPerMin} requests/min, worst p95 ${c.worstP95Ms} ms, worst event-loop stall ${c.worstLoopMaxMs} ms, ${c.errors5xx} 5xx`,
					...table(c.refused).map((l) => `  refused, server full: ${l.trim()}`),
				],
	);
	const u = summary.usage;
	section(
		'Usage (screens shown and controls pressed)',
		u.windows === 0
			? []
			: [
					`  ${u.views} views, ${u.clicks} clicks, at most ${u.peakPeople} people in a 5-minute window${u.dropped ? `, ${u.dropped} batches dropped as floods` : ''}`,
					...table(u.top),
				],
	);
	section('Errors (excluding the edge sign-in 401s)', table(summary.errors));
}
const report = out.join('\n');
console.log(report);

const alerting = breaches.length > 0 || sealRefused.length > 0;

/** The Discord message: what needs a look first, then one line per section; the report rides along as a file. */
function digest(): string {
	const n = (xs: unknown[]) => xs.length;
	const sum = (xs: [string, number][]) => xs.reduce((t, [, k]) => t + k, 0);
	const top = (xs: [string, number][], k = 3) => xs.slice(0, k).map(([key, c]) => `${c} × ${key}`).join(', ');
	const lines = [
		`**cardtable daily** · ${since.slice(0, 16).replace('T', ' ')} UTC → now · ${rows.length} edge rows, ${events.length} server events`,
		alerting
			? `🚨 **${n(summary.alerts.gateBreaches)} gate breach(es), ${n(summary.alerts.sealRefused)} seal-refused** — see the report`
			: '✅ no gate breaches, no seal refusals',
		`**New accounts:** ${
			n(summary.newAccounts) === 0
				? 'none'
				: `${n(summary.newAccounts)} — ${summary.newAccounts
						.slice(0, 10)
						.map((a: Record<string, unknown>) => `${String(a.tier)} \`${String(a.userId).slice(0, 8)}\``)
						.join(', ')}`
		}`,
		`**Traffic:** ${top(summary.traffic, 5) || 'none'}`,
		`**Anonymous:** ${sum(summary.anonymous.byKind) === 0 ? 'none' : top(summary.anonymous.byKind)}`,
		`**Scripted accounts:** ${n(summary.accounts.scripted) === 0 ? 'none' : summary.accounts.scripted.map((a) => `${a.tier} \`${a.id.slice(0, 8)}\` (${a.requests})`).join(', ')}`,
		`**Costly acts / rate limits:** ${sum(summary.acts) === 0 ? 'none' : top(summary.acts)}`,
		`**Capacity:** ${
			summary.capacity.windows === 0
				? 'no samples'
				: `busiest ${summary.capacity.peakRequestsPerMin}/min, worst p95 ${Math.round(summary.capacity.worstP95Ms ?? 0)} ms, loop stall ${summary.capacity.worstLoopMaxMs} ms, lowest Forge headroom ${summary.capacity.lowestForgeFree}, ${summary.capacity.errors5xx} 5xx, ${sum(summary.capacity.refused)} refused`
		}`,
		`**Usage:** ${
			summary.usage.windows === 0
				? 'no samples'
				: `${summary.usage.views} views, ${summary.usage.clicks} clicks, peak ${summary.usage.peakPeople} people`
		}`,
		`**Errors:** ${sum(summary.errors) === 0 ? 'none' : `${sum(summary.errors)} — ${top(summary.errors)}`}`,
	];
	const text = lines.join('\n');
	return text.length <= 2000 ? text : `${text.slice(0, 1990)}…`;
}

async function post(): Promise<void> {
	let hook = process.env.DISCORD_CARDTABLE_DAILY_WEBHOOK;
	if (!hook) {
		const res = await fetch('http://127.0.0.1:4000/api/secrets/get/DISCORD_CARDTABLE_DAILY_WEBHOOK', {
			headers: { 'User-Agent': UA, 'X-User-Key': KEY },
		});
		const body = (await res.json()) as { success?: boolean; value?: string; error?: string };
		if (!body.value) throw new Error(`vault: DISCORD_CARDTABLE_DAILY_WEBHOOK: ${body.error ?? `HTTP ${res.status}`}`);
		hook = body.value;
	}
	const form = new FormData();
	form.append('payload_json', JSON.stringify({ content: digest(), allowed_mentions: { parse: [] } }));
	form.append('files[0]', new Blob([report], { type: 'text/plain' }), `cardtable-${new Date().toISOString().slice(0, 10)}.txt`);
	const res = await fetch(hook, { method: 'POST', body: form });
	if (!res.ok) throw new Error(`discord: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
}

if (args.post) {
	try {
		await post();
	} catch (err) {
		console.error(`PostError: ${(err as Error).message}`);
		process.exit(3);
	}
}
if (alerting) process.exit(2);
