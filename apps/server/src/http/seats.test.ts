/**
 * Who sits at a table and who is ready, through the real lobby: every seat and
 * ready route (`/sit`, `/stand`, `PUT /deck`, `/ready`, `/gauntlet/ready`),
 * the rules the operator ruled on 2026-10-12 (an explicit sit and a deck that
 * seats you, nobody stands anybody else up, a watcher with no seat, the AI
 * for one seated human), the mode lock once a seat is ready, and a restart.
 *
 * `tables.test.ts` drives the same routes over a stand-in lobby; this file is
 * the one that holds them to `room/lobby.ts`'s own store.
 */

import express from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { identityFromHeaders } from '../room/identity.js';
import { openLobby, type Lobby } from '../room/lobby.js';
import { loadTablesLibrary } from './library.js';
import { attachTables } from './routes.js';

// @reads decks/
const library = loadTablesLibrary(resolve(dirname(fileURLToPath(import.meta.url)), '../../../..'));
const ERA = '2010-07-16';
const DECK = { deck: { library: 'power-2010-3-antoine-ruel-ug-polymorph' } };
const OTHER = { deck: { library: 'power-2010-1-emanuele-giusti-jund' } };

const headers = (user: string): Record<string, string> => ({ 'x-user-id': `user-${user}`, 'x-user-key': `friend-key-${user}` });
const person = (user: string) => ({ id: identityFromHeaders(headers(user), 'unused'), name: user });
const ALICE = person('alice');
const BOB = person('bob');
const CAROL = person('carol');

interface Stack {
	dir: string;
	lobby: Lobby;
	roomId: string;
	call: (user: string, method: string, path: string, body?: unknown) => Promise<{ status: number; body: Record<string, unknown> }>;
	close: () => Promise<void>;
}

const open: Stack[] = [];
const dirs: string[] = [];
afterEach(async () => {
	for (const s of open.splice(0)) await s.close();
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** The tables routes over a lobby on `dir`; a new room with Alice, Bob and Carol unless `roomId` names one already there. */
async function boot(dir?: string, roomId?: string): Promise<Stack> {
	const at = dir ?? (await mkdtemp(join(tmpdir(), 'cardtable-seats-test-')));
	if (dir === undefined) dirs.push(at);
	const lobby = await openLobby({ dir: at, defaultFormat: ERA, formats: library.formats });
	let id = roomId;
	if (id === undefined) {
		const made = lobby.create(ALICE, { name: 'seats', gameType: 'constructed-1v1', clientMode: 'builtin' });
		if (!made.ok) throw new Error('create failed');
		id = made.room.id;
		lobby.join(id, BOB);
		lobby.join(id, CAROL);
		expect(lobby.setMode(id, ALICE.id, { mode: 'classic', modeOptions: {} }).ok).toBe(true);
	}
	const api = express.Router();
	api.use(express.json());
	attachTables(api, { library, draftRooms: null, log: () => undefined, rooms: lobby, schedule: () => undefined, random: () => 0.25 });
	const app = express();
	app.use('/api', api);
	const server: Server = createServer(app);
	await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/tables/rooms/${id}`;
	const stack: Stack = {
		dir: at,
		lobby,
		roomId: id,
		async call(user, method, path, body) {
			const res = await fetch(`${url}${path}`, {
				method,
				headers: { ...headers(user), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
			return { status: res.status, body: (await res.json()) as Record<string, unknown> };
		},
		close: () => new Promise<void>((done) => server.close(() => done())),
	};
	open.push(stack);
	return stack;
}

/** The table as `user` reads it: each seat's name and ready flag, in seat order, and whether it is locked. */
async function seats(s: Stack, user = 'carol', table?: string): Promise<{ players: [string, boolean][]; locked: boolean }> {
	const res = await s.call(user, 'GET', table === undefined ? '' : `?table=${table}`);
	expect(res.status).toBe(200);
	const players = (res.body.players as { name: string; ready: boolean }[]).map((p): [string, boolean] => [p.name, p.ready]);
	return { players, locked: (res.body.room as { locked: boolean }).locked };
}

/** The room's own view of who sits at each table. */
const roomSeats = (s: Stack): string[][] => s.lobby.get(s.roomId)!.tables.map((t) => t.players.map((p) => p.name));

describe('a constructed table', () => {
	it('seats by sitting or by loading a deck, two at most, in the order people sat', async () => {
		const s = await boot();
		expect((await s.call('bob', 'POST', '/sit', {})).status).toBe(200);
		expect((await s.call('alice', 'PUT', '/deck', DECK)).status).toBe(200);
		expect(await seats(s)).toEqual({ players: [['bob', false], ['alice', false]], locked: false });
		expect(roomSeats(s)).toEqual([['bob', 'alice']]);
		expect(await s.call('carol', 'POST', '/sit', {})).toMatchObject({ status: 409, body: { error: 'this table already has two players' } });
		expect(await s.call('carol', 'PUT', '/deck', DECK)).toMatchObject({ status: 409, body: { error: 'this table already has two players' } });
		// Sitting again is a no-op, not a second seat.
		expect((await s.call('bob', 'POST', '/sit', {})).status).toBe(200);
		expect(roomSeats(s)).toEqual([['bob', 'alice']]);
	});

	it('readies a seat that holds a legal deck, and nobody else', async () => {
		const s = await boot();
		expect(await s.call('carol', 'POST', '/ready', { ready: true })).toMatchObject({ status: 409, body: { error: 'load a deck before you ready up' } });
		await s.call('alice', 'POST', '/sit', {});
		expect(await s.call('alice', 'POST', '/ready', { ready: true })).toMatchObject({ status: 409, body: { error: 'load a deck before you ready up' } });
		expect((await s.call('alice', 'POST', '/ready', { ready: 'yes' })).status).toBe(400);
		await s.call('alice', 'PUT', '/deck', DECK);
		expect((await s.call('alice', 'POST', '/ready', { ready: true })).status).toBe(200);
		expect(await seats(s)).toEqual({ players: [['alice', true]], locked: false });
		// A new deck is not the deck you readied with.
		await s.call('alice', 'PUT', '/deck', OTHER);
		expect(await seats(s)).toEqual({ players: [['alice', false]], locked: false });
	});

	it('locks both seats once both are ready: nobody stands, and the mode cannot change', async () => {
		const s = await boot();
		await s.call('alice', 'PUT', '/deck', DECK);
		await s.call('bob', 'PUT', '/deck', OTHER);
		await s.call('alice', 'POST', '/ready', { ready: true });
		// One seat ready already freezes the mode.
		expect(s.lobby.setMode(s.roomId, ALICE.id, { mode: 'gauntlet', modeOptions: {} })).toEqual({ ok: false, reason: 'mode-locked' });
		await s.call('bob', 'POST', '/ready', { ready: true });
		expect(await seats(s)).toEqual({ players: [['alice', true], ['bob', true]], locked: true });
		expect(await s.call('alice', 'POST', '/stand', {})).toMatchObject({ status: 409, body: { error: 'both players are ready — the table is locked' } });
		await s.call('bob', 'POST', '/ready', { ready: false });
		await s.call('alice', 'POST', '/ready', { ready: false });
		expect(s.lobby.setMode(s.roomId, ALICE.id, { mode: 'gauntlet', modeOptions: {} }).ok).toBe(true);
	});

	it('gives a seat back only to its holder, and the next player moves up', async () => {
		const s = await boot();
		await s.call('alice', 'PUT', '/deck', DECK);
		await s.call('bob', 'PUT', '/deck', OTHER);
		await s.call('bob', 'POST', '/ready', { ready: true });
		// Carol holds no seat: standing is a no-op for her and does not touch anybody else's.
		expect((await s.call('carol', 'POST', '/stand', {})).status).toBe(200);
		expect((await s.call('alice', 'POST', '/stand', {})).status).toBe(200);
		expect(await seats(s)).toEqual({ players: [['bob', true]], locked: false });
		expect(roomSeats(s)).toEqual([['bob']]);
		const mine = await s.call('alice', 'GET', '');
		expect(mine.body.you).toMatchObject({ player: false });
		// Sitting down again takes the free seat with no deck.
		await s.call('alice', 'POST', '/sit', {});
		const back = await s.call('alice', 'GET', '');
		expect((back.body.players as { name: string; deck?: unknown }[]).map((p) => [p.name, p.deck])).toEqual([
			['bob', undefined],
			['alice', null],
		]);
	});

	it('moves a player who sits at another table, deck and ready left behind', async () => {
		const s = await boot();
		const second = s.lobby.addTable(s.roomId, ALICE.id);
		if (!second.ok) throw new Error('addTable failed');
		await s.call('alice', 'PUT', '/deck', DECK);
		await s.call('alice', 'POST', '/ready', { ready: true });
		await s.call('alice', 'POST', '/sit', { table: second.table.id });
		expect(await seats(s, 'alice')).toEqual({ players: [], locked: false });
		expect(await seats(s, 'alice', second.table.id)).toEqual({ players: [['alice', false]], locked: false });
		const at = await s.call('alice', 'GET', `?table=${second.table.id}`);
		expect((at.body.players as { deck: unknown }[])[0]!.deck).toBeNull();
	});

	it("keeps the room's own seats in step without a table read", async () => {
		const s = await boot();
		const second = s.lobby.addTable(s.roomId, ALICE.id);
		if (!second.ok) throw new Error('addTable failed');
		await s.call('alice', 'POST', '/sit', {});
		await s.call('bob', 'POST', '/sit', {});
		await s.call('alice', 'POST', '/sit', { table: second.table.id });
		expect(roomSeats(s)).toEqual([['bob'], ['alice']]);
		s.lobby.leave(s.roomId, BOB.id);
		expect(roomSeats(s)).toEqual([[], ['alice']]);
	});

	it('empties the seats when the pool changes, and when a member leaves', async () => {
		const s = await boot();
		await s.call('alice', 'PUT', '/deck', DECK);
		await s.call('bob', 'PUT', '/deck', OTHER);
		s.lobby.leave(s.roomId, BOB.id);
		expect(await seats(s, 'alice')).toEqual({ players: [['alice', false]], locked: false });
		expect(roomSeats(s)).toEqual([['alice']]);
		expect(s.lobby.setFormat(s.roomId, ALICE.id, '2011-07-15').ok).toBe(true);
		expect(await seats(s, 'alice')).toEqual({ players: [], locked: false });
		expect(roomSeats(s)).toEqual([[]]);
	});

	it('comes back from a restart with its seats, their order and their Readys', async () => {
		const s = await boot();
		await s.call('bob', 'PUT', '/deck', OTHER);
		await s.call('alice', 'PUT', '/deck', DECK);
		await s.call('alice', 'POST', '/ready', { ready: true });
		await s.close();
		open.splice(open.indexOf(s), 1);
		const after = await boot(s.dir, s.roomId);
		expect(roomSeats(after)).toEqual([['bob', 'alice']]);
		expect(await seats(after)).toEqual({ players: [['bob', false], ['alice', true]], locked: false });
		expect(after.lobby.setMode(after.roomId, ALICE.id, { mode: 'gauntlet', modeOptions: {} })).toEqual({ ok: false, reason: 'mode-locked' });
	});
});

describe('a Gauntlet table', () => {
	async function gauntlet(): Promise<Stack> {
		const s = await boot();
		expect(s.lobby.setMode(s.roomId, ALICE.id, { mode: 'gauntlet', modeOptions: { family: 'modern' } }).ok).toBe(true);
		return s;
	}

	it('readies a seated player, and only one', async () => {
		const s = await gauntlet();
		expect(await s.call('alice', 'POST', '/gauntlet/ready', { ready: true })).toMatchObject({ status: 409, body: { error: 'sit at the table before you ready up' } });
		await s.call('alice', 'POST', '/sit', {});
		await s.call('bob', 'POST', '/sit', {});
		expect((await s.call('alice', 'POST', '/gauntlet/ready', { ready: 1 })).status).toBe(400);
		const readied = await s.call('alice', 'POST', '/gauntlet/ready', { ready: true });
		expect(readied.status).toBe(200);
		expect(readied.body).toMatchObject({ phase: 'options', you: 0, ready: [true, false] });
		expect((await s.call('carol', 'GET', '/gauntlet')).body).toMatchObject({ you: null, ready: [true, false] });
		expect(s.lobby.setMode(s.roomId, ALICE.id, { mode: 'classic', modeOptions: {} })).toEqual({ ok: false, reason: 'mode-locked' });
		expect((await s.call('alice', 'POST', '/gauntlet/ready', { ready: false })).body).toMatchObject({ ready: [false, false] });
		expect(s.lobby.setMode(s.roomId, ALICE.id, { mode: 'classic', modeOptions: {} }).ok).toBe(true);
	});

	it('leaves a Ready with the player who stands, not with the seat', async () => {
		const s = await gauntlet();
		await s.call('alice', 'POST', '/sit', {});
		await s.call('bob', 'POST', '/sit', {});
		await s.call('bob', 'POST', '/gauntlet/ready', { ready: true });
		expect((await s.call('bob', 'POST', '/stand', {})).status).toBe(200);
		await s.call('carol', 'POST', '/sit', {});
		expect((await s.call('carol', 'GET', '/gauntlet')).body).toMatchObject({ you: 1, ready: [false, false] });
		expect((await s.call('alice', 'POST', '/gauntlet/ready', { ready: true })).body).toMatchObject({ phase: 'options' });
	});

	it('draws once both seats are ready, and holds the table from there', async () => {
		const s = await gauntlet();
		await s.call('alice', 'POST', '/sit', {});
		await s.call('bob', 'POST', '/sit', {});
		await s.call('bob', 'POST', '/gauntlet/ready', { ready: true });
		const drawn = await s.call('alice', 'POST', '/gauntlet/ready', { ready: true });
		expect(drawn.body).toMatchObject({ phase: 'reveal', you: 0 });
		expect((drawn.body.players as { name: string }[]).map((p) => p.name)).toEqual(['alice', 'bob']);
		expect((await seats(s)).locked).toBe(true);
		expect(await s.call('carol', 'POST', '/sit', {})).toMatchObject({ status: 409 });
		expect(await s.call('alice', 'POST', '/gauntlet/ready', { ready: false })).toMatchObject({ status: 409, body: { reason: 'drawn' } });
	});

	it('plays the AI for one seated human, and refuses it with two', async () => {
		const s = await gauntlet();
		await s.call('alice', 'POST', '/sit', {});
		await s.call('bob', 'POST', '/sit', {});
		expect(await s.call('alice', 'POST', '/gauntlet/ready', { ready: true, ai: true })).toMatchObject({ status: 409, body: { error: 'the AI plays a table with one seated player' } });
		await s.call('bob', 'POST', '/stand', {});
		const drawn = await s.call('alice', 'POST', '/gauntlet/ready', { ready: true, ai: true });
		expect(drawn.body).toMatchObject({ phase: 'reveal' });
		expect((drawn.body.players as { memberId: string | null }[]).map((p) => p.memberId)).toEqual([ALICE.id, null]);
	});
});
