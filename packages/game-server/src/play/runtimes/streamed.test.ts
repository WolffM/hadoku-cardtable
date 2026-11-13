/*
 * The streamed desktop as an `EngineRuntime`, and `streamedHost` against a FAKE allocator (no
 * docker, no container.sh) — the real script's own guards are `stream/alloc.test.ts`'s, dry-run and
 * fake-script both. What this file proves: a seat's container comes up, stop tears every seat's
 * container down, and a failed provision reaches the caller as the match's fatal.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRoomStreams, type ContainerScript } from '../../stream/alloc.js';
import {
	STREAMED_CONTAINER_MB,
	streamedContainerEnv,
	streamedEngineConfig,
	streamedEngineRuntime,
	streamedHost,
	type StreamedHostEvents,
} from './streamed.js';

interface Recorder extends StreamedHostEvents {
	fatals: string[];
	exits: string[];
	logs: Record<string, unknown>[];
}

function recorder(): Recorder {
	const r: Recorder = {
		fatals: [],
		exits: [],
		logs: [],
		fatal: (m) => r.fatals.push(m),
		exit: (reason) => r.exits.push(reason),
		log: (e) => r.logs.push(e),
	};
	return r;
}

interface Recording extends ContainerScript {
	calls: string[];
}

/** A fake that records every call, and can be told to fail one particular `up`. */
function recordingScript(failOn?: string): Recording {
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
			return Promise.resolve([]);
		},
		async netDown(network) {
			calls.push(`net-down ${network}`);
			await Promise.resolve();
		},
	};
}

describe('streamedHost, against a fake allocator (no docker)', () => {
	it("starts: every seat's container comes up through RoomStreams.allocate", async () => {
		const script = recordingScript();
		const rooms = createRoomStreams({ roomExists: () => true, script });
		const events = recorder();

		streamedHost(rooms, 'room-start', 2, events);

		await vi.waitFor(() => {
			expect(script.calls.filter((c) => c.startsWith('up '))).toHaveLength(2);
		});
		expect(events.fatals).toEqual([]);
		expect(events.logs.map((l) => l.evt)).toEqual(['streamed-host-up']);
	});

	it("stop tears every seat's container down", async () => {
		const script = recordingScript();
		const rooms = createRoomStreams({ roomExists: () => true, script });
		const events = recorder();

		const host = streamedHost(rooms, 'room-stop', 2, events);
		await vi.waitFor(() => expect(script.calls.filter((c) => c.startsWith('up '))).toHaveLength(2));

		host.stop();
		await vi.waitFor(() => expect(script.calls.filter((c) => c.startsWith('down '))).toHaveLength(2));
		expect(events.exits).toEqual(['stopped']);

		// Idempotent: a second stop() tears nothing down twice.
		host.stop();
		await Promise.resolve();
		expect(script.calls.filter((c) => c.startsWith('down '))).toHaveLength(2);
		expect(events.exits).toEqual(['stopped']);
	});

	it("settled() reports an externally-reclaimed room without releasing it a second time", async () => {
		const script = recordingScript();
		const rooms = createRoomStreams({ roomExists: () => true, script });
		const events = recorder();

		const host = streamedHost(rooms, 'room-settled', 2, events);
		await vi.waitFor(() => expect(script.calls.filter((c) => c.startsWith('up '))).toHaveLength(2));

		// The allocator's own sweep already tore the containers down (idle, say) by the time this
		// fires — `plugins/stream.ts` wires exactly this call from `RoomStreamsOptions.onEnded`.
		host.settled('idle');
		expect(events.exits).toEqual(['idle']);

		// A stop() after settling must not release a second time: the room is already gone.
		host.stop();
		await Promise.resolve();
		expect(script.calls.filter((c) => c.startsWith('down '))).toHaveLength(0);
		expect(events.exits).toEqual(['idle']);
	});

	it("the allocator's own idle sweep reaches a tracked host through RoomStreamsOptions.onEnded", async () => {
		const script = recordingScript();
		let now = 0;
		const ended: Array<{ roomKey: string; reason: string }> = [];
		const rooms = createRoomStreams({
			roomExists: () => true,
			script,
			now: () => now,
			idleMs: 1000,
			onEnded: (roomKey, reason) => ended.push({ roomKey, reason }),
		});
		const events = recorder();

		streamedHost(rooms, 'room-idle', 1, events);
		await vi.waitFor(() => expect(script.calls.filter((c) => c.startsWith('up '))).toHaveLength(1));

		now = 2000; // past idleMs, nobody attached
		await rooms.sweep();

		expect(ended).toEqual([{ roomKey: 'room-idle', reason: 'idle' }]);
		expect(script.calls.filter((c) => c.startsWith('down '))).toHaveLength(1);
	});

	it("a failed provision is the match's fatal", async () => {
		// `prefix-roomKey-seat` is the real naming (`alloc.ts`'s default prefix is 'cardtable-room').
		// Fail the SECOND seat, so the allocator's own rollback has already brought seat 0 up and
		// tears it back down — proving the rollback path, not just "nothing ever came up".
		const script = recordingScript('cardtable-room-room-fail-1');
		const rooms = createRoomStreams({ roomExists: () => true, script });
		const events = recorder();

		streamedHost(rooms, 'room-fail', 2, events);

		await vi.waitFor(() => expect(events.fatals).toHaveLength(1));
		expect(events.fatals[0]).toMatch(/provision-failed/);
		expect(events.exits).toEqual(['provisioning failed: Error: docker run failed for cardtable-room-room-fail-1']);
		// Half a room is not a room: the allocator rolled seat 0's container back too.
		expect(script.calls.filter((c) => c.startsWith('down '))).toHaveLength(1);
	});
});

describe('streamedEngineRuntime', () => {
	it('costs what the streaming spike measured, one container per seat, nothing shared', () => {
		const runtime = streamedEngineRuntime({ forgeJar: '/jar', forgeRes: '/res' });
		expect(runtime.overheadMb).toBe(STREAMED_CONTAINER_MB);
		expect(runtime.perProcess).toBe(1);
		expect(runtime.artifacts).toEqual({ jar: '/jar', res: '/res' });
		expect(runtime.argv('/any/dir', { memoryMb: 1 })).toEqual([]);
		expect(runtime.health?.('/any/dir')).toEqual({ recycle: false });
	});
});

describe('streamedEngineConfig', () => {
	const made: string[] = [];
	afterEach(() => {
		for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function forgeTree(): { jar: string; res: string } {
		const root = mkdtempSync(join(tmpdir(), 'streamed-engine-config-'));
		made.push(root);
		const jar = join(root, 'forge.jar');
		writeFileSync(jar, '');
		const res = join(root, 'res');
		mkdirSync(join(res, 'cardsfolder'), { recursive: true });
		return { jar, res };
	}

	it('is ok with CARDTABLE_STREAM_FORGE_JAR/_RES set and real', () => {
		const { jar, res } = forgeTree();
		const result = streamedEngineConfig({ CARDTABLE_STREAM_FORGE_JAR: jar, CARDTABLE_STREAM_FORGE_RES: res });
		expect(result).toEqual({ ok: true, config: { forgeJar: jar, forgeRes: res } });
	});

	it('falls back to CARDTABLE_FORGE_JAR/_RES — the pool jar — when the container has none of its own', () => {
		const { jar, res } = forgeTree();
		const result = streamedEngineConfig({ CARDTABLE_FORGE_JAR: jar, CARDTABLE_FORGE_RES: res });
		expect(result).toEqual({ ok: true, config: { forgeJar: jar, forgeRes: res } });
	});

	it('names the reason when nothing is set', () => {
		const result = streamedEngineConfig({});
		expect(result).toEqual({ ok: false, reason: 'neither CARDTABLE_STREAM_FORGE_JAR nor CARDTABLE_FORGE_JAR is set' });
	});

	it("names the reason when the jar does not exist", () => {
		const result = streamedEngineConfig({ CARDTABLE_STREAM_FORGE_JAR: '/nope.jar', CARDTABLE_STREAM_FORGE_RES: '/nope' });
		expect(result).toEqual({ ok: false, reason: 'no Forge jar for the streamed desktop at /nope.jar' });
	});

	it("names the reason when res has no cardsfolder", () => {
		const { jar } = forgeTree();
		const root = mkdtempSync(join(tmpdir(), 'streamed-engine-config-badres-'));
		made.push(root);
		const result = streamedEngineConfig({ CARDTABLE_STREAM_FORGE_JAR: jar, CARDTABLE_STREAM_FORGE_RES: root });
		expect(result.ok).toBe(false);
		expect((result as { reason: string }).reason).toMatch(/no cardsfolder/);
	});
});

describe('streamedContainerEnv', () => {
	it('names exactly the two env vars container.sh reads for the container, nothing else', () => {
		expect(streamedContainerEnv({ forgeJar: '/a.jar', forgeRes: '/res' })).toEqual({
			CARDTABLE_STREAM_FORGE_JAR: '/a.jar',
			CARDTABLE_STREAM_FORGE_RES: '/res',
		});
	});
});
