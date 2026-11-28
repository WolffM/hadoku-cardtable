import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileRoomStore, STORE_VERSION, type RoomSnapshot } from '@wolffm/rooms-server/store';
import { createSeatTable } from '@wolffm/rooms-protocol';
import { afterAll, describe, expect, it } from 'vitest';

import { OffLoopRoomStore } from '../room/off-loop-store.js';
import { SnapshotWriter } from './snapshot-writer.js';

const dirs: string[] = [];
const tempDir = async (): Promise<string> => {
	const dir = await mkdtemp(join(tmpdir(), 'cardtable-snapshot-writer-'));
	dirs.push(dir);
	return dir;
};
afterAll(async () => {
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

/**
 * The writer's clock for a test that asserts its whole log: time stands still, so no write is "slow" whatever the
 * host's disk does (a stalled claw took 2.3 s for one, run 46155656374). Whether a slow write IS logged is its own
 * test below, on a clock that test drives.
 */
const still = (): number => 0;

const text = (file: string): string | null => (existsSync(file) ? readFileSync(file, 'utf8') : null);

describe('SnapshotWriter', () => {
	it('writes off the call, keeps only the newest text of a file not yet started, and leaves no temp file', async () => {
		const dir = await tempDir();
		const log: Record<string, unknown>[] = [];
		const writer = new SnapshotWriter({ log: (e) => log.push(e), now: still });
		const a = join(dir, 'a.json');
		const b = join(dir, 'b.json');
		writer.write(a, '1');
		writer.write(b, 'b1');
		writer.write(b, 'b2');
		writer.write(b, 'b3');
		expect(text(a)).toBeNull();
		expect(writer.pending()).toBe(2);
		await writer.idle();
		expect([text(a), text(b)]).toEqual(['1', 'b3']);
		expect(readdirSync(dir).sort()).toEqual(['a.json', 'b.json']);
		expect(writer.pending()).toBe(0);
		expect(log).toEqual([]);
	});

	it('removes a file only after the writes queued before it, and a write queued after a remove wins', async () => {
		const dir = await tempDir();
		const writer = new SnapshotWriter({ log: () => {} });
		const gone = join(dir, 'gone.json');
		const back = join(dir, 'back.json');
		writer.write(gone, 'first');
		const removed = writer.remove(gone);
		writer.write(back, 'x');
		const removedThenWritten = writer.remove(back);
		writer.write(back, 'again');
		await removed;
		await removedThenWritten;
		await writer.idle();
		expect(text(gone)).toBeNull();
		expect(text(back)).toBe('again');
	});

	it('writes what is still queued synchronously on the exit path', async () => {
		const dir = await tempDir();
		const writer = new SnapshotWriter({ log: () => {} });
		const first = join(dir, 'first.json');
		const second = join(dir, 'nested', 'second.json');
		writer.write(first, 'in flight');
		writer.write(second, 'queued');
		writer.drainSync();
		expect(text(second)).toBe('queued');
		await writer.idle();
		expect(text(first)).toBe('in flight');
	});

	it('logs a write that fails and goes on to the next', async () => {
		const dir = await tempDir();
		const log: Record<string, unknown>[] = [];
		const writer = new SnapshotWriter({ log: (e) => log.push(e), now: still });
		const blocked = join(dir, 'file');
		writer.write(blocked, 'a file');
		await writer.idle();
		writer.write(join(blocked, 'under-a-file.json'), 'never');
		writer.write(join(dir, 'fine.json'), 'fine');
		await writer.idle();
		expect(text(join(dir, 'fine.json'))).toBe('fine');
		expect(log.map((e) => [e.evt, e.file])).toEqual([['snapshot-write-failed', join(blocked, 'under-a-file.json')]]);
	});

	it('logs a write slower than the slow mark', async () => {
		const dir = await tempDir();
		const log: Record<string, unknown>[] = [];
		let clock = 0;
		const writer = new SnapshotWriter({ log: (e) => log.push(e), now: () => (clock += 600) });
		writer.write(join(dir, 'slow.json'), 'slow');
		await writer.idle();
		expect(log.map((e) => e.evt)).toEqual(['snapshot-write-slow']);
	});
});

describe('OffLoopRoomStore', () => {
	it('writes the files FileRoomStore reads, and removes them in order', async () => {
		const dir = await tempDir();
		const writer = new SnapshotWriter({ log: () => {} });
		const store = new OffLoopRoomStore(dir, { writer });
		const snapshot: RoomSnapshot = {
			storeVersion: STORE_VERSION,
			roomId: 'r-0123456789ab',
			roomKey: 'r-0123456789ab',
			lastEventSeq: 0,
			createdAt: 1,
			updatedAt: 2,
			members: [],
			usedAvatars: [],
			seats: createSeatTable(null),
			app: { name: 'Cube night' },
			appVersion: 1,
		};
		store.saveSync(snapshot);
		await store.flushed();
		const reader = new FileRoomStore(dir);
		expect(await reader.list()).toEqual(['r-0123456789ab']);
		expect(await reader.load('r-0123456789ab')).toEqual(snapshot);
		store.saveSync({ ...snapshot, updatedAt: 3 });
		await store.remove('r-0123456789ab');
		expect(await reader.list()).toEqual([]);
	});
});
