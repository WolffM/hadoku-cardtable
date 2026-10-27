import { gunzipSync } from 'node:zlib';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DeckCosts } from '../deck-colors.js';
import type { BridgeLine, HostEvents, MatchHost, MatchHostFactory, MatchSpec } from '../host.js';
import { bridgeDigest, createRecorder, forgePin, serverVersion } from './recorder.js';

let dir: string;

afterEach(() => {
	if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

function linesOf(path: string): { t: string; [k: string]: unknown }[] {
	return gunzipSync(readFileSync(path))
		.toString('utf8')
		.split('\n')
		.filter((l) => l !== '')
		.map((l) => JSON.parse(l) as { t: string; [k: string]: unknown });
}

const NO_COSTS: DeckCosts = () => ({});

function spec(seed?: number): MatchSpec {
	return { seed, seats: [{ name: 'A', ai: false, deck: null }, { name: 'B', ai: false, deck: null }] };
}

interface FakeFactory extends MatchHostFactory {
	calls: { matchId: string; spec: MatchSpec; events: HostEvents }[];
	sends: unknown[];
}

function fakeFactory(): FakeFactory {
	const calls: FakeFactory['calls'] = [];
	const sends: unknown[] = [];
	const factory = ((matchId, s, events) => {
		calls.push({ matchId, spec: s, events });
		const host: MatchHost = { send: (c) => sends.push(c), stop: () => undefined };
		return host;
	}) as FakeFactory;
	factory.calls = calls;
	factory.sends = sends;
	factory.close = () => undefined;
	factory.spare = () => 'none';
	return factory;
}

describe('forgePin / bridgeDigest / serverVersion', () => {
	it('reads the pin from a 40-hex jar name, and null from forge.jar', () => {
		const sha = 'a'.repeat(40);
		expect(forgePin(`/jars/${sha}.jar`)).toBe(sha);
		expect(forgePin('/jars/forge.jar')).toBeNull();
	});

	it('is a stable sha-256 of the bridge source text', () => {
		dir = mkdtempSync(join(tmpdir(), 'cardtable-bridge-'));
		const file = join(dir, 'PlayBridge.java');
		writeFileSync(file, 'class PlayBridge {}');
		const digest = bridgeDigest(file);
		expect(digest).toMatch(/^[0-9a-f]{64}$/);
		expect(bridgeDigest(file)).toBe(digest);
		writeFileSync(file, 'class PlayBridge { /* changed */ }');
		expect(bridgeDigest(file)).not.toBe(digest);
	});

	it('reads package.json version, and "unknown" when there is none', () => {
		dir = mkdtempSync(join(tmpdir(), 'cardtable-pkg-'));
		writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '1.2.3' }));
		expect(serverVersion(dir)).toBe('1.2.3');
		expect(serverVersion('/nonexistent-dir-xyz')).toBe('unknown');
	});
});

describe('createRecorder', () => {
	it('assigns a random seed when the spec carries none, and keeps one it was given', async () => {
		dir = mkdtempSync(join(tmpdir(), 'cardtable-recorder-'));
		const inner = fakeFactory();
		const recorder = createRecorder({ dir, identity: { pin: null, bridge: 'b', server: 's' }, roomOf: () => null, deckCosts: NO_COSTS, randomSeed: () => 42 });
		const hosted = recorder.host(inner);
		hosted('m-1', spec(undefined), { line: () => undefined, exit: () => undefined, log: () => undefined });
		hosted('m-2', spec(7), { line: () => undefined, exit: () => undefined, log: () => undefined });
		expect(inner.calls[0]!.spec.seed).toBe(42);
		expect(inner.calls[1]!.spec.seed).toBe(7);
	});

	it('passes through the inner factory\'s own members unchanged', () => {
		dir = mkdtempSync(join(tmpdir(), 'cardtable-recorder-'));
		const inner = fakeFactory();
		const recorder = createRecorder({ dir, identity: { pin: null, bridge: 'b', server: 's' }, roomOf: () => null, deckCosts: NO_COSTS });
		const hosted = recorder.host(inner);
		expect(hosted.close).toBe(inner.close);
		expect(hosted.spare!()).toBe('none');
	});

	it('never lets a fault in recording reach the match: the line, the command and the envelope all still go through', () => {
		dir = mkdtempSync(join(tmpdir(), 'cardtable-recorder-'));
		const inner = fakeFactory();
		const logged: Record<string, unknown>[] = [];
		const recorder = createRecorder({ dir, identity: { pin: null, bridge: 'b', server: 's' }, roomOf: () => null, deckCosts: NO_COSTS, log: (e) => logged.push(e) });
		const seen: BridgeLine[] = [];
		const host = recorder.host(inner)('m-2', spec(1), { line: (l) => seen.push(l), exit: () => undefined, log: () => undefined });
		// An ask frame with no `frame` object: reading `.kind` off it throws, the match does not.
		const broken = { t: 'frame', seat: 0, frame: null } as unknown as BridgeLine;
		expect(() => inner.calls[0]!.events.line(broken)).not.toThrow();
		expect(seen).toEqual([broken]);
		host.send({ t: 'reply', seat: 0, callId: 'c1', result: true });
		expect(inner.sends).toHaveLength(1);
		expect(logged.some((e) => e.evt === 'recording-failed')).toBe(true);
	});

	it('logs an act from its applied echo, never from the send, and other command kinds are not logged at all', async () => {
		dir = mkdtempSync(join(tmpdir(), 'cardtable-recorder-'));
		const inner = fakeFactory();
		const recorder = createRecorder({ dir, identity: { pin: null, bridge: 'b', server: 's' }, roomOf: () => null, deckCosts: NO_COSTS });
		const host = recorder.host(inner)('m-4', spec(1), { line: () => undefined, exit: () => undefined, log: () => undefined });
		const events = inner.calls[0]!.events;
		// Sent but never applied (no `applied` echo for it): must never appear in the log.
		host.send({ t: 'act', seat: 0, frame: { kind: 'act', method: 'selectButtonOk' } });
		host.send({ t: 'resend-pending', seat: 1 });
		host.send({ t: 'stop' });
		// Applied: this is what actually makes the log, regardless of what was sent through this host.
		events.line({ t: 'applied', seat: 0, seq: 1, input: 'InputPassPriority', act: { kind: 'act', method: 'selectButtonOk' } } as unknown as BridgeLine);
		recorder.onGameOver({ id: 'm-4', endedAt: Date.now(), winner: null, winnerSeat: null, concededBy: null, spec: spec(1) });
		await vi.waitFor(() => expect(existsSync(join(dir, 'm-4.actions.jsonl.gz'))).toBe(true));
		const cmds = linesOf(join(dir, 'm-4.actions.jsonl.gz')).filter((l) => l.t === 'cmd');
		expect(cmds).toEqual([{ t: 'cmd', seat: 0, cmd: { t: 'act', seat: 0, frame: { kind: 'act', method: 'selectButtonOk' } } }]);
	});

	it('numbers each reply by the ask it answers, not by its place among replies', async () => {
		dir = mkdtempSync(join(tmpdir(), 'cardtable-recorder-'));
		const inner = fakeFactory();
		const recorder = createRecorder({ dir, identity: { pin: null, bridge: 'b', server: 's' }, roomOf: () => null, deckCosts: NO_COSTS });
		const host = recorder.host(inner)('m-3', spec(1), { line: () => undefined, exit: () => undefined, log: () => undefined });
		const events = inner.calls[0]!.events;
		const ask = (callId: string) => events.line({ t: 'frame', seat: 1, frame: { kind: 'ask', method: 'confirm', callId } } as unknown as BridgeLine);
		ask('s1-1');
		ask('s1-2');
		// The first ask lapsed (the server answered it, or Forge moved on): the one reply answers the second.
		host.send({ t: 'reply', seat: 1, callId: 's1-2', result: true });
		// An applied act: logged with no `ask` property at all, unlike a reply/abort.
		events.line({ t: 'applied', seat: 1, seq: 1, input: 'InputConfirm', act: { kind: 'act', method: 'selectButtonOk' } } as unknown as BridgeLine);
		recorder.onGameOver({ id: 'm-3', endedAt: Date.now(), winner: null, winnerSeat: null, concededBy: null, spec: spec(1) });
		await vi.waitFor(() => expect(existsSync(join(dir, 'm-3.actions.jsonl.gz'))).toBe(true));
		const cmds = linesOf(join(dir, 'm-3.actions.jsonl.gz')).filter((l) => l.t === 'cmd');
		expect(cmds[0]).toMatchObject({ ask: 1, cmd: { t: 'reply', callId: 's1-2' } });
		expect(cmds[1]).not.toHaveProperty('ask');
	});

	it('records a header, a cmd line for an applied act and for a reply, and an end line with the winner', async () => {
		dir = mkdtempSync(join(tmpdir(), 'cardtable-recorder-'));
		const inner = fakeFactory();
		let tick = 0;
		const recorder = createRecorder({
			dir,
			identity: { pin: 'pin-1', bridge: 'bridge-1', server: 'server-1' },
			roomOf: (matchId) => (matchId === 'm-1' ? 'r-1' : null),
			deckCosts: NO_COSTS,
			now: () => (tick += 1000),
		});
		const hosted = recorder.host(inner);
		let exit: ((reason: string) => void) | undefined;
		const host = hosted('m-1', spec(1), {
			line: () => undefined,
			exit: (r) => {
				exit = r as never;
			},
			log: () => undefined,
		});
		const events = inner.calls[0]!.events;
		events.line({ t: 'applied', seat: 0, seq: 1, input: 'InputPassPriority', act: { kind: 'act', method: 'selectButtonOk' } } as unknown as BridgeLine);
		events.line({ t: 'frame', seat: 1, frame: { kind: 'ask', method: 'confirm', callId: 'c1' } } as unknown as BridgeLine);
		host.send({ t: 'reply', seat: 1, callId: 'c1', result: true });
		// Housekeeping, not a move: never a cmd line.
		host.send({ t: 'stop' });
		// Written at the game's end, while its JVM is still up for the over-grace: a replay does not wait for the exit.
		recorder.onGameOver({ id: 'm-1', endedAt: Date.now(), winner: 'A', winnerSeat: 0, concededBy: null, spec: spec(1) });

		expect(inner.sends).toEqual([{ t: 'reply', seat: 1, callId: 'c1', result: true }, { t: 'stop' }]);
		await vi.waitFor(() => {
			expect(existsSync(join(dir, 'm-1.actions.jsonl.gz'))).toBe(true);
			expect(existsSync(join(dir, 'm-1.public.jsonl.gz'))).toBe(true);
		});

		const actions = linesOf(join(dir, 'm-1.actions.jsonl.gz'));
		expect(actions[0]).toMatchObject({ t: 'header', v: 2, matchId: 'm-1', roomId: 'r-1', pin: 'pin-1', bridge: 'bridge-1', server: 'server-1' });
		expect(actions[1]).toEqual({ t: 'cmd', seat: 0, cmd: { t: 'act', seat: 0, frame: { kind: 'act', method: 'selectButtonOk' } } });
		expect(actions[2]).toEqual({ t: 'cmd', seat: 1, ask: 0, cmd: { t: 'reply', seat: 1, callId: 'c1', result: true } });
		expect(actions[3]).toMatchObject({ t: 'end', reason: 'game-over' });

		const pub = linesOf(join(dir, 'm-1.public.jsonl.gz'));
		expect(pub[0]).toMatchObject({ t: 'header', v: 1, matchId: 'm-1', roomId: 'r-1', players: ['A', 'B'], ai: [false, false] });
		expect(pub[pub.length - 1]).toMatchObject({ t: 'end', winner: 0 });
		events.exit('clean');
		expect(exit).toBeDefined();
	});

	it('onEnvelope records only WATCHER_SEAT, and ignores an unknown matchId', async () => {
		dir = mkdtempSync(join(tmpdir(), 'cardtable-recorder-'));
		const inner = fakeFactory();
		const recorder = createRecorder({ dir, identity: { pin: null, bridge: 'b', server: 's' }, roomOf: () => null, deckCosts: NO_COSTS });
		const hosted = recorder.host(inner);
		hosted('m-1', spec(1), { line: () => undefined, exit: () => undefined, log: () => undefined });
		const events = inner.calls[0]!.events;

		recorder.onEnvelope('m-1', 0, { matchId: 'm-1', cursor: { epoch: 'e', seq: 1 }, frame: { kind: 'notify' } } as never);
		recorder.onEnvelope('m-unknown', -1, { matchId: 'm-unknown', cursor: { epoch: 'e', seq: 1 }, frame: { kind: 'notify' } } as never);
		recorder.onEnvelope('m-1', -1, { matchId: 'm-1', cursor: { epoch: 'e', seq: 2 }, frame: { kind: 'notify', method: 'openView' } } as never);

		(events.exit as (r: string) => void)('stopped');
		await vi.waitFor(() => expect(existsSync(join(dir, 'm-1.public.jsonl.gz'))).toBe(true));
		const pub = linesOf(join(dir, 'm-1.public.jsonl.gz'));
		// header + exactly the one WATCHER_SEAT envelope + end
		expect(pub.filter((l) => l.t === 'env')).toHaveLength(1);
	});

	it('a late onEnvelope/onGameOver after exit is a quiet no-op, and never recreates the files', async () => {
		dir = mkdtempSync(join(tmpdir(), 'cardtable-recorder-'));
		const inner = fakeFactory();
		const recorder = createRecorder({ dir, identity: { pin: null, bridge: 'b', server: 's' }, roomOf: () => null, deckCosts: NO_COSTS });
		const hosted = recorder.host(inner);
		hosted('m-1', spec(1), { line: () => undefined, exit: () => undefined, log: () => undefined });
		const events = inner.calls[0]!.events;
		(events.exit as (r: string) => void)('clean');
		await vi.waitFor(() => expect(existsSync(join(dir, 'm-1.actions.jsonl.gz'))).toBe(true));
		expect(() => recorder.onGameOver({ id: 'm-1', endedAt: Date.now(), winner: 'A', winnerSeat: 0, concededBy: null, spec: spec(1) })).not.toThrow();
		expect(() => recorder.onEnvelope('m-1', -1, { matchId: 'm-1', cursor: { epoch: 'e', seq: 1 }, frame: { kind: 'notify' } } as never)).not.toThrow();
		expect(existsSync(join(dir, 'm-1.actions.jsonl.gz'))).toBe(true);
	});
});
