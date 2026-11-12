/**
 * `RelayMatch`: `RelaySession` composed with `HostedMatch`'s own seat/rejoin-grace/watcher
 * machinery — the end recorded by the shell, and a seat leaving past its own rejoin grace.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerGameType, type GameTypeSpec } from '@hadoku/shared';

import { openLobby } from '../../room/lobby.ts';
import { createRelayMatch, createRelayMatchRegistry, relayMatches, type RelayMatchDeps } from './relay-match.ts';

function deps(overrides: Partial<RelayMatchDeps> = {}): RelayMatchDeps {
	return { log: () => {}, ...overrides };
}

function sink(): { toSeat: ReturnType<typeof vi.fn>; toWatchers: ReturnType<typeof vi.fn> } {
	return { toSeat: vi.fn(), toWatchers: vi.fn() };
}

const ALICE = 'fk:aaaaaaaaaaaaaaaa';
const BOB = 'fk:bbbbbbbbbbbbbbbb';
const CAROL = 'fk:cccccccccccccccc';

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('RelayMatch.roleOf', () => {
	it('claims a free seat for a new participant, keeps it for the same one, and leaves a full table a watcher', () => {
		const m = createRelayMatch('m1', 2, deps());
		expect(m.roleOf(ALICE)).toBe(0);
		expect(m.roleOf(ALICE)).toBe(0);
		expect(m.roleOf(BOB)).toBe(1);
		expect(m.roleOf(CAROL)).toBeNull();
		// Never `undefined`: this match has no membership of its own to refuse a stranger by.
		expect(m.roleOf(CAROL)).not.toBeUndefined();
	});
});

describe('RelayMatch.attach', () => {
	it('builds the session once, wires the sink, and goes running the instant it has somewhere to relay to', () => {
		const m = createRelayMatch('m1', 2, deps());
		expect(m.status).toBe('starting');
		const s = sink();
		const onEnded = vi.fn();
		const session = m.attach(s, onEnded);
		expect(m.status).toBe('running');
		session.fromSeat(0, 'hi');
		expect(s.toSeat).toHaveBeenCalledWith(1, 'hi');
	});

	it('a second attach() returns the same session rather than building another', () => {
		const m = createRelayMatch('m1', 2, deps());
		const first = m.attach(sink(), () => {});
		const second = m.attach(sink(), () => {});
		expect(second).toBe(first);
	});
});

describe('RelayMatch: the end recorded by the shell', () => {
	it("the leader's own { t: 'over' } ends the match AND the shell's own status, through the one onEnded path", () => {
		const ended = vi.fn();
		const m = createRelayMatch('m1', 2, deps({ ended }));
		const attached = vi.fn();
		const session = m.attach(sink(), attached);
		m.roleOf(ALICE);
		m.roleOf(BOB);
		// Drive the end the way `relay-socket.ts` does: through the session itself.
		session.fromSeat(0, { t: 'over', winners: [0] });
		expect(m.status).toBe('over');
		expect(m.result).toEqual({ winners: [0] });
		expect(attached).toHaveBeenCalledWith({ winners: [0] });
		expect(ended).toHaveBeenCalledTimes(1);
	});

	it('every seat left ends the match with a null outcome, recorded the same way', () => {
		const m = createRelayMatch('m1', 2, deps());
		const session = m.attach(sink(), () => {});
		m.roleOf(ALICE);
		m.roleOf(BOB);
		session.seatLeft(0);
		expect(m.status).toBe('running');
		session.seatLeft(1);
		expect(m.status).toBe('over');
		expect(m.result).toBeNull();
	});
});

describe('RelayMatch: a seat past its own rejoin grace', () => {
	it('with no `seatRejoinGraceMs`, a disconnected seat never leaves on its own', () => {
		const m = createRelayMatch('m1', 2, deps());
		const s = sink();
		m.attach(s, () => {});
		m.roleOf(ALICE);
		m.roleOf(BOB);
		m.seatConnected(0);
		m.seatDisconnected(0);
		vi.advanceTimersByTime(10 * 60_000);
		expect(m.status).toBe('running');
	});

	it('past `seatRejoinGraceMs` with no reconnect, the seat is out: `RelaySession.seatLeft` fires for it, and the match ends once BOTH are out', () => {
		const m = createRelayMatch('m1', 2, deps({ seatRejoinGraceMs: 1000 }));
		const s = sink();
		m.attach(s, () => {});
		m.roleOf(ALICE);
		m.roleOf(BOB);
		m.seatConnected(0);
		m.seatConnected(1);
		m.seatDisconnected(0);
		vi.advanceTimersByTime(999);
		expect(m.status).toBe('running');
		vi.advanceTimersByTime(2);
		expect(m.status).toBe('running'); // seat 1 is still here
		m.seatDisconnected(1);
		vi.advanceTimersByTime(1001);
		expect(m.status).toBe('over');
		expect(m.result).toBeNull();
	});

	it('reconnecting before the grace elapses cancels it: the seat stays in, the match keeps running', () => {
		const m = createRelayMatch('m1', 2, deps({ seatRejoinGraceMs: 1000 }));
		m.attach(sink(), () => {});
		m.roleOf(ALICE);
		m.roleOf(BOB);
		m.seatConnected(0);
		m.seatConnected(1);
		m.seatDisconnected(0);
		vi.advanceTimersByTime(500);
		m.seatConnected(0);
		vi.advanceTimersByTime(1000);
		expect(m.status).toBe('running');
	});

});

describe('RelayMatch.serverStopping', () => {
	it("forwards a { t: 'notice' } to every seat through the session, once attached", () => {
		const m = createRelayMatch('m1', 2, deps());
		const s = sink();
		m.attach(s, () => {});
		m.serverStopping('The server is restarting for a deploy.');
		expect(s.toSeat).toHaveBeenCalledWith(0, { t: 'notice', message: 'The server is restarting for a deploy.' });
		expect(s.toSeat).toHaveBeenCalledWith(1, { t: 'notice', message: 'The server is restarting for a deploy.' });
	});

	it('before attach(), there is no session yet, so it is a no-op rather than a throw', () => {
		const m = createRelayMatch('m1', 2, deps());
		expect(() => m.serverStopping('bye')).not.toThrow();
	});
});

describe('createRelayMatchRegistry', () => {
	it('register() then get() returns the same match; a second register() under the same id replaces it', () => {
		const reg = createRelayMatchRegistry();
		const first = reg.register('m1', 2, deps());
		expect(reg.get('m1')).toBe(first);
		const second = reg.register('m1', 2, deps());
		expect(reg.get('m1')).toBe(second);
		expect(reg.get('m1')).not.toBe(first);
	});

	it('forgets a match once it ends, and still tells the caller\'s own `ended` hook', () => {
		const reg = createRelayMatchRegistry();
		const ended = vi.fn();
		const match = reg.register('m1', 2, deps({ ended }));
		const session = match.attach(sink(), () => {});
		session.seatLeft(0);
		session.seatLeft(1);
		expect(reg.get('m1')).toBeUndefined();
		expect(ended).toHaveBeenCalledTimes(1);
	});

	it('get() of an unregistered id is undefined', () => {
		const reg = createRelayMatchRegistry();
		expect(reg.get('nope')).toBeUndefined();
	});
});

describe("room/lobby.ts's own hook (the ≤30-line start call site)", () => {
	const dirs: string[] = [];
	async function tempDir(): Promise<string> {
		const dir = await mkdtemp(join(tmpdir(), 'cardtable-relay-lobby-test-'));
		dirs.push(dir);
		return dir;
	}
	afterAll(async () => {
		for (const dir of dirs) await rm(dir, { recursive: true, force: true });
	});

	const RELAY_LOBBY_TEST_TYPE: GameTypeSpec = {
		id: 'relay-lobby-test',
		runtime: 'relay',
		seats: { min: 2, max: 2 },
		ready: false,
		series: { length: 1 },
		canStart: (seated) => (seated >= 2 ? { ok: true } : { ok: false, reason: 'not-enough-players' }),
	};
	registerGameType(RELAY_LOBBY_TEST_TYPE);

	const NON_RELAY_TEST_TYPE: GameTypeSpec = {
		id: 'non-relay-lobby-test',
		seats: { min: 2, max: 2 },
		ready: false,
		series: { length: 1 },
		canStart: (seated) => (seated >= 2 ? { ok: true } : { ok: false, reason: 'not-enough-players' }),
	};
	registerGameType(NON_RELAY_TEST_TYPE);

	const ALICE_MEMBER = { id: 'fk:1111111111111111', name: 'alice', userId: 'uid-alice' };

	/** What `plugins/relay.ts` wires onto a REAL lobby at boot — see `Lobby.onRelayRoomOpened`'s
	 *  own doc for why `lobby.ts` calls this hook rather than importing `relay-match.ts` itself
	 *  (the import cycle back to `match.ts`'s `HostedMatch` it would otherwise close). */
	function wireRelay(lobby: Awaited<ReturnType<typeof openLobby>>): void {
		lobby.onRelayRoomOpened((roomId, seatCount) => {
			relayMatches.register(roomId, seatCount, { log: () => {} });
		});
	}

	it("a `runtime: 'relay'` room registers a `RelayMatch` under its own room id, sized from the game type's seats, the moment it is created", async () => {
		const lobby = await openLobby({ dir: await tempDir() });
		wireRelay(lobby);
		const made = lobby.create(ALICE_MEMBER, { name: 'relay lobby test', gameType: RELAY_LOBBY_TEST_TYPE.id, clientMode: 'builtin' });
		expect(made.ok).toBe(true);
		if (!made.ok) throw new Error(made.reason);
		const match = relayMatches.get(made.room.id);
		expect(match).toBeDefined();
		expect(match?.seatCount).toBe(2);
	});

	it('an ordinary (non-relay) room registers no `RelayMatch` at all', async () => {
		const lobby = await openLobby({ dir: await tempDir() });
		wireRelay(lobby);
		const made = lobby.create(ALICE_MEMBER, { name: 'ordinary lobby test', gameType: NON_RELAY_TEST_TYPE.id, clientMode: 'builtin' });
		expect(made.ok).toBe(true);
		if (!made.ok) throw new Error(made.reason);
		expect(relayMatches.get(made.room.id)).toBeUndefined();
	});

	it('without the hook wired (a unit suite, or before the plugin runs), a relay room is created with no RelayMatch at all, never throwing', async () => {
		const lobby = await openLobby({ dir: await tempDir() });
		const made = lobby.create(ALICE_MEMBER, { name: 'unwired relay lobby test', gameType: RELAY_LOBBY_TEST_TYPE.id, clientMode: 'builtin' });
		expect(made.ok).toBe(true);
		if (!made.ok) throw new Error(made.reason);
		expect(relayMatches.get(made.room.id)).toBeUndefined();
	});
});
