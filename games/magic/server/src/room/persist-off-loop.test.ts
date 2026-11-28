/**
 * A room or a draft write never waits on the disk with the event loop held.
 *
 * 2026-11-27 06:07–06:12Z: under another workload's writes, hokon's btrfs root took 7–27 s per
 * `fsyncSync`; prod sat in D state with its CPU idle, every request and heartbeat behind it, and the
 * claws fenced their JVMs (a lost bot game, three matches moved). Here the disk is that slow on
 * purpose: each synchronous write call the stores could make takes {@link STALL_MS}, and the
 * mutation has to return well inside it, with the bytes on disk once the writer says so. "Soon" is the
 * writer's own word (`idle()`), never a wall-clock wait: on a stalled host the off-loop write itself is
 * slow, which is exactly what it is for.
 */

import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { snapshotWriter } from '@hadoku/game-server/persist/snapshot-writer';
import { FileRoomStore } from '@wolffm/rooms-server/store';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDraftRooms, singlePoolResolver } from './draftRooms.ts';
import { openLobby } from './lobby.ts';
import { loadPool, type CubePool } from './pool.ts';
import { createSeatPresence, SEAT_RELEASE_MS } from './socket.js';

const STALL_MS = 400;
const SYNC_WRITES = ['fsyncSync', 'writeFileSync', 'writeSync', 'renameSync'] as const;
const BUNDLED_POOL_FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../games/magic/ui/src/draft/pool.json');
const ALICE = { id: 'fk:aaaaaaaaaaaaaaaa', name: 'alice', userId: 'uid-alice' };

/** Every synchronous write call takes `STALL_MS` while `body` runs: what a saturated btrfs did. */
function withStalledDisk<T>(body: () => T): { value: T; ms: number } {
	const real = SYNC_WRITES.map((name) => [name, fs[name]] as const);
	for (const [name, original] of real) {
		(fs as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
			const until = Date.now() + STALL_MS;
			while (Date.now() < until) {
				// The disk, not answering: the loop is held exactly as a blocking syscall holds it.
			}
			return (original as (...a: unknown[]) => unknown)(...args);
		};
	}
	syncBuiltinESMExports();
	const started = Date.now();
	try {
		const value = body();
		return { value, ms: Date.now() - started };
	} finally {
		for (const [name, original] of real) (fs as unknown as Record<string, unknown>)[name] = original;
		syncBuiltinESMExports();
	}
}

const dirs: string[] = [];
const tempDir = async (): Promise<string> => {
	const dir = await mkdtemp(join(tmpdir(), 'cardtable-off-loop-'));
	dirs.push(dir);
	return dir;
};
afterAll(async () => {
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

let cube: CubePool;
beforeAll(() => {
	const load = loadPool(BUNDLED_POOL_FIXTURE);
	if (!load.ok) throw new Error(`the bundled cube pool did not load: ${load.detail}`);
	cube = load.pool;
});

describe('a write on a stalled disk', () => {
	it('a room made in the lobby returns before its file is on disk, and is there once the writer is idle', async () => {
		const dir = await tempDir();
		const lobby = await openLobby({ dir });
		const { value: made, ms } = withStalledDisk(() => lobby.create(ALICE, { name: 'Cube night', gameType: 'draft', clientMode: 'builtin' }));
		if (!made.ok) throw new Error('not made');
		expect(ms).toBeLessThan(STALL_MS / 2);
		await snapshotWriter().idle();
		expect((await new FileRoomStore(dir).load(made.room.id))?.app).toMatchObject({ name: 'Cube night' });
	});

	it('a dealt draft returns before its snapshot is on disk, and a restart finds it once the writer is idle', async () => {
		const dir = await tempDir();
		const presence = createSeatPresence({ seatReleaseMs: SEAT_RELEASE_MS, draftGraceOf: () => 0 });
		const first = createDraftRooms({ presence, ...singlePoolResolver(cube), storeDir: dir });
		const { ms } = withStalledDisk(() => first.open('pod-stall'));
		expect(ms).toBeLessThan(STALL_MS / 2);
		await snapshotWriter().idle();
		expect(createDraftRooms({ presence, ...singlePoolResolver(cube), storeDir: dir }).find('pod-stall')).toBeDefined();
	});
});
