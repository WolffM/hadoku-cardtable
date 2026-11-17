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
import { createRelayMatch, createRelayMatchRegistry, relayMatches, type RelayMatchDeps } from '@hadoku/game-server/play/runtimes/relay-match';

const ALICE = 'fk:aaaaaaaaaaaaaaaa';
const BOB = 'fk:bbbbbbbbbbbbbbbb';
const CAROL = 'fk:cccccccccccccccc';

/** The room seats alice at 0 and bob at 1, alice leads; anyone else watches. */
function deps(overrides: Partial<RelayMatchDeps> = {}): RelayMatchDeps {
	const roomSeats = [ALICE, BOB];
	return { log: () => {}, roomSeatOf: (p) => (roomSeats.includes(p) ? roomSeats.indexOf(p) : null), leaderSeat: () => 0, ...overrides };
}

function sink(): { toSeat: ReturnType<typeof vi.fn>; toWatchers: ReturnType<typeof vi.fn> } {
	return { toSeat: vi.fn(), toWatchers: vi.fn() };
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('RelayMatch.roleOf', () => {
	it("seats each participant where the room seats them, whichever socket joins first, and leaves anyone the room seats nowhere a watcher", () => {
		const m = createRelayMatch('m1', 2, deps());
		// Carol, a watcher in the room, reaches the relay before bob: she still holds no seat.
		expect(m.roleOf(CAROL)).toBeNull();
		expect(m.roleOf(BOB)).toBe(1);
		expect(m.roleOf(ALICE)).toBe(0);
		expect(m.roleOf(ALICE)).toBe(0);
		// Never `undefined`: this match has no membership of its own to refuse a stranger by.
		expect(m.roleOf(CAROL)).not.toBeUndefined();
	});

	it("follows the room when a member moves seats: the new seat is theirs and the old one is nobody's", () => {
		const roomSeats: (string | null)[] = [ALICE, BOB];
		const m = createRelayMatch('m1', 2, deps({ roomSeatOf: (p) => (roomSeats.includes(p) ? roomSeats.indexOf(p) : null) }));
		expect(m.roleOf(ALICE)).toBe(0);
		roomSeats.splice(0, 2, null, ALICE);
		expect(m.roleOf(ALICE)).toBe(1);
		expect(m.seatOf(ALICE)).toBe(1);
		expect(m.seats[0]?.owner).toBeNull();
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

describe('RelayMatch: only the leader or the round\'s host ends it', () => {
	it("a seat that is neither the leader's nor the round's host sends over: refused and logged, relayed to nobody, and the match goes on", () => {
		const logs: Record<string, unknown>[] = [];
		const m = createRelayMatch('m1', 2, deps({ log: (e) => logs.push(e) }));
		const s = sink();
		const session = m.attach(s, () => {});
		// Nobody has joined (roleOf) yet, so there is no host seat either — seat 1 is refused on both counts.
		session.fromSeat(1, { t: 'over', winners: [1] });
		expect(m.status).toBe('running');
		expect(session.isEnded).toBe(false);
		expect(s.toSeat).not.toHaveBeenCalled();
		expect(s.toWatchers).not.toHaveBeenCalled();
		expect(logs).toContainEqual({ evt: 'relay-over-refused', matchId: 'm1', seat: 1, leaderSeat: 0, hostSeat: null });
		// A refused over does not start the match either: the last result is still told.
		session.fromSeat(0, { t: 'over', winners: [0] });
		expect(m.status).toBe('over');
		expect(m.result).toEqual({ winners: [0] });
	});

	it('a leader who holds no seat: nobody ends it with over; every seat leaving still does', () => {
		const m = createRelayMatch('m1', 2, deps({ leaderSeat: () => null }));
		const session = m.attach(sink(), () => {});
		session.fromSeat(0, { t: 'over', winners: [0] });
		expect(m.status).toBe('running');
		session.seatLeft(0);
		session.seatLeft(1);
		expect(m.status).toBe('over');
	});

	it("the round's HOST seat — the first to join, never only the leader (§G.3, bm1-BR) — ends it even when a DIFFERENT seat leads the room and never sends anything", () => {
		// Leader is seat 0 (alice), but bob (seat 1) joins first: he is this round's host. Alice
		// never sends anything at all, so bob's own `over` can only succeed through the HOST path.
		const m = createRelayMatch('m1', 2, deps({ leaderSeat: () => 0 }));
		const session = m.attach(sink(), () => {});
		expect(m.roleOf(BOB)).toBe(1);
		expect(m.hostSeat).toBe(1);
		session.fromSeat(1, { t: 'over', winners: [1] });
		expect(m.status).toBe('over');
	});

	it('the host and the leader can be two different seats; EITHER one alone ends the match (two separate matches isolate each path)', () => {
		// Bob (seat 1) is the host of this match; the leader (seat 0, alice) never joins or sends
		// anything — bob's over succeeds through the HOST path alone.
		const hostEnds = createRelayMatch('m1', 2, deps({ leaderSeat: () => 0 }));
		const hostSession = hostEnds.attach(sink(), () => {});
		expect(hostEnds.roleOf(BOB)).toBe(1);
		hostSession.fromSeat(1, { t: 'over', winners: [1] });
		expect(hostEnds.status).toBe('over');

		// A second, independent match: bob is again the host (seat 1), but this time it is the
		// LEADER's own seat (0, alice — never joined at all) that sends `over`, through the LEADER
		// path alone, with no participant ever occupying it.
		const leaderEnds = createRelayMatch('m2', 2, deps({ leaderSeat: () => 0 }));
		const leaderSession = leaderEnds.attach(sink(), () => {});
		expect(leaderEnds.roleOf(BOB)).toBe(1);
		leaderSession.fromSeat(0, { t: 'over', winners: [0] });
		expect(leaderEnds.status).toBe('over');
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

	it('logs the hold with its grace, the return, and a leave past it', () => {
		const logged: Record<string, unknown>[] = [];
		const m = createRelayMatch('m1', 2, deps({ seatRejoinGraceMs: 1000, log: (e) => logged.push(e) }));
		m.attach(sink(), () => {});
		m.roleOf(ALICE);
		m.roleOf(BOB);
		m.seatConnected(0);
		m.seatConnected(1);
		m.seatDisconnected(1);
		m.seatConnected(1);
		m.seatDisconnected(0);
		vi.advanceTimersByTime(1001);
		const relay = logged.filter((e) => String(e.evt).startsWith('relay-seat-'));
		expect(relay).toEqual([
			{ evt: 'relay-seat-held', matchId: 'm1', seat: 1, graceMs: 1000 },
			{ evt: 'relay-seat-back', matchId: 'm1', seat: 1 },
			{ evt: 'relay-seat-held', matchId: 'm1', seat: 0, graceMs: 1000 },
			{ evt: 'relay-seat-left', matchId: 'm1', seat: 0 },
		]);
	});

	it('with no grace, a drop logs no hold', () => {
		const logged: Record<string, unknown>[] = [];
		const m = createRelayMatch('m1', 2, deps({ log: (e) => logged.push(e) }));
		m.attach(sink(), () => {});
		m.roleOf(ALICE);
		m.seatConnected(0);
		m.seatDisconnected(0);
		expect(logged.filter((e) => String(e.evt).startsWith('relay-seat-'))).toEqual([]);
	});

	it("a seat that reconnects AFTER its own hold already expired is RE-ADMITTED to the still-running match, never muted forever (§G.3, bm1-BR: 'a seat past its relay hold was muted')", () => {
		const logged: Record<string, unknown>[] = [];
		const m = createRelayMatch('m1', 2, deps({ seatRejoinGraceMs: 1000, log: (e) => logged.push(e) }));
		const s = sink();
		const session = m.attach(s, () => {});
		m.roleOf(ALICE);
		m.roleOf(BOB);
		m.seatConnected(0);
		m.seatConnected(1);
		m.seatDisconnected(0);
		// Past the hold with no reconnect: seat 0 is conceded (`RelaySession.seatLeft`); the match
		// stays running because seat 1 (bob) is still here.
		vi.advanceTimersByTime(1001);
		expect(m.status).toBe('running');
		// Seat 0 comes back late. Without the fix this reconnect is a silent no-op at the session
		// level: `seatConnected` finds no pending timer to clear (it already fired) and does
		// nothing else, so `fromSeat(0, …)` below would still be dropped by `this.left.has(0)`.
		m.seatConnected(0);
		expect(logged).toContainEqual({ evt: 'relay-seat-readmitted', matchId: 'm1', seat: 0 });
		session.fromSeat(0, { t: 'hello-again' });
		expect(s.toSeat).toHaveBeenCalledWith(1, { t: 'hello-again' });
	});

	it('reconnecting WITHIN the hold never touches readmit at all: the pending timer is cleared, nothing was ever conceded', () => {
		const logged: Record<string, unknown>[] = [];
		const m = createRelayMatch('m1', 2, deps({ seatRejoinGraceMs: 1000, log: (e) => logged.push(e) }));
		m.attach(sink(), () => {});
		m.roleOf(ALICE);
		m.roleOf(BOB);
		m.seatConnected(0);
		m.seatConnected(1);
		m.seatDisconnected(0);
		vi.advanceTimersByTime(500);
		m.seatConnected(0);
		expect(logged.filter((e) => e.evt === 'relay-seat-readmitted')).toEqual([]);
		expect(logged).toContainEqual({ evt: 'relay-seat-back', matchId: 'm1', seat: 0 });
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
	it('register() then get() returns the same match', () => {
		const reg = createRelayMatchRegistry();
		const first = reg.register('m1', 2, deps());
		expect(reg.get('m1')).toBe(first);
	});

	it("two concurrent starts register the SAME id before either's match has ended: the second gets the first's match, never a second, orphaned one (G.3)", () => {
		const reg = createRelayMatchRegistry();
		const first = reg.register('m1', 2, deps());
		const second = reg.register('m1', 2, deps());
		expect(second).toBe(first);
		expect(reg.get('m1')).toBe(first);
	});

	it('once a match has ended, a late register() of the same id (a duplicate start arriving after it) gets the room\'s CURRENT match — never a third one, and never the ended one back', () => {
		const reg = createRelayMatchRegistry();
		const first = reg.register('m1', 2, deps());
		first.attach(sink(), () => {}).fromSeat(0, { t: 'over', winners: [0] });
		const current = reg.get('m1');
		expect(current).not.toBe(first);
		const late = reg.register('m1', 2, deps());
		expect(late).toBe(current);
	});

	it("registers the room's next match the moment one ends, with the same seats, and still tells the caller's own `ended` hook", () => {
		const reg = createRelayMatchRegistry();
		const ended = vi.fn();
		const first = reg.register('m1', 2, deps({ ended }));
		first.attach(sink(), () => {}).fromSeat(0, { t: 'over', winners: [0] });
		const next = reg.get('m1');
		expect(next).toBeDefined();
		expect(next).not.toBe(first);
		expect(next?.status).toBe('starting');
		expect(next?.roleOf(ALICE)).toBe(0);
		expect(next?.roleOf(BOB)).toBe(1);
		expect(ended).toHaveBeenCalledTimes(1);
	});

	it('two matches back to back in one room: the second relays and records its own over', () => {
		const reg = createRelayMatchRegistry();
		const ended = vi.fn();
		reg.register('m1', 2, deps({ ended }));
		for (const winners of [[0], [1]]) {
			const match = reg.get('m1');
			if (match === undefined) throw new Error('no match for the room');
			const s = sink();
			const session = match.attach(s, () => {});
			session.fromSeat(0, { t: 'hello' });
			expect(s.toSeat).toHaveBeenCalledWith(1, { t: 'hello' });
			session.fromSeat(0, { t: 'over', winners });
			expect(match.result).toEqual({ winners });
		}
		expect(ended).toHaveBeenCalledTimes(2);
	});

	it("the room's next match carries how the last one ended until its own first message, and a first match carries nothing", () => {
		const reg = createRelayMatchRegistry();
		const first = reg.register('m1', 2, deps());
		expect(first.lastEnded()).toBeUndefined();
		first.attach(sink(), () => {}).fromSeat(0, { t: 'over', winners: [1] });
		const next = reg.get('m1');
		if (next === undefined) throw new Error('no next match');
		expect(next.lastEnded()).toEqual({ winners: [1] });
		const session = next.attach(sink(), () => {});
		expect(next.lastEnded()).toEqual({ winners: [1] });
		session.fromSeat(0, { t: 'start' });
		expect(next.lastEnded()).toBeUndefined();
	});

	it('a match every seat left is remembered with no winners', () => {
		const reg = createRelayMatchRegistry();
		const session = reg.register('m1', 2, deps()).attach(sink(), () => {});
		session.seatLeft(0);
		session.seatLeft(1);
		expect(reg.get('m1')?.lastEnded()).toEqual({ winners: null });
	});

	it("each end replaces the room's match with exactly one next one, never two and never the one it replaced — the idempotency guard above only ever holds a LIVE match, so a genuinely new generation still gets made every time one ends", () => {
		const reg = createRelayMatchRegistry();
		const gen1 = reg.register('m1', 2, deps());
		gen1.attach(sink(), () => {}).fromSeat(0, { t: 'over', winners: [0] });
		const gen2 = reg.get('m1');
		expect(gen2).not.toBe(gen1);
		gen2?.attach(sink(), () => {}).fromSeat(0, { t: 'over', winners: [1] });
		const gen3 = reg.get('m1');
		expect(gen3).not.toBe(gen2);
		expect(gen3).not.toBe(gen1);
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
			relayMatches.register(roomId, seatCount, {
				log: () => {},
				roomSeatOf: (p) => lobby.gameSeatOf(roomId, p),
				leaderSeat: () => {
					const leader = lobby.get(roomId)?.leader;
					return leader === undefined ? null : lobby.gameSeatOf(roomId, leader);
				},
			});
		});
	}

	it("the hook is told the room's game type, so the plugin can read that type's own spec", async () => {
		const lobby = await openLobby({ dir: await tempDir() });
		const told: unknown[][] = [];
		lobby.onRelayRoomOpened((...args) => told.push(args));
		const made = lobby.create(ALICE_MEMBER, { name: 'relay type test', gameType: RELAY_LOBBY_TEST_TYPE.id, clientMode: 'builtin' });
		if (!made.ok) throw new Error(made.reason);
		expect(told).toEqual([[made.room.id, 2, RELAY_LOBBY_TEST_TYPE.id]]);
	});

	it('a relay room restored from disk gets a fresh RelayMatch the moment the hook is wired: no match outlives a restart, the room does', async () => {
		const dir = await tempDir();
		const before = await openLobby({ dir });
		const made = before.create(ALICE_MEMBER, { name: 'relay restart test', gameType: RELAY_LOBBY_TEST_TYPE.id, clientMode: 'builtin' });
		if (!made.ok) throw new Error(made.reason);
		const ordinary = before.create(ALICE_MEMBER, { name: 'ordinary restart test', gameType: NON_RELAY_TEST_TYPE.id, clientMode: 'builtin' });
		if (!ordinary.ok) throw new Error(ordinary.reason);

		const after = await openLobby({ dir });
		const told: unknown[][] = [];
		after.onRelayRoomOpened((...args) => told.push(args));
		expect(told).toEqual([[made.room.id, 2, RELAY_LOBBY_TEST_TYPE.id]]);
	});

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

	it("a third member of a two-seat room watches, in the room's view and on the relay, even when her socket joins before the second seat's", async () => {
		const lobby = await openLobby({ dir: await tempDir() });
		wireRelay(lobby);
		const bob = { id: 'fk:2222222222222222', name: 'bob', userId: 'uid-bob' };
		const carol = { id: 'fk:3333333333333333', name: 'carol', userId: 'uid-carol' };
		const made = lobby.create(ALICE_MEMBER, { name: 'relay watcher test', gameType: RELAY_LOBBY_TEST_TYPE.id, clientMode: 'builtin' });
		if (!made.ok) throw new Error(made.reason);
		const roomId = made.room.id;
		expect(lobby.join(roomId, bob).ok).toBe(true);
		const joined = lobby.join(roomId, carol);
		if (!joined.ok) throw new Error(joined.reason);
		expect(joined.room.members.map((m) => m.id)).toEqual([ALICE_MEMBER.id, bob.id, carol.id]);
		expect(joined.room.seats).toEqual([ALICE_MEMBER.id, bob.id]);
		const match = relayMatches.get(roomId);
		if (match === undefined) throw new Error('no match registered');
		expect(match.roleOf(carol.id)).toBeNull();
		expect(match.roleOf(bob.id)).toBe(1);
		expect(match.roleOf(ALICE_MEMBER.id)).toBe(0);
	});

	it("the leader leaves mid-match: leadership passes on (ruling 6); the NEW leader's over ends it, and so does the round's HOST — the old leader's seat, which started this round and never stopped being able to end it (§G.3)", async () => {
		const lobby = await openLobby({ dir: await tempDir() });
		wireRelay(lobby);
		const bob = { id: 'fk:2222222222222222', name: 'bob', userId: 'uid-bob' };
		const made = lobby.create(ALICE_MEMBER, { name: 'relay leader leaves test', gameType: RELAY_LOBBY_TEST_TYPE.id, clientMode: 'builtin' });
		if (!made.ok) throw new Error(made.reason);
		const roomId = made.room.id;
		expect(lobby.join(roomId, bob).ok).toBe(true);
		const match = relayMatches.get(roomId);
		if (match === undefined) throw new Error('no match registered');
		// Alice joins (roleOf) first: she is both the room's leader and this round's host.
		expect(match.roleOf(ALICE_MEMBER.id)).toBe(0);
		expect(match.roleOf(bob.id)).toBe(1);
		expect(match.hostSeat).toBe(0);
		const session = match.attach(sink(), () => {});
		// Bob is neither the leader nor the host yet: refused.
		session.fromSeat(1, { t: 'over', winners: [1] });
		expect(match.status).toBe('running');

		expect(lobby.leave(roomId, ALICE_MEMBER.id).ok).toBe(true);
		expect(lobby.get(roomId)?.leader).toBe(bob.id);
		// Bob is now the leader: his own over ends it.
		session.fromSeat(1, { t: 'over', winners: [1] });
		expect(match.status).toBe('over');
		expect(match.result).toEqual({ winners: [1] });
	});

	it("the round's host keeps ending authority after leaving the room's leadership — a SEPARATE match proves it in isolation from bob's own leader path above", async () => {
		const lobby = await openLobby({ dir: await tempDir() });
		wireRelay(lobby);
		const bob = { id: 'fk:2222222222222222', name: 'bob', userId: 'uid-bob' };
		const made = lobby.create(ALICE_MEMBER, { name: 'relay host outlives leadership test', gameType: RELAY_LOBBY_TEST_TYPE.id, clientMode: 'builtin' });
		if (!made.ok) throw new Error(made.reason);
		const roomId = made.room.id;
		expect(lobby.join(roomId, bob).ok).toBe(true);
		const match = relayMatches.get(roomId);
		if (match === undefined) throw new Error('no match registered');
		expect(match.roleOf(ALICE_MEMBER.id)).toBe(0);
		expect(match.roleOf(bob.id)).toBe(1);
		const session = match.attach(sink(), () => {});

		expect(lobby.leave(roomId, ALICE_MEMBER.id).ok).toBe(true);
		expect(lobby.get(roomId)?.leader).toBe(bob.id);
		// Alice is no longer the room's leader, but her seat started this round, so it still ends
		// it — the exact gap bm1-BR found (a non-leader host's `over` was refused before this fix).
		session.fromSeat(0, { t: 'over', winners: [0] });
		expect(match.status).toBe('over');
		expect(match.result).toEqual({ winners: [0] });
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
