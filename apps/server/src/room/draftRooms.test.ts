/**
 * The seat transitions, against the REAL `@wolffm/rooms-server` — whichever
 * version `apps/server/package.json` pins, which is the point: no stub room, no
 * fabricated cards, and no version number in a comment to go stale. (This line
 * said `0.38.111` for two upgrades after the upgrades landed.)
 *
 * The centrepiece is `leaveRoom`'s refresh hazard. It is tested here rather than
 * over a socket because the failure is a specific ORDER of calls, and a test
 * that has to win a race to reproduce an ordering bug is a test that will one
 * day pass for the wrong reason. Every step is sampled, not just the end state:
 * the bug is that an intermediate call takes the seat away, and asserting only
 * the final seat would pass just as happily if the property never held.
 *
 * ## `bare()`, and why the hazard is tested with everything switched OFF
 *
 * `rooms()` ships the product's defaults: a two-minute seat hold, and (in
 * production) a disconnect grace. Under those, the live-duplicate property is
 * INVISIBLE — a dropped socket is covered by the grace and a deliberate leave
 * by the reservation the unseat itself takes out, so the seat comes back to
 * its owner either way and a suite that tests the hazard against the defaults
 * is green whether the property holds or not. That reads as coverage and is
 * not.
 *
 * So the hazard is driven through `bare()`: `reservationTtlMs: 0` AND
 * `disconnectGraceMs: 0`, the one configuration where an unseated player's
 * seat is empty, unreserved and takeable while they are still connected on
 * another tab. CAROL arriving into that seat is what the assertion is really
 * about. (hadoku_site's `templates/game/apps/server/test/rooms.test.ts` runs a
 * whole second server configured this way for the same reason.)
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
	humanSeats,
	occupantOf,
	reservationFor,
	roleOf,
	seatOf,
	seatRows,
	type SeatId,
} from '@wolffm/rooms-protocol';
import { pick as enginePick } from '@hadoku/draft';

import {
	createDraftRooms,
	joinDraftRoom,
	leaveDraftRoom,
	releaseSeat,
	stateOf,
	viewForParticipant,
	type DraftRoom,
	type DraftRooms,
} from './draftRooms.js';
import { loadPool, type CubePool } from './pool.js';

/**
 * The cube the app actually ships with. Using it rather than a handful of
 * invented cards is the difference between testing the seat logic and testing
 * the seat logic against something that resembles a draft.
 */
const POOL_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '../../../ui/src/draft/pool.json');

const ALICE = 'fk:aaaaaaaaaaaaaaaa';
const BOB = 'fk:bbbbbbbbbbbbbbbb';
const CAROL = 'fk:cccccccccccccccc';

let pool: CubePool;

beforeAll(() => {
	const load = loadPool(POOL_FILE);
	if (!load.ok) throw new Error(`the bundled cube pool did not load: ${load.detail}`);
	pool = load.pool;
});

function rooms(
	overrides: {
		reservationTtlMs?: number;
		disconnectGraceMs?: number;
		onDeferredChange?: (room: DraftRoom) => void;
	} = {},
): DraftRooms {
	return createDraftRooms({
		pool: pool.cards,
		cube: pool.meta,
		params: {
			reservationTtlMs: overrides.reservationTtlMs ?? 120_000,
			disconnectGraceMs: overrides.disconnectGraceMs ?? 0,
		},
		now: () => 1_700_000_000_000,
		onDeferredChange: overrides.onDeferredChange,
	});
}

/**
 * The same rooms with every safety net OFF — no seat hold, no disconnect
 * grace. See the module header: this is the only configuration in which the
 * live-duplicate property is observable.
 */
function bare(): DraftRooms {
	return rooms({ reservationTtlMs: 0, disconnectGraceMs: 0 });
}

describe('loadPool', () => {
	it('reads the shipped cube and reports what it actually parsed', () => {
		expect(pool.cards.length).toBeGreaterThan(300);
		expect(pool.meta.size).toBe(pool.cards.length);
		expect(pool.meta.name).not.toBe('');
	});

	it('is a verdict, not a throw, when the file is not there', () => {
		const load = loadPool(resolve(POOL_FILE, '..', 'no-such-pool.json'));
		expect(load.ok).toBe(false);
		if (!load.ok) expect(load.reason).toBe('missing');
	});
});

describe('opening a draft room', () => {
	it('deals a full pod of bots and aliases the room table to the engine table', () => {
		const r = rooms();
		const room = r.open('pod-1');
		const state = stateOf(room);

		// One table, not two. This is the invariant everything else rests on.
		expect(room.seats).toBe(state.table);
		expect(state.seatCount).toBe(8);
		expect(humanSeats(room.seats)).toEqual([]);
		for (let s = 0; s < 8; s++) expect(occupantOf(room.seats, s)?.kind).toBe('bot');
	});

	it('is idempotent — the same id is the same draft, dealt once', () => {
		const r = rooms();
		const first = r.open('pod-1');
		const state = stateOf(first);
		const second = r.open('pod-1');
		expect(second).toBe(first);
		expect(stateOf(second)).toBe(state);
	});

	it('does not invent a room for a draft nobody opened', () => {
		expect(rooms().find('never-opened')).toBeUndefined();
	});
});

describe('joining', () => {
	it('evicts a bot, names the seat from the digest, and advances the cursor', () => {
		const r = rooms();
		const room = r.open('pod-1');
		const before = stateOf(room).seq;

		const outcome = joinDraftRoom(room, 'sock-a', ALICE, 'friend');
		expect(outcome.seat).toBe(0);
		expect(outcome.changed).toBe(true);
		expect(occupantOf(room.seats, 0)).toEqual({ kind: 'human', participantId: ALICE });
		expect(stateOf(room).seq).toBe(before + 1);

		// The seat row carries a handle derived from the id, never the id's
		// source material and never the edge's X-User-Id.
		const name = stateOf(room).displayNames[0];
		expect(name).toBe(ALICE.slice(3, 9));
		expect(name).not.toBe('Bot 0');
	});

	it('seats a second person beside the first', () => {
		const r = rooms();
		const room = r.open('pod-1');
		joinDraftRoom(room, 'sock-a', ALICE, 'friend');
		const bob = joinDraftRoom(room, 'sock-b', BOB, 'friend');
		expect(bob.seat).toBe(1);
		expect(humanSeats(room.seats)).toEqual([
			{ id: 0, participantId: ALICE },
			{ id: 1, participantId: BOB },
		]);
	});

	it('is idempotent for a participant who is already seated', () => {
		const r = rooms();
		const room = r.open('pod-1');
		joinDraftRoom(room, 'sock-a', ALICE, 'friend');
		const seq = stateOf(room).seq;

		const again = joinDraftRoom(room, 'sock-a2', ALICE, 'friend');
		expect(again.seat).toBe(0);
		expect(again.changed).toBe(false);
		// Nothing moved, so nothing advanced — an update stamped with an
		// unchanged cursor would reach every other client as a duplicate.
		expect(stateOf(room).seq).toBe(seq);
	});
});

describe('leaving on purpose', () => {
	it('frees the seat but holds it for the TTL', () => {
		const r = rooms();
		const room = r.open('pod-1');
		joinDraftRoom(room, 'sock-a', ALICE, 'friend');

		expect(releaseSeat(room, ALICE)).toBe(true);
		expect(seatOf(room.seats, ALICE)).toBeNull();
		expect(roleOf(room.seats, ALICE)).toBe('spectator');
		// Held against other people, so the pod does not hand the seat away the
		// moment a laptop sleeps.
		expect(reservationFor(room.seats, 0)?.participantId).toBe(ALICE);
		// And a stranger cannot take it while the hold stands.
		const carol = joinDraftRoom(room, 'sock-c', CAROL, 'friend');
		expect(carol.seat).not.toBe(0);
	});

	it('reports false for someone who held no seat', () => {
		const r = rooms();
		const room = r.open('pod-1');
		expect(releaseSeat(room, ALICE)).toBe(false);
	});
});

describe('a genuine disconnect', () => {
	it('unseats, remembers and holds — and does not re-seat a participant who left', () => {
		const r = rooms();
		const room = r.open('pod-1');
		joinDraftRoom(room, 'sock-a', ALICE, 'friend');

		const outcome = leaveDraftRoom(room, 'sock-a');
		expect(outcome.participantId).toBe(ALICE);
		expect(outcome.guarded).toBe(false);
		expect(outcome.changed).toBe(true);
		expect(seatOf(room.seats, ALICE)).toBeNull();
		expect(room.seats.remembered[ALICE]).toBe(0);
		expect(reservationFor(room.seats, 0)?.participantId).toBe(ALICE);
	});

	it('returns them to the SAME seat with their pool intact when they come back', () => {
		const r = rooms();
		const room = r.open('pod-1');
		joinDraftRoom(room, 'sock-a', ALICE, 'friend');
		joinDraftRoom(room, 'sock-b', BOB, 'friend');

		// Take a real card, so there is a pool to lose.
		const opening = viewForParticipant(room, ALICE);
		if (opening.viewer.kind !== 'seat') throw new Error('alice should be seated');
		const taken = opening.viewer.pack[0];
		if (taken === undefined) throw new Error('an opening pack should not be empty');
		const picked = enginePick(stateOf(room), 0, taken.cardId);
		expect(picked.ok).toBe(true);
		if (!picked.ok) return;
		// No re-alias: the engine spreads its state, so `table` is the same
		// object the registry's factory handed the room. Re-assigning
		// `room.seats` here would be the second owner `open` just removed.
		room.app.state = picked.state;

		leaveDraftRoom(room, 'sock-a');
		expect(seatOf(room.seats, ALICE)).toBeNull();

		// Within the TTL, so the hold is still standing.
		const back = joinDraftRoom(room, 'sock-a-new', ALICE, 'friend');
		expect(back.seat).toBe(0);

		const view = viewForParticipant(room, ALICE);
		expect(view.viewer.kind).toBe('seat');
		if (view.viewer.kind !== 'seat') return;
		expect(view.viewer.pool.map((c) => c.cardId)).toEqual([taken.cardId]);
	});

	it('gives the seat away once the hold has expired', () => {
		const r = rooms({ reservationTtlMs: 0 });
		const room = r.open('pod-1');
		joinDraftRoom(room, 'sock-a', ALICE, 'friend');
		leaveDraftRoom(room, 'sock-a');
		expect(reservationFor(room.seats, 0)).toBeNull();

		const carol = joinDraftRoom(room, 'sock-c', CAROL, 'friend');
		expect(carol.seat).toBe(0);
	});
});

describe('the refresh hazard in leaveRoom, with nothing else covering it', () => {
	/*
	 * A stale close that lands AFTER its replacement joined — a second tab, or
	 * a dead connection socket.io only reaps at its ping timeout. Through
	 * 0.38.x `leaveRoom` unseated a participant who was sitting right there on
	 * a live connection, and this file carried a re-seat afterwards to undo it.
	 * `@wolffm/rooms-server@0.39.4` deletes the client FIRST and unseats only
	 * a participant's LAST connection, so the re-seat is gone and the PACKAGE
	 * holds the property.
	 *
	 * Which is exactly why these run on `bare()` now. With a seat hold on, the
	 * old suite passed whether the property held or not: the reservation
	 * returned ALICE to seat 0 by itself. With both nets off, an unseated
	 * ALICE is a spectator whose empty seat CAROL can walk into — so the last
	 * test here is the one that actually fails when the property is absent,
	 * and the `guarded`/role/reservation samples are what say WHY.
	 */
	function refresh() {
		const r = bare();
		const room = r.open('pod-1');

		joinDraftRoom(room, 'sock-a', ALICE, 'friend');
		joinDraftRoom(room, 'sock-b', BOB, 'friend');
		const seated: Record<string, SeatId | null> = { afterFirstJoin: seatOf(room.seats, ALICE) };

		// The refresh: a NEW socket for the same participant.
		const rejoin = joinDraftRoom(room, 'sock-a2', ALICE, 'friend');
		seated.afterRejoin = seatOf(room.seats, ALICE);

		// …and only now does the stale socket's close arrive.
		const outcome = leaveDraftRoom(room, 'sock-a');
		seated.afterStaleClose = seatOf(room.seats, ALICE);

		return { room, rejoin, outcome, seated };
	}

	it('keeps the drafter in their seat when a stale socket closes behind them', () => {
		const { room, rejoin, outcome, seated } = refresh();

		expect(seated.afterFirstJoin).toBe(0);
		// `seatParticipant` is idempotent, so the rejoin is the SAME seat.
		expect(rejoin.seat).toBe(0);
		expect(seated.afterRejoin).toBe(0);

		// It held because another live client still carried this participant.
		expect(outcome.participantId).toBe(ALICE);
		expect(outcome.guarded).toBe(true);

		// Neither safety net is doing the work. Assert that, or this test
		// silently becomes a test of the reservation again.
		expect(reservationFor(room.seats, 0)).toBeNull();
		expect(room.app.vacating.size).toBe(0);

		// The state the pod actually sees.
		expect(seated.afterStaleClose).toBe(0);
		expect(roleOf(room.seats, ALICE)).toBe('player');
		expect(occupantOf(room.seats, 0)).toEqual({ kind: 'human', participantId: ALICE });
		expect(humanSeats(room.seats)).toEqual([
			{ id: 0, participantId: ALICE },
			{ id: 1, participantId: BOB },
		]);
	});

	it('leaves the rest of the pod exactly where it was', () => {
		const { room } = refresh();
		expect(seatOf(room.seats, BOB)).toBe(1);
		expect(roleOf(room.seats, BOB)).toBe('player');
	});

	it('does not advance the cursor, because nothing about the table changed', () => {
		const r = bare();
		const room = r.open('pod-1');
		joinDraftRoom(room, 'sock-a', ALICE, 'friend');
		joinDraftRoom(room, 'sock-a2', ALICE, 'friend');
		const seq = stateOf(room).seq;

		const outcome = leaveDraftRoom(room, 'sock-a');
		expect(outcome.guarded).toBe(true);
		expect(outcome.changed).toBe(false);
		expect(stateOf(room).seq).toBe(seq);
	});

	it('still has the live socket registered afterwards', () => {
		const { room } = refresh();
		expect(room.clients.has('sock-a')).toBe(false);
		expect(room.clients.get('sock-a2')?.participantId).toBe(ALICE);
	});

	/*
	 * THE assertion. Everything above samples the mechanism; this is the
	 * consequence, and it is the only one that goes red when the property is
	 * gone. With no hold and no grace, an ALICE who was unseated by her own
	 * stale socket leaves seat 0 empty and unreserved — and the next arrival
	 * takes it while she is still connected, mid-draft, on her other tab.
	 */
	it('does not hand the seat to the next arrival while its owner is still connected', () => {
		const { room } = refresh();

		const carol = joinDraftRoom(room, 'sock-c', CAROL, 'friend');

		expect(seatOf(room.seats, ALICE)).toBe(0);
		expect(roleOf(room.seats, ALICE)).toBe('player');
		expect(occupantOf(room.seats, 0)).toEqual({ kind: 'human', participantId: ALICE });
		expect(carol.seat).not.toBe(0);
		expect(seatOf(room.seats, CAROL)).not.toBe(0);
		// And ALICE can still see her own hand, which is what the seat is for.
		const mine = viewForParticipant(room, ALICE);
		expect(mine.viewer.kind).toBe('seat');
	});
});

describe('a browser refresh, in the order it actually arrives', () => {
	/*
	 * Wave 10 measured a real refresh on loopback: the OLD socket's close lands
	 * ~36 ms BEFORE the new socket joins. So at the stale close there is no
	 * other live client and the guard above has nothing to do — this block is
	 * that ordering, close then join, and the one above is the other.
	 *
	 * What the rest of the pod SEES is modelled exactly as `socket.ts` decides
	 * it: a leave or join outcome with `changed` is broadcast, and so is every
	 * `onDeferredChange`. Each broadcast is recorded as the occupant of seat 0
	 * it carried, which is the flicker, measured.
	 */
	const GRACE_MS = 5_000;

	afterEach(() => {
		vi.useRealTimers();
	});

	function pod(disconnectGraceMs: number) {
		const seen: Array<string | null> = [];
		const occupantOfSeat0 = (room: DraftRoom): string | null => {
			const occupant = viewForParticipant(room, BOB).seats[0]?.occupant ?? null;
			return occupant === null ? null : occupant.kind === 'human' ? occupant.participantId : occupant.kind;
		};
		const r = rooms({ disconnectGraceMs, onDeferredChange: (room) => seen.push(occupantOfSeat0(room)) });
		const room = r.open('pod-1');
		joinDraftRoom(room, 'sock-a', ALICE, 'friend');
		joinDraftRoom(room, 'sock-b', BOB, 'friend');
		const broadcast = (changed: boolean) => {
			if (changed) seen.push(occupantOfSeat0(room));
		};
		return { room, seen, broadcast };
	}

	it('never reaches the guard: the reservation is what returns them with no grace', () => {
		const { room, seen, broadcast } = pod(0);
		const seq = stateOf(room).seq;

		// Close first. Nobody else carries ALICE, so this is a plain departure.
		const closed = leaveDraftRoom(room, 'sock-a');
		broadcast(closed.changed);
		expect(closed.guarded).toBe(false);
		expect(closed.held).toBe(false);
		expect(seatOf(room.seats, ALICE)).toBeNull();
		expect(reservationFor(room.seats, 0)?.participantId).toBe(ALICE);

		// Join second — the hold is what puts them back in seat 0.
		const back = joinDraftRoom(room, 'sock-a2', ALICE, 'friend');
		broadcast(back.changed);
		expect(back.seat).toBe(0);
		expect(reservationFor(room.seats, 0)).toBeNull();

		// And the pod watched it: two broadcasts, the first with seat 0 empty.
		expect(seen).toEqual([null, ALICE]);
		expect(stateOf(room).seq).toBe(seq + 2);
	});

	it('with a grace, keeps them seated through the gap — the pod sees nothing at all', () => {
		vi.useFakeTimers();
		const { room, seen, broadcast } = pod(GRACE_MS);
		const seq = stateOf(room).seq;

		const closed = leaveDraftRoom(room, 'sock-a');
		broadcast(closed.changed);
		expect(closed.guarded).toBe(false);
		expect(closed.held).toBe(true);
		expect(closed.changed).toBe(false);
		// Still in the chair, no hold standing, during the gap.
		expect(seatOf(room.seats, ALICE)).toBe(0);
		expect(occupantOf(room.seats, 0)).toEqual({ kind: 'human', participantId: ALICE });
		expect(reservationFor(room.seats, 0)).toBeNull();

		// The measured gap, then the new socket.
		vi.advanceTimersByTime(36);
		const back = joinDraftRoom(room, 'sock-a2', ALICE, 'friend');
		broadcast(back.changed);
		expect(back.seat).toBe(0);
		expect(back.changed).toBe(false);

		// Well past the grace: the vacate was cancelled, not merely late.
		vi.advanceTimersByTime(GRACE_MS * 2);
		expect(seatOf(room.seats, ALICE)).toBe(0);
		expect(room.clients.get('sock-a2')?.participantId).toBe(ALICE);

		expect(seen).toEqual([]);
		expect(stateOf(room).seq).toBe(seq);
	});

	it('with a grace, still vacates and holds for a drafter who does not come back', () => {
		vi.useFakeTimers();
		const { room, seen, broadcast } = pod(GRACE_MS);
		const seq = stateOf(room).seq;

		broadcast(leaveDraftRoom(room, 'sock-a').changed);
		vi.advanceTimersByTime(GRACE_MS - 1);
		expect(seatOf(room.seats, ALICE)).toBe(0);
		expect(seen).toEqual([]);

		vi.advanceTimersByTime(1);
		expect(seatOf(room.seats, ALICE)).toBeNull();
		expect(reservationFor(room.seats, 0)?.participantId).toBe(ALICE);
		// Announced once, by the hook, with the seat empty.
		expect(seen).toEqual([null]);
		expect(stateOf(room).seq).toBe(seq + 1);

		// And the hold still does its job when they do come back.
		const back = joinDraftRoom(room, 'sock-a2', ALICE, 'friend');
		expect(back.seat).toBe(0);
		expect(back.changed).toBe(true);
	});

	it('leaves the guard to the other ordering — join, then the stale close', () => {
		vi.useFakeTimers();
		const { room, seen, broadcast } = pod(GRACE_MS);

		broadcast(joinDraftRoom(room, 'sock-a2', ALICE, 'friend').changed);
		const closed = leaveDraftRoom(room, 'sock-a');
		broadcast(closed.changed);
		expect(closed.guarded).toBe(true);
		expect(closed.held).toBe(false);
		expect(room.app.vacating.size).toBe(0);

		vi.advanceTimersByTime(GRACE_MS * 2);
		expect(seatOf(room.seats, ALICE)).toBe(0);
		expect(seen).toEqual([]);
	});
});

describe('one seat table, not two', () => {
	/*
	 * `room.seats` used to be ASSIGNED `state.table` right after `seed`. It is
	 * now the seat-table FACTORY's return value, so the room is born holding
	 * the engine's table and nothing ever writes the field. Identity, not
	 * equality: two tables that happen to agree today are still two answers to
	 * "which seat is Alice in", and the whole point is that there is one.
	 */
	it('hands the registry the engine table itself, from the moment the room exists', () => {
		const r = rooms();
		const room = r.open('pod-1');
		expect(room.seats).toBe(stateOf(room).table);
		// Bounded at the pod size, which the registry's own default (unbounded)
		// is not — so catching the default would be visible here.
		expect(room.seats.capacity).toBe(8);
	});

	it('stays the same object across a pick, with nobody re-aliasing it', () => {
		const r = rooms();
		const room = r.open('pod-1');
		joinDraftRoom(room, 'sock-a', ALICE, 'friend');
		const table = room.seats;

		const view = viewForParticipant(room, ALICE);
		if (view.viewer.kind !== 'seat') throw new Error('alice should be seated');
		const card = view.viewer.pack[0];
		if (card === undefined) throw new Error('an opening pack should not be empty');
		const picked = enginePick(stateOf(room), 0, card.cardId);
		expect(picked.ok).toBe(true);
		if (!picked.ok) return;
		room.app.state = picked.state;

		expect(room.seats).toBe(table);
		expect(room.seats).toBe(stateOf(room).table);
	});

	it('re-opens the same room rather than re-dealing it', () => {
		const r = rooms();
		const first = r.open('pod-1');
		joinDraftRoom(first, 'sock-a', ALICE, 'friend');
		const again = r.open('pod-1');
		expect(again).toBe(first);
		expect(again.seats).toBe(first.seats);
		expect(seatOf(again.seats, ALICE)).toBe(0);
	});
});

describe('onRoomDelete', () => {
	/*
	 * A room owns pending `vacating` timers. They used to be drained at the GC
	 * sweep, which was correct only while that was the one delete path; they
	 * are drained on the REGISTRY now, so a future admin close or game-over
	 * reap is covered by construction. GC itself is still off — `collectGC` is
	 * called from nowhere — and turning it on is the operator's decision.
	 */
	afterEach(() => {
		vi.useRealTimers();
	});

	it('drains a room’s pending vacates when the room is deleted', () => {
		vi.useFakeTimers();
		const r = rooms({ disconnectGraceMs: 5_000 });
		const room = r.open('pod-1');
		joinDraftRoom(room, 'sock-a', ALICE, 'friend');

		const closed = leaveDraftRoom(room, 'sock-a');
		expect(closed.held).toBe(true);
		expect(room.app.vacating.size).toBe(1);

		r.delete('pod-1');
		expect(room.app.vacating.size).toBe(0);
		expect(r.find('pod-1')).toBeUndefined();

		// The timer is really gone: the deferred vacate does not fire, and in
		// particular does not reach `onDeferredChange` for a room that no
		// longer exists.
		expect(() => vi.advanceTimersByTime(60_000)).not.toThrow();
		expect(seatOf(room.seats, ALICE)).toBe(0);
	});

	it('is still resolvable inside the callback — it runs BEFORE the map entry goes', () => {
		const r = rooms({ disconnectGraceMs: 5_000 });
		const room = r.open('pod-1');
		joinDraftRoom(room, 'sock-a', ALICE, 'friend');
		leaveDraftRoom(room, 'sock-a');
		// If the drain ran after the delete it would find nothing and the
		// timer above would survive. It does not.
		r.delete('pod-1');
		expect(room.app.vacating.size).toBe(0);
	});
});

describe('the wire seat rows agree with seatRows, row for row', () => {
	/*
	 * `seatRows(table)` is 0.39.4's answer to "how does a renderer see a bounded
	 * table": every existing seat, then empty rows out to `capacity`. A draft
	 * payload's `seats` is built in `packages/draft/src/view.ts`, which still
	 * hand-rolls `Array.from({ length: state.seatCount })`.
	 *
	 * Those two agree only while the table is exactly `capacity` seats long, and
	 * for a draft room they are: `createDraft` calls `padWithBots` at creation,
	 * so the table is FULL from birth (a human joining evicts a bot rather than
	 * appending) and `unseatParticipant` empties a seat without shortening the
	 * array. So neither of the two failure modes `seatRows` exists for — a short
	 * render below capacity, and an occupied seat DROPPED when
	 * `seats.length > capacity` — is reachable here today.
	 *
	 * "Not reachable today" is the whole reason to pin it. These tests are the
	 * guard on that equivalence: they hold whichever way `view.ts` builds the
	 * rows, they go red the moment the table stops being capacity-many, and they
	 * are what makes swapping that one line to `seatRows` a refactor somebody
	 * can verify instead of a change of behaviour nobody can see. The swap
	 * itself is not this lane's file.
	 */
	const rowsOf = (room: DraftRoom, who: string) =>
		viewForParticipant(room, who).seats.map(({ id, occupant }) => ({ id, occupant }));

	it('is capacity-many rows, because the engine pre-pads the table', () => {
		const r = rooms();
		const room = r.open('pod-1');
		// The invariant the hand-rolled pad is only correct under. If this ever
		// stops holding, the payload is short or a seat vanishes from it.
		expect(room.seats.seats).toHaveLength(8);
		expect(room.seats.capacity).toBe(8);
		expect(rowsOf(room, CAROL)).toEqual(seatRows(room.seats));
		expect(rowsOf(room, CAROL)).toHaveLength(room.seats.capacity ?? -1);
	});

	it('still agrees after a join, a deliberate leave and a disconnect', () => {
		const r = rooms();
		const room = r.open('pod-1');
		joinDraftRoom(room, 'sock-a', ALICE, 'friend');
		joinDraftRoom(room, 'sock-b', BOB, 'friend');
		expect(rowsOf(room, ALICE)).toEqual(seatRows(room.seats));

		// An empty seat is emptied in place, never spliced out — which is what
		// keeps the table capacity-many and the hand-rolled pad honest.
		releaseSeat(room, ALICE);
		expect(room.seats.seats).toHaveLength(8);
		expect(rowsOf(room, BOB)).toEqual(seatRows(room.seats));
		expect(rowsOf(room, BOB)[0]).toEqual({ id: 0, occupant: null });

		leaveDraftRoom(room, 'sock-b');
		expect(room.seats.seats).toHaveLength(8);
		expect(rowsOf(room, CAROL)).toEqual(seatRows(room.seats));
	});

	it('names every occupant the table names, and invents none', () => {
		const r = rooms();
		const room = r.open('pod-1');
		joinDraftRoom(room, 'sock-a', ALICE, 'friend');

		const rows = rowsOf(room, ALICE);
		for (const { id } of rows) expect(rows[id]?.occupant).toEqual(occupantOf(room.seats, id));
		// Nobody is dropped: every occupied seat in the table appears in the view.
		const occupiedInView = rows.filter((row) => row.occupant !== null).map((row) => row.id);
		const occupiedInTable = room.seats.seats.filter((s) => s.occupant !== null).map((s) => s.id);
		expect(occupiedInView).toEqual(occupiedInTable);
	});
});

describe('viewForParticipant', () => {
	it('gives a seated player their own slice and a stranger the spectator arm', () => {
		const r = rooms();
		const room = r.open('pod-1');
		joinDraftRoom(room, 'sock-a', ALICE, 'friend');

		const mine = viewForParticipant(room, ALICE);
		expect(mine.viewer.kind).toBe('seat');
		if (mine.viewer.kind !== 'seat') return;
		expect(mine.viewer.seatId).toBe(0);
		expect(mine.viewer.pack).toHaveLength(15);

		const theirs = viewForParticipant(room, CAROL);
		expect(theirs.viewer).toEqual({ kind: 'spectator' });
	});
});
