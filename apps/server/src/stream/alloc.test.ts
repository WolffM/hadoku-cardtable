/*
 * A room's containers: handing them out, and getting them back.
 *
 * Two kinds of test here, on purpose:
 *
 * - against the **real** `scripts/stream/container.sh` in dry-run mode, so the
 *   allocator is proven against the script it actually invokes — the argument
 *   order, the guards, the exit codes — on a machine with no docker;
 * - against a **fake** script, for the paths a dry run cannot produce: a
 *   provision that fails half way, an orphan a restart left behind.
 *
 * The idle window is tested with a FAKE CLOCK. A test that waits 30 minutes is
 * a test nobody runs.
 */
import { describe, expect, it } from 'vitest';

import {
	createRoomStreams,
	findContainerScript,
	isStaticIndexLike,
	scriptRunner,
	type ContainerScript,
	IDLE_RECLAIM_MS,
	ROOM_STREAM_BASE_PORT,
} from './alloc.ts';

const SCRIPT = findContainerScript();

/** The real script, dry-run: it prints what it would do and touches nothing. */
function dryRunScript(): ContainerScript {
	if (SCRIPT === null) throw new Error('scripts/stream/container.sh not found');
	return scriptRunner(SCRIPT, { CARDTABLE_STREAM_DRY_RUN: '1' });
}

interface Recording extends ContainerScript {
	calls: string[];
}

/** A fake that records, and can be told to fail one particular `up`. */
function recordingScript(failOn?: string, orphans: string[] = []): Recording {
	const calls: string[] = [];
	return {
		calls,
		async up(name, port, network) {
			calls.push(`up ${name} ${String(port)} ${network}`);
			if (name === failOn) throw new Error(`docker run failed for ${name}`);
			await Promise.resolve();
		},
		async down(name) {
			calls.push(`down ${name}`);
			await Promise.resolve();
		},
		async list() {
			calls.push('list');
			return Promise.resolve(orphans);
		},
		async netDown(network) {
			calls.push(`net-down ${network}`);
			await Promise.resolve();
		},
	};
}

describe('the script the allocator shells', () => {
	it('is on disk, and is found from wherever this module lives', () => {
		// Production bundles this module into dist/index.js; a test runs it from
		// src/. A fixed relative path is wrong in one of those two.
		expect(SCRIPT).not.toBeNull();
		expect(SCRIPT).toMatch(/scripts\/stream\/container\.sh$/);
	});

	it('REFUSES the static bench by name, even asked nicely', async () => {
		// cardtable-lab-0/1 are serving a friend demo. Nothing this product runs
		// may stop them, and the refusal is the script's, not the caller's.
		await expect(dryRunScript().up('cardtable-lab-0', 6100, 'cardtable-room-x')).rejects.toThrow(/static bench/);
	});

	it('REFUSES a host port the bench or the e2e harness could own', async () => {
		await expect(dryRunScript().up('cardtable-room-x-0', 6080, 'cardtable-room-x')).rejects.toThrow(/below 6100/);
	});

	it('refuses a name outside the prefix it manages', async () => {
		await expect(dryRunScript().up('something-else-0', 6100, 'n')).rejects.toThrow(/starts with/);
	});
});

describe('allocating a room its containers, against the real script', () => {
	it('gives a two-seat room two containers and two ports', async () => {
		const rooms = createRoomStreams({ roomExists: () => true, script: dryRunScript() });
		const got = await rooms.allocate('kitchen-table', 2);

		expect(got.ok).toBe(true);
		if (!got.ok) return;
		expect(got.allocation.seats).toEqual([
			{ seat: 0, port: ROOM_STREAM_BASE_PORT, container: 'cardtable-room-kitchen-table-0' },
			{ seat: 1, port: ROOM_STREAM_BASE_PORT + 1, container: 'cardtable-room-kitchen-table-1' },
		]);
		expect(rooms.portOf('kitchen-table', 1)).toBe(ROOM_STREAM_BASE_PORT + 1);
		expect(rooms.portOf('kitchen-table', 2)).toBeNull();
		expect(rooms.statusOf('kitchen-table')).toMatchObject({ state: 'live', seats: 2 });
	});

	it('is idempotent — asking twice does not double the containers', async () => {
		const script = recordingScript();
		const rooms = createRoomStreams({ roomExists: () => true, script });
		await rooms.allocate('again', 2);
		await rooms.allocate('again', 2);
		expect(script.calls.filter((c) => c.startsWith('up '))).toHaveLength(2);
	});

	it('does not put two rooms on one port', async () => {
		const rooms = createRoomStreams({ roomExists: () => true, script: recordingScript() });
		await rooms.allocate('room-a', 2);
		await rooms.allocate('room-b', 2);
		const ports = rooms.list().flatMap((a) => a.seats.map((s) => s.port));
		expect(new Set(ports).size).toBe(4);
	});

	it('refuses a room key that reads as a static stream index', async () => {
		// `/stream/3/` is the bench's third container. A room called `3` would
		// make `/stream/3/0/` ambiguous, so it never gets containers at all.
		expect(isStaticIndexLike('3')).toBe(true);
		const rooms = createRoomStreams({ roomExists: () => true, script: recordingScript() });
		const got = await rooms.allocate('3', 2);
		expect(got.ok).toBe(false);
		if (got.ok) return;
		expect(got.reason).toBe('bad-room-key');
	});

	it('refuses a key the lobby could never mint, and a seat count no room has', async () => {
		const rooms = createRoomStreams({ roomExists: () => true, script: recordingScript() });
		for (const bad of ['Room', 'a b', '../etc', 'x'.repeat(41), '']) {
			expect((await rooms.allocate(bad, 2)).ok, `key=${bad}`).toBe(false);
		}
		for (const seats of [0, -1, 9, 1.5]) {
			expect((await rooms.allocate('fine-key', seats)).ok, `seats=${String(seats)}`).toBe(false);
		}
	});

	it('runs out of ports rather than out of memory', async () => {
		// The pool IS the cap: 1.3 GiB per desktop, measured. See alloc.ts.
		const rooms = createRoomStreams({ roomExists: () => true, script: recordingScript(), poolSize: 2 });
		expect((await rooms.allocate('first', 2)).ok).toBe(true);
		const second = await rooms.allocate('second', 2);
		expect(second.ok).toBe(false);
		if (second.ok) return;
		expect(second.reason).toBe('no-ports');
	});

	it('takes back what came up when a later seat fails', async () => {
		// Half a room is not a room, and a leaked container is 1.3 GiB.
		const script = recordingScript('cardtable-room-halfway-1');
		const rooms = createRoomStreams({ roomExists: () => true, script });
		const got = await rooms.allocate('halfway', 2);

		expect(got.ok).toBe(false);
		expect(script.calls).toContain('down cardtable-room-halfway-0');
		expect(script.calls).toContain('net-down cardtable-room-halfway');
		expect(rooms.find('halfway')).toBeUndefined();
		// And the ports are free again, so the next room can have them.
		expect((await rooms.allocate('next-one', 2)).ok).toBe(true);
	});
});

describe('reclaim: a room that is gone', () => {
	it('destroys the containers of a room nobody can join', async () => {
		const alive = new Set(['still-here', 'going-away']);
		const script = recordingScript();
		const rooms = createRoomStreams({ roomExists: (k) => alive.has(k), script });
		await rooms.allocate('still-here', 1);
		await rooms.allocate('going-away', 2);

		alive.delete('going-away');
		const report = await rooms.sweep();

		expect(report.reclaimed).toEqual([{ roomKey: 'going-away', reason: 'room-gone' }]);
		expect(script.calls).toContain('down cardtable-room-going-away-0');
		expect(script.calls).toContain('down cardtable-room-going-away-1');
		expect(rooms.find('still-here')).toBeDefined();
	});

	it('says so honestly afterwards, instead of 502ing behind a live link', async () => {
		const rooms = createRoomStreams({ roomExists: () => false, script: recordingScript() });
		await rooms.allocate('was-a-room', 1);
		await rooms.sweep();
		expect(rooms.statusOf('was-a-room')).toMatchObject({ state: 'dead', reason: 'room-gone' });
		// A room that never had streams is not the same as one that lost them.
		expect(rooms.statusOf('never-existed')).toMatchObject({ state: 'none' });
	});
});

describe('reclaim: nobody is watching (fake clock, never a real wait)', () => {
	function fakeClock(): { now: () => number; advance: (ms: number) => void } {
		let t = 1_000_000;
		return { now: () => t, advance: (ms) => (t += ms) };
	}

	it('destroys an abandoned room once the idle window passes', async () => {
		const clock = fakeClock();
		const script = recordingScript();
		const rooms = createRoomStreams({ roomExists: () => true, script, now: clock.now });
		await rooms.allocate('abandoned', 2);

		rooms.noteAttach('abandoned');
		rooms.noteDetach('abandoned');

		clock.advance(IDLE_RECLAIM_MS - 1);
		expect((await rooms.sweep()).reclaimed).toEqual([]);
		expect(rooms.find('abandoned')).toBeDefined();

		clock.advance(1);
		expect((await rooms.sweep()).reclaimed).toEqual([{ roomKey: 'abandoned', reason: 'idle' }]);
		expect(script.calls).toContain('down cardtable-room-abandoned-0');
		expect(script.calls).toContain('down cardtable-room-abandoned-1');
		expect(rooms.statusOf('abandoned')).toMatchObject({ state: 'dead', reason: 'idle' });
	});

	it('NEVER reclaims a room somebody is still watching', async () => {
		// Destroying a container destroys the match inside it. An attached
		// socket is a person at the table, whatever the clock says.
		const clock = fakeClock();
		const rooms = createRoomStreams({ roomExists: () => true, script: recordingScript(), now: clock.now });
		await rooms.allocate('in-play', 2);
		rooms.noteAttach('in-play');

		clock.advance(IDLE_RECLAIM_MS * 10);
		expect((await rooms.sweep()).reclaimed).toEqual([]);
		expect(rooms.find('in-play')).toBeDefined();
	});

	it('the window restarts when the last watcher leaves, not when the first arrives', async () => {
		const clock = fakeClock();
		const rooms = createRoomStreams({ roomExists: () => true, script: recordingScript(), now: clock.now });
		await rooms.allocate('re-opened', 1);

		clock.advance(IDLE_RECLAIM_MS - 60_000);
		rooms.noteAttach('re-opened');
		clock.advance(120_000);
		rooms.noteDetach('re-opened');

		clock.advance(IDLE_RECLAIM_MS - 1);
		expect((await rooms.sweep()).reclaimed).toEqual([]);
		clock.advance(1);
		expect((await rooms.sweep()).reclaimed).toEqual([{ roomKey: 're-opened', reason: 'idle' }]);
	});

	it('a reallocation clears the tombstone', async () => {
		const clock = fakeClock();
		const rooms = createRoomStreams({ roomExists: () => true, script: recordingScript(), now: clock.now });
		await rooms.allocate('second-life', 1);
		clock.advance(IDLE_RECLAIM_MS);
		await rooms.sweep();
		expect(rooms.statusOf('second-life').state).toBe('dead');

		await rooms.allocate('second-life', 1);
		expect(rooms.statusOf('second-life')).toMatchObject({ state: 'live', seats: 1 });
	});
});

describe('reclaim: what a restart left behind', () => {
	it('destroys a container with our prefix that no allocation owns', async () => {
		// Containers outlive this process. Without this, every deploy leaks a
		// room's worth of RAM until somebody notices with `docker ps`.
		const script = recordingScript(undefined, ['cardtable-room-ghost-0', 'cardtable-room-live-0']);
		const rooms = createRoomStreams({ roomExists: () => true, script });
		await rooms.allocate('live', 1);

		const report = await rooms.sweepOrphans();

		expect(report.reclaimed).toEqual([{ roomKey: 'cardtable-room-ghost-0', reason: 'orphan' }]);
		expect(script.calls).toContain('down cardtable-room-ghost-0');
		expect(script.calls).not.toContain('down cardtable-room-live-0');
	});

	it('a dry run reports no orphans rather than guessing at some', async () => {
		const rooms = createRoomStreams({ roomExists: () => true, script: dryRunScript() });
		expect((await rooms.sweepOrphans()).reclaimed).toEqual([]);
	});
});
