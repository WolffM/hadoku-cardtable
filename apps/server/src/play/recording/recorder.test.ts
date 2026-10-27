import { gunzipSync } from 'node:zlib';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DeckCosts } from '../deck-colors.js';
import type { BridgeLine, HostEvents, MatchHost, MatchHostFactory, MatchSpec } from '../host.js';
import { bridgeDigest, createRecorder, forgePin, recordingsDir, serverVersion } from './recorder.js';

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

describe('recordingsDir', () => {
	it('defaults under ~/.local/share/cardtable, and honours CARDTABLE_RECORDINGS_DIR', () => {
		expect(recordingsDir({})).toMatch(/\.local\/share\/cardtable\/recordings$/);
		expect(recordingsDir({ CARDTABLE_RECORDINGS_DIR: '/tmp/x' })).toBe('/tmp/x');
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

	it('records a header, a cmd line per send with that seat\'s board digest and prompt, and an end line with the winner', async () => {
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
		events.line({ t: 'frame', seat: 0, frame: { kind: 'notify', method: 'setGameView', payload: { gameView: { 'card:1': { _type: 1, _id: 1, Name: { t: 's', v: 'Shock' } } }, sequenceNumber: 0 } } } as BridgeLine);
		events.line({ t: 'frame', seat: 0, frame: { kind: 'notify', method: 'showPromptMessage', message: 'Priority: A' } } as BridgeLine);
		host.send({ t: 'act', seat: 0, frame: { kind: 'act', method: 'selectButtonOk' } });
		host.send({ t: 'stop' });
		recorder.onGameOver({ id: 'm-1', endedAt: Date.now(), winner: 'A', winnerSeat: 0, concededBy: null, spec: spec(1) });
		events.exit('clean');

		expect(inner.sends).toEqual([{ t: 'act', seat: 0, frame: { kind: 'act', method: 'selectButtonOk' } }, { t: 'stop' }]);
		await vi.waitFor(() => {
			expect(existsSync(join(dir, 'm-1.actions.jsonl.gz'))).toBe(true);
			expect(existsSync(join(dir, 'm-1.public.jsonl.gz'))).toBe(true);
		});

		const actions = linesOf(join(dir, 'm-1.actions.jsonl.gz'));
		expect(actions[0]).toMatchObject({ t: 'header', v: 1, matchId: 'm-1', roomId: 'r-1', pin: 'pin-1', bridge: 'bridge-1', server: 'server-1' });
		expect(actions[1]).toMatchObject({ t: 'cmd', seat: 0, prompt: 'Priority: A', cmd: { t: 'act', seat: 0, frame: { kind: 'act', method: 'selectButtonOk' } } });
		expect((actions[1] as unknown as { board: string }).board).toMatch(/^[0-9a-f]{64}$/);
		expect(actions[2]).toMatchObject({ t: 'cmd', seat: null, prompt: '', board: '', cmd: { t: 'stop' } });
		expect(actions[3]).toMatchObject({ t: 'end', reason: 'clean' });

		const pub = linesOf(join(dir, 'm-1.public.jsonl.gz'));
		expect(pub[0]).toMatchObject({ t: 'header', v: 1, matchId: 'm-1', roomId: 'r-1', players: ['A', 'B'], ai: [false, false] });
		expect(pub[pub.length - 1]).toMatchObject({ t: 'end', winner: 0 });
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
