/**
 * The seat transitions, against the REAL `@wolffm/rooms-server@0.38.111` and the
 * real cube pool — no stub room, no fabricated cards.
 *
 * The centrepiece is `leaveRoom`'s refresh hazard. It is tested here rather than
 * over a socket because the failure is a specific ORDER of calls, and a test
 * that has to win a race to reproduce an ordering bug is a test that will one
 * day pass for the wrong reason. Every step is sampled, not just the end state:
 * the bug is that an intermediate call takes the seat away, and asserting only
 * the final seat would pass just as happily if the guard never ran.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
	humanSeats,
	occupantOf,
	reservationFor,
	roleOf,
	seatOf,
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

function rooms(overrides: { reservationTtlMs?: number } = {}): DraftRooms {
	return createDraftRooms({
		pool: pool.cards,
		cube: pool.meta,
		params: { reservationTtlMs: overrides.reservationTtlMs ?? 120_000 },
		now: () => 1_700_000_000_000,
	});
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
		room.app.state = picked.state;
		room.seats = picked.state.table;

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

describe('the refresh hazard in leaveRoom', () => {
	/*
	 * A browser refresh: the new socket connects and joins BEFORE the old
	 * socket's close lands. `leaveRoom` then unseats a participant who is
	 * sitting right there on a live connection.
	 *
	 * Every step below is sampled. The seat at the end is the headline, but the
	 * `guarded` flag and the intermediate role are what distinguish "the guard
	 * put them back" from "the unseat never happened in the first place" — and
	 * the mutation test on this file breaks the guard specifically, so the
	 * distinction has to be asserted rather than assumed.
	 */
	function refresh() {
		const r = rooms();
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

		// The guard fired, and it fired because another live client still
		// carried this participant.
		expect(outcome.participantId).toBe(ALICE);
		expect(outcome.guarded).toBe(true);

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
		const r = rooms();
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
