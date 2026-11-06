import { describe, expect, it } from 'vitest';

import { alertLine, HttpError, latestBackup, retrying, digest, pages, render, summarise, type Event, type Get, type Row } from './watch.ts';

/** A monitoring-api listing, newest first, that answers at most `cap` rows a page whatever was asked, and says `hasMore` past them. */
function cappedApi(all: { id: string }[], cap = 500): { get: Get; asked: string[] } {
	const asked: string[] = [];
	const get: Get = async (path) => {
		asked.push(path);
		const q = new URLSearchParams(path.slice(path.indexOf('?') + 1));
		const offset = Number(q.get('offset'));
		const limit = Math.min(Number(q.get('limit')), cap);
		return { events: all.slice(offset, offset + limit), hasMore: offset + limit < all.length, total: all.length };
	};
	return { get, asked };
}

const ids = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ id: `e${from + i}` }));

describe('pages', () => {
	it('reads every row from a listing that caps its pages at 500, stepping by the rows that came', async () => {
		const all = ids(1271);
		const { get, asked } = cappedApi(all);
		const got = await pages(get, '/service-events?service=cardtable', 'events');

		expect(got).toEqual(all);
		expect(asked.map((p) => new URLSearchParams(p.split('?')[1]).get('offset'))).toEqual(['0', '500', '1000']);
	});

	it('keeps a row once when one posted while paging pushes the rest down', async () => {
		const all = ids(700, 1);
		const { get: inner } = cappedApi(all);
		let calls = 0;
		const get: Get = async (path) => {
			if (calls++ === 1) all.unshift({ id: 'e0' });
			return inner(path);
		};
		const got = await pages(get, '/service-events?service=cardtable', 'events');

		expect(got.map((r) => r.id)).toEqual(ids(700, 1).map((r) => r.id));
	});
});

const at = (hhmm: string) => `2026-11-04T${hhmm}:00.000Z`;
const ev = (timestamp: string, event: string, level: string, context: Record<string, unknown>): Event => ({
	timestamp,
	event,
	level,
	context_json: JSON.stringify({ service: 'cardtable', ...context }),
});
const row = (timestamp: string, path: string, over: Partial<Row> = {}): Row => ({
	timestamp,
	method: 'GET',
	path,
	status: 200,
	backend: 'tunnel',
	user_id: '3f2b8c1e-5d4a-4e7b-9a10-6c2d8e4f1a01',
	user_type: 'member',
	ip_address: '203.0.113.*',
	user_agent: 'Mozilla/5.0 Firefox',
	country: 'US',
	...over,
});
const capacity = (timestamp: string, site: string | undefined, peak: Record<string, number>) =>
	ev(timestamp, 'capacity', 'info', { ...(site ? { site } : {}), peak, perMin: 10, p95Ms: 40.6, loopMaxMs: 20, errors5xx: 0 });

const EVENTS: Event[] = [
	capacity(at('01:00'), 'prod', { sockets: 3, forgeFree: 50 }),
	capacity(at('01:05'), 'prod', { sockets: 5, forgeFree: 70 }),
	// PPE places on no claws, so it has no headroom gauge.
	capacity(at('01:00'), 'ppe', { sockets: 9 }),
	// Posted before the servers tagged their site.
	capacity(at('00:30'), undefined, { sockets: 1, forgeFree: 0 }),
	ev(at('02:00'), 'seal-refused', 'warn', { site: 'prod', surface: 'http', path: '/cardtable/api/replays', userId: null, tier: 'public', ua: 'curl/8', suppressed: 3 }),
	ev(at('03:00'), 'alert', 'error', { site: 'prod', key: 'failover:claw-9', text: '🚨 Failover: claw-9 — heartbeat lost.', severity: 'critical' }),
	ev(at('03:10'), 'alert', 'info', { site: 'prod', key: 'failover:claw-9:resolved', text: '✅ claw-9 is back (open 600 s)' }),
	ev(at('04:00'), 'costly-act', 'info', { site: 'prod', act: 'room-create', tier: 'member', userId: 'u1' }),
	// mgmt-api's, which names the pm2 service rather than a site.
	ev(at('04:30'), 'deploy.finished', 'info', { pm2Service: 'cardtable', status: 'success' }),
];
const ROWS: Row[] = [
	row(at('01:00'), '/cardtable/api/rooms'),
	row(at('01:01'), '/cardtable/api/rooms', { status: 404 }),
	row(at('01:02'), '/cardtable-ppe/socket.io/', { status: 502 }),
	row(at('01:03'), '/cardtable-ppe/api/rooms'),
	// The edge's own sign-in answer to an anonymous caller: traffic, not a breach.
	row(at('01:04'), '/cardtable/', { status: 401, backend: 'auth', user_id: null, user_type: 'public' }),
];

describe('summarise', () => {
	const s = summarise(ROWS, EVENTS, '198.51.100.*', at('00:00'));

	it('lists every warn+ event, alert resolution and edge 5xx individually, oldest first', () => {
		expect(s.incidents.map((i) => [i.at.slice(11, 16), i.site, i.level, i.what])).toEqual([
			['01:02', 'ppe', 'error', 'edge 502 GET /cardtable-ppe/socket.io/'],
			['02:00', 'prod', 'warn', 'seal-refused'],
			['03:00', 'prod', 'critical', 'alert failover:claw-9'],
			['03:10', 'prod', 'info', 'alert failover:claw-9:resolved'],
		]);
		expect(s.incidents[1].detail).toBe('surface=http path=/cardtable/api/replays userId=null tier=public ua=curl/8 (suppressed 3)');
		expect(s.incidents[2].detail).toBe('🚨 Failover: claw-9 — heartbeat lost.');
		expect(s.levels).toEqual({ critical: 1, error: 1, warn: 1, info: 1 });
	});

	it('aggregates info traffic per site, with Forge headroom only where there are claws', () => {
		expect(Object.keys(s.sites)).toEqual(['prod', 'ppe', 'unknown']);
		expect(s.sites.prod.capacity).toMatchObject({ windows: 2, peaks: { sockets: 5, forgeFree: 70 }, lowestForgeFree: 50, worstP95Ms: 41 });
		expect(s.sites.ppe.capacity).toMatchObject({ windows: 1, peaks: { sockets: 9 }, lowestForgeFree: null });
		expect(s.sites.unknown.capacity.lowestForgeFree).toBe(0);
		expect(s.sites.prod.requests).toBe(3);
		expect(s.sites.prod.errors4xx).toEqual([['404 GET /cardtable/api/rooms', 1]]);
		expect(s.sites.prod.costlyActs).toEqual([['room-create member u1', 1]]);
		expect(s.sites.prod.eventsByName).toEqual([
			['capacity', 2],
			['alert', 1],
			['costly-act', 1],
			['deploy.finished', 1],
		]);
		expect(s.sites.ppe.requests).toBe(2);
	});

	it('exits 2 for a seal refusal or a critical event, and names them', () => {
		expect(alertLine(s)).toBe('ALERT: 0 gate breach(es), 1 seal-refused, 1 critical event(s)');
		expect(alertLine(summarise(ROWS, EVENTS.filter((e) => e.level === 'info'), '198.51.100.*', at('00:00')))).toBeNull();
		const breach = row(at('05:00'), '/cardtable/api/rooms', { user_id: null, user_type: 'public' });
		expect(alertLine(summarise([breach], [], '198.51.100.*', at('00:00')))).toBe('ALERT: 1 gate breach(es), 0 seal-refused, 0 critical event(s)');
	});

	it('renders the incidents first, then one block per site', () => {
		const text = render(s);
		const heads = text.split('\n').filter((l) => l.startsWith('## '));
		expect(heads[0]).toBe('## Needs a look: 1 critical, 1 error, 1 warn, 1 resolved (each one, oldest first)');
		expect(heads.slice(1).map((h) => h.split(':')[0])).toEqual(['## prod', '## ppe', '## unknown']);
		expect(text).toContain('lowest Forge headroom (free match slots on eligible claws, at a window\'s peak) n/a: no claws');
		expect(text.split('\n')[1]).toBe('ALERT: 0 gate breach(es), 1 seal-refused, 1 critical event(s)');
	});
});

describe('digest', () => {
	it('leads with the counts by level and keeps to the Discord budget however many incidents there are', () => {
		const many = Array.from({ length: 400 }, (_, i) =>
			ev(`2026-11-04T05:${String(i % 60).padStart(2, '0')}:00.000Z`, 'alert', 'warn', { site: 'prod', key: `kind-${i}`, text: `⚠️ ${'x'.repeat(300)}` }),
		);
		const s = summarise(ROWS, [...EVENTS, ...many], '198.51.100.*', at('00:00'));
		const text = digest(s);

		expect(text.split('\n')[1]).toBe('**Needs a look:** 1 critical, 1 error, 401 warn, 1 resolved');
		expect(text.split('\n')[3]).toMatch(/^· 1 × critical prod alert failover:claw-9 — 11-04 03:00 🚨 Failover/);
		expect(text).toContain('· … 398 more in the report');
		expect(text).toMatch(/\*\*prod:\*\* 3 requests .*Forge headroom ≥ 50/);
		expect(text).not.toMatch(/\*\*ppe:\*\*.*headroom/);
		expect(text.length).toBeLessThanOrEqual(2000);
	});
});

describe('retrying', () => {
	const flaky = (statuses: number[]) => {
		let n = 0;
		const get: Get = async (path) => {
			const status = statuses[n++];
			if (status === undefined) return { path };
			throw new HttpError(`${path}: HTTP ${status}`, status);
		};
		return { get, calls: () => n };
	};
	const waited: number[] = [];
	const wait = async (ms: number) => void waited.push(ms);

	it('asks again after each wait while the answer is a 5xx', async () => {
		waited.length = 0;
		const { get, calls } = flaky([500, 503]);
		expect(await retrying(get, [1, 2, 3], wait)('/logs')).toEqual({ path: '/logs' });
		expect(calls()).toBe(3);
		expect(waited).toEqual([1, 2]);
	});

	it('throws the last 5xx once the waits run out, and a 4xx at once', async () => {
		waited.length = 0;
		await expect(retrying(flaky([500, 500, 500]).get, [1, 2], wait)('/logs')).rejects.toThrow('/logs: HTTP 500');
		expect(waited).toEqual([1, 2]);
		const forbidden = flaky([403]);
		await expect(retrying(forbidden.get, [1, 2], wait)('/jobs')).rejects.toThrow('/jobs: HTTP 403');
		expect(forbidden.calls()).toBe(1);
	});
});

describe('backup', () => {
	const now = new Date('2026-11-06T18:00:00Z');
	/** monitoring-api's job log answering `rows` to every ask. */
	const jobs = (rows: { timestamp: string }[]): { get: Get; asked: string[] } => {
		const asked: string[] = [];
		return { asked, get: async (path) => (asked.push(path), { jobs: rows, total: rows.length, hasMore: false }) };
	};

	it("asks for the job's newest succeeded run in the last 36 h, and a fresh row needs no look", async () => {
		const { get, asked } = jobs([{ timestamp: '2026-11-06T12:02:35.538Z' }]);
		const b = await latestBackup(get, now);
		expect(asked).toEqual(['/jobs?job_name=cardtable%3Astate-backup&state=succeeded&since=2026-11-05T06:00:00.000Z&limit=1']);
		expect(b).toEqual({ at: '2026-11-06T12:02:35.538Z', ageHours: 5, stale: false, error: null });
		const s = summarise([], [], '198.51.100.*', at('00:00'), b);
		expect(alertLine(s)).toBeNull();
		expect(render(s)).toContain('## Backup: last succeeded 2026-11-06 12:02:35 (5h)');
		expect(digest(s)).toContain('**Backup:** last succeeded 2026-11-06 12:02:35 (5h)');
	});

	it('exits 2 when no run succeeded in the window, and says so in the report and the digest', async () => {
		const s = summarise([], [], '198.51.100.*', at('00:00'), await latestBackup(jobs([]).get, now));
		expect(alertLine(s)).toBe('ALERT: 0 gate breach(es), 0 seal-refused, 0 critical event(s), backup stale');
		expect(render(s)).toContain('## Backup: no succeeded cardtable:state-backup in 36h (STALE)');
		expect(digest(s)).toContain('**Backup:** no succeeded cardtable:state-backup in 36h (STALE) ⚠️');
	});

	it('exits 2 with the error when the job log cannot be read, never passing silently', async () => {
		const get: Get = async (path) => {
			throw new Error(`${path.split('?')[0]}: HTTP 403`);
		};
		const b = await latestBackup(get, now);
		expect(b).toEqual({ at: null, ageHours: null, stale: true, error: '/jobs: HTTP 403' });
		const s = summarise([], [], '198.51.100.*', at('00:00'), b);
		expect(alertLine(s)).toBe('ALERT: 0 gate breach(es), 0 seal-refused, 0 critical event(s), backup unreadable (/jobs: HTTP 403)');
		expect(render(s)).toContain('## Backup: job log unreadable: /jobs: HTTP 403');
	});
});
