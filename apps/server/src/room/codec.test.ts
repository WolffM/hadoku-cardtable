/**
 * The saved-room codec against real rooms. `fixtures/codec-v1/` holds rooms
 * copied from the prod and PPE state dirs as app version 1 wrote them, with
 * every account and participant id replaced by a stable fake, every room name
 * by a placeholder, and the timestamps kept.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { decodeSnapshot, FileRoomStore, type RoomSnapshot } from '@hadoku/room-store';
import { MAGIC_ROOM_STORED_KEYS } from '@hadoku/shared';

import { openLobby, roomCodec } from './lobby.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'codec-v1');
const fixtures = readdirSync(FIXTURES)
	.filter((f) => f.endsWith('.json'))
	.sort()
	.map((file) => ({ file, snapshot: JSON.parse(readFileSync(join(FIXTURES, file), 'utf8')) as RoomSnapshot }));

const ctx = (roomId: string) => ({ roomId, restoreId: 'test', restoredAt: 0 });
const isMagicKey = (k: string): boolean => (MAGIC_ROOM_STORED_KEYS as readonly string[]).includes(k);

const dirs: string[] = [];
async function storeOf(snapshots: readonly RoomSnapshot[]): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'cardtable-codec-test-'));
	dirs.push(dir);
	const store = new FileRoomStore(dir);
	for (const s of snapshots) store.saveSync(s);
	return dir;
}
afterAll(async () => {
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

/** `snapshot` re-encoded as this build writes it: app version 2. */
function asV2(snapshot: RoomSnapshot): RoomSnapshot {
	const { app } = decodeSnapshot(snapshot, roomCodec, ctx(snapshot.roomId));
	return { ...snapshot, app: roomCodec.app.serialize(app), appVersion: roomCodec.app.version };
}

async function restore(snapshots: readonly RoomSnapshot[]) {
	const events: Record<string, unknown>[] = [];
	const lobby = await openLobby({ dir: await storeOf(snapshots), log: (e) => events.push(e), defaultFormat: 'fixed-format' });
	return { lobby, events };
}

describe('app codec v2 reads v1 rooms from disk', () => {
	it('has a fixture for every game type and mode, a pod, a tournament and a scenario', () => {
		const apps = fixtures.map(({ snapshot }) => snapshot.app as Record<string, unknown>);
		expect(fixtures.every(({ snapshot }) => snapshot.appVersion === 1)).toBe(true);
		expect(new Set(apps.map((a) => `${String(a.gameType)}/${String(a.mode)}`))).toEqual(new Set(['draft/null', 'constructed-1v1/classic', 'constructed-1v1/gauntlet']));
		expect(apps.some((a) => a.pod !== null && a.gameType === 'draft')).toBe(true);
		expect(apps.some((a) => a.pod !== null && a.gameType === 'constructed-1v1')).toBe(true);
		expect(apps.some((a) => typeof a.scenario === 'string')).toBe(true);
	});

	describe.each(fixtures)('$file', ({ snapshot }) => {
		it('decodes, re-encodes as v2, and decodes again to the same record', () => {
			const first = decodeSnapshot(snapshot, roomCodec, ctx(snapshot.roomId));
			const v2 = asV2(snapshot);
			expect(v2.appVersion).toBe(2);
			expect(decodeSnapshot(v2, roomCodec, ctx(snapshot.roomId))).toEqual(first);
		});

		it("nests v1's Magic fields under game, unchanged, and keeps every other v1 value at the top", () => {
			const raw = snapshot.app as Record<string, unknown>;
			const written = asV2(snapshot).app as Record<string, unknown>;
			const magic = Object.fromEntries(Object.entries(raw).filter(([k]) => isMagicKey(k)));
			const rest = Object.fromEntries(Object.entries(raw).filter(([k]) => !isMagicKey(k)));
			expect(Object.keys(magic).length).toBeGreaterThan(0);
			expect(written.game).toEqual(magic);
			expect(Object.keys(written).filter(isMagicKey)).toEqual([]);
			// The rest only gains the defaults the decoder fills in for an older table.
			expect(written).toMatchObject(rest);
		});

		it('restores the same room from the v1 file as from its v2 re-encoding', async () => {
			const fromV1 = await restore([snapshot]);
			const fromV2 = await restore([asV2(snapshot)]);
			expect(fromV1.events.filter((e) => e.event === 'room-quarantined')).toEqual([]);
			expect(fromV2.events.filter((e) => e.event === 'room-quarantined')).toEqual([]);
			const view = fromV1.lobby.get(snapshot.roomId);
			expect(view).toBeDefined();
			expect(fromV2.lobby.get(snapshot.roomId)).toEqual(view);
			// The view's `game` is Magic's blob, and the top level restates it.
			const { format, mode, modeOptions, clientMode, draftStartedAt, pod } = view!;
			expect(view!.game).toEqual({ format, mode, modeOptions, clientMode, draftStartedAt, pod, ...(view!.scenario === undefined ? {} : { scenario: view!.scenario }) });
		});
	});
});

describe('app codec versions it does not read', () => {
	const [{ snapshot }] = fixtures as [(typeof fixtures)[number]];

	it.each([0, 3])('quarantines a room saved under app version %i', async (appVersion) => {
		const { lobby, events } = await restore([{ ...snapshot, appVersion }]);
		expect(lobby.get(snapshot.roomId)).toBeUndefined();
		expect(events).toContainEqual({ event: 'room-quarantined', roomId: snapshot.roomId, reason: expect.stringContaining('app version is not one this build reads') });
	});

	it('quarantines a v2 room with no game blob', async () => {
		const { game: _game, ...flat } = asV2(snapshot).app as Record<string, unknown>;
		const { lobby, events } = await restore([{ ...snapshot, app: flat, appVersion: 2 }]);
		expect(lobby.get(snapshot.roomId)).toBeUndefined();
		expect(events).toContainEqual({ event: 'room-quarantined', roomId: snapshot.roomId, reason: expect.stringContaining('app.game is not an object') });
	});
});
