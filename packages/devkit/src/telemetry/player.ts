/**
 * One person's visit, as a single timeline: every request the edge logged for them, every screen
 * they saw and control they pressed (the app's `usage-user` trail, `relays/usage.ts`), and every
 * server event that names them (first seen, costly acts, rate limits, seal refusals), oldest first.
 *
 *   node scripts/telemetry/player.ts --name "Player 80583" [--hours 24 | --since ISO] [--until ISO] [--all] [--json]
 *   node scripts/telemetry/player.ts --user <userId> …
 *
 * `--name` is matched (case-insensitively) against the names the trail recorded in the window; a
 * name two accounts used is refused with both ids. A request answered 4xx/5xx is marked `!`.
 * Without `--all`, the background chatter a page makes on its own (the usage posts themselves,
 * prefs reads, art redirects, polls of the same room) is folded: a run of identical lines prints
 * once with `×N`, and the folded kinds are counted in the header instead.
 */
import { parseArgs } from 'node:util';

import { findRoot, loadConfig } from '../config.ts';
import { BASE, HttpError, pages, retrying, serviceKey, UA, watchApp, type Event, type Get, type Row } from './watch.ts';

export interface Line {
	at: string;
	source: 'edge' | 'ui' | 'event';
	text: string;
	/** A request the edge answered 4xx/5xx, or a warn-or-worse event. */
	bad: boolean;
}

export interface Visit {
	userId: string;
	names: string[];
	tiers: string[];
	first: string | null;
	last: string | null;
	requests: number;
	errors: number;
	views: number;
	clicks: number;
	topControls: [string, number][];
	folded: Record<string, number>;
	lines: Line[];
}

const ctx = (e: Event): Record<string, unknown> =>
	e.context ?? (e.context_json ? (JSON.parse(e.context_json) as Record<string, unknown>) : {});

/** Background requests a page makes on its own, folded out of the timeline unless `--all`. */
const BACKGROUND: [string, RegExp][] = [
	['usage posts', /\/api\/usage$/],
	['client logs', /\/api\/client-log$/],
	['prefs reads', /^\/prefs\/api\//],
	['art redirects', /\/api\/art\//],
	['sound files', /\/api\/sounds\/audio\//],
];

/** The ids a userId's names were recorded under, from the trail events in the window. */
export function idsForName(events: Event[], name: string): string[] {
	const want = name.toLowerCase();
	const ids = new Set<string>();
	for (const e of events) {
		const c = ctx(e);
		if (e.event === 'usage-user' && typeof c.name === 'string' && c.name.toLowerCase() === want && typeof c.userId === 'string') ids.add(c.userId);
	}
	return [...ids];
}

/** The trail's `HH:MM:SS` on the window's own date (`from`), rolled a day on when it wraps past midnight. */
function trailTime(from: string, clock: string): string {
	const day = from.slice(0, 10);
	const at = `${day}T${clock}.000Z`;
	return at < from.slice(0, 19) ? new Date(Date.parse(at) + 86_400_000).toISOString() : at;
}

export function visit(userId: string, rows: Row[], events: Event[], all: boolean): Visit {
	const names = new Set<string>();
	const tiers = new Set<string>();
	const folded: Record<string, number> = {};
	const controls = new Map<string, number>();
	const lines: Line[] = [];
	let errors = 0;
	let views = 0;
	let clicks = 0;
	const mine = rows.filter((r) => r.user_id === userId);
	for (const r of mine) {
		tiers.add(r.user_type);
		const bad = r.status >= 400;
		if (bad) errors += 1;
		const background = BACKGROUND.find(([, re]) => re.test(r.path.split('?')[0]!));
		if (background !== undefined && !all && !bad) {
			folded[background[0]] = (folded[background[0]] ?? 0) + 1;
			continue;
		}
		lines.push({ at: r.timestamp, source: 'edge', text: `${r.status} ${r.method} ${r.path}`, bad });
	}
	for (const e of events) {
		const c = ctx(e);
		if (c.userId !== userId) continue;
		if (e.event === 'usage-user') {
			if (typeof c.name === 'string') names.add(c.name);
			if (typeof c.tier === 'string') tiers.add(c.tier);
			for (const l of (c.trail ?? []) as string[]) {
				const [clock, kind, ...rest] = l.split(' ');
				if (kind === 'view') views += 1;
				if (kind === 'click') {
					clicks += 1;
					const control = rest.join(' ');
					controls.set(control, (controls.get(control) ?? 0) + 1);
				}
				lines.push({ at: trailTime(String(c.from), clock!), source: 'ui', text: `${kind} ${rest.join(' ')}`, bad: false });
			}
			if (typeof c.trailDropped === 'number') lines.push({ at: String(c.from), source: 'ui', text: `(${c.trailDropped} more presses in this window not kept)`, bad: true });
			continue;
		}
		const what = [c.act, c.surface, c.path].filter((x) => typeof x === 'string').join(' ');
		lines.push({ at: e.timestamp, source: 'event', text: `${e.event ?? '?'}${what === '' ? '' : ` ${what}`}`, bad: e.level !== 'info' && e.level !== 'debug' });
	}
	lines.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.source.localeCompare(b.source)));
	const at = lines.map((l) => l.at);
	return {
		userId,
		names: [...names],
		tiers: [...tiers],
		first: at[0] ?? null,
		last: at.at(-1) ?? null,
		requests: mine.length,
		errors,
		views,
		clicks,
		topControls: [...controls].sort((a, b) => b[1] - a[1]).slice(0, 15),
		folded,
		lines: all ? lines : fold(lines),
	};
}

/** A run of identical consecutive lines (same source and text) printed once, `×N` and its span. */
export function fold(lines: Line[]): Line[] {
	const out: Line[] = [];
	for (let i = 0; i < lines.length; ) {
		let j = i + 1;
		while (j < lines.length && lines[j]!.source === lines[i]!.source && lines[j]!.text === lines[i]!.text) j += 1;
		const n = j - i;
		out.push(n === 1 ? lines[i]! : { ...lines[i]!, text: `${lines[i]!.text}  ×${n} until ${lines[j - 1]!.at.slice(11, 19)}` });
		i = j;
	}
	return out;
}

export function renderVisit(v: Visit): string {
	const out = [
		`${v.names.join(' / ') || '(no name recorded)'}  ${v.userId}  tier ${v.tiers.join(', ') || '?'}`,
		`seen ${v.first ?? '-'} .. ${v.last ?? '-'}: ${v.requests} requests (${v.errors} answered 4xx/5xx), ${v.views} screens, ${v.clicks} presses`,
	];
	if (v.topControls.length > 0) out.push(`most pressed: ${v.topControls.map(([c, n]) => `${c} ${n}`).join(', ')}`);
	const folded = Object.entries(v.folded);
	if (folded.length > 0) out.push(`folded (--all shows them): ${folded.map(([k, n]) => `${n} ${k}`).join(', ')}`);
	out.push('');
	for (const l of v.lines) out.push(`${l.at.slice(0, 10)} ${l.at.slice(11, 19)} ${l.bad ? '!' : ' '} ${l.source.padEnd(5)} ${l.text}`);
	return out.join('\n');
}

export interface PlayerDeps {
	fetch: typeof fetch;
	env: NodeJS.ProcessEnv;
	now: () => Date;
	print: (line: string) => void;
	printError: (line: string) => void;
}

const realDeps = (): PlayerDeps => ({ fetch: globalThis.fetch, env: process.env, now: () => new Date(), print: console.log, printError: console.error });

/** The visit report on stdout; exit 0, or 1 when the person could not be named or read. */
export async function main(argv: string[], root: string, deps: PlayerDeps = realDeps()): Promise<number> {
	const app = watchApp(loadConfig(root));
	const { values: args } = parseArgs({
		args: argv,
		options: {
			user: { type: 'string' },
			name: { type: 'string' },
			hours: { type: 'string', default: '24' },
			since: { type: 'string' },
			until: { type: 'string' },
			all: { type: 'boolean', default: false },
			json: { type: 'boolean', default: false },
		},
	});
	if ((args.user === undefined) === (args.name === undefined)) {
		deps.printError('player: give exactly one of --user <userId> or --name <display name>');
		return 1;
	}
	const since = args.since ?? new Date(deps.now().getTime() - Number(args.hours) * 3_600_000).toISOString();
	const until = args.until === undefined ? '' : `&until=${encodeURIComponent(args.until)}`;
	const key = serviceKey(app.envPrefix, deps.env, root);
	const get: Get = retrying(async (path) => {
		const res = await deps.fetch(`${BASE}${path}`, { headers: { 'User-Agent': UA, 'X-User-Key': key } });
		if (!res.ok) throw new HttpError(`${path}: HTTP ${res.status}`, res.status);
		return (await res.json()) as Record<string, unknown>;
	});
	const events = await pages<Event>(get, `/service-events?service=${app.service}&since=${since}${until}`, 'events');
	if (events.error !== null) deps.printError(`server events: ${events.error}`);
	let userId = args.user;
	if (userId === undefined) {
		const ids = idsForName(events.rows, args.name!);
		if (ids.length !== 1) {
			deps.printError(
				ids.length === 0
					? `player: no trail since ${since} names "${args.name}" (trails began with the per-person usage events; try --user, or a wider --hours)`
					: `player: "${args.name}" names ${ids.length} accounts in this window: ${ids.join(', ')}; pass --user`,
			);
			return 1;
		}
		userId = ids[0]!;
	}
	const logs = await pages<Row>(get, `/logs/query?userId=${encodeURIComponent(userId)}&since=${since}${until}`, 'logs');
	if (logs.error !== null) deps.printError(`edge log: ${logs.error}`);
	const v = visit(userId, logs.rows, events.rows, args.all);
	deps.print(args.json ? JSON.stringify(v, null, 2) : renderVisit(v));
	return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2), findRoot()));
