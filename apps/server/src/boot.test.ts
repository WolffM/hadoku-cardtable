/*
 * A restart gives back every room the way it was left: one server state with every kind of room in
 * flight, booted again by the function `index.ts` boots with (`restoreRooms`), over the same data
 * directories.
 *
 * The 2026-10-23 restarts reset two constructed tournaments mid-round (r-c1eb7fcaa5d7 in round 2,
 * r-228e5e39987e): `releaseLostDrafts` took a tournament for a draft that had not come back. Each
 * step of the boot had its own restart test; none ran the steps together, which is what this does.
 *
 * A live match is handed to the next process by play (`shutdown-matches handed`); what is checked
 * here is that the room still points at it.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { packOf, pick, runBots } from '@hadoku/draft';
import { GAUNTLET_SNAKE, type DraftCard, type GauntletSeatIndex } from '@hadoku/shared';

import { restoreRooms, type RestoredRooms } from './boot.ts';
import { DEFAULT_PLAN, joinDraftRoom, singlePoolResolver, stateOf } from './room/draftRooms.ts';
import { act, drawGauntlet, newGauntlet, startBanpick, type GauntletEraPool, type GauntletState } from './room/gauntlet.ts';
import type { Lobby, PodChecks } from './room/lobby.ts';
import { loadPool, type CubePool } from './room/pool.ts';

const CUBE_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '../../ui/src/draft/pool.json');

const ALICE = { id: 'fk:1111111111111111', name: 'user-alice' };
const BOB = { id: 'fk:2222222222222222', name: 'user-bob' };
const CAROL = { id: 'fk:3333333333333333', name: 'user-carol' };
const EVERYONE = [ALICE, BOB, CAROL];

const dirs: string[] = [];
afterAll(async () => {
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

function cubePool(): CubePool {
	const load = loadPool(CUBE_FILE);
	if (!load.ok) throw new Error(`the bundled cube pool did not load: ${load.detail}`);
	return load.pool;
}

/** The checks `http/routes.ts` installs, answered the same way on both sides of the restart. */
const CHECKS: PodChecks = {
	draftComplete: () => true,
	built: () => true,
	seatState: (_podId, memberId) => ({ seatedFor: memberId }),
	holdsSeriesDeck: () => true,
	planNameOf: () => 'cube',
	hasLegalSeatDeck: () => true,
	currentTournamentDeck: (_roomId, entrant) => ({ deckOf: entrant }),
	seatTournamentDeck: () => undefined,
};

const VERDICT = { ok: true, cards: 1 } as const;

/** The server's own boot, over `roomsDir`/`draftsDir`. */
async function boot(roomsDir: string, draftsDir: string, cube: CubePool): Promise<RestoredRooms> {
	const restored = await restoreRooms({
		lobby: { dir: roomsDir, checkPlan: async () => VERDICT },
		drafts: { ...singlePoolResolver(cube), storeDir: draftsDir },
		log: () => undefined,
	});
	restored.lobby.setPodChecks(CHECKS);
	return restored;
}

function era(id: string): GauntletEraPool {
	return {
		id,
		family: 'standard',
		title: `standard ${id}`,
		decks: Array.from({ length: 12 }, (_, i) => `${id}-d${i}`),
	};
}

function seeded(seed = 7): () => number {
	let s = seed;
	return () => {
		s = (s * 1103515245 + 12345) % 2 ** 31;
		return s / 2 ** 31;
	};
}

function gauntletInBanpick(players: [string, string]): GauntletState {
	const drawn = drawGauntlet(newGauntlet(), {
		players: [
			{ memberId: players[0], name: players[0] },
			{ memberId: players[1], name: players[1] },
		],
		eras: [era('2022-04-29')],
		now: 1_760_000_000_000,
		options: {},
		random: seeded(),
	});
	if (!drawn.ok) throw new Error(drawn.reason);
	const banpick = startBanpick(drawn.state);
	// One act in: a banpick part played.
	const step = GAUNTLET_SNAKE[0]!;
	const seat = (step.player === 'p1' ? banpick.first : 1 - banpick.first!) as GauntletSeatIndex;
	const open = banpick.decks.filter((_, i) => banpick.marks[i] === null);
	const out = act(banpick, seat, step.act, open[0]!);
	if (!out.ok) throw new Error(out.reason);
	return out.state;
}

function gauntletInChoose(players: [string, string]): GauntletState {
	let s = gauntletInBanpick(players);
	while (s.phase === 'banpick') {
		const step = GAUNTLET_SNAKE[s.stepIndex]!;
		const seat = (step.player === 'p1' ? s.first : 1 - s.first!) as GauntletSeatIndex;
		const out = act(s, seat, step.act, s.decks.filter((_, i) => s.marks[i] === null)[0]!);
		if (!out.ok) throw new Error(out.reason);
		s = out.state;
	}
	expect(s.phase).toBe('choose');
	return s;
}

function created(lobby: Lobby, name: string, options: Omit<Parameters<Lobby['create']>[1], 'name'>): string {
	const made = lobby.create(ALICE, { ...options, name });
	if (!made.ok) throw new Error(`create ${name}: ${made.reason}`);
	for (const m of [BOB, CAROL]) expect(lobby.join(made.room.id, m).ok).toBe(true);
	return made.room.id;
}

/** A draft room ready to deal: everyone ready, the open seats AI, the plan checked. */
function readyDraft(lobby: Lobby, name: string, sit: boolean): string {
	const id = created(lobby, name, { gameType: 'draft', clientMode: 'builtin' });
	if (sit) for (const [i, m] of EVERYONE.entries()) expect(lobby.sitPod(id, m.id, i)).toMatchObject({ ok: true });
	for (const m of EVERYONE) expect(lobby.setReady(id, m.id, true)).toBe(true);
	(lobby.get(id)?.pod?.seats ?? []).forEach((occupant, seat) => {
		if (occupant === null) expect(lobby.aiPod(id, ALICE.id, seat, true)).toMatchObject({ ok: true });
	});
	lobby.setPodPlan(id, ALICE.id, DEFAULT_PLAN, VERDICT);
	expect(lobby.startDraft(id, ALICE.id)).toMatchObject({ ok: true });
	return id;
}

function firstTable(lobby: Lobby, roomId: string): string {
	return lobby.get(roomId)!.tables[0]!.id;
}

/** A Constructed tournament, mid-round: its round dealt and a game live at its first table. */
function tournament(lobby: Lobby, name: string, mode: 'classic' | 'gauntlet' | 'random', seated: 'humans' | 'vs-ai'): string {
	const id = created(lobby, name, {
		gameType: 'constructed-1v1',
		clientMode: 'builtin',
		mode: mode === 'random' ? { mode: 'random', modeOptions: { pool: 'full' } } : { mode, modeOptions: {} },
	});
	expect(
		lobby.setSettings(id, ALICE.id, {
			tournament: true,
			tournamentDecks: mode === 'gauntlet' ? 'per-round' : 'locked',
		}),
	).toMatchObject({ ok: true });
	expect(lobby.sitPod(id, ALICE.id, 0)).toMatchObject({ ok: true });
	if (seated === 'humans') expect(lobby.sitPod(id, BOB.id, 1)).toMatchObject({ ok: true });
	else expect(lobby.aiPod(id, ALICE.id, 1, true)).toMatchObject({ ok: true });
	for (const m of seated === 'humans' ? [ALICE, BOB] : [ALICE]) if (lobby.get(id)!.draftStartedAt === null) lobby.setReady(id, m.id, true);
	// A complete field of legal decks locks itself (ruling 7); otherwise the leader starts it.
	if (lobby.get(id)!.draftStartedAt === null) expect(lobby.startDraft(id, ALICE.id)).toMatchObject({ ok: true });
	expect(lobby.get(id)!.pod?.phase).toBe('rounds');
	const pairing = lobby.get(id)!.pod!.pairings[0]!;
	if (mode === 'gauntlet') {
		const players = pairing.players as [string, string];
		expect(lobby.setGauntlet(id, gauntletInChoose(players), pairing.tableId)).toBe(true);
	}
	expect(lobby.setTableMatch(id, pairing.tableId, `m-${name}`)).toBe(true);
	return id;
}

describe('a restart gives every room in flight back the way it was left', () => {
	it('draft rooms, pods in rounds, tournaments of every mode, Gauntlet tables, a Bo3 between games and a live match', async () => {
		const cube = cubePool();
		const roomsDir = await mkdtemp(join(tmpdir(), 'cardtable-boot-rooms-'));
		const draftsDir = await mkdtemp(join(tmpdir(), 'cardtable-boot-drafts-'));
		dirs.push(roomsDir, draftsDir);
		const before = await boot(roomsDir, draftsDir, cube);
		const { lobby } = before;
		const drafts = before.draftRooms!;
		const rooms: Record<string, string> = {};

		// A draft mid-pick: dealt, Alice seated, one pick made and the bots caught up.
		rooms.draftMidPick = readyDraft(lobby, 'draft-mid-pick', false);
		const pod = drafts.open(rooms.draftMidPick);
		const seat = joinDraftRoom(pod, 'sock-alice', ALICE.id, 'friend').seat;
		if (seat === null) throw new Error('alice was not seated');
		const picked = pick(stateOf(pod), seat, (packOf(stateOf(pod), seat)[0] as DraftCard).cardId);
		if (!picked.ok) throw new Error(picked.reason);
		pod.app.state = runBots(picked.state).state;

		// A draft pod in its rounds: drafted, built, round 1 dealt and a game live.
		rooms.podRounds = readyDraft(lobby, 'pod-rounds', true);
		drafts.open(rooms.podRounds);
		for (const m of EVERYONE) expect(lobby.playPod(rooms.podRounds, m.id)).toMatchObject({ ok: true });
		expect(lobby.get(rooms.podRounds)!.pod!.phase).toBe('rounds');
		const podTable = lobby.get(rooms.podRounds)!.pod!.pairings[0]!.tableId;
		expect(lobby.setTableMatch(rooms.podRounds, podTable, 'm-pod-rounds')).toBe(true);

		// Constructed tournaments mid-round, in every mode, and one against the AI.
		rooms.classicTournament = tournament(lobby, 'classic-tournament', 'classic', 'humans');
		rooms.gauntletTournament = tournament(lobby, 'gauntlet-tournament', 'gauntlet', 'humans');
		rooms.randomTournament = tournament(lobby, 'random-tournament', 'random', 'humans');
		rooms.vsAiTournament = tournament(lobby, 'vs-ai-tournament', 'classic', 'vs-ai');

		// Gauntlet tables in banpick and in choose.
		for (const [key, state] of [
			['gauntletBanpick', gauntletInBanpick([ALICE.id, BOB.id])],
			['gauntletChoose', gauntletInChoose([ALICE.id, BOB.id])],
		] as const) {
			rooms[key] = created(lobby, key, {
				gameType: 'constructed-1v1',
				clientMode: 'builtin',
				mode: { mode: 'gauntlet', modeOptions: {} },
			});
			const table = firstTable(lobby, rooms[key]);
			for (const m of [ALICE, BOB]) expect(lobby.sit(rooms[key], table, m.id)).toBe(true);
			expect(lobby.setGauntlet(rooms[key], state, table)).toBe(true);
		}

		// A Bo3 between games: game 1 played, the Rematch taken, both seats sideboarding.
		rooms.bo3Sideboarding = created(lobby, 'bo3-sideboarding', {
			gameType: 'constructed-1v1',
			clientMode: 'builtin',
		});
		const bo3Table = firstTable(lobby, rooms.bo3Sideboarding);
		for (const m of [ALICE, BOB]) {
			expect(lobby.sit(rooms.bo3Sideboarding, bo3Table, m.id)).toBe(true);
			expect(
				lobby.setPlayerState(rooms.bo3Sideboarding, m.id, {
					deck: `${m.name}'s deck`,
				}),
			).toBe(true);
		}
		expect(lobby.setTableMatch(rooms.bo3Sideboarding, bo3Table, 'm-bo3-game-1')).toBe(true);
		expect(
			lobby.recordGameResult(rooms.bo3Sideboarding, bo3Table, {
				matchId: 'm-bo3-game-1',
				winner: 0,
			}).ok,
		).toBe(true);
		expect(lobby.beginSideboarding(rooms.bo3Sideboarding, bo3Table)).toBe(true);
		expect(lobby.get(rooms.bo3Sideboarding)!.tables[0]!.series.phase).toBe('sideboarding');

		// A live match, handed over to the next process.
		rooms.liveMatch = created(lobby, 'live-match', {
			gameType: 'constructed-1v1',
			clientMode: 'builtin',
		});
		const liveTable = firstTable(lobby, rooms.liveMatch);
		for (const m of [ALICE, BOB]) expect(lobby.sit(rooms.liveMatch, liveTable, m.id)).toBe(true);
		expect(lobby.setTableMatch(rooms.liveMatch, liveTable, 'm-live')).toBe(true);

		const snapshot = (l: Lobby) =>
			Object.fromEntries(
				Object.entries(rooms).map(([key, id]) => {
					const view = l.get(id);
					return [
						key,
						{
							view,
							gauntlets: (view?.tables ?? []).map((t) => l.gauntlet(id, t.id)),
							players: EVERYONE.map((m) => l.playerState(id, m.id)),
						},
					];
				}),
			);
		const left = snapshot(lobby);
		for (const [key, room] of Object.entries(left)) expect(room.view, key).toBeDefined();

		const after = await boot(roomsDir, draftsDir, cube);
		expect(after.lostDrafts).toEqual([]);
		// A plan's verdict is not kept: a restored room checks its plan again, in the background (`OpenLobbyOptions.checkPlan`).
		await vi.waitFor(() => {
			const back = snapshot(after.lobby);
			for (const key of Object.keys(rooms)) expect(back[key], key).toEqual(left[key]);
		});
		// The draft is where its pick left it, under a new epoch: a restored draft is a new session for its sockets.
		const { epoch: leftEpoch, ...leftDraft } = stateOf(pod);
		const { epoch: backEpoch, ...backDraft } = stateOf(after.draftRooms!.find(rooms.draftMidPick)!);
		expect(backDraft).toEqual(leftDraft);
		expect(backEpoch).not.toBe(leftEpoch);
	});

	it('a draft room whose draft did not come back is the one room the boot sends back to its lobby', async () => {
		const cube = cubePool();
		const roomsDir = await mkdtemp(join(tmpdir(), 'cardtable-boot-rooms-'));
		const draftsDir = await mkdtemp(join(tmpdir(), 'cardtable-boot-drafts-'));
		dirs.push(roomsDir, draftsDir);
		const { lobby } = await boot(roomsDir, draftsDir, cube);
		const draft = readyDraft(lobby, 'draft-lost', false);
		const kept = tournament(lobby, 'kept', 'classic', 'humans');

		const after = await boot(roomsDir, draftsDir, cube);
		expect(after.lostDrafts).toEqual([draft]);
		expect(after.lobby.get(draft)?.draftStartedAt).toBeNull();
		expect(after.lobby.get(kept)?.pod).toMatchObject({
			phase: 'rounds',
			round: 1,
		});
	});
});
