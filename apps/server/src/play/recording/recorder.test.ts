import { gunzipSync } from 'node:zlib';
import type { PresenceMessage, SeatIdentity } from '@hadoku/shared';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import type { DeckCosts } from '../deck-colors.js';
import type { BridgeLine, HostEvents, MatchHost, MatchHostFactory, MatchSpec } from '../host.js';
import { anonymousSpec, bridgeDigest, createRecorder, forgePin, SEATS_RECORD_MS, serverVersion } from './recorder.js';

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
	factory.room = () => 'none';
	return factory;
}

describe('forgePin / bridgeDigest / serverVersion', () => {
	it('reads the pin from a 40-hex jar name, and null from forge.jar outside a pin directory', () => {
		const sha = 'a'.repeat(40);
		expect(forgePin(`/jars/${sha}.jar`)).toBe(sha);
		expect(forgePin('/jars/forge.jar')).toBeNull();
	});

	it('falls back to the parent directory\'s name — CI\'s own bundle layout (scripts/forge-bundle.sh), always literally forge.jar with the pin as the cache directory', () => {
		const sha = 'b'.repeat(40);
		expect(forgePin(`/home/x/.cache/cardtable-forge/${sha}/forge.jar`)).toBe(sha);
		// Neither name is a pin: no fallback fires.
		expect(forgePin('/home/x/.cache/cardtable-forge/forge.jar')).toBeNull();
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

	it('reads the version the build wrote to dist/version.txt, and "unknown" when there is none', () => {
		dir = mkdtempSync(join(tmpdir(), 'cardtable-pkg-'));
		mkdirSync(join(dir, 'dist'));
		writeFileSync(join(dir, 'dist', 'version.txt'), 'v0.45.0+1a2b3c4d5\n');
		expect(serverVersion(dir)).toBe('v0.45.0+1a2b3c4d5');
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
		expect(hosted.room!()).toBe('none');
	});

	it("keeps a class host's own methods: stop, handOver and remember reach it (placement's Face)", () => {
		dir = mkdtempSync(join(tmpdir(), 'cardtable-recorder-'));
		const said: string[] = [];
		class ClassHost implements MatchHost {
			send(): void {
				said.push('send');
			}
			stop(): void {
				said.push('stop');
			}
			handOver(): boolean {
				said.push('handOver');
				return true;
			}
			remember(): void {
				said.push('remember');
			}
		}
		const inner = (() => new ClassHost()) as unknown as MatchHostFactory;
		const recorder = createRecorder({ dir, identity: { pin: null, bridge: 'b', server: 's' }, roomOf: () => null, deckCosts: NO_COSTS });
		const host = recorder.host(inner)('m-9', spec(1), { line: () => undefined, exit: () => undefined, log: () => undefined });
		expect(host.handOver?.()).toBe(true);
		host.remember?.({ epoch: 'e', owners: [null, null] });
		host.stop();
		expect(said).toEqual(['handOver', 'remember', 'stop']);
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
		// Each seat's final board, for a rebuild to be checked against.
		expect((actions[3] as unknown as { boards: string[] }).boards).toEqual([expect.stringMatching(/^[0-9a-f]{64}$/), expect.stringMatching(/^[0-9a-f]{64}$/)]);

		const pub = linesOf(join(dir, 'm-1.public.jsonl.gz'));
		expect(pub[0]).toMatchObject({ t: 'header', v: 2, matchId: 'm-1', roomId: 'r-1', players: ['A', 'B'], ai: [false, false], art: [] });
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

	it('onPresence keeps the active seat\'s pointer at most every 100 ms, but never drops a change of what the hands are doing', async () => {
		dir = mkdtempSync(join(tmpdir(), 'cardtable-recorder-'));
		const inner = fakeFactory();
		let clock = 1_000;
		const recorder = createRecorder({ dir, identity: { pin: null, bridge: 'b', server: 's' }, roomOf: () => null, deckCosts: NO_COSTS, now: () => clock });
		const hosted = recorder.host(inner);
		hosted('m-1', spec(1), { line: () => undefined, exit: () => undefined, log: () => undefined });
		const events = inner.calls[0]!.events;
		const at = (x: number, held = false): PresenceMessage => ({
			matchId: 'm-1',
			type: 'presence',
			pointer: { zone: 'hand', x, y: 0.5 },
			anchor: null,
			held,
			from: null,
			arranging: null,
			placing: null,
			handMove: null,
		});

		recorder.onPresence('m-1', 0, 1, at(0.1)); // kept: the first
		clock += 40;
		recorder.onPresence('m-1', 0, 1, at(0.2)); // dropped: 40 ms on, same hands
		clock += 20;
		recorder.onPresence('m-1', 0, 1, at(0.3, true)); // kept: a card lifted, 60 ms on
		clock += 100;
		recorder.onPresence('m-1', 0, 1, at(0.4, true)); // kept: 100 ms on
		recorder.onPresence('m-unknown', 0, 1, at(0.5)); // no session: nothing

		(events.exit as (r: string) => void)('stopped');
		await vi.waitFor(() => expect(existsSync(join(dir, 'm-1.public.jsonl.gz'))).toBe(true));
		const kept = linesOf(join(dir, 'm-1.public.jsonl.gz')).filter((l) => l.t === 'presence');
		expect(kept.map((l) => [l.at, l.seat, l.playerId, (l.presence as PresenceMessage).pointer?.x, (l.presence as PresenceMessage).held])).toEqual([
			[0, 0, 1, 0.1, false],
			[60, 0, 1, 0.3, true],
			[160, 0, 1, 0.4, true],
		]);
	});

	it('onPresence keeps where a pointer came to rest: a position dropped inside the 100 ms is written when the 100 ms is up', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: 1_000 });
		onTestFinished(() => {
			vi.useRealTimers();
		});
		dir = mkdtempSync(join(tmpdir(), 'cardtable-recorder-'));
		const inner = fakeFactory();
		const tick = (ms: number): void => {
			vi.advanceTimersByTime(ms);
		};
		const recorder = createRecorder({ dir, identity: { pin: null, bridge: 'b', server: 's' }, roomOf: () => null, deckCosts: NO_COSTS, now: () => Date.now() });
		const hosted = recorder.host(inner);
		hosted('m-1', spec(1), { line: () => undefined, exit: () => undefined, log: () => undefined });
		const events = inner.calls[0]!.events;
		const at = (seat: number, x: number, held = false): PresenceMessage => ({
			matchId: 'm-1',
			type: 'presence',
			pointer: { zone: 'hand', x, y: 0.5 },
			anchor: null,
			held,
			from: null,
			arranging: null,
			placing: null,
			handMove: null,
		});

		recorder.onPresence('m-1', 0, 1, at(0, 0.1)); // kept: the first
		tick(40);
		recorder.onPresence('m-1', 0, 1, at(0, 0.2)); // inside the 100 ms: held back
		tick(20);
		recorder.onPresence('m-1', 0, 1, at(0, 0.25)); // still inside: replaces it
		tick(400); // the pointer rests on 0.25; its 100 ms ran out 340 ms ago
		recorder.onPresence('m-1', 0, 1, at(0, 0.25, true)); // a card lifted where it rests
		tick(30);
		recorder.onPresence('m-1', 0, 1, at(0, 0.3, true)); // inside: held back
		recorder.onPresence('m-1', 1, 2, at(1, 0.9)); // the other seat: kept, and seat 0's held-back line first
		tick(200);
		vi.useRealTimers();

		(events.exit as (r: string) => void)('stopped');
		await vi.waitFor(() => expect(existsSync(join(dir, 'm-1.public.jsonl.gz'))).toBe(true));
		const kept = linesOf(join(dir, 'm-1.public.jsonl.gz')).filter((l) => l.t === 'presence');
		expect(kept.map((l) => [l.at, l.seat, (l.presence as PresenceMessage).pointer?.x, (l.presence as PresenceMessage).held])).toEqual([
			[0, 0, 0.1, false],
			[100, 0, 0.25, false],
			[460, 0, 0.25, true],
			[490, 0, 0.3, true],
			[490, 1, 0.9, false],
		]);
	});

	it('onPresence stamps a held-back line at a time its seat was active: a board change lets it out at the time it came in', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: 1_000 });
		onTestFinished(() => {
			vi.useRealTimers();
		});
		dir = mkdtempSync(join(tmpdir(), 'cardtable-recorder-'));
		const inner = fakeFactory();
		const recorder = createRecorder({ dir, identity: { pin: null, bridge: 'b', server: 's' }, roomOf: () => null, deckCosts: NO_COSTS, now: () => Date.now() });
		recorder.host(inner)('m-1', spec(1), { line: () => undefined, exit: () => undefined, log: () => undefined });
		const events = inner.calls[0]!.events;
		const at = (x: number): PresenceMessage => ({ matchId: 'm-1', type: 'presence', pointer: { zone: 'hand', x, y: 0.5 }, anchor: null, held: false, from: null, arranging: null, placing: null, handMove: null });

		recorder.onPresence('m-1', 0, 1, at(0.1)); // kept: seat 0 is active
		vi.advanceTimersByTime(40);
		recorder.onPresence('m-1', 0, 1, at(0.2)); // inside the 100 ms: held back
		vi.advanceTimersByTime(30);
		recorder.onEnvelope('m-1', -1, { matchId: 'm-1', cursor: { epoch: 'e', seq: 1 }, frame: { kind: 'notify' } } as never); // the turn passes
		vi.advanceTimersByTime(10);
		recorder.onPresence('m-1', 1, 2, at(0.9)); // seat 1 is active now
		vi.advanceTimersByTime(200);
		vi.useRealTimers();

		(events.exit as (r: string) => void)('stopped');
		await vi.waitFor(() => expect(existsSync(join(dir, 'm-1.public.jsonl.gz'))).toBe(true));
		const lines = linesOf(join(dir, 'm-1.public.jsonl.gz'));
		expect(lines.filter((l) => l.t === 'env').map((l) => l.at)).toEqual([70]);
		expect(lines.filter((l) => l.t === 'presence').map((l) => [l.at, l.seat, (l.presence as PresenceMessage).pointer?.x])).toEqual([
			[0, 0, 0.1],
			[40, 0, 0.2],
			[80, 1, 0.9],
		]);
	});

	/** Drives `steps` presence messages through a recorder on fake timers; returns the presence lines it wrote. */
	async function recordPresence(steps: { gap: number; seat: number; x: number; held?: boolean }[]): Promise<{ at: number; seat: number; x: number | undefined }[]> {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: 1_000 });
		dir = mkdtempSync(join(tmpdir(), 'cardtable-recorder-'));
		const inner = fakeFactory();
		const recorder = createRecorder({ dir, identity: { pin: null, bridge: 'b', server: 's' }, roomOf: () => null, deckCosts: NO_COSTS, now: () => Date.now() });
		recorder.host(inner)('m-1', spec(1), { line: () => undefined, exit: () => undefined, log: () => undefined });
		const events = inner.calls[0]!.events;
		for (const s of steps) {
			vi.advanceTimersByTime(s.gap);
			recorder.onPresence('m-1', s.seat, s.seat + 1, {
				matchId: 'm-1',
				type: 'presence',
				pointer: { zone: 'hand', x: s.x, y: 0.5 },
				anchor: null,
				held: s.held ?? false,
				from: null,
				arranging: null,
				placing: null,
				handMove: null,
			});
		}
		vi.advanceTimersByTime(500);
		vi.useRealTimers();
		(events.exit as (r: string) => void)('stopped');
		await vi.waitFor(() => expect(existsSync(join(dir, 'm-1.public.jsonl.gz'))).toBe(true));
		return linesOf(join(dir, 'm-1.public.jsonl.gz'))
			.filter((l) => l.t === 'presence')
			.map((l) => ({ at: l.at as number, seat: l.seat as number, x: (l.presence as PresenceMessage).pointer?.x }));
	}

	it('onPresence writes no more than one position per 100 ms for a pointer that never stops, as before it held any back', async () => {
		// Two seconds of one seat's pointer at 100 a second (ten times what a seat sends), hands unchanged.
		const lines = await recordPresence(Array.from({ length: 200 }, (_, i) => ({ gap: 10, seat: 0, x: i / 200 })));
		expect(lines.length).toBeLessThanOrEqual(2_000 / 100 + 1);
		for (let i = 1; i < lines.length; i += 1) expect(lines[i]!.at - lines[i - 1]!.at, `line ${i}`).toBeGreaterThanOrEqual(100);
		expect(lines.at(-1)!.x, 'and the last place it was is the last line').toBe(199 / 200);
	});

	it('onPresence writes its lines in time order across both seats, whatever order their messages come in', async () => {
		let seed = 7;
		const random = (): number => {
			seed = (seed * 48_271) % 2_147_483_647;
			return seed / 2_147_483_647;
		};
		const steps = Array.from({ length: 400 }, () => ({ gap: Math.floor(random() * 80), seat: random() < 0.5 ? 0 : 1, x: random(), held: random() < 0.1 }));
		const lines = await recordPresence(steps);
		for (let i = 1; i < lines.length; i += 1) expect(lines[i]!.at, `line ${i}`).toBeGreaterThanOrEqual(lines[i - 1]!.at);
		for (const seat of [0, 1]) {
			const sent = steps.filter((s) => s.seat === seat);
			expect(lines.filter((l) => l.seat === seat).at(-1)!.x, `seat ${seat}'s last position is kept`).toBe(sent.at(-1)!.x);
		}
	});

	it('onRelay keeps every relayed table message, each one, timed from the match start', async () => {
		dir = mkdtempSync(join(tmpdir(), 'cardtable-recorder-'));
		const inner = fakeFactory();
		let clock = 1_000;
		const recorder = createRecorder({ dir, identity: { pin: null, bridge: 'b', server: 's' }, roomOf: () => null, deckCosts: NO_COSTS, now: () => clock });
		const hosted = recorder.host(inner);
		hosted('m-1', spec(1), { line: () => undefined, exit: () => undefined, log: () => undefined });
		const events = inner.calls[0]!.events;
		const placement = { matchId: 'm-1', seat: 0, card: 21, slot: 'lands', target: { kind: 'end' }, at: { zone: 'battlefield', x: 0.3, y: 0.6 } };
		const rows = { matchId: 'm-1', seat: 0, type: 'arrangement', layout: 'tiers', rows: { back: [[21]] } };

		clock += 250;
		recorder.onRelay('m-1', 'forge:placement', placement);
		clock += 10;
		recorder.onRelay('m-1', 'forge:arrangement', rows);
		recorder.onRelay('m-1', 'forge:arrangement', rows); // never thinned: each is the table as it stood
		recorder.onRelay('m-unknown', 'forge:placement', placement); // no session: nothing

		(events.exit as (r: string) => void)('stopped');
		await vi.waitFor(() => expect(existsSync(join(dir, 'm-1.public.jsonl.gz'))).toBe(true));
		const kept = linesOf(join(dir, 'm-1.public.jsonl.gz')).filter((l) => l.t === 'relay');
		expect(kept).toEqual([
			{ t: 'relay', at: 250, event: 'forge:placement', echo: placement },
			{ t: 'relay', at: 260, event: 'forge:arrangement', echo: rows },
			{ t: 'relay', at: 260, event: 'forge:arrangement', echo: rows },
		]);
	});

	it("keeps each seat holder's userId beside their seat, so the replay can draw them as they are when watched", async () => {
		dir = mkdtempSync(join(tmpdir(), 'cardtable-recorder-'));
		const inner = fakeFactory();
		const roster: SeatIdentity[] = [
			{ seat: 0, claimed: true, playerId: 0, avatarId: 'sage' },
			{ seat: 1, claimed: false, playerId: null, avatarId: 'ai-face' },
		];
		const recorder = createRecorder({ dir, identity: { pin: null, bridge: 'b', server: 's' }, roomOf: () => null, deckCosts: NO_COSTS, seatsOf: () => roster, usersOf: () => ['uid-ari', null] });
		recorder.host(inner)('m-1', spec(1), { line: () => undefined, exit: () => undefined, log: () => undefined });
		(inner.calls[0]!.events.exit as (r: string) => void)('stopped');
		await vi.waitFor(() => expect(existsSync(join(dir, 'm-1.public.jsonl.gz'))).toBe(true));
		const pub = linesOf(join(dir, 'm-1.public.jsonl.gz'));
		expect(pub[pub.length - 1]?.seats).toEqual([
			{ seat: 0, claimed: true, playerId: 0, avatarId: 'sage', userId: 'uid-ari' },
			{ seat: 1, claimed: false, playerId: null, avatarId: 'ai-face' },
		]);
	});

	it('keeps no person\'s name in the 90-day action log: its seats are Player 1 and 2, and its end line names them by userId (#27)', async () => {
		dir = mkdtempSync(join(tmpdir(), 'cardtable-recorder-'));
		const inner = fakeFactory();
		const roster: SeatIdentity[] = [
			{ seat: 0, claimed: true, playerId: 0 },
			{ seat: 1, claimed: true, playerId: 1 },
		];
		const recorder = createRecorder({ dir, identity: { pin: null, bridge: 'b', server: 's' }, roomOf: () => null, deckCosts: NO_COSTS, seatsOf: () => roster, usersOf: () => ['uid-ari', 'uid-bo'] });
		const played: MatchSpec = { seed: 1, seats: [{ name: 'Ari Realname', ai: false, deck: null }, { name: 'Bo Realname', ai: false, deck: null }] };
		recorder.host(inner)('m-1', played, { line: () => undefined, exit: () => undefined, log: () => undefined });
		expect(inner.calls[0]!.spec.seats.map((s) => s.name), 'Forge still plays the people by name').toEqual(['Ari Realname', 'Bo Realname']);
		(inner.calls[0]!.events.exit as (r: string) => void)('stopped');
		const file = join(dir, 'm-1.actions.jsonl.gz');
		await vi.waitFor(() => expect(existsSync(file)).toBe(true));
		const lines = linesOf(file);
		expect(JSON.stringify(lines)).not.toContain('Realname');
		expect((lines[0]!.spec as MatchSpec).seats.map((s) => s.name)).toEqual(['Player 1', 'Player 2']);
		expect(lines.at(-1)?.users).toEqual(['uid-ari', 'uid-bo']);
	});

	it('the AI keeps the name Forge plays it by', () => {
		const vsAi: MatchSpec = { seats: [{ name: 'Ari', ai: false, deck: null }, { name: 'Forge AI', ai: true, deck: null }] };
		expect(anonymousSpec(vsAi).seats.map((s) => s.name)).toEqual(['Player 1', 'Forge AI']);
	});

	it("writes the roster's faces on the end line, keeping the last one read when the match is already gone", async () => {
		dir = mkdtempSync(join(tmpdir(), 'cardtable-recorder-'));
		const inner = fakeFactory();
		let clock = 0;
		let roster: SeatIdentity[] | undefined = [
			{ seat: 0, claimed: true, playerId: 0, avatarId: 'old-face' },
			{ seat: 1, claimed: false, playerId: null, avatarId: 'ai-face' },
		];
		const recorder = createRecorder({ dir, identity: { pin: null, bridge: 'b', server: 's' }, roomOf: () => null, deckCosts: NO_COSTS, now: () => clock, seatsOf: () => roster });
		recorder.host(inner)('m-1', spec(1), { line: () => undefined, exit: () => undefined, log: () => undefined });
		const envelope = { matchId: 'm-1', cursor: { epoch: 'e', seq: 1 }, frame: { kind: 'notify' } } as never;

		recorder.onEnvelope('m-1', -1, envelope);
		// A face changed mid-game is read again once SEATS_RECORD_MS has passed.
		roster = [{ seat: 0, claimed: true, playerId: 0, avatarId: 'new-face' }, { seat: 1, claimed: false, playerId: null, avatarId: 'ai-face', waitingOn: { method: 'm', hostCard: null } }];
		clock = SEATS_RECORD_MS;
		recorder.onEnvelope('m-1', -1, envelope);
		// Then the match is let go of before its JVM exits.
		roster = undefined;
		(inner.calls[0]!.events.exit as (r: string) => void)('stopped');

		await vi.waitFor(() => expect(existsSync(join(dir, 'm-1.public.jsonl.gz'))).toBe(true));
		const pub = linesOf(join(dir, 'm-1.public.jsonl.gz'));
		expect(pub[pub.length - 1]).toEqual({
			t: 'end',
			endedAt: new Date(SEATS_RECORD_MS).toISOString(),
			winner: null,
			seats: [
				{ seat: 0, claimed: true, playerId: 0, avatarId: 'new-face' },
				{ seat: 1, claimed: false, playerId: null, avatarId: 'ai-face' },
			],
		});
	});

	it('names the room in both headers when the room links its match only after the host started', async () => {
		dir = mkdtempSync(join(tmpdir(), 'cardtable-recorder-'));
		const inner = fakeFactory();
		let linked: string | null = null;
		const recorder = createRecorder({ dir, identity: { pin: null, bridge: 'b', server: 's' }, roomOf: () => linked, deckCosts: NO_COSTS });
		recorder.host(inner)('m-1', spec(1), { line: () => undefined, exit: () => undefined, log: () => undefined });
		// The lobby sets `table.matchId` once `matches.create` has returned: after the host asked.
		linked = 'r-1';
		recorder.onEnvelope('m-1', -1, { matchId: 'm-1', cursor: { epoch: 'e', seq: 1 }, frame: { kind: 'notify' } } as never);
		// A room that lets go of its match before the end keeps the answer it gave.
		linked = null;
		(inner.calls[0]!.events.exit as (r: string) => void)('stopped');

		await vi.waitFor(() => expect(existsSync(join(dir, 'm-1.public.jsonl.gz'))).toBe(true));
		expect(linesOf(join(dir, 'm-1.public.jsonl.gz'))[0]).toMatchObject({ t: 'header', roomId: 'r-1' });
		expect(linesOf(join(dir, 'm-1.actions.jsonl.gz'))[0]).toMatchObject({ t: 'header', roomId: 'r-1' });
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
