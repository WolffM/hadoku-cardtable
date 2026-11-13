/**
 * The generic room record against real rooms (`docs/planning/room-record-generic.md`).
 * `fixtures/codec-v2/` holds rooms as the build before it wrote them (app version 2, Magic's
 * fields under `game` but `settings`, `tables` and `matches` at the top and the seats in
 * `game.podSeats`): three copied from prod's state dir (a constructed tournament with a scenario,
 * a draft pod's lobby, a finished Gauntlet tournament) with the one account and participant id
 * replaced by fakes and every room name by a placeholder, and one bomberman room that build wrote.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeSnapshot, FileRoomStore, type RoomSnapshot } from '@wolffm/rooms-server/store';
import { BOMBERMAN_GAME_TYPE_SPEC, registerGameType } from '@hadoku/shared';

import { openLobby } from './lobby.ts';
import { roomCodec, type StoredApp } from './lobby-codec.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'codec-v2');
const fixtures = readdirSync(FIXTURES)
	.filter((f) => f.endsWith('.json'))
	.sort()
	.map((file) => ({ file, snapshot: JSON.parse(readFileSync(join(FIXTURES, file), 'utf8')) as RoomSnapshot }));

type Raw = Record<string, unknown> & { game: Record<string, unknown> };
const ctx = (roomId: string) => ({ roomId, restoreId: 'test', restoredAt: 0 });
const decode = (snapshot: RoomSnapshot): StoredApp => decodeSnapshot(snapshot, roomCodec, ctx(snapshot.roomId)).app as StoredApp;
/** `snapshot` re-encoded as this build writes it. */
const rewritten = (snapshot: RoomSnapshot): RoomSnapshot => ({ ...snapshot, app: roomCodec.app.serialize(decode(snapshot)) });
/** What a build before the generic room record reads of `app`: the new fields gone, the rollback copies left. */
function oldShapeOf(app: unknown): Raw {
	const { seats: _seats, ...rest } = app as Raw;
	const { settings: _s, tables: _t, matches: _m, ...game } = rest.game;
	return { ...rest, game };
}

const dirs: string[] = [];
async function restore(snapshots: readonly RoomSnapshot[]) {
	const dir = await mkdtemp(join(tmpdir(), 'cardtable-codec-generic-'));
	dirs.push(dir);
	const store = new FileRoomStore(dir);
	for (const s of snapshots) store.saveSync(s);
	const events: Record<string, unknown>[] = [];
	const lobby = await openLobby({ dir, log: (e) => events.push(e), defaultFormat: 'fixed-format', now: () => 1_800_000_000_000 });
	expect(events.filter((e) => e.event === 'room-quarantined')).toEqual([]);
	return lobby;
}
beforeAll(() => registerGameType(BOMBERMAN_GAME_TYPE_SPEC));
afterAll(async () => {
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

describe('the generic room record reads rooms the build before it wrote', () => {
	it('has a constructed room, a draft pod, a Gauntlet tournament and a bomberman room, all in the old shape', () => {
		const apps = fixtures.map(({ snapshot }) => snapshot.app as Raw);
		expect(apps.map((a) => a.gameType).sort()).toEqual(['bomberman', 'constructed-1v1', 'constructed-1v1', 'draft']);
		expect(apps.some((a) => a.game.mode === 'gauntlet' && (a.settings as { tournament: boolean }).tournament)).toBe(true);
		expect(apps.every((a) => a.seats === undefined && Array.isArray(a.game.podSeats) && a.tables !== undefined && a.game.tables === undefined)).toBe(true);
	});

	// A room of a game Magic does not play is hosted on the platform's plain room type: no `game` of its own.
	describe.each(fixtures.filter((f) => f.file !== 'bomberman.json'))('$file', ({ snapshot }) => {
		const raw = snapshot.app as Raw;

		it("decodes the old shape: the seats from game.podSeats, Magic's settings, tables and matches under game", () => {
			const app = decode(snapshot);
			expect(app.seats).toEqual(raw.game.podSeats);
			expect(app.game.settings).toMatchObject(raw.settings as object);
			expect(app.game.tables.map((t) => t.id)).toEqual((raw.tables as { id: string }[]).map((t) => t.id));
			expect(app.game.matches).toEqual(raw.matches);
			expect(Object.keys(app)).not.toContain('settings');
			expect(Object.keys(app.game)).not.toContain('podSeats');
		});

		it('writes the new shape with the rollback copies beside it, in step', () => {
			const written = rewritten(snapshot).app as Raw;
			expect(written.seats).toEqual(raw.game.podSeats);
			expect(written.game.podSeats).toEqual(written.seats);
			expect(written.settings).toEqual(written.game.settings);
			expect(written.tables).toEqual(written.game.tables);
			expect(written.matches).toEqual(written.game.matches);
			expect(written.matchId).toBe((written.game.tables as { matchId: string | null }[])[0]!.matchId);
		});
	});

	it('decodes a bomberman room of the old shape to its seats and no game of its own, and writes the seats where a rollback reads them', () => {
		const { snapshot } = fixtures.find((f) => f.file === 'bomberman.json')!;
		const raw = snapshot.app as Raw;
		const app = decode(snapshot) as unknown as Raw;
		expect(app.seats).toEqual(raw.game.podSeats);
		expect(app.game).toEqual({});
		const written = rewritten(snapshot).app as Raw;
		expect(written.seats).toEqual(raw.game.podSeats);
		expect(written.game).toEqual({ podSeats: written.seats });
	});

	describe.each(fixtures)('$file', ({ snapshot }) => {
		it('decodes the same room from the new shape, and from the new shape read the old way (a rollback)', () => {
			const first = decode(snapshot);
			const again = rewritten(snapshot);
			expect(decode(again)).toEqual(first);
			expect(decode({ ...again, app: oldShapeOf(again.app) })).toEqual(first);
		});

		it('restores the same room from the old file, the new one, and the new one read the old way', async () => {
			const again = rewritten(snapshot);
			const fromOld = await restore([snapshot]);
			const fromNew = await restore([again]);
			const fromRollback = await restore([{ ...again, app: oldShapeOf(again.app) }]);
			const view = fromOld.get(snapshot.roomId);
			expect(view).toBeDefined();
			expect(fromNew.get(snapshot.roomId)).toEqual(view);
			expect(fromRollback.get(snapshot.roomId)).toEqual(view);
		});
	});

	it('reads the new place when a record holds both', () => {
		const { snapshot } = fixtures.find((f) => f.file === 'draft-pod-lobby.json')!;
		const written = rewritten(snapshot).app as Raw;
		const seats = (written.seats as (string | null)[]).map((_, i) => (i === 0 ? 'ai' : null));
		const both = { ...written, seats, settings: { ...(written.settings as object), handSmoothing: false } };
		const app = decode({ ...snapshot, app: { ...both, game: { ...written.game, settings: { ...(written.game.settings as object), handSmoothing: true } } } });
		expect(app.seats).toEqual(seats);
		expect(app.game.settings.handSmoothing).toBe(true);
	});

	it("seats a restored bomberman room through the platform's game seats", async () => {
		const { snapshot } = fixtures.find((f) => f.file === 'bomberman.json')!;
		const podSeats = (snapshot.app as Raw).game.podSeats as (string | null)[];
		const lobby = await restore([snapshot]);
		const [alice, bob] = podSeats as [string, string];
		const carol = snapshot.members.map((m) => m.participantId).find((id) => !podSeats.includes(id))!;
		expect(lobby.gameSeatOf(snapshot.roomId, alice)).toBe(0);
		expect(lobby.gameSeatOf(snapshot.roomId, bob)).toBe(1);
		// The member who stood is watching; the AI's seat is nobody's.
		expect(lobby.gameSeatOf(snapshot.roomId, carol)).toBeNull();
		expect(lobby.get(snapshot.roomId)!.seats).toEqual(podSeats.map((s) => (s === 'ai' ? null : s)));
		// Sitting takes the platform's first open seat.
		expect(lobby.sitSeat(snapshot.roomId, carol).ok).toBe(true);
		expect(lobby.gameSeatOf(snapshot.roomId, carol)).toBe(2);
	});
});
