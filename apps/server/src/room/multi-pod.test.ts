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
import { POD_MAX_SEATS, POD_SEATS, POD_SPLIT_GRACE_MS } from '@hadoku/shared';
import { createDraftRooms, DEFAULT_PLAN, singlePoolResolver, stateOf } from './draftRooms.ts';
import { openLobby, splitIntoPods, type Lobby, type PodChecks } from './lobby.ts';
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

const T0 = 1_700_000_000_000;

/** A draft room of `n` humans, every one seated (the room growing a seat at a time past 8), any open seat AI, all ready. */
async function readyRoom(n: number, dir?: string): Promise<{ lobby: Lobby; id: string; humans: string[]; clock: { t: number }; seeds: string[] }> {
	const clock = { t: T0 };
	const seeds: string[] = [];
	const lobby = await openLobby({
		dir: dir ?? (await tempDir()),
		now: () => clock.t,
		log: (e) => {
			if (e.event === 'room-pods-split') seeds.push(e.seed as string);
		},
	});
	const people = Array.from({ length: n }, (_, i) => member(i));
	const made = lobby.create(people[0]!, { name: 'Cube night', gameType: 'draft', clientMode: 'builtin' });
	if (!made.ok) throw new Error('create failed');
	const id = made.room.id;
	for (const m of people.slice(1)) expect(lobby.join(id, m).ok).toBe(true);
	for (const m of people) expect(lobby.sitPod(id, m.id).ok, `${m.name} sits`).toBe(true);
	expect(lobby.get(id)!.pod!.seats).toHaveLength(Math.max(n, POD_SEATS));
	lobby.get(id)!.pod!.seats.forEach((s, seat) => {
		if (s === null) expect(lobby.aiPod(id, people[0]!.id, seat, true).ok).toBe(true);
	});
	lobby.setPodPlan(id, people[0]!.id, DEFAULT_PLAN, { ok: true, cards: 1 });
	for (const m of people) expect(lobby.setReady(id, m.id, true)).toBe(true);
	return { lobby, id, humans: people.map((m) => m.id), clock, seeds };
}

/** `readyRoom`, split by its leader past 8, and its draft started once the split has stood its moment. */
async function startedRoom(n: number, dir?: string): Promise<{ lobby: Lobby; id: string; humans: string[]; pods: string[][] }> {
	const { lobby, id, humans, clock } = await readyRoom(n, dir);
	if (n > POD_SEATS) {
		expect(lobby.splitPod(id, humans[0]!).ok).toBe(true);
		clock.t += POD_SPLIT_GRACE_MS;
	}
	expect(lobby.startDraft(id, humans[0]!).ok).toBe(true);
	return { lobby, id, humans, pods: lobby.get(id)!.pod?.pods ?? [humans] };
}

describe('Split & randomize: past 8 drafters, the leader splits the ready room into random pods before the draft', () => {
	it('is refused until every seated drafter is ready, to anyone but the leader, and in a room of 8 or fewer', async () => {
		const small = await readyRoom(8);
		expect(small.lobby.splitPod(small.id, small.humans[0]!)).toEqual({ ok: false, reason: 'one-pod' });

		const { lobby, id, humans } = await readyRoom(9);
		expect(lobby.setReady(id, humans[4]!, false)).toBe(true);
		expect(lobby.splitPod(id, humans[0]!)).toEqual({ ok: false, reason: 'not-ready' });
		expect(lobby.setReady(id, humans[4]!, true)).toBe(true);
		expect(lobby.splitPod(id, humans[1]!)).toEqual({ ok: false, reason: 'not-leader' });
		expect(lobby.get(id)!.pod?.pods).toBeUndefined();
		expect(lobby.splitPod(id, humans[0]!).ok).toBe(true);
	});

	it('splits 9 into 5 + 4 at random, the same pods again from the logged seed', async () => {
		const { lobby, id, humans, seeds } = await readyRoom(9);
		const split = lobby.splitPod(id, humans[0]!);
		if (!split.ok) throw new Error(split.reason);
		expect(seeds).toHaveLength(1);
		const pods = split.room.pod?.pods;
		expect(pods?.map((p) => p.length)).toEqual([5, 4]);
		expect(new Set(pods?.flat())).toEqual(new Set(humans));
		expect(pods).toEqual(splitIntoPods(humans, seeds[0]!));
		expect(splitIntoPods(humans, seeds[0]!)).toEqual(splitIntoPods(humans, seeds[0]!));
		// Random, not seat order: across seeds the first pod is not always the first five seats.
		const firsts = new Set(Array.from({ length: 20 }, (_, i) => splitIntoPods(humans, `seed-${i}`)[0]!.join()));
		expect(firsts.size).toBeGreaterThan(1);
		// A second press while the split stands changes nothing.
		const again = lobby.splitPod(id, humans[0]!);
		expect(again.ok && again.room.pod?.pods).toEqual(pods);
		expect(seeds).toHaveLength(1);
	});

	it('the draft starts only from a split, a moment after it, on the split’s own pods', async () => {
		const { lobby, id, humans, clock } = await readyRoom(9);
		expect(lobby.startDraft(id, humans[3]!)).toEqual({ ok: false, reason: 'not-split' });
		const split = lobby.splitPod(id, humans[0]!);
		if (!split.ok) throw new Error(split.reason);
		clock.t += POD_SPLIT_GRACE_MS - 1;
		expect(lobby.startDraft(id, humans[3]!)).toEqual({ ok: false, reason: 'not-split' });
		clock.t += 1;
		const started = lobby.startDraft(id, humans[3]!);
		expect(started.ok).toBe(true);
		expect(lobby.get(id)!.pod?.phase).toBe('drafting');
		expect(lobby.get(id)!.pod?.pods).toEqual(split.room.pod?.pods);
	});

	it('a split stops standing once its field changes: someone stands, and the room splits again', async () => {
		const { lobby, id, humans, clock } = await readyRoom(10);
		expect(lobby.splitPod(id, humans[0]!).ok).toBe(true);
		expect(lobby.standPod(id, humans[9]!).ok).toBe(true);
		expect(lobby.get(id)!.pod?.pods).toBeUndefined();
		clock.t += POD_SPLIT_GRACE_MS;
		expect(lobby.startDraft(id, humans[0]!)).toEqual({ ok: false, reason: 'not-split' });
		const resplit = lobby.splitPod(id, humans[0]!);
		expect(resplit.ok && resplit.room.pod?.pods?.map((p) => p.length)).toEqual([5, 4]);
	});

	it('a room of 8 or fewer needs no split and starts as it always has', async () => {
		const { lobby, id, humans } = await readyRoom(6);
		expect(lobby.startDraft(id, humans[2]!).ok).toBe(true);
		expect(lobby.podDraft(`${id}~1`)).toBeNull();
	});
});

describe('a room of 13 drafts as 7 + 6 and plays one Swiss of 3 rounds into one standings', () => {
	it('drafts the split’s 7 + 6, each pod on its own draft id, the second routed by member', async () => {
		const { lobby, id, humans, pods } = await startedRoom(13);
		const view = lobby.get(id)!;
		expect(view.pod?.phase).toBe('drafting');
		expect(pods.map((p) => p.length)).toEqual([7, 6]);
		expect(new Set(pods.flat())).toEqual(new Set(humans));

		const first = lobby.podDraft(id)!;
		const second = lobby.podDraft(`${id}~1`)!;
		expect(first.humans.map((h) => h.participantId)).toEqual(pods[0]);
		expect(second.humans.map((h) => h.participantId)).toEqual(pods[1]);
		// Each pod drafts a full table of 8: its humans, AI filling the rest.
		expect([first.seats, second.seats]).toEqual([POD_SEATS, POD_SEATS]);
		expect(first.bots).toHaveLength(1);
		expect(second.bots).toHaveLength(2);
		// The room id routes each drafter to their own pod's draft.
		expect(first.podOf?.[pods[0]![0]!]).toBe(id);
		expect(first.podOf?.[pods[1]![0]!]).toBe(`${id}~1`);
	});

	it('a real DraftRooms deals each pod apart, and a pod-2 drafter is found through the room id', async () => {
		const { lobby, id, pods } = await startedRoom(13);
		const [one, two] = [pods[0]![0]!, pods[1]![0]!];
		const load = loadPool(CUBE_FILE);
		if (!load.ok) throw new Error(`the bundled cube pool did not load: ${load.detail}`);
		const draftRooms = createDraftRooms({ ...singlePoolResolver(load.pool), now: () => 1_700_000_000_000 });
		draftRooms.setPodLookup((podId) => lobby.podDraft(podId));
		const podOne = stateOf(draftRooms.open(id));
		const podTwo = stateOf(draftRooms.open(`${id}~1`));
		expect(podOne.seatCount).toBe(POD_SEATS);
		expect(podTwo.seatCount).toBe(POD_SEATS);
		expect(seatOf(podOne.table, two)).toBeNull();
		expect(seatOf(podTwo.table, two)).not.toBeNull();
		// Every seam that holds only the room id (the deck routes, the drafted-deck check at Ready) asks `findFor`.
		expect(draftRooms.findFor(id, two)?.roomId).toBe(`${id}~1`);
		expect(draftRooms.findFor(id, one)?.roomId).toBe(id);
		expect(draftRooms.routeFor(id, two)).toBe(`${id}~1`);
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
		const { lobby, id, humans, pods } = await startedRoom(13);
		const asked = { built: [] as [string, string][], seatState: [] as [string, string][] };
		lobby.setPodChecks(recordingChecks(asked));
		for (const h of humans) expect(lobby.playPod(id, h).ok).toBe(true);
		const podOf = (h: string) => (pods[0]!.includes(h) ? id : `${id}~1`);
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
		// Round 1 pairs the whole field by seat, whatever pod each drafted in: seat i plays seat i + 7, seat 6 has the bye.
		expect(view.pod?.pairings.map((p) => p.players)).toEqual(Array.from({ length: 6 }, (_, i) => [humans[i], humans[i + 7]]));
		expect(view.pod?.bye).toBe(humans[6]);

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

describe('the room grows and shrinks a seat at a time, as one list', () => {
	it('a sit with no seat open adds one seat; standing out of the last one takes it away', async () => {
		const lobby = await openLobby({ dir: await tempDir() });
		const people = Array.from({ length: 9 }, (_, i) => member(i));
		const made = lobby.create(people[0]!, { name: 'Cube night', gameType: 'draft', clientMode: 'builtin' });
		if (!made.ok) throw new Error('create failed');
		const id = made.room.id;
		for (const m of people.slice(1)) lobby.join(id, m);
		for (const m of people.slice(0, 8)) expect(lobby.sitPod(id, m.id).ok).toBe(true);
		expect(lobby.get(id)!.pod!.seats).toHaveLength(8);
		expect(lobby.sitPod(id, people[8]!.id).ok).toBe(true);
		expect(lobby.get(id)!.pod!.seats).toHaveLength(9);
		expect(lobby.get(id)!.pod!.seats[8]?.memberId).toBe(people[8]!.id);
		expect(lobby.standPod(id, people[8]!.id).ok).toBe(true);
		expect(lobby.get(id)!.pod!.seats).toHaveLength(8);
	});

	it('the AI button on the seat past the last grows the room too, and a bad seat past it is refused', async () => {
		const lobby = await openLobby({ dir: await tempDir() });
		const owner = member(0);
		const made = lobby.create(owner, { name: 'Cube night', gameType: 'draft', clientMode: 'builtin' });
		if (!made.ok) throw new Error('create failed');
		const id = made.room.id;
		expect(lobby.aiPod(id, owner.id, 9, true)).toMatchObject({ ok: false, reason: 'bad-seat' });
		for (let seat = 0; seat < 8; seat++) expect(lobby.aiPod(id, owner.id, seat, true).ok).toBe(true);
		expect(lobby.aiPod(id, owner.id, 8, true).ok).toBe(true);
		expect(lobby.get(id)!.pod!.seats).toHaveLength(9);
		expect(lobby.aiPod(id, owner.id, 10, true)).toMatchObject({ ok: false, reason: 'bad-seat' });
	});

	it('stops at 64 seats, eight pods’ worth', async () => {
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

	it('a restart keeps the pods, and a standing split', async () => {
		const dir = await tempDir();
		const { lobby, id, humans } = await readyRoom(10, dir);
		const split = lobby.splitPod(id, humans[0]!);
		if (!split.ok) throw new Error(split.reason);
		expect((await openLobby({ dir })).get(id)!.pod?.pods).toEqual(split.room.pod?.pods);

		const drafted = await tempDir();
		const started = await startedRoom(10, drafted);
		const again = await openLobby({ dir: drafted });
		expect(again.get(started.id)!.pod?.pods).toEqual(started.pods);
		expect(again.podDraft(`${started.id}~1`)?.humans.map((h) => h.participantId)).toEqual(started.pods[1]);
	});
});
