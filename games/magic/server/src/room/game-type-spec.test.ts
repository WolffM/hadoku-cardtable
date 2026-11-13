/**
 * Proves the `GameTypeSpec` registry (`@hadoku/shared`'s `game-type-spec.ts`)
 * actually opens the lobby to a game Magic never wrote: register a
 * bomberman-shaped spec — up to 10 seats, its own bots, no ready step,
 * started on a countdown — and run it through the SAME lobby mechanics a
 * Magic room already uses (`sitPod`/`aiPod`), with no change to `lobby.ts`
 * beyond registering a spec.
 *
 * `sitPod(..., 7)` is the load-bearing line: a seat index a plain two-seat
 * table could never hold. It only reaches the pod's own (already N-seat)
 * array because `usesPod` (`lobby.ts`) asks this room's OWN spec whether it
 * plays with more than a table's two seats, rather than asking only "is
 * this Magic's own `draft`". Reverting that one line to a Magic-only
 * condition is the hard two-seat cap a mutation test should reintroduce:
 * with it back, this file's seat-7 assertion refuses with `not-draft` and
 * the test goes red; restoring `lobby.ts` turns it green again.
 */

import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, describe, expect, it } from 'vitest';
import { registerGameType, type GameTypeSpec } from '@hadoku/shared';
import type { TablesLibrary } from '../http/library.ts';
import { attachTables } from '../http/routes.ts';
import { identityFromHeaders } from '@hadoku/game-server/room/identity';
import { openLobby, type Lobby } from './lobby.ts';

/** This game's own bot marker — opaque to the registry, which never reads it; only this spec's own `bots.fill` and the test assign it meaning. */
const BOMBERMAN_BOT = 'bomberman-bot';

/**
 * A game Magic never wrote: a free-for-all of 1 to 10, no 1v1 pairing, no
 * ready step (it starts on its own countdown instead), one game per
 * "series", and a trivial bot-fill — every field a `GameTypeSpec` asks a
 * STATIC game type for, with no server instance or runtime service behind
 * any of it (unlike Magic's own `GameHooks`, which `lobby.ts` wires in per
 * game type through `Lobby.useGameType`).
 */
const BOMBERMAN: GameTypeSpec = {
	id: 'bomberman',
	seats: { min: 1, max: 10 },
	ready: false,
	bots: { fill: (seats) => seats.map((s) => s ?? BOMBERMAN_BOT) },
	series: { length: 1 },
	canStart: (seated) => (seated >= 1 ? { ok: true } : { ok: false, reason: 'not-enough-players' }),
};
registerGameType(BOMBERMAN);

const ALICE = { id: 'fk:aaaaaaaaaaaaaaaa', name: 'user-alice', userId: 'uid-user-alice' };
const BOB = { id: 'fk:bbbbbbbbbbbbbbbb', name: 'user-bob', userId: 'uid-user-bob' };

const dirs: string[] = [];
async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'cardtable-gametype-test-'));
	dirs.push(dir);
	return dir;
}
afterAll(async () => {
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

describe('a registered game type Magic never wrote', () => {
	it('opens, seats at an index no 1v1 table could ever hold, fills its own open seats with its own bot, and answers its own canStart', async () => {
		const lobby: Lobby = await openLobby({ dir: await tempDir() });

		// open — no `GAME_TYPES` entry for 'bomberman', and no code change: the room registry asks
		// the spec registry, not a closed enum (`room-modes.ts`'s `GameTypeSchema`).
		const made = lobby.create(ALICE, { name: 'Bomberman match', gameType: BOMBERMAN.id, clientMode: 'builtin' });
		expect(made.ok).toBe(true);
		if (!made.ok) throw new Error(made.reason);
		const roomId = made.room.id;
		expect(made.room.gameType).toBe('bomberman');

		// seat 7 — past index 1, which is as far as a plain 1v1 table ever reaches.
		expect(lobby.sitPod(roomId, ALICE.id, 7).ok).toBe(true);
		expect(lobby.get(roomId)?.game.pod?.seats[7]?.memberId).toBe(ALICE.id);

		// fill bots — this game's OWN spec decides the marker; the lobby only ever sees a member id string.
		const seated = lobby.get(roomId)!.game.pod!.seats.map((s) => s?.memberId ?? null);
		const filled = BOMBERMAN.bots!.fill(seated);
		filled.forEach((occupant, seat) => {
			if (occupant === BOMBERMAN_BOT && seated[seat] === null) expect(lobby.aiPod(roomId, ALICE.id, seat, true).ok).toBe(true);
		});
		const afterFill = lobby.get(roomId)!.game.pod!.seats;
		const filledCount = afterFill.filter((s) => s !== null).length;
		expect(filledCount).toBeGreaterThan(1);
		expect(filledCount).toBeLessThanOrEqual(BOMBERMAN.seats.max);

		// start — this game's own seat-count verdict, with no Magic-specific gate (deck legality,
		// a draft's own completion, …) anywhere on its path.
		expect(BOMBERMAN.canStart(filledCount)).toEqual({ ok: true });
		expect(BOMBERMAN.canStart(0)).toEqual({ ok: false, reason: 'not-enough-players' });
	});

	it('an unregistered game type still quarantines on restore, exactly as a type outside the old closed enum always did', async () => {
		const dir = await tempDir();
		const lobby = await openLobby({ dir });
		const made = lobby.create(ALICE, { name: 'Unknown game', gameType: 'some-game-nobody-registered', clientMode: 'builtin' });
		expect(made.ok).toBe(true);
		const reopened = await openLobby({ dir });
		expect(reopened.get(made.ok ? made.room.id : '')).toBeUndefined();
	});

	it('a type of fewer than eight seats survives a restart, its pod read back at its own size', async () => {
		// `initialPodSize` opens a small type's pod at its own `seats.max`; the codec reads that
		// pod back against the same type's range, not Magic's eight.
		registerGameType({ id: 'four-seat', seats: { min: 2, max: 4 }, ready: false, series: { length: 1 }, canStart: () => ({ ok: true }) });
		const dir = await tempDir();
		const lobby = await openLobby({ dir });
		const made = lobby.create(ALICE, { name: 'Four of us', gameType: 'four-seat', clientMode: 'builtin' });
		if (!made.ok) throw new Error(made.reason);
		expect(lobby.join(made.room.id, BOB).ok).toBe(true);
		const seats = lobby.get(made.room.id)?.game.pod?.seats.map((s) => s?.memberId ?? null);
		expect(seats).toEqual([ALICE.id, BOB.id, null, null]);

		const logged: Record<string, unknown>[] = [];
		const reopened = await openLobby({ dir, log: (entry) => logged.push(entry) });
		expect(logged.filter((e) => e.event === 'room-quarantined')).toEqual([]);
		expect(reopened.get(made.room.id)?.gameType).toBe('four-seat');
		expect(reopened.get(made.room.id)?.game.pod?.seats.map((s) => s?.memberId ?? null)).toEqual(seats);
	});

	it('seats 10, and refuses an 11th', async () => {
		const lobby: Lobby = await openLobby({ dir: await tempDir() });
		const made = lobby.create(ALICE, { name: 'Bomberman match', gameType: BOMBERMAN.id, clientMode: 'builtin' });
		expect(made.ok).toBe(true);
		if (!made.ok) throw new Error(made.reason);
		const roomId = made.room.id;

		// Alice auto-seats at 0 on create; nine bots fill the rest of this game's own ceiling.
		for (let seat = 1; seat < 10; seat++) expect(lobby.aiPod(roomId, ALICE.id, seat, true).ok, `seat ${seat}`).toBe(true);
		expect(lobby.get(roomId)?.game.pod?.seats.filter((s) => s !== null)).toHaveLength(10);

		// An 11th, by an explicit seat index past the ceiling (`seatInReach`/`podSeatCeiling`, `lobby.ts`) …
		expect(lobby.aiPod(roomId, ALICE.id, 10, true)).toEqual({ ok: false, reason: 'bad-seat' });
		// … and by the auto-pick path, with every seat already full (`sitPod`'s own `pod-full`).
		expect(lobby.join(roomId, BOB).ok).toBe(true);
		expect(lobby.sitPod(roomId, BOB.id)).toEqual({ ok: false, reason: 'pod-full' });
	});
});

/** Answers nothing for any format or deck — the table-view route this describe drives reads neither. */
const EMPTY_LIBRARY: TablesLibrary = { formats: [], decks: [], faults: [], format: () => undefined, deck: () => undefined };

describe('a registered game type Magic never wrote, over a real table route', () => {
	it("GET /api/tables/rooms/:roomId answers the room's OWN spec's seats, not a hard two — and that many seats are reachable", async () => {
		const lobby: Lobby = await openLobby({ dir: await tempDir() });
		const me = identityFromHeaders({ 'x-user-id': 'user-bomberman-table' }, 'http-bomberman-table');
		const made = lobby.create({ id: me, name: 'bomberman-table', userId: null }, { name: 'Bomberman table', gameType: BOMBERMAN.id, clientMode: 'builtin' });
		expect(made.ok).toBe(true);
		if (!made.ok) throw new Error(made.reason);

		// seat 7 — reachable because this room's own pod ceiling is `BOMBERMAN.seats.max` (10), not a table's two.
		expect(lobby.sitPod(made.room.id, me, 7).ok).toBe(true);

		const app = express();
		const api = express.Router();
		attachTables(api, { library: EMPTY_LIBRARY, draftRooms: null, rooms: lobby, log: () => {} });
		app.use('/api', api);
		const server: Server = createServer(app);
		await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
		try {
			const port = (server.address() as AddressInfo).port;
			const res = await fetch(`http://127.0.0.1:${port}/api/tables/rooms/${made.room.id}`, { headers: { 'x-user-id': 'user-bomberman-table' } });
			expect(res.status).toBe(200);
			const body = (await res.json()) as { room: { seats: number } };
			// The load-bearing number: a plain constructed/draft table answers 2 here (Forge's own
			// match size, `table.seats`) — bomberman has no `table` field, so its whole room is one
			// table of its own `seats.max` (`tableSeatCount`, `http/routes.ts`).
			expect(body.room.seats).toBe(BOMBERMAN.seats.max);
		} finally {
			await new Promise<void>((done) => server.close(() => done()));
		}
	});
});
