/**
 * `/api/events` (`./events.ts`) over a real lobby on a temp dir: an event's room is made at
 * once with the organizer as its leader, survives the lobby's stale filter and idle sweep until
 * its event, moves with a reschedule and closes with a cancel; only the organizer may change one.
 */

import express from 'express';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { EventListSchema, EventViewSchema } from '@hadoku/shared';

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
	await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function openApp(clock: { now: number }) {
	const dir = await mkdtemp(join(tmpdir(), 'cardtable-events-test-'));
	dirs.push(dir);
	const now = (): number => clock.now;
	const log = (): void => {};
	const lobby = await lobbyMod.openLobby({ dir: join(dir, 'rooms'), log, now, defaultFormat: 'unavailable' });
	const events = await eventsStore.openEvents(join(dir, 'events.json'), log, now);
	const closed: string[] = [];
	const app = express();
	app.use(edgeMod.edgeProvenance);
	app.use(edgeMod.requireMinTier);
	const api = express.Router();
	api.use(express.json());
	eventsHttp.attachEvents(api, { events, lobby, now, closed: (roomId) => closed.push(roomId) });
	app.use('/api', api);
	const server = createServer(app);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	servers.push(server);
	const { port } = server.address() as AddressInfo;
	return { base: `http://127.0.0.1:${port}/api`, lobby, closed };
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

describe('/api/events', () => {
	it('a draft pod makes its room at once, led by the organizer, and only they see it as theirs', async () => {
		const clock = { now: Date.UTC(2026, 9, 28, 12) };
		const { base, lobby } = await openApp(clock);
		const startsAt = new Date(clock.now + 2 * DAY).toISOString();
		const made = await call(base, 'alice', 'POST', '/events', { kind: 'draft-pod', title: 'Saturday cube', startsAt });
		expect(made.status).toBe(201);
		const event = EventViewSchema.parse(made.body);
		expect(event).toMatchObject({ kind: 'draft-pod', title: 'Saturday cube', startsAt, organizer: 'user-alice', mine: true });
		const room = lobby.get(event.roomId!);
		expect(room).toMatchObject({ name: 'Saturday cube', gameType: 'draft', scheduledFor: startsAt });
		expect(room?.members.map((m) => m.name)).toEqual(['user-alice']);

		const seen = EventListSchema.parse((await call(base, 'bob', 'GET', '/events')).body);
		expect(seen.events.map((e) => [e.title, e.mine])).toEqual([['Saturday cube', false]]);
	});

	it('a constructed tournament turns tournament mode on; a casual event makes no room', async () => {
		const clock = { now: Date.UTC(2026, 9, 28, 12) };
		const { base, lobby } = await openApp(clock);
		const startsAt = new Date(clock.now + DAY).toISOString();
		const t = EventViewSchema.parse((await call(base, 'alice', 'POST', '/events', { kind: 'constructed-tournament', title: 'Pauper cup', startsAt })).body);
		expect(lobby.get(t.roomId!)).toMatchObject({ gameType: 'constructed-1v1', settings: { tournament: true } });
		const c = EventViewSchema.parse((await call(base, 'alice', 'POST', '/events', { kind: 'casual', title: 'Come play', startsAt })).body);
		expect(c.roomId).toBeNull();
		expect(lobby.list()).toHaveLength(1);
	});

	it('a room event takes the Create room form’s own fields, named after the event', async () => {
		const clock = { now: Date.UTC(2026, 9, 28, 12) };
		const { base, lobby } = await openApp(clock);
		const startsAt = new Date(clock.now + DAY).toISOString();
		const made = await call(base, 'alice', 'POST', '/events', { kind: 'room', title: 'Locked 1v1', startsAt, room: { gameType: 'constructed-1v1', password: 'hunter22' } });
		expect(made.status).toBe(201);
		expect(lobby.get(EventViewSchema.parse(made.body).roomId!)).toMatchObject({ name: 'Locked 1v1', locked: true });
		const bad = await call(base, 'alice', 'POST', '/events', { kind: 'casual', title: 'x', startsAt, room: {} });
		expect(bad.status).toBe(400);
	});

	it('refuses a start in the past and an unknown kind', async () => {
		const clock = { now: Date.UTC(2026, 9, 28, 12) };
		const { base } = await openApp(clock);
		expect((await call(base, 'alice', 'POST', '/events', { kind: 'casual', title: 'Late', startsAt: new Date(clock.now - HOUR).toISOString() })).status).toBe(400);
		expect((await call(base, 'alice', 'POST', '/events', { kind: 'party', title: 'x', startsAt: new Date(clock.now + HOUR).toISOString() })).status).toBe(400);
	});

	it('lists soonest first and drops an event six hours after it starts', async () => {
		const clock = { now: Date.UTC(2026, 9, 28, 12) };
		const { base } = await openApp(clock);
		for (const [title, at] of [['Later', 3 * DAY], ['Sooner', DAY], ['Middle', 2 * DAY]] as const) {
			await call(base, 'alice', 'POST', '/events', { kind: 'casual', title, startsAt: new Date(clock.now + at).toISOString() });
		}
		const titles = async () => EventListSchema.parse((await call(base, 'bob', 'GET', '/events')).body).events.map((e) => e.title);
		expect(await titles()).toEqual(['Sooner', 'Middle', 'Later']);
		clock.now += DAY + 7 * HOUR;
		expect(await titles()).toEqual(['Middle', 'Later']);
	});

	it('the room is offered and kept until its event, however long nobody touches it', async () => {
		const clock = { now: Date.UTC(2026, 9, 28, 12) };
		const { base, lobby } = await openApp(clock);
		const event = EventViewSchema.parse((await call(base, 'alice', 'POST', '/events', { kind: 'draft-pod', title: 'Friday', startsAt: new Date(clock.now + 3 * DAY).toISOString() })).body);
		clock.now += 2 * DAY;
		expect(lobby.sweep()).toEqual([]);
		expect(lobby.offered().map((r) => r.id)).toEqual([event.roomId]);
		clock.now += DAY + lobbyMod.ROOM_STALE_MS + 1;
		expect(lobby.offered()).toEqual([]);
		clock.now += lobbyMod.ROOM_IDLE_MS;
		expect(lobby.sweep()).toEqual([event.roomId]);
	});

	it('only the organizer edits or cancels; a reschedule moves the room, a cancel closes it', async () => {
		const clock = { now: Date.UTC(2026, 9, 28, 12) };
		const { base, lobby, closed } = await openApp(clock);
		const event = EventViewSchema.parse((await call(base, 'alice', 'POST', '/events', { kind: 'draft-pod', title: 'Pod', startsAt: new Date(clock.now + DAY).toISOString() })).body);
		const later = new Date(clock.now + 2 * DAY).toISOString();

		expect((await call(base, 'bob', 'PATCH', `/events/${event.id}`, { startsAt: later })).status).toBe(403);
		expect((await call(base, 'bob', 'DELETE', `/events/${event.id}`)).status).toBe(403);
		expect((await call(base, 'alice', 'PATCH', '/events/e-nope', { title: 'x' })).status).toBe(404);
		expect((await call(base, 'alice', 'PATCH', `/events/${event.id}`, {})).status).toBe(400);

		const moved = await call(base, 'alice', 'PATCH', `/events/${event.id}`, { title: 'Pod night', startsAt: later });
		expect(EventViewSchema.parse(moved.body)).toMatchObject({ title: 'Pod night', startsAt: later });
		expect(lobby.get(event.roomId!)?.scheduledFor).toBe(later);

		expect((await call(base, 'alice', 'DELETE', `/events/${event.id}`)).status).toBe(200);
		expect(lobby.get(event.roomId!)).toBeUndefined();
		expect(closed).toEqual([event.roomId]);
		expect(EventListSchema.parse((await call(base, 'alice', 'GET', '/events')).body).events).toEqual([]);
	});

	it('an event whose room was closed reads back with no room', async () => {
		const clock = { now: Date.UTC(2026, 9, 28, 12) };
		const { base, lobby } = await openApp(clock);
		const event = EventViewSchema.parse((await call(base, 'alice', 'POST', '/events', { kind: 'draft-pod', title: 'Pod', startsAt: new Date(clock.now + DAY).toISOString() })).body);
		const alice = lobby.get(event.roomId!)!.leader;
		expect(lobby.close(event.roomId!, alice).ok).toBe(true);
		expect(EventListSchema.parse((await call(base, 'alice', 'GET', '/events')).body).events[0]?.roomId).toBeNull();
	});
});

describe('openEvents', () => {
	it('reads back what it wrote, and forgets an event a week after it started', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'cardtable-events-store-'));
		dirs.push(dir);
		const file = join(dir, 'events.json');
		const clock = { now: Date.UTC(2026, 9, 28, 12) };
		const first = await eventsStore.openEvents(file, () => {}, () => clock.now);
		first.create({ kind: 'casual', title: 'Soon', startsAt: clock.now + HOUR, organizerId: 'a', organizerName: 'Alice', roomId: null }, clock.now);
		first.create({ kind: 'casual', title: 'Old', startsAt: clock.now - 8 * DAY, organizerId: 'a', organizerName: 'Alice', roomId: null }, clock.now);
		// The write is the store's own; wait for the file to hold the one event it keeps.
		await vi.waitFor(async () => expect((JSON.parse(await readFile(file, 'utf8')) as unknown[]).length).toBe(1));
		const second = await eventsStore.openEvents(file, () => {}, () => clock.now);
		expect(second.upcoming(clock.now).map((e) => e.title)).toEqual(['Soon']);
		expect(second.upcoming(clock.now - 30 * DAY).map((e) => e.title)).toEqual(['Soon']);
	});
});
