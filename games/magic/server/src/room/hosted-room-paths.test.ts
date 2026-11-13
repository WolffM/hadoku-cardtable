/**
 * A room of a game Magic does not play, through every Magic path an any-room view reaches. Its view
 * has no tables, settings, locks or matchId (`RoomView`), and each of these readers goes through
 * `magicView` or reads the field as optional: none of them may throw on it, and none may find a table.
 */

import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerGameType, type ParticipantId } from '@hadoku/shared';
import { identityFromHeaders } from '@hadoku/game-server/room/identity';
import { playsIn } from '@hadoku/game-server/room/session';
import type { TablesLibrary } from '../http/library.ts';
import { seatsOf } from '../http/preview.ts';
import { attachTables, type TablesHandle } from '../http/routes.ts';
import { attachTableActions } from '../http/table-actions.ts';
import { tableGamesOf } from '../play/table-game.ts';
import { openLobby, type Lobby, type RoomView } from './lobby.ts';
import { magicView } from './magic-view.ts';
import { placeOfKey } from './serve.ts';

registerGameType({ id: 'hosted-paths-game', seats: { min: 1, max: 4 }, ready: false, series: { length: 1 }, canStart: () => ({ ok: true }) });

const EMPTY_LIBRARY: TablesLibrary = { formats: [], decks: [], faults: [], format: () => undefined, deck: () => undefined };

let dir: string;
let lobby: Lobby;
let me: ParticipantId;
let hosted: RoomView;
let magicRoomId: string;
let tables: TablesHandle;
let server: Server;
let base: string;

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), 'cardtable-hosted-paths-'));
	lobby = await openLobby({ dir });
	me = identityFromHeaders({ 'x-user-id': 'user-hosted-paths' }, 'http-hosted-paths');
	const made = lobby.create({ id: me, name: 'hosted-paths', userId: null }, { name: 'Not Magic', gameType: 'hosted-paths-game', clientMode: 'builtin' });
	if (!made.ok) throw new Error(made.reason);
	hosted = made.room;
	// A Magic room beside it, so a path that walks every room has one it should read.
	const magic = lobby.create({ id: me, name: 'hosted-paths', userId: null }, { name: 'Magic', gameType: 'constructed-1v1', clientMode: 'builtin' });
	if (!magic.ok) throw new Error(magic.reason);
	magicRoomId = magic.room.id;

	const app = express();
	const api = express.Router();
	api.use(express.json());
	tables = attachTables(api, { library: EMPTY_LIBRARY, draftRooms: null, rooms: lobby, log: () => {} });
	attachTableActions(api, {
		lobby,
		log: () => {},
		seriesEnded: () => {},
		callerOf: () => me,
		match: () => undefined,
	});
	app.use('/api', api);
	server = createServer(app);
	await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
	await new Promise<void>((done) => server.close(() => done()));
	await rm(dir, { recursive: true, force: true });
});

describe('a room of a game Magic does not play, through Magic’s readers', () => {
	it('has none of Magic’s fields, and magicView answers only for the Magic room', () => {
		const view = lobby.get(hosted.id)!;
		expect(view.tables).toBeUndefined();
		expect(view.settings).toBeUndefined();
		expect(view.locks).toBeUndefined();
		expect(view.matchId).toBeUndefined();
		expect(magicView(view)).toBeUndefined();
		expect(magicView(lobby.get(magicRoomId))?.tables).toHaveLength(1);
	});

	it('session: playsIn reads its game seats', () => {
		expect(playsIn(lobby.get(hosted.id)!, me)).toBe(true);
		expect(playsIn(lobby.get(hosted.id)!, 'fk:0000000000000000')).toBe(false);
	});

	it('the table card: tableGames answers none', () => {
		expect(tableGamesOf(lobby.get(hosted.id)!, () => undefined, () => ({}))).toEqual({});
	});

	it('boot: releaseGoneMatches walks past it', () => {
		expect(() => tables.releaseGoneMatches()).not.toThrow();
	});

	it('the link preview: the host and no other seat', () => {
		expect(seatsOf(lobby.get(hosted.id)!)).toEqual({ host: me, other: null });
	});

	it('serve: its key is the room, and nothing after it is a table', () => {
		expect(placeOfKey(lobby, () => false, `cardtable-${hosted.id}`)).toEqual({ served: hosted.id, roomId: hosted.id, kind: 'room' });
		expect(placeOfKey(lobby, () => false, `cardtable-${hosted.id}-t-anything`)).toBeNull();
	});

	it('a table’s concede: no room here', async () => {
		const res = await fetch(`${base}/api/rooms/${hosted.id}/tables/t-anything/concede`, { method: 'POST' });
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: 'no such room' });
	});

	it('a table route (tableFor): no room here', async () => {
		const res = await fetch(`${base}/api/tables/rooms/${hosted.id}`, { headers: { 'x-user-id': 'user-hosted-paths' } });
		expect(res.status).toBe(404);
	});
});
