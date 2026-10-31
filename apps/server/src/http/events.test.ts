/**
 * `/api/events` (`./events.ts`) over a real lobby on a temp dir: an event's room is made at
 * once with every setting the form chose and the organizer as its leader, is read live (a change
 * in the room shows on the calendar), survives the lobby's stale filter and idle sweep until its
 * event, moves with a reschedule and closes with a cancel; only the organizer may change one.
 * Attached forms go through a stand-in for Rally's summary endpoint.
 */

import express from 'express';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AttachedFormSchema, EventListSchema, EventViewSchema, FormListSchema, rallyCreateUrl, rallyFormIdOf, rallyReturnOf } from '@hadoku/shared';

const EDGE_SECRET = 'test-edge-auth-secret';
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

let eventsHttp: typeof import('./events.ts');
let eventsStore: typeof import('../room/events.ts');
let lobbyMod: typeof import('../room/lobby.ts');
let edgeMod: typeof import('../edge-auth.ts');

beforeAll(async () => {
	process.env.EDGE_AUTH_SECRET = EDGE_SECRET;
	delete process.env.CARDTABLE_INSECURE_NO_EDGE_AUTH;
	vi.resetModules();
	eventsHttp = await import('./events.ts');
	eventsStore = await import('../room/events.ts');
	lobbyMod = await import('../room/lobby.ts');
	edgeMod = await import('../edge-auth.ts');
});

const dirs: string[] = [];
const servers: HttpServer[] = [];

afterEach(async () => {
	await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});
afterAll(async () => {
	// The stores write after a route answers, so a write can land while its directory is being removed.
	await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5 })));
});

/** Two draft pools: the harness's `checkPlan` refuses any round naming the cube `refuse`, and passes the rest. */
const PLAN = { rounds: [{ kind: 'cube', cubeId: 'vintage' }, { kind: 'cube', cubeId: 'vintage' }, { kind: 'cube', cubeId: 'vintage' }] };
const REFUSED_PLAN = { rounds: [{ kind: 'cube', cubeId: 'refuse' }, { kind: 'cube', cubeId: 'refuse' }, { kind: 'cube', cubeId: 'refuse' }] };

/** Rally's summary endpoint as a table of forms by id; `status` stands for what Rally answers instead. */
type RallyRow = { status: 401 | 404 | 500 } | { status: 200; form: Record<string, unknown> };
function rallyForm(id: string, over: Record<string, unknown> = {}): RallyRow {
	return {
		status: 200,
		form: { id, title: `Form ${id}`, status: 'open', closesAt: null, url: `https://hadoku.me/rally?e=${id}`, createdBy: 'Mika', schema: { name: 'event-signup', version: 1 }, ...over },
	};
}

async function openApp(clock: { now: number }, rally: Record<string, RallyRow> = {}) {
	const dir = await mkdtemp(join(tmpdir(), 'cardtable-events-test-'));
	dirs.push(dir);
	const now = (): number => clock.now;
	const log = (): void => {};
	const lobby = await lobbyMod.openLobby({ dir: join(dir, 'rooms'), log, now, defaultFormat: 'unavailable' });
	const events = await eventsStore.openEvents(join(dir, 'events.json'), log, now);
	const closed: string[] = [];
	const rallyCalls: { url: string; key: string | null }[] = [];
	const fetchRally = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = String(input);
		rallyCalls.push({ url, key: new Headers(init?.headers).get('x-user-key') });
		const id = /\/forms\/([^/]+)\/summary$/.exec(url)?.[1] ?? '';
		const row = rally[decodeURIComponent(id)] ?? { status: 404 };
		return row.status === 200 ? Response.json({ success: true, data: row.form }) : Response.json({ success: false }, { status: row.status });
	};
	const app = express();
	app.use(edgeMod.edgeProvenance);
	app.use(edgeMod.requireMinTier);
	const api = express.Router();
	api.use(express.json());
	eventsHttp.attachEvents(api, {
		events,
		lobby,
		now,
		closed: (roomId) => closed.push(roomId),
		checkPlan: async (plan) => (plan.rounds.some((r) => r.kind === 'cube' && r.cubeId === 'refuse') ? { ok: false, unplayable: ['Black Lotus'], missingText: [] } : { ok: true, cards: 540 }),
		rally: { serviceKey: 'svc-key', fetch: fetchRally },
		log,
	});
	app.use('/api', api);
	const server = createServer(app);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	servers.push(server);
	const { port } = server.address() as AddressInfo;
	return { base: `http://127.0.0.1:${port}/api`, lobby, closed, rallyCalls };
}

function headersFor(user: string): Record<string, string> {
	return {
		'content-type': 'application/json',
		'x-edge-auth': EDGE_SECRET,
		'x-hadoku-tier': 'friend',
		'x-user-id': `user-${user}`,
		'x-user-name': `user-${user}`,
		'x-user-key': `friend-key-${user}`,
	};
}

const call = async (base: string, user: string, method: string, path: string, body?: unknown) => {
	const res = await fetch(`${base}${path}`, { method, headers: headersFor(user), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
	return { status: res.status, body: (await res.json()) as unknown };
};

const tournament = (title: string, startsAt: string, room: Record<string, unknown> = {}) => ({ title, startsAt, room });

describe('/api/events', () => {
	it('a constructed tournament makes its room at once with every setting the form chose, led by the organizer', async () => {
		const clock = { now: Date.UTC(2026, 9, 28, 12) };
		const { base, lobby } = await openApp(clock);
		const startsAt = new Date(clock.now + 2 * DAY).toISOString();
		const made = await call(base, 'alice', 'POST', '/events', tournament('Pauper cup', startsAt, {
			gameType: 'constructed-1v1',
			mode: 'classic',
			format: 'free',
			settings: { tournamentDecks: 'per-round', clock: 'on', handSmoothing: false },
		}));
		expect(made.status).toBe(201);
		const event = EventViewSchema.parse(made.body);
		expect(event).toMatchObject({ kind: 'constructed-tournament', title: 'Pauper cup', startsAt, organizer: 'user-alice', mine: true });
		const room = lobby.get(event.roomId!);
		expect(room).toMatchObject({
			name: 'Pauper cup',
			gameType: 'constructed-1v1',
			mode: 'classic',
			format: 'free',
			scheduledFor: startsAt,
			settings: { tournament: true, tournamentDecks: 'per-round', clock: 'on', handSmoothing: false },
		});
		expect(room?.members.map((m) => m.name)).toEqual(['user-alice']);
		expect(event.room).toMatchObject({ gameType: 'constructed-1v1', mode: 'classic', format: 'free', settings: { tournament: true, clock: 'on' }, locked: false, members: 1 });

		const seen = EventListSchema.parse((await call(base, 'bob', 'GET', '/events')).body);
		expect(seen.events.map((e) => [e.title, e.mine])).toEqual([['Pauper cup', false]]);
	});

	it('a draft tournament checks its pool first and sets it, with its pick timer; a refused pool makes no room', async () => {
		const clock = { now: Date.UTC(2026, 9, 28, 12) };
		const { base, lobby } = await openApp(clock);
		const startsAt = new Date(clock.now + DAY).toISOString();
		const made = await call(base, 'alice', 'POST', '/events', tournament('Saturday cube', startsAt, { gameType: 'draft', plan: PLAN, settings: { pickTimer: { on: true, speed: 2 } } }));
		expect(made.status).toBe(201);
		const event = EventViewSchema.parse(made.body);
		expect(event.kind).toBe('draft-pod');
		expect(lobby.get(event.roomId!)).toMatchObject({ gameType: 'draft', settings: { pickTimer: { on: true, speed: 2 } }, pod: { plan: PLAN, verdict: { ok: true } } });
		expect(event.room).toMatchObject({ gameType: 'draft', phase: 'lobby', settings: { pickTimer: { on: true, speed: 2 } } });

		const refused = await call(base, 'alice', 'POST', '/events', tournament('Bad cube', startsAt, { gameType: 'draft', plan: REFUSED_PLAN }));
		expect(refused.status).toBe(409);
		expect(refused.body).toMatchObject({ verdict: { ok: false, unplayable: ['Black Lotus'] } });
		expect(lobby.list()).toHaveLength(1);
	});

	it('refuses a format on a draft room, a plan on a constructed one, a bad setting, a start in the past', async () => {
		const clock = { now: Date.UTC(2026, 9, 28, 12) };
		const { base, lobby } = await openApp(clock);
		const startsAt = new Date(clock.now + HOUR).toISOString();
		const status = async (body: unknown) => (await call(base, 'alice', 'POST', '/events', body)).status;
		expect(await status(tournament('x', startsAt, { gameType: 'draft', format: 'free' }))).toBe(400);
		expect(await status(tournament('x', startsAt, { gameType: 'constructed-1v1', plan: PLAN }))).toBe(400);
		expect(await status(tournament('x', startsAt, { settings: { clock: 'sometimes' } }))).toBe(400);
		expect(await status(tournament('x', startsAt, { settings: { tournament: false } }))).toBe(400);
		expect(await status(tournament('x', new Date(clock.now - HOUR).toISOString()))).toBe(400);
		expect(await status({ kind: 'casual', title: 'x', startsAt })).toBe(400);
		expect(lobby.list()).toEqual([]);
	});

	it('the room is the source of truth: a change made in the room shows through GET /api/events at once', async () => {
		const clock = { now: Date.UTC(2026, 9, 28, 12) };
		const { base, lobby } = await openApp(clock);
		const event = EventViewSchema.parse((await call(base, 'alice', 'POST', '/events', tournament('Cup', new Date(clock.now + DAY).toISOString(), { gameType: 'constructed-1v1', mode: 'classic' }))).body);
		const leader = lobby.get(event.roomId!)!.leader;
		const listed = async () => EventListSchema.parse((await call(base, 'bob', 'GET', '/events')).body).events[0];

		expect(lobby.setSettings(event.roomId!, leader, { clock: 'off', tournamentDecks: 'per-round' }).ok).toBe(true);
		expect(lobby.setMode(event.roomId!, leader, { mode: 'random', modeOptions: { pool: 'modern' } }).ok).toBe(true);
		expect(await listed()).toMatchObject({ kind: 'constructed-tournament', room: { mode: 'random', settings: { clock: 'off', tournamentDecks: 'per-round' } } });

		expect(lobby.setSettings(event.roomId!, leader, { tournament: false }).ok).toBe(true);
		expect((await listed())?.kind).toBe('room');
		expect(lobby.setGameType(event.roomId!, leader, 'draft').ok).toBe(true);
		expect(await listed()).toMatchObject({ kind: 'draft-pod', room: { gameType: 'draft', mode: null } });

		expect(lobby.join(event.roomId!, { id: 'fk:2222222222222222', name: 'user-bob' }).ok).toBe(true);
		expect((await listed())?.room?.members).toBe(2);
	});

	it('lists soonest first and drops an event six hours after it starts', async () => {
		const clock = { now: Date.UTC(2026, 9, 28, 12) };
		const { base } = await openApp(clock);
		for (const [title, at] of [['Later', 3 * DAY], ['Sooner', DAY], ['Middle', 2 * DAY]] as const) {
			await call(base, 'alice', 'POST', '/events', tournament(title, new Date(clock.now + at).toISOString()));
		}
		const titles = async () => EventListSchema.parse((await call(base, 'bob', 'GET', '/events')).body).events.map((e) => e.title);
		expect(await titles()).toEqual(['Sooner', 'Middle', 'Later']);
		clock.now += DAY + 7 * HOUR;
		expect(await titles()).toEqual(['Middle', 'Later']);
	});

	it('the room is offered and kept until its event, however long nobody touches it', async () => {
		const clock = { now: Date.UTC(2026, 9, 28, 12) };
		const { base, lobby } = await openApp(clock);
		const event = EventViewSchema.parse((await call(base, 'alice', 'POST', '/events', tournament('Friday', new Date(clock.now + 3 * DAY).toISOString(), { gameType: 'draft' }))).body);
		clock.now += 2 * DAY;
		expect(lobby.sweep()).toEqual([]);
		expect(lobby.offered().map((r) => r.id)).toEqual([event.roomId]);
		clock.now += DAY + lobbyMod.ROOM_STALE_MS + 1;
		expect(lobby.offered()).toEqual([]);
		clock.now += lobbyMod.ROOM_IDLE_MS;
		expect(lobby.sweep()).toEqual([event.roomId]);
	});

	it('only the organizer moves or cancels; a reschedule moves the room, a cancel closes it; the title is the room’s', async () => {
		const clock = { now: Date.UTC(2026, 9, 28, 12) };
		const { base, lobby, closed } = await openApp(clock);
		const event = EventViewSchema.parse((await call(base, 'alice', 'POST', '/events', tournament('Pod', new Date(clock.now + DAY).toISOString(), { gameType: 'draft' }))).body);
		const later = new Date(clock.now + 2 * DAY).toISOString();

		expect((await call(base, 'bob', 'PATCH', `/events/${event.id}`, { startsAt: later })).status).toBe(403);
		expect((await call(base, 'bob', 'DELETE', `/events/${event.id}`)).status).toBe(403);
		expect((await call(base, 'alice', 'PATCH', '/events/e-nope', { startsAt: later })).status).toBe(404);
		expect((await call(base, 'alice', 'PATCH', `/events/${event.id}`, {})).status).toBe(400);
		expect((await call(base, 'alice', 'PATCH', `/events/${event.id}`, { title: 'Pod night', startsAt: later })).status).toBe(400);

		const moved = await call(base, 'alice', 'PATCH', `/events/${event.id}`, { title: 'Pod', startsAt: later });
		expect(EventViewSchema.parse(moved.body)).toMatchObject({ title: 'Pod', startsAt: later });
		expect(lobby.get(event.roomId!)?.scheduledFor).toBe(later);

		expect((await call(base, 'alice', 'DELETE', `/events/${event.id}`)).status).toBe(200);
		expect(lobby.get(event.roomId!)).toBeUndefined();
		expect(closed).toEqual([event.roomId]);
		expect(EventListSchema.parse((await call(base, 'alice', 'GET', '/events')).body).events).toEqual([]);
	});

	it('an event whose room was closed is no longer listed', async () => {
		const clock = { now: Date.UTC(2026, 9, 28, 12) };
		const { base, lobby } = await openApp(clock);
		const event = EventViewSchema.parse((await call(base, 'alice', 'POST', '/events', tournament('Pod', new Date(clock.now + DAY).toISOString(), { gameType: 'draft' }))).body);
		const alice = lobby.get(event.roomId!)!.leader;
		expect(lobby.close(event.roomId!, alice).ok).toBe(true);
		expect(EventListSchema.parse((await call(base, 'alice', 'GET', '/events')).body).events).toEqual([]);
	});
});

describe('/api/events/forms', () => {
	it('attaches an event-signup@1 form checked through Rally with our service key, once', async () => {
		const clock = { now: Date.UTC(2026, 9, 28, 12) };
		const { base, rallyCalls } = await openApp(clock, { abc123: rallyForm('abc123', { closesAt: '2026-12-01T00:00:00.000Z' }) });
		const made = await call(base, 'alice', 'POST', '/events/forms', { formId: 'abc123' });
		expect(made.status).toBe(201);
		expect(AttachedFormSchema.parse(made.body)).toMatchObject({ id: 'abc123', title: 'Form abc123', status: 'open', url: 'https://hadoku.me/rally?e=abc123', attachedBy: 'user-alice', mine: true });
		expect(rallyCalls[0]).toEqual({ url: 'https://hadoku.me/rally/api/forms/abc123/summary', key: 'svc-key' });
		expect((await call(base, 'alice', 'POST', '/events/forms', { formId: 'abc123' })).status).toBe(200);

		const listed = FormListSchema.parse((await call(base, 'bob', 'GET', '/events/forms')).body);
		expect(listed.forms.map((f) => [f.id, f.mine, f.closesAt])).toEqual([['abc123', false, '2026-12-01T00:00:00.000Z']]);
	});

	it('accepts only event-signup@1, answers 404 for a form Rally does not know and 502 when Rally refuses us', async () => {
		const clock = { now: Date.UTC(2026, 9, 28, 12) };
		const { base } = await openApp(clock, {
			custom: rallyForm('custom', { schema: { name: 'custom', version: 1 } }),
			v2: rallyForm('v2', { schema: { name: 'event-signup', version: 2 } }),
			locked: { status: 401 },
			down: { status: 500 },
		});
		const attach = async (formId: unknown) => (await call(base, 'alice', 'POST', '/events/forms', { formId })).status;
		expect(await attach('custom')).toBe(400);
		expect(await attach('v2')).toBe(400);
		expect(await attach('nope')).toBe(404);
		expect(await attach('locked')).toBe(502);
		expect(await attach('down')).toBe(502);
		expect(await attach('bad id!')).toBe(400);
		expect(FormListSchema.parse((await call(base, 'alice', 'GET', '/events/forms')).body).forms).toEqual([]);
	});

	it('lists only the forms Rally says are open, and only the attacher detaches one', async () => {
		const clock = { now: Date.UTC(2026, 9, 28, 12) };
		const rally: Record<string, RallyRow> = { a: rallyForm('a', { closesAt: '2026-11-05T00:00:00.000Z' }), b: rallyForm('b', { closesAt: '2026-11-02T00:00:00.000Z' }), c: rallyForm('c') };
		const { base } = await openApp(clock, rally);
		for (const formId of ['a', 'b', 'c']) expect((await call(base, 'alice', 'POST', '/events/forms', { formId })).status).toBe(201);
		const ids = async () => FormListSchema.parse((await call(base, 'bob', 'GET', '/events/forms')).body).forms.map((f) => f.id);
		expect(await ids()).toEqual(['b', 'a', 'c']);

		rally.a = rallyForm('a', { status: 'closed' });
		rally.c = { status: 404 };
		clock.now += 10 * 60_000;
		expect(await ids()).toEqual(['b']);

		expect((await call(base, 'bob', 'DELETE', '/events/forms/b')).status).toBe(403);
		expect((await call(base, 'alice', 'DELETE', '/events/forms/zzz')).status).toBe(404);
		expect((await call(base, 'alice', 'DELETE', '/events/forms/b')).status).toBe(200);
		expect(await ids()).toEqual([]);
	});
});

describe('Rally links', () => {
	it('reads the return trip from location.search, before the hash route', () => {
		expect(rallyReturnOf('?form=abc123&ref=ct-42')).toEqual({ formId: 'abc123', ref: 'ct-42' });
		expect(rallyReturnOf(new URL('https://hadoku.me/cardtable/?form=abc123&ref=ct-42#/rooms').search)).toEqual({ formId: 'abc123', ref: 'ct-42' });
		expect(rallyReturnOf('?form=abc123')).toBeNull();
		expect(rallyReturnOf('?form=a%20b&ref=x')).toBeNull();
		expect(rallyReturnOf('')).toBeNull();
	});

	it('builds the create link and reads a pasted form link or id', () => {
		const url = new URL(rallyCreateUrl('ct-42', 'https://hadoku.me/cardtable-ppe/#/rooms'));
		expect(`${url.origin}${url.pathname}`).toBe('https://hadoku.me/rally');
		expect(Object.fromEntries(url.searchParams)).toEqual({ origin: 'cardtable', ref: 'ct-42', return: 'https://hadoku.me/cardtable-ppe/#/rooms' });
		expect(rallyFormIdOf(' abc123 ')).toBe('abc123');
		expect(rallyFormIdOf('https://hadoku.me/rally?e=abc123')).toBe('abc123');
		expect(rallyFormIdOf('https://evil.example/rally?e=abc123')).toBeNull();
		expect(rallyFormIdOf('not a form')).toBeNull();
	});
});

describe('openEvents', () => {
	it('reads back what it wrote, and forgets an event a week after it started', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'cardtable-events-store-'));
		dirs.push(dir);
		const file = join(dir, 'events.json');
		const clock = { now: Date.UTC(2026, 9, 28, 12) };
		const first = await eventsStore.openEvents(file, () => {}, () => clock.now);
		first.create({ startsAt: clock.now + HOUR, organizerId: 'a', organizerName: 'Alice', roomId: 'r-000000000001' }, clock.now);
		first.create({ startsAt: clock.now - 8 * DAY, organizerId: 'a', organizerName: 'Alice', roomId: 'r-000000000002' }, clock.now);
		first.attachForm({ formId: 'abc123', attachedById: 'a', attachedByName: 'Alice' }, clock.now);
		// The write is the store's own; wait for the file to hold the one event it keeps.
		await vi.waitFor(async () => expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ events: [{ roomId: 'r-000000000001' }], forms: [{ formId: 'abc123' }] }));
		const second = await eventsStore.openEvents(file, () => {}, () => clock.now);
		expect(second.upcoming(clock.now).map((e) => e.roomId)).toEqual(['r-000000000001']);
		expect(second.upcoming(clock.now - 30 * DAY).map((e) => e.roomId)).toEqual(['r-000000000001']);
		expect(second.forms().map((f) => f.formId)).toEqual(['abc123']);
	});
});

describe('POST /api/events rate limit', () => {
	it('answers 429 once a caller has organized a burst of events, and only that caller', async () => {
		const clock = { now: Date.UTC(2026, 9, 28, 12) };
		const { base, lobby } = await openApp(clock);
		const startsAt = new Date(clock.now + DAY).toISOString();
		const { capacity } = eventsHttp.EVENT_CREATE_RATE_LIMIT;
		const statuses: number[] = [];
		for (let i = 0; i < capacity + 1; i++) {
			statuses.push((await call(base, 'mallory', 'POST', '/events', tournament(`Spam ${i}`, startsAt, { gameType: 'draft' }))).status);
		}
		expect(statuses).toEqual([...Array.from({ length: capacity }, () => 201), 429]);
		expect(lobby.list()).toHaveLength(capacity);
		expect((await call(base, 'bob', 'POST', '/events', tournament('Come play', startsAt))).status).toBe(201);
	});
});
