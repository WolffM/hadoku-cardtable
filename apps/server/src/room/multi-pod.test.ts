/**
 * Multi-pod rooms (wave 84 §w84b): a room of more than 8 splits its drafters
 * into pods of at most 8 (`splitPods`: 13 → 7 + 6), each pod drafts on its own
 * draft id, and then ONE Swiss of at most 3 rounds pairs the whole field into
 * ONE standings (the operator, 2026-10-31: *"everyone is displayed in the same
 * 'bracket' and we only go to 3 matches maximum"*).
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { seatOf } from '@wolffm/rooms-protocol';
import { POD_MAX_SEATS, POD_SEATS } from '@hadoku/shared';
import { createDraftRooms, DEFAULT_PLAN, singlePoolResolver, stateOf } from './draftRooms.ts';
import { openLobby, type Lobby, type PodChecks } from './lobby.ts';
import { loadPool } from './pool.ts';
import { roundNamesOf } from './plan.ts';

const CUBE_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '../../../ui/src/draft/pool.json');

const dirs: string[] = [];
afterAll(async () => {
	await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});
async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'cardtable-multipod-'));
	dirs.push(dir);
	return dir;
}

const member = (i: number) => ({ id: `fk:${String(i + 1).padStart(16, '0')}`, name: `user-${i + 1}` });

/** Checks that answer every pod complete and every drafter built, and record which draft id each question named. */
function recordingChecks(asked: { built: [string, string][]; seatState: [string, string][] }): PodChecks {
	return {
		draftComplete: () => true,
		built: (podId, memberId) => {
			asked.built.push([podId, memberId]);
			return true;
		},
		seatState: (podId, memberId) => {
			asked.seatState.push([podId, memberId]);
			return { seatedFor: memberId, podId };
		},
		holdsSeriesDeck: () => true,
		roundNamesOf: (plan) => roundNamesOf(plan, (source) => (source.kind === 'cube' ? source.cubeId : source.code)),
		hasLegalSeatDeck: () => false,
		currentTournamentDeck: () => null,
		seatTournamentDeck: () => {},
	};
}

/** A draft room of `n` humans, every one seated (growing the room a pod at a time), the open seats AI, all ready, and its draft started. */
async function startedRoom(n: number): Promise<{ lobby: Lobby; id: string; humans: string[] }> {
	const lobby = await openLobby({ dir: await tempDir() });
	const people = Array.from({ length: n }, (_, i) => member(i));
	const made = lobby.create(people[0]!, { name: 'Cube night', gameType: 'draft', clientMode: 'builtin' });
	if (!made.ok) throw new Error('create failed');
	const id = made.room.id;
	for (const m of people.slice(1)) expect(lobby.join(id, m).ok).toBe(true);
	// Seat order, one at a time: past the 8th, a sit with no seat open grows the room by a pod.
	for (const m of people) expect(lobby.sitPod(id, m.id).ok, `${m.name} sits`).toBe(true);
	const seats = lobby.get(id)!.pod!.seats;
	expect(seats.length).toBe(Math.ceil(n / POD_SEATS) * POD_SEATS);
	seats.forEach((s, seat) => {
		if (s === null) expect(lobby.aiPod(id, people[0]!.id, seat, true).ok).toBe(true);
	});
	for (const m of people) expect(lobby.setReady(id, m.id, true)).toBe(true);
	lobby.setPodPlan(id, people[0]!.id, DEFAULT_PLAN, { ok: true, cards: 1 });
	expect(lobby.startDraft(id, people[0]!.id).ok).toBe(true);
	return { lobby, id, humans: people.map((m) => m.id) };
}

describe('a room of 13 drafts as 7 + 6 and plays one Swiss of 3 rounds into one standings', () => {
	it('splits the drafters 7 + 6 in seat order, each pod on its own draft id, the second routed by member', async () => {
		const { lobby, id, humans } = await startedRoom(13);
		const view = lobby.get(id)!;
		expect(view.pod?.phase).toBe('drafting');
		expect(view.pod?.pods).toEqual([humans.slice(0, 7), humans.slice(7)]);

		const first = lobby.podDraft(id)!;
		const second = lobby.podDraft(`${id}~1`)!;
		expect(first.humans.map((h) => h.participantId)).toEqual(humans.slice(0, 7));
		expect(second.humans.map((h) => h.participantId)).toEqual(humans.slice(7));
		// Each pod drafts a full table of 8: its humans, AI filling the rest.
		expect([first.seats, second.seats]).toEqual([POD_SEATS, POD_SEATS]);
		expect(first.bots).toHaveLength(1);
		expect(second.bots).toHaveLength(2);
		// The room id routes each drafter to their own pod's draft.
		expect(first.podOf?.[humans[0]!]).toBe(id);
		expect(first.podOf?.[humans[9]!]).toBe(`${id}~1`);
	});

	it('a real DraftRooms deals each pod apart, and a pod-2 drafter is found through the room id', async () => {
		const { lobby, id, humans } = await startedRoom(13);
		const load = loadPool(CUBE_FILE);
		if (!load.ok) throw new Error(`the bundled cube pool did not load: ${load.detail}`);
		const draftRooms = createDraftRooms({ ...singlePoolResolver(load.pool), now: () => 1_700_000_000_000 });
		draftRooms.setPodLookup((podId) => lobby.podDraft(podId));
		const podOne = stateOf(draftRooms.open(id));
		const podTwo = stateOf(draftRooms.open(`${id}~1`));
		expect(podOne.seatCount).toBe(POD_SEATS);
		expect(podTwo.seatCount).toBe(POD_SEATS);
		expect(seatOf(podOne.table, humans[9]!)).toBeNull();
		expect(seatOf(podTwo.table, humans[9]!)).not.toBeNull();
		// Every seam that holds only the room id (the deck routes, the drafted-deck check at Ready) asks `findFor`.
		expect(draftRooms.findFor(id, humans[9]!)?.roomId).toBe(`${id}~1`);
		expect(draftRooms.findFor(id, humans[0]!)?.roomId).toBe(id);
		expect(draftRooms.routeFor(id, humans[9]!)).toBe(`${id}~1`);
	});

	it('waits for every pod to finish drafting', async () => {
		const { lobby, id } = await startedRoom(13);
		const done = new Set<string>([id]);
		lobby.setPodChecks({ ...recordingChecks({ built: [], seatState: [] }), draftComplete: (podId) => done.has(podId) });
		expect(lobby.get(id)!.pod?.phase).toBe('drafting');
		done.add(`${id}~1`);
		expect(lobby.get(id)!.pod?.phase).toBe('building');
	});

	it('asks each drafter’s own pod whether their deck is built, and seats them with it', async () => {
		const { lobby, id, humans } = await startedRoom(13);
		const asked = { built: [] as [string, string][], seatState: [] as [string, string][] };
		lobby.setPodChecks(recordingChecks(asked));
		for (const h of humans) expect(lobby.playPod(id, h).ok).toBe(true);
		const podOf = (h: string) => (humans.indexOf(h) < 7 ? id : `${id}~1`);
		expect(asked.built.length).toBeGreaterThan(0);
		for (const [podId, h] of asked.built) expect(podId, `built(${h})`).toBe(podOf(h));
		for (const [podId, h] of asked.seatState) expect(podId, `seatState(${h})`).toBe(podOf(h));
	});

	it('pairs the whole field across pods for 3 rounds and ends with one standings of 13', async () => {
		const { lobby, id, humans } = await startedRoom(13);
		lobby.setPodChecks(recordingChecks({ built: [], seatState: [] }));
		for (const h of humans) lobby.playPod(id, h);
		let view = lobby.get(id)!;
		expect(view.pod?.phase).toBe('rounds');
		expect(view.pod?.rounds).toBe(3);
		const pod1 = new Set(humans.slice(0, 7));
		const crossPod = (players: readonly string[]) => pod1.has(players[0]!) !== pod1.has(players[1]!);
		expect(view.pod?.pairings).toHaveLength(6);
		expect(view.pod?.pairings.some((p) => crossPod(p.players)), 'round 1 pairs across pods').toBe(true);

		for (let round = 1; round <= 3; round++) {
			view = lobby.get(id)!;
			expect(view.pod?.round).toBe(round);
			for (const p of view.pod!.pairings) {
				lobby.recordGameResult(id, p.tableId, { matchId: `m-${round}-${p.tableId}-1`, winner: 0 });
				lobby.recordGameResult(id, p.tableId, { matchId: `m-${round}-${p.tableId}-2`, winner: 0 });
			}
		}
		const done = lobby.get(id)!;
		expect(done.pod?.phase).toBe('done');
		expect(done.pod?.standings).toHaveLength(13);
		expect(new Set(done.pod?.standings.map((r) => r.id))).toEqual(new Set(humans));
		expect(done.pod?.results.filter((r) => r.playerB === null)).toHaveLength(3);
	});
});

describe('the room grows and shrinks a pod at a time', () => {
	it('a sit with no seat open adds 8 seats; standing out of an empty last pod takes them away', async () => {
		const lobby = await openLobby({ dir: await tempDir() });
		const people = Array.from({ length: 9 }, (_, i) => member(i));
		const made = lobby.create(people[0]!, { name: 'Cube night', gameType: 'draft', clientMode: 'builtin' });
		if (!made.ok) throw new Error('create failed');
		const id = made.room.id;
		for (const m of people.slice(1)) lobby.join(id, m);
		for (const m of people.slice(0, 8)) expect(lobby.sitPod(id, m.id).ok).toBe(true);
		expect(lobby.get(id)!.pod!.seats).toHaveLength(8);
		expect(lobby.sitPod(id, people[8]!.id).ok).toBe(true);
		expect(lobby.get(id)!.pod!.seats).toHaveLength(16);
		expect(lobby.get(id)!.pod!.seats[8]?.memberId).toBe(people[8]!.id);
		expect(lobby.standPod(id, people[8]!.id).ok).toBe(true);
		expect(lobby.get(id)!.pod!.seats).toHaveLength(8);
	});

	it('the AI button on the next pod’s first seat grows the room too, and a bad seat past it is refused', async () => {
		const lobby = await openLobby({ dir: await tempDir() });
		const owner = member(0);
		const made = lobby.create(owner, { name: 'Cube night', gameType: 'draft', clientMode: 'builtin' });
		if (!made.ok) throw new Error('create failed');
		const id = made.room.id;
		expect(lobby.aiPod(id, owner.id, 9, true)).toMatchObject({ ok: false, reason: 'bad-seat' });
		for (let seat = 0; seat < 8; seat++) expect(lobby.aiPod(id, owner.id, seat, true).ok).toBe(true);
		expect(lobby.aiPod(id, owner.id, 8, true).ok).toBe(true);
		expect(lobby.get(id)!.pod!.seats).toHaveLength(16);
	});

	it('stops at eight pods: a room of 64 seats is full', async () => {
		const lobby = await openLobby({ dir: await tempDir() });
		const owner = member(0);
		const made = lobby.create(owner, { name: 'Cube night', gameType: 'draft', clientMode: 'builtin' });
		if (!made.ok) throw new Error('create failed');
		const id = made.room.id;
		for (let seat = 0; seat < POD_MAX_SEATS; seat++) expect(lobby.aiPod(id, owner.id, seat, true).ok, `seat ${seat}`).toBe(true);
		expect(lobby.aiPod(id, owner.id, POD_MAX_SEATS, true)).toMatchObject({ ok: false, reason: 'bad-seat' });
		expect(lobby.sitPod(id, owner.id)).toEqual({ ok: false, reason: 'pod-full' });
	});

	it('a room of 8 or fewer drafts exactly as before: one pod on the room id', async () => {
		const { lobby, id } = await startedRoom(5);
		expect(lobby.get(id)!.pod?.pods).toEqual([lobby.get(id)!.pod!.drafters]);
		expect(lobby.podDraft(id)?.podOf).toBeUndefined();
		expect(lobby.podDraft(`${id}~1`)).toBeNull();
	});

	it('a restart keeps the pods', async () => {
		const dir = await tempDir();
		const lobby = await openLobby({ dir });
		const people = Array.from({ length: 10 }, (_, i) => member(i));
		const made = lobby.create(people[0]!, { name: 'Cube night', gameType: 'draft', clientMode: 'builtin' });
		if (!made.ok) throw new Error('create failed');
		const id = made.room.id;
		for (const m of people.slice(1)) lobby.join(id, m);
		for (const m of people) lobby.sitPod(id, m.id);
		lobby.get(id)!.pod!.seats.forEach((s, seat) => {
			if (s === null) lobby.aiPod(id, people[0]!.id, seat, true);
		});
		for (const m of people) lobby.setReady(id, m.id, true);
		lobby.setPodPlan(id, people[0]!.id, DEFAULT_PLAN, { ok: true, cards: 1 });
		expect(lobby.startDraft(id, people[0]!.id).ok).toBe(true);
		const before = lobby.get(id)!.pod?.pods;
		expect(before).toHaveLength(2);
		const again = await openLobby({ dir });
		expect(again.get(id)!.pod?.pods).toEqual(before);
		expect(again.podDraft(`${id}~1`)?.humans.map((h) => h.participantId)).toEqual(before![1]);
	});
});
