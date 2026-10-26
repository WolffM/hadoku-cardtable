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

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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
import { safeParseServerMessage, stateMessage, type DraftCard, type DraftPlan, type PoolSource } from '@hadoku/shared';

import {
	createDraftRooms,
	DEFAULT_PARAMS,
	DEFAULT_PLAN,
	joinDraftRoom,
	leaveDraftRoom,
	releaseSeat,
	singlePoolResolver,
	stateOf,
	viewForClient,
	viewForParticipant,
	type DraftRoom,
	type DraftRooms,
	type PodDeal,
	type PoolSourceResolver,
} from './draftRooms.js';
import { loadPool, type CubePool } from './pool.js';

/**
 * The cube the app actually ships with. Using it rather than a handful of
 * invented cards is the difference between testing the seat logic and testing
 * the seat logic against something that resembles a draft.
 */
const BUNDLED_POOL_FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), '../../../ui/src/draft/pool.json');

const ALICE = 'fk:aaaaaaaaaaaaaaaa';
const BOB = 'fk:bbbbbbbbbbbbbbbb';
const CAROL = 'fk:cccccccccccccccc';

let pool: CubePool;

beforeAll(() => {
	const load = loadPool(BUNDLED_POOL_FIXTURE);
	if (!load.ok) throw new Error(`the bundled cube pool did not load: ${load.detail}`);
	pool = load.pool;
});

/** An eight-seat pod dealt to these players, its bots unnamed, on the default plan. */
function podDeal(humans: PodDeal['humans']): PodDeal {
	return { seats: 8, humans, bots: [], plan: DEFAULT_PLAN };
}

function rooms(
	overrides: {
		reservationTtlMs?: number;
		disconnectGraceMs?: number;
		onDeferredChange?: (room: DraftRoom) => void;
	} = {},
): DraftRooms {
	return createDraftRooms({
		...singlePoolResolver(pool),
		params: {
			reservationTtlMs: overrides.reservationTtlMs ?? 120_000,
			disconnectGraceMs: overrides.disconnectGraceMs ?? 0,
		},
		now: () => 1_700_000_000_000,
		onDeferredChange: overrides.onDeferredChange,
		// Every test here is pure in-memory. Persistence has its own suite in
		// `http/drafts.test.ts`, against an explicit temp directory — the
		// default (`CARDTABLE_DRAFTS_DIR`, or `<logDir>/../data/drafts`) is for
		// production, and letting it apply here would make an ordinary unit
		// test touch real disk under this repo's own `logs/` directory.
		storeDir: null,
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
		const load = loadPool(resolve(BUNDLED_POOL_FIXTURE, '..', 'no-such-pool.json'));
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

	it('is eight seats whatever the room holds, and nobody chooses otherwise', () => {
		// The wave-23 answer, written down where it is enforced: the leader does
		// not pick a seat count, so a pod dealt for a room of one looks exactly
		// like a pod dealt for a room of eight and the difference is how many
		// bots get evicted.
		expect(DEFAULT_PARAMS.seatCount).toBe(8);
		const r = rooms();
		expect(r.params.seatCount).toBe(8);
		for (const id of ['pod-of-one', 'pod-of-eight']) {
			const room = r.open(id);
			expect(stateOf(room).seatCount).toBe(8);
			expect(seatRows(room.seats)).toHaveLength(8);
			expect(humanSeats(room.seats)).toEqual([]);
		}
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

	describe("the pod lookup's humans", () => {
		it('deals to exactly the players the lookup names, each at the seat it names, when wired BEFORE open', () => {
			const r = rooms();
			r.setPodLookup((draftId) => (draftId === 'pod-seated' ? podDeal([{ participantId: ALICE, displayName: 'Alice', seat: 5 }, { participantId: BOB, displayName: 'Bob', seat: 2 }]) : null));
			const room = r.open('pod-seated');
			const seats = humanSeats(room.seats);
			expect(seats).toHaveLength(2);
			const seated = new Set(seats.map((s) => s.id));
			expect(seatOf(room.seats, ALICE)).toBe(5);
			expect(seatOf(room.seats, BOB)).toBe(2);
			// Every other seat is a bot, same as an unseated pod.
			for (let s = 0; s < 8; s++) {
				if (seated.has(s as SeatId)) continue;
				expect(occupantOf(room.seats, s)?.kind).toBe('bot');
			}
		});

		it('is unwired by default, and a lookup answering [] is the SAME pre-wave behaviour: nobody dealt human, all eight seats bots', () => {
			const unwired = rooms().open('pod-unwired');
			expect(humanSeats(unwired.seats)).toEqual([]);
			for (let s = 0; s < 8; s++) expect(occupantOf(unwired.seats, s)?.kind).toBe('bot');

			const r = rooms();
			r.setPodLookup(() => podDeal([]));
			const wiredEmpty = r.open('pod-wired-empty');
			expect(humanSeats(wiredEmpty.seats)).toEqual([]);
			for (let s = 0; s < 8; s++) expect(occupantOf(wiredEmpty.seats, s)?.kind).toBe('bot');
		});

		it('is read once, at the moment `open` deals the draft — a later call does not re-deal an existing room', () => {
			const r = rooms();
			r.setPodLookup(() => podDeal([]));
			const dealt = r.open('pod-already-dealt');
			expect(humanSeats(dealt.seats)).toEqual([]);

			r.setPodLookup((draftId) => podDeal(draftId === 'pod-already-dealt' ? [{ participantId: ALICE, displayName: 'Alice', seat: 0 }] : []));
			const again = r.open('pod-already-dealt');
			expect(again).toBe(dealt);
			expect(humanSeats(again.seats)).toEqual([]);
		});
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

describe('a pod dealt to the members who sat', () => {
	it('takes nobody else: another member joins as a watcher, every bot stays, and the cursor does not move', () => {
		const r = rooms();
		r.setPodLookup((draftId) => podDeal(draftId === 'pod-sat' ? [{ participantId: ALICE, displayName: 'Alice', seat: 0 }] : []));
		const room = r.open('pod-sat');
		expect(r.drafters('pod-sat')).toHaveLength(1);
		const seq = stateOf(room).seq;

		const alice = joinDraftRoom(room, 'sock-a', ALICE, 'friend', r.drafters('pod-sat'));
		expect(alice.seat).toBe(0);
		const carol = joinDraftRoom(room, 'sock-c', CAROL, 'friend', r.drafters('pod-sat'));
		expect(carol.seat).toBeNull();
		expect(carol.changed).toBe(false);
		expect(humanSeats(room.seats)).toEqual([{ id: 0, participantId: ALICE }]);
		expect(stateOf(room).seq).toBe(seq);

		// Carol watches the pod's drafter; alice is shown only her own seat.
		expect(viewForClient(room, carol.client).viewer).toMatchObject({ kind: 'watcher', seatId: 0 });
		expect(viewForClient(room, alice.client).viewer).toMatchObject({ kind: 'seat', seatId: 0 });
		carol.client.app.watching = 3;
		expect(viewForClient(room, carol.client).viewer).toMatchObject({ kind: 'watcher', seatId: 3 });

		// A drafter coming back still gets their seat.
		const back = joinDraftRoom(room, 'sock-a2', ALICE, 'friend', r.drafters('pod-sat'));
		expect(back.seat).toBe(0);
	});

	it('a draft nobody sat in still seats whoever joins', () => {
		const r = rooms();
		const room = r.open('pod-open');
		expect(r.drafters('pod-open')).toEqual([]);
		expect(joinDraftRoom(room, 'sock-c', CAROL, 'friend', r.drafters('pod-open')).seat).not.toBeNull();
	});

	// The operator, 2026-10-20, after a restart mid-draft: "our names died?"
	it("keeps a drafter's name through a seat released and reclaimed, and mends a seat already renamed", () => {
		const r = rooms();
		r.setPodLookup((draftId) => podDeal(draftId === 'pod-sat' ? [{ participantId: ALICE, displayName: 'Alice', seat: 0 }] : []));
		const room = r.open('pod-sat');
		expect(stateOf(room).displayNames[0]).toBe('Alice');

		joinDraftRoom(room, 'sock-a', ALICE, 'friend', r.drafters('pod-sat'));
		expect(releaseSeat(room, ALICE)).toBe(true);
		const back = joinDraftRoom(room, 'sock-a2', ALICE, 'friend', r.drafters('pod-sat'));
		expect(back).toMatchObject({ seat: 0, changed: true });
		expect(stateOf(room).displayNames[0]).toBe('Alice');

		// A pod saved with the handle in place of the name takes the name on the next join, and says so.
		stateOf(room).displayNames[0] = 'f00dfee';
		const seq = stateOf(room).seq;
		const mended = joinDraftRoom(room, 'sock-a3', ALICE, 'friend', r.drafters('pod-sat'));
		expect(mended).toMatchObject({ seat: 0, changed: true });
		expect(stateOf(room).displayNames[0]).toBe('Alice');
		expect(stateOf(room).seq).toBe(seq + 1);
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

/*
 * wave 73 §A, done-when: "a server test sets a plan, starts the pod, and
 * finds the first pack in that cube." Two distinct cubes behind one
 * resolver, keyed by `PoolSource.cubeId` — the shape `index.ts`'s real
 * shortlist resolver has — so setting the LOOKUP's plan to the non-default
 * one is the whole test: `build()` reads `podLookup(draftId)?.plan`, deals
 * from whichever cube that plan names, and nothing else about the room
 * changes.
 */
describe('a room is dealt from its OWN plan, not a server-global cube', () => {
	function makeNamedCube(name: string, size: number): DraftCard[] {
		return Array.from({ length: size }, (_, i) => ({
			cardId: `${name}-${i}`,
			name: `${name} ${i}`,
			manaCost: [],
			manaValue: 0,
			colors: [],
			typeLine: 'Creature — Test',
			oracleText: '',
			setCode: 'TST',
			collectorNumber: String(i + 1),
			rarity: 'common' as const,
		}));
	}

	const VINTAGE = makeNamedCube('vintage', 360);
	const LEGACY = makeNamedCube('legacy', 360);

	function twoCubeResolver(): PoolSourceResolver {
		return {
			cards: (src) => (src.kind === 'cube' && src.cubeId === 'legacy' ? LEGACY : VINTAGE),
			name: (src) => (src.kind === 'cube' ? src.cubeId : `${src.code}:${src.style}`),
		};
	}

	function legacyPlan(): DraftPlan {
		const src: PoolSource = { kind: 'cube', cubeId: 'legacy' };
		return { rounds: [src, src, src] };
	}

	it("setting a room's plan to a non-default cube deals its first pack from that cube", () => {
		const r = createDraftRooms({
			resolver: twoCubeResolver(),
			defaultPlan: DEFAULT_PLAN, // names a cube this resolver does not even know — proves the room never falls back to it once a plan is set.
			now: () => 1_700_000_000_000,
			storeDir: null,
		});
		// `podDraft` (wired in production from `lobby.ts`) is where a pod's own
		// plan reaches `build()` — set here directly, the same seam.
		r.setPodLookup(() => ({ seats: 8, humans: [], bots: [], plan: legacyPlan() }));

		const room = r.open('pod-legacy');
		const state = stateOf(room);
		for (const pack of state.queues.flat()) {
			for (const card of pack) expect(card.name.startsWith('legacy')).toBe(true);
		}
		expect(r.cubeMetaOf(room)).toEqual({ name: 'legacy', size: 360 });
	});

	it('a room with no pod lookup wired deals the DEFAULT plan, not the other cube', () => {
		const r = createDraftRooms({ resolver: twoCubeResolver(), defaultPlan: legacyPlan(), now: () => 1_700_000_000_000, storeDir: null });
		const room = r.open('pod-default');
		const state = stateOf(room);
		for (const pack of state.queues.flat()) {
			for (const card of pack) expect(card.name.startsWith('legacy')).toBe(true);
		}
	});

	/*
	 * Wave 74 §E step 2: a `kind: 'set', style: 'set-cube'` round is dealt
	 * through the SAME `PoolSourceResolver.cards` seam a cube round is — no
	 * new plumbing in `draftRooms.ts` for it at all, which is the point of
	 * this test (it would fail just by `twoCubeResolver`-style wiring not
	 * recognising the source, not by any set-cube-specific bug).
	 */
	it('a set-cube round is dealt through the resolver exactly like a cube round', () => {
		const ARB = makeNamedCube('ARB', 145);
		const resolver: PoolSourceResolver = {
			cards: (src) => (src.kind === 'set' && src.code === 'ARB' ? ARB : VINTAGE),
			name: (src) => (src.kind === 'set' ? `${src.code} (${src.style})` : src.cubeId),
		};
		const src: PoolSource = { kind: 'set', code: 'ARB', style: 'set-cube' };
		const r = createDraftRooms({ resolver, defaultPlan: DEFAULT_PLAN, now: () => 1_700_000_000_000, storeDir: null });
		r.setPodLookup(() => ({ seats: 8, humans: [], bots: [], plan: { rounds: [src, src, src] } }));
		const room = r.open('pod-set-cube');
		const state = stateOf(room);
		for (const pack of state.queues.flat()) {
			for (const card of pack) expect(card.name.startsWith('ARB')).toBe(true);
		}
	});
});

/*
 * Wave 74 §E step 2: "realistic boosters are fetched before `deal` and
 * passed in, so `deal` stays synchronous and seeded." `cacheRealisticRound`
 * is the seam `http/rooms.ts`'s `POST …/start` route uses for that — these
 * tests drive it directly, the same way the suite above drives
 * `setPodLookup` directly rather than through a route.
 */
describe('cacheRealisticRound — realistic packs are read back once, by draft id and round', () => {
	function makeNamedCube(name: string, size: number): DraftCard[] {
		return Array.from({ length: size }, (_, i) => ({
			cardId: `${name}-${i}`,
			name: `${name} ${i}`,
			manaCost: [],
			manaValue: 0,
			colors: [],
			typeLine: 'Creature — Test',
			oracleText: '',
			setCode: 'TST',
			collectorNumber: String(i + 1),
			rarity: 'common' as const,
		}));
	}

	function forgePacks(seatCount: number, tag: string): DraftCard[][] {
		return Array.from({ length: seatCount }, (_, seat) => makeNamedCube(`${tag}-seat${seat}`, 15));
	}

	const REALISTIC: PoolSource = { kind: 'set', code: 'ISD', style: 'realistic' };

	/** Every field but `cardId` — `deal()` now stamps its own per-instance id (the fix-forward for the duplicate-name stall), so a byte-for-byte content check compares everything else. */
	function withoutId(packs: readonly (readonly DraftCard[])[]): unknown {
		return packs.map((pack) => pack.map(({ cardId: _cardId, ...rest }) => rest));
	}

	function realisticResolver(): PoolSourceResolver {
		return {
			cards: () => {
				throw new Error('a realistic round must never ask the resolver for a pool');
			},
			name: (src) => (src.kind === 'set' ? `${src.code} (${src.style})` : src.cubeId),
		};
	}

	it("a realistic round is dealt exactly from the packs cacheRealisticRound was given, never from the resolver", () => {
		const r = createDraftRooms({ resolver: realisticResolver(), defaultPlan: DEFAULT_PLAN, now: () => 1_700_000_000_000, storeDir: null });
		r.setPodLookup(() => ({ seats: 8, humans: [], bots: [], plan: { rounds: [REALISTIC, REALISTIC, REALISTIC] } }));
		const packs = forgePacks(8, 'isd');
		r.cacheRealisticRound('pod-realistic', 0, packs);
		r.cacheRealisticRound('pod-realistic', 1, packs);
		r.cacheRealisticRound('pod-realistic', 2, packs);
		const room = r.open('pod-realistic');
		const state = stateOf(room);
		expect(JSON.stringify(withoutId(state.rounds[0]!))).toBe(JSON.stringify(withoutId(packs)));
		// Every dealt card still gets its own unique id.
		const ids = (state.rounds[0] as DraftCard[][]).flat().map((c) => c.cardId);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('the cached round is consumed once — a SECOND open() for a different draft id never sees a stale entry', () => {
		const r = createDraftRooms({ resolver: realisticResolver(), defaultPlan: DEFAULT_PLAN, now: () => 1_700_000_000_000, storeDir: null });
		r.setPodLookup(() => ({ seats: 8, humans: [], bots: [], plan: { rounds: [REALISTIC, REALISTIC, REALISTIC] } }));
		r.cacheRealisticRound('pod-a', 0, forgePacks(8, 'a'));
		r.cacheRealisticRound('pod-a', 1, forgePacks(8, 'a'));
		r.cacheRealisticRound('pod-a', 2, forgePacks(8, 'a'));
		r.open('pod-a');
		// pod-b never had anything cached for it — dealing it must throw rather
		// than silently reuse pod-a's stashed packs.
		expect(() => r.open('pod-b')).toThrow(/realistic/);
	});

	/*
	 * Acceptance 2: "a restore of the persisted pod gives the identical packs
	 * with no Forge call." The packs a realistic round deals are written into
	 * the pod's own snapshot (`@hadoku/room-store`, wave 73's persistence —
	 * no new code here), and `createDraftRooms`'s eager restore loop reads
	 * them back through `decodeSnapshot`/`applySnapshot`, never through
	 * `build()`/`deal()`. The resolver whose `cards()` throws and the absence
	 * of ANY `cacheRealisticRound` call on the restored instance are what
	 * prove it: if a restore ever fell back to re-dealing, this test would
	 * throw instead of asserting byte-identical packs.
	 */
	it('a restore reads a realistic round\'s packs back from disk — never re-shuffles, never needs cacheRealisticRound again', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'cardtable-draftrooms-restore-test-'));
		try {
			const first = createDraftRooms({ resolver: realisticResolver(), defaultPlan: DEFAULT_PLAN, now: () => 1_700_000_000_000, storeDir: dir });
			first.setPodLookup(() => ({ seats: 8, humans: [], bots: [], plan: { rounds: [REALISTIC, REALISTIC, REALISTIC] } }));
			const originalPacks = forgePacks(8, 'persisted');
			first.cacheRealisticRound('pod-restore', 0, originalPacks);
			first.cacheRealisticRound('pod-restore', 1, originalPacks);
			first.cacheRealisticRound('pod-restore', 2, originalPacks);
			const dealt = stateOf(first.open('pod-restore')).rounds;

			// A second instance, same dir: the eager restore loop in
			// `createDraftRooms` runs before this function even returns, so the
			// pod is already live — `open` below is idempotent-into-the-restore,
			// not a fresh deal.
			const restored = createDraftRooms({ resolver: realisticResolver(), defaultPlan: DEFAULT_PLAN, now: () => 1_700_000_000_001, storeDir: dir });
			const room = restored.open('pod-restore');
			expect(JSON.stringify(stateOf(room).rounds)).toBe(JSON.stringify(dealt));
			expect(JSON.stringify(withoutId(stateOf(room).rounds[0]!))).toBe(JSON.stringify(withoutId(originalPacks)));
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

/*
 * PRODUCTION INCIDENT (found by lane F's e2e, since 50b5b06f): a realistic
 * draft hangs forever. `cubeMetaOf` builds the wire's `CubeMeta` as
 * `{ name, size: resolver.cards(src).length }`, and `index.ts`'s own
 * resolver answered `[]` for a realistic source (its packs come from
 * `cacheRealisticRound`, never a pool to shuffle) — so `size` was 0.
 * `CubeMetaSchema.size` is `z.number().int().positive()`, so the browser's
 * `safeParseServerMessage` rejected the WHOLE `state` message and the pod
 * sat on its skeleton forever. Nothing upstream of `cubeMetaOf` ever
 * round-tripped the real wire schema — every earlier test (including this
 * file's own) asserted on `DraftState`/`DraftCard` shapes directly, never on
 * what actually crosses the socket.
 *
 * These tests are deliberately generic over the resolver: `emptyForRealistic`
 * reproduces exactly the shape of resolver a lane can still write (`cards`
 * answering `[]` for a style it does not think needs a pool) — not a
 * specific fix to `index.ts`. The fix that makes these pass lives in
 * `cubeMetaOf` itself: it must never hand the wire a non-positive size,
 * whatever the resolver answered.
 */
describe('the wire: cubeMetaOf never emits a CubeMeta the real ServerMessage schema would reject', () => {
	function makeCards(tag: string, size: number): DraftCard[] {
		return Array.from({ length: size }, (_, i) => ({
			cardId: `${tag}-${i}`,
			name: `${tag} ${i}`,
			manaCost: [],
			manaValue: 0,
			colors: [],
			typeLine: 'Creature — Test',
			oracleText: '',
			setCode: 'TST',
			collectorNumber: String(i + 1),
			rarity: 'common' as const,
		}));
	}

	/** Reproduces the production bug: a realistic source has no shared pool, so a resolver answers `[]` for it — exactly `index.ts`'s resolver before the fix. */
	function emptyForRealistic(): PoolSourceResolver {
		return {
			cards(src) {
				if (src.kind === 'cube') return makeCards(src.cubeId, 60);
				if (src.style === 'set-cube') return makeCards(src.code, 60);
				return []; // the bug
			},
			name(src) {
				return src.kind === 'cube' ? src.cubeId : `${src.code} (${src.style})`;
			},
		};
	}

	/** `cubeMetaOf` reads round 1's source only, so a state message is one `open()` + one `cubeMetaOf()` away, no socket needed. */
	function stateMessageFor(r: DraftRooms, draftId: string, plan: DraftPlan, realisticRounds: { round: number; packs: DraftCard[][] }[] = []) {
		r.setPodLookup(() => ({ seats: 8, humans: [], bots: [], plan }));
		for (const { round, packs } of realisticRounds) r.cacheRealisticRound(draftId, round, packs);
		const room = r.open(draftId);
		const view = viewForParticipant(room, ALICE);
		return stateMessage(view, r.cubeMetaOf(room));
	}

	function expectValidWireMessage(msg: unknown): void {
		const parsed = safeParseServerMessage(msg);
		expect(parsed.ok, parsed.ok ? undefined : JSON.stringify(parsed.errors)).toBe(true);
	}

	it('a cube round\'s state message round-trips the real schema', () => {
		const r = createDraftRooms({ resolver: emptyForRealistic(), defaultPlan: DEFAULT_PLAN, now: () => 1_700_000_000_000, storeDir: null });
		const plan: DraftPlan = { rounds: [{ kind: 'cube', cubeId: 'vintage' }, { kind: 'cube', cubeId: 'vintage' }, { kind: 'cube', cubeId: 'vintage' }] };
		expectValidWireMessage(stateMessageFor(r, 'pod-wire-cube', plan));
	});

	it('a set-cube round\'s state message round-trips the real schema', () => {
		const r = createDraftRooms({ resolver: emptyForRealistic(), defaultPlan: DEFAULT_PLAN, now: () => 1_700_000_000_000, storeDir: null });
		const plan: DraftPlan = { rounds: [{ kind: 'set', code: 'ARB', style: 'set-cube' }, { kind: 'set', code: 'ARB', style: 'set-cube' }, { kind: 'set', code: 'ARB', style: 'set-cube' }] };
		expectValidWireMessage(stateMessageFor(r, 'pod-wire-set-cube', plan));
	});

	it('a REALISTIC round\'s state message round-trips the real schema — this is the production bug (fails on main)', () => {
		const r = createDraftRooms({ resolver: emptyForRealistic(), defaultPlan: DEFAULT_PLAN, now: () => 1_700_000_000_000, storeDir: null });
		const plan: DraftPlan = { rounds: [{ kind: 'set', code: 'ISD', style: 'realistic' }, { kind: 'set', code: 'ISD', style: 'realistic' }, { kind: 'set', code: 'ISD', style: 'realistic' }] };
		const packs = Array.from({ length: 8 }, (_, seat) => makeCards(`isd-seat${seat}`, 15));
		expectValidWireMessage(stateMessageFor(r, 'pod-wire-realistic', plan, [{ round: 0, packs }, { round: 1, packs }, { round: 2, packs }]));
	});

	it('a MIXED plan (realistic / set-cube / cube) state message round-trips the real schema — fails on main', () => {
		// `cubeMetaOf` reads round 1's source only,
		// so the realistic round has to be FIRST for this plan to exercise the
		// bug at all — a mixed plan with it in round 2 or 3 would pass on main
		// too, for the wrong reason (cubeMetaOf never looking at it).
		const r = createDraftRooms({ resolver: emptyForRealistic(), defaultPlan: DEFAULT_PLAN, now: () => 1_700_000_000_000, storeDir: null });
		const plan: DraftPlan = { rounds: [{ kind: 'set', code: 'ISD', style: 'realistic' }, { kind: 'set', code: 'ARB', style: 'set-cube' }, { kind: 'cube', cubeId: 'vintage' }] };
		const packs = Array.from({ length: 8 }, (_, seat) => makeCards(`isd-seat${seat}`, 15));
		expectValidWireMessage(stateMessageFor(r, 'pod-wire-mixed', plan, [{ round: 0, packs }]));
	});
});
