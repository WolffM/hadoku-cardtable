/**
 * A whole draft tournament, simulated end to end: N drafters on real socket.io
 * connections, through the real lobby (seats, Ready, Split, Start), the real
 * draft engine and its bots, building, and every Swiss round to the standings.
 *
 * Built for a field past one pod (the operator, 2026-11-23: "i haven't tested
 * with >8 people at all yet"). Nothing here is stubbed but Forge: a table's
 * games are recorded with `recordGameResult`, as `play/` does when a match
 * ends, and a bot game answers at once. The drafters pick by different rules
 * (the heuristic bot's, at random, first card, rarest) and the bot seats by the
 * room's `draftBots` (CubeCobra's model through a draftbot that sometimes fails,
 * pick order, or split), so every pod mixes kinds of drafter.
 *
 * Every round is checked against what a Swiss must be: everyone still in plays
 * exactly once or has the bye, the bye only when the field is odd and never
 * twice to one player, no repeat pairing, three rounds, one standings of the
 * whole field.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Server as SocketIOServer } from 'socket.io';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { DRAFT_CHANNEL, answerAsk, joinDraft, pickCard, safeParseServerMessage, splitPods, POD_SEATS, type DraftBots, type DraftCard, type DraftView, type PodView } from '@hadoku/shared';
import { choosePick, waitingOn } from '@hadoku/draft';
import { deriveParticipantId } from '@hadoku/game-server/room/identity';
import type { Draftbot } from './draftbot.js';
import type { DraftRooms } from './draftRooms.js';
import type { Lobby } from './lobby.js';
import type { CubePool } from './pool.js';
import type { GameHooks } from './pods.js';

const POOL_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../games/magic/ui/src/draft/pool.json');
const EDGE_SECRET = 'test-edge-auth-secret';

let socketMod: typeof import('./socket.ts');
let roomsMod: typeof import('./draftRooms.ts');
let lobbyMod: typeof import('./lobby.ts');
let podsMod: typeof import('./pods.ts');
let botDeckMod: typeof import('./botDeck.ts');
let pool: CubePool;
const dirs: string[] = [];

beforeAll(async () => {
	process.env.EDGE_AUTH_SECRET = EDGE_SECRET;
	delete process.env.CARDTABLE_INSECURE_NO_EDGE_AUTH;
	vi.resetModules();
	socketMod = await import('./socket.ts');
	roomsMod = await import('./draftRooms.ts');
	lobbyMod = await import('./lobby.ts');
	podsMod = await import('./pods.ts');
	botDeckMod = await import('./botDeck.ts');
	// A draft finished here is recorded (`history/`): in this file's own dir, never the checkout's state dir.
	const historyDir = await mkdtemp(join(tmpdir(), 'cardtable-tournament-sim-history-'));
	dirs.push(historyDir);
	const history = await import('../history/index.ts');
	history.useDraftRecordStore(history.createDraftRecordStore(historyDir, () => {}));
	const load = (await import('./pool.ts')).loadPool(POOL_FILE);
	if (!load.ok) throw new Error(`the bundled cube pool did not load: ${load.detail}`);
	pool = load.pool;
});

afterAll(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A seeded generator, so a red run is the same run again. */
function rng(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

type Strategy = 'heuristic' | 'random' | 'first' | 'rarest';
const STRATEGIES: readonly Strategy[] = ['heuristic', 'random', 'first', 'rarest'];
const RARITY_RANK: Record<string, number> = { mythic: 4, rare: 3, uncommon: 2, common: 1 };

function choose(strategy: Strategy, pack: readonly DraftCard[], poolSoFar: readonly DraftCard[], next: () => number): DraftCard {
	if (strategy === 'first') return pack[0]!;
	if (strategy === 'random') return pack[Math.floor(next() * pack.length)]!;
	if (strategy === 'rarest') return [...pack].sort((a, b) => (RARITY_RANK[b.rarity ?? 'common'] ?? 0) - (RARITY_RANK[a.rarity ?? 'common'] ?? 0))[0]!;
	return choosePick(pack, poolSoFar, { next }) ?? pack[0]!;
}

/** A draftbot that rates the pack by its order, and fails one batch in `failEvery` — CubeCobra's service on a bad day. */
function flakyDraftbot(failEvery: number): Draftbot {
	let calls = 0;
	return {
		async batchDraft(inputs) {
			calls += 1;
			if (calls % failEvery === 0) throw new Error('draftbot answered 503');
			return inputs.map((input) => input.pack.map((oracle, i) => ({ oracle, rating: 1 / (i + 1) })));
		},
	};
}

interface Drafter {
	id: string;
	key: string;
	name: string;
	strategy: Strategy;
	socket: ClientSocket | null;
	view: DraftView | null;
	picks: number;
	/** Stops picking: an AFK drafter. */
	afk: boolean;
	/** Every error the server answered this drafter with. */
	errors: string[];
}

interface Sim {
	lobby: Lobby;
	rooms: DraftRooms;
	roomId: string;
	drafters: Drafter[];
	events: Record<string, unknown>[];
	close: () => Promise<void>;
	port: number;
}

/** The draft's view of a member: the server derives a participant id from the account the edge vouched for. */
function memberFor(i: number): { id: string; name: string; userId: string; key: string } {
	const key = `sim-${String(i + 1).padStart(2, '0')}`;
	const userId = `user-${key}`;
	return { id: deriveParticipantId({ accountId: userId, socketId: 'unused' }), name: `Player ${String(i + 1).padStart(2, '0')}`, userId, key };
}

/** Like production's (`http/routes.ts`): a deck is built when it is saved and holds 40. */
function simHooks(rooms: DraftRooms, playBotGame: GameHooks['playBotGame']): GameHooks {
	const builtText = (podId: string, memberId: string): string | null => {
		const room = rooms.find(podId);
		const dck = room === undefined ? null : roomsMod.builtDeckOf(room, memberId);
		if (dck === null) return null;
		const count = dck.split('\n').reduce((n, line) => n + (Number(/^(\d+)\s/.exec(line)?.[1] ?? 0) || 0), 0);
		return count >= 40 ? dck : null;
	};
	return {
		draftComplete: (podId) => {
			const room = rooms.find(podId);
			return room !== undefined && roomsMod.stateOf(room).status === 'complete';
		},
		built: (podId, memberId) => builtText(podId, memberId) !== null,
		seatState: (podId, memberId) => {
			const text = builtText(podId, memberId);
			return text === null ? null : { v: 1, deck: { text }, seriesDeck: null };
		},
		holdsSeriesDeck: () => true,
		roundNamesOf: (plan) => [0, 1, 2].map((i) => {
			const s = plan.rounds[i]!;
			return s.kind === 'cube' ? s.cubeId : s.code;
		}) as [string, string, string],
		hasLegalSeatDeck: () => false,
		currentTournamentDeck: () => null,
		seatTournamentDeck: () => {},
		...(playBotGame === undefined ? {} : { playBotGame }),
	};
}

async function boot(opts: { n: number; draftBots: DraftBots; seed: number; pickTimer?: { on: boolean; speed: number }; botsPlay?: boolean }): Promise<Sim> {
	const dir = await mkdtemp(join(tmpdir(), 'cardtable-tourney-sim-'));
	dirs.push(dir);
	const events: Record<string, unknown>[] = [];
	let rooms: DraftRooms;
	const presence = socketMod.createSeatPresence({ seatReleaseMs: socketMod.SEAT_RELEASE_MS, draftGraceOf: (id) => rooms.find(id)?.app.disconnectGraceMs ?? 0 });
	rooms = roomsMod.createDraftRooms({ ...roomsMod.singlePoolResolver(pool), presence, params: { disconnectGraceMs: 5_000 } });
	const lobby = await lobbyMod.openLobby({ dir, log: (e) => events.push(e) });
	rooms.setPodLookup((podId) => lobby.podDraft(podId));
	const next = rng(opts.seed ^ 0xb07);
	const hooks = simHooks(rooms, async () => {
		// Answered on a later tick, as a real bot game is: the round waits on it like on a table.
		await Promise.resolve();
		return next() < 0.5 ? { wins: [2, Math.floor(next() * 2)], gameMs: [600_000, 700_000] } : { wins: [Math.floor(next() * 2), 2], gameMs: [600_000, 700_000] };
	});
	lobby.useGameType('draft', hooks);
	lobby.useGameType('constructed-1v1', hooks);

	const people = Array.from({ length: opts.n }, (_, i) => memberFor(i));
	const owner = people[0]!;
	const made = lobby.create({ id: owner.id, name: owner.name, userId: owner.userId }, { name: 'Cardtable Draft Major (sim)', gameType: 'draft', clientMode: 'builtin' });
	if (!made.ok) throw new Error(`create: ${made.reason}`);
	const roomId = made.room.id;
	expect(lobby.setSettings(roomId, owner.id, { draftBots: opts.draftBots, ...(opts.pickTimer === undefined ? {} : { pickTimer: opts.pickTimer }), ...(opts.botsPlay === undefined ? {} : { botsPlay: opts.botsPlay }) }).ok).toBe(true);
	for (const p of people.slice(1)) expect(lobby.join(roomId, { id: p.id, name: p.name, userId: p.userId }).ok, `${p.name} joins`).toBe(true);
	for (const p of people) expect(lobby.sitSeat(roomId, p.id).ok, `${p.name} sits`).toBe(true);
	// Under a pod's eight, the open seats are bots, as the leader's AI button makes them.
	lobby.get(roomId)!.game!.pod!.seats.forEach((s, seat) => {
		if (s === null) expect(lobby.aiSeat(roomId, owner.id, seat, true).ok).toBe(true);
	});
	const plan = lobby.get(roomId)!.game!.pod!.plan!;
	expect(lobby.setPodPlan(roomId, owner.id, plan, { ok: true, cards: pool.cards.length }).ok).toBe(true);
	for (const p of people) expect(lobby.setReady(roomId, p.id, true), `${p.name} readies`).toBe(true);

	const http: HttpServer = createServer();
	const io = new SocketIOServer(http, { serveClient: false });
	const handle = socketMod.attachDraftSocket(io, {
		rooms,
		lobby,
		minTier: 'friend',
		log: (line) => events.push(line as Record<string, unknown>),
		botPickMs: 0,
		// A person picks far under the four a second `PICK_RATE_LIMIT` allows; a script would not, and the limit is not what this is about.
		rateLimit: { capacity: 1_000_000, refillAmount: 1_000_000, refillIntervalMs: 1 },
		draftbot: flakyDraftbot(7),
		presence,
	});
	await new Promise<void>((done) => http.listen(0, '127.0.0.1', done));
	const port = (http.address() as AddressInfo).port;
	const drafters: Drafter[] = people.map((p, i) => ({ id: p.id, key: p.key, name: p.name, strategy: STRATEGIES[i % STRATEGIES.length]!, socket: null, view: null, picks: 0, afk: false, errors: [] }));
	return {
		lobby,
		rooms,
		roomId,
		drafters,
		events,
		port,
		close: async () => {
			for (const d of drafters) d.socket?.disconnect();
			handle.close();
			presence.dispose();
			io.close();
			await new Promise<void>((done) => http.close(() => done()));
		},
	};
}

/** One drafter's browser: joins the room's draft (the server routes it to their pod) and picks whenever a pack is in front of them. */
function connect(sim: Sim, d: Drafter, seed: number): Promise<void> {
	const next = rng(seed);
	return new Promise((done, fail) => {
		const socket = ioClient(`http://127.0.0.1:${sim.port}`, {
			transports: ['websocket'],
			extraHeaders: { 'x-edge-auth': EDGE_SECRET, 'x-hadoku-tier': 'friend', 'x-user-id': `user-${d.key}`, 'x-user-key': `friend-key-${d.key}` },
			forceNew: true,
			reconnection: false,
		});
		d.socket = socket;
		let lastAsked = '';
		socket.on(DRAFT_CHANNEL.serverToClient, (payload: unknown) => {
			const parsed = safeParseServerMessage(payload);
			if (!parsed.ok) {
				fail(new Error(`${d.name}: the server sent something a browser would refuse: ${parsed.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`));
				return;
			}
			const msg = parsed.value;
			if (msg.type === 'error') {
				d.errors.push(msg.error.code);
				return;
			}
			if (msg.type !== 'state' && msg.type !== 'update') return;
			d.view = msg.view;
			const viewer = msg.view.viewer;
			if (viewer.kind !== 'seat' || d.afk) return;
			const ask = viewer.asks?.[0];
			if (ask !== undefined) {
				const choice = ask.options?.[0]?.key ?? ask.cards?.[0]?.cardId;
				if (choice !== undefined) socket.emit(DRAFT_CHANNEL.clientToServer, answerAsk(msg.view.draftId, ask.id, choice));
				return;
			}
			if (viewer.pack.length === 0) return;
			// One pick per pack in front of us: a repeat view of the same pack is not a second turn.
			const turn = `${msg.view.packNumber}:${viewer.pool.length}`;
			if (turn === lastAsked) return;
			lastAsked = turn;
			const card = choose(d.strategy, viewer.pack, viewer.pool, next);
			d.picks += 1;
			socket.emit(DRAFT_CHANNEL.clientToServer, pickCard(msg.view.draftId, card.cardId));
		});
		socket.on('connect', () => {
			socket.emit(DRAFT_CHANNEL.clientToServer, joinDraft(sim.roomId));
			done();
		});
		socket.on('connect_error', (err) => fail(err));
	});
}

async function waitUntil(predicate: () => boolean, label: string, timeoutMs: number): Promise<void> {
	await vi.waitFor(
		() => {
			if (!predicate()) throw new Error(`timed out waiting for ${label}`);
		},
		{ timeout: timeoutMs, interval: 10 },
	);
}

function pod(sim: Sim): PodView {
	const view = sim.lobby.get(sim.roomId)!.game!.pod;
	if (view === null || view === undefined) throw new Error('no pod');
	return view;
}

/** Split past 8, start, every drafter connected and drafting until every pod is done. */
async function draft(sim: Sim, seed: number): Promise<string[][]> {
	const leader = sim.drafters[0]!.id;
	if (sim.drafters.length > POD_SEATS) expect(sim.lobby.splitPod(sim.roomId, leader).ok, 'the leader splits').toBe(true);
	const started = sim.lobby.startDraft(sim.roomId, leader);
	expect(started.ok, `start: ${started.ok ? '' : started.reason}`).toBe(true);
	await Promise.all(sim.drafters.map((d, i) => connect(sim, d, seed * 100 + i)));
	await waitUntil(() => pod(sim).phase !== 'drafting', `every pod to finish drafting (${sim.drafters.filter((d) => d.picks < 45).map((d) => `${d.name}:${d.picks}${d.errors.length === 0 ? '' : ` [${[...new Set(d.errors)].join(', ')}]`}`).join(' ')})`, 90_000);
	expect(sim.drafters.filter((d) => d.errors.length > 0).map((d) => `${d.name}: ${d.errors.join(', ')}`), 'the server refused no pick').toEqual([]);
	return pod(sim).pods ?? [];
}

/** Every drafter saves the heuristic bot's deck from their own pool and presses Play. */
function build(sim: Sim, skip: ReadonlySet<string> = new Set()): void {
	for (const d of sim.drafters) {
		if (skip.has(d.id)) continue;
		const draft = sim.rooms.findFor(sim.roomId, d.id);
		if (draft === undefined) throw new Error(`${d.name} has no draft`);
		const seat = roomsMod.stateOf(draft).table.seats.findIndex((s) => s.occupant?.kind === 'human' && s.occupant.participantId === d.id);
		const mine = roomsMod.stateOf(draft).pools[seat] ?? [];
		expect(mine, `${d.name}'s pool`).toHaveLength(45);
		roomsMod.saveBuiltDeck(draft, d.id, botDeckMod.botDeckText(mine, `${d.name}'s deck`));
		const played = sim.lobby.playPod(sim.roomId, d.id);
		expect(played.ok, `${d.name} plays: ${played.ok ? '' : played.reason}`).toBe(true);
	}
}

/** What went wrong with a round, by the rules of a Swiss: empty when nothing did. */
function roundProblems(view: PodView, stillIn: readonly string[], byes: Map<string, number>, met: Set<string>): string[] {
	const problems: string[] = [];
	const seen = new Map<string, number>();
	const live = [...view.pairings.map((p) => p.players), ...(view.botGames ?? []).map((g) => g.players)];
	// A pairing settled at once (a dropped player's opponent) is a bye-shaped result of this round, not a table.
	const settledByes = view.results.filter((r) => r.round === view.round && r.playerB === null).map((r) => r.playerA);
	for (const [a, b] of live) {
		for (const id of [a, b]) seen.set(id, (seen.get(id) ?? 0) + 1);
		const key = [a, b].sort().join('|');
		// Humans pair with humans first (the operator, 2026-11-16), so a pod's only two bots meet every round.
		if (met.has(key) && !(podsMod.isAiEntrant(a) && podsMod.isAiEntrant(b))) problems.push(`round ${view.round}: ${a} and ${b} meet again`);
	}
	for (const id of settledByes) seen.set(id, (seen.get(id) ?? 0) + 1);
	// A bot game that already ended is a result of this round, no longer a live game.
	const live_ = new Set(live.flat());
	for (const r of view.results) {
		if (r.round !== view.round || r.playerB === null || live_.has(r.playerA)) continue;
		for (const id of [r.playerA, r.playerB]) seen.set(id, (seen.get(id) ?? 0) + 1);
		const key = [r.playerA, r.playerB].sort().join('|');
		if (met.has(key) && !(podsMod.isAiEntrant(r.playerA) && podsMod.isAiEntrant(r.playerB))) problems.push(`round ${view.round}: ${r.playerA} and ${r.playerB} meet again`);
		met.add(key);
	}
	for (const id of stillIn) if ((seen.get(id) ?? 0) !== 1) problems.push(`round ${view.round}: ${id} has ${seen.get(id) ?? 0} places, not 1`);
	const roundByes = view.results.filter((r) => r.round === view.round && r.playerB === null);
	if (stillIn.length % 2 === 1 && roundByes.length === 0) problems.push(`round ${view.round}: an odd field of ${stillIn.length} and no bye`);
	for (const r of roundByes) {
		byes.set(r.playerA, (byes.get(r.playerA) ?? 0) + 1);
		if ((byes.get(r.playerA) ?? 0) > 1) problems.push(`round ${view.round}: ${r.playerA} has a second bye`);
	}
	return problems;
}

interface Played {
	rounds: { round: number; tables: number; botGames: number; byes: string[]; crossPod: number }[];
	problems: string[];
	standings: number;
}

/** Plays every round out: each table a bo3 by seeded coin, `onRound` before a round's games. */
async function playRounds(sim: Sim, seed: number, pods: string[][], onRound?: (round: number) => void): Promise<Played> {
	const next = rng(seed);
	const podOf = new Map(pods.flatMap((members, k) => members.map((id) => [id, k] as const)));
	const out: Played = { rounds: [], problems: [], standings: 0 };
	const byes = new Map<string, number>();
	const met = new Set<string>();
	let guard = 0;
	while (pod(sim).phase === 'rounds') {
		if (++guard > 10) throw new Error('more rounds than a Swiss has');
		let view = pod(sim);
		const stillIn = view.drafters.filter((id) => !(view.dropped ?? []).includes(id));
		onRound?.(view.round);
		view = pod(sim);
		if (view.phase !== 'rounds') break;
		out.problems.push(...roundProblems(view, stillIn, byes, met));
		out.rounds.push({
			round: view.round,
			tables: view.pairings.length,
			botGames: (view.botGames ?? []).length,
			byes: view.results.filter((r) => r.round === view.round && r.playerB === null).map((r) => r.playerA),
			crossPod: view.pairings.filter((p) => podOf.get(p.players[0]) !== podOf.get(p.players[1])).length,
		});
		for (const p of view.pairings) met.add([...p.players].sort().join('|'));
		for (const g of view.botGames ?? []) met.add([...g.players].sort().join('|'));
		const round = view.round;
		for (const p of view.pairings) {
			const first = next() < 0.5 ? 0 : 1;
			const sweep = next() < 0.5;
			const games: (0 | 1)[] = sweep ? [first, first] : [first, first === 0 ? 1 : 0, next() < 0.5 ? 0 : 1];
			for (const [g, winner] of games.entries()) {
				const recorded = sim.lobby.recordGameResult(sim.roomId, p.tableId, { matchId: `m-${round}-${p.tableId}-${g}`, winner });
				expect(recorded.ok, `round ${round} ${p.tableId} game ${g + 1}`).toBe(true);
			}
		}
		await waitUntil(() => pod(sim).phase !== 'rounds' || pod(sim).round !== round, `round ${round} to end`, 10_000);
	}
	const end = pod(sim);
	expect(end.phase).toBe('done');
	out.standings = end.standings.length;
	return out;
}

/** Every field size worth a look with `CARDTABLE_SIM_ALL=1`; by default four that cover even, odd, one-bot and few-player pods. */
const SIZES = process.env.CARDTABLE_SIM_ALL === '1' ? [24, 23, 21, 20, 17, 16, 14, 13, 10, 9] : [24, 21, 14, 9];

describe('a draft tournament past one pod, simulated end to end over real sockets', () => {
	for (const n of SIZES) {
		it(`${n} drafters: pods of ${splitPods(n).join(' + ')}, every pod a table of 8, three clean Swiss rounds, one standings of ${n}`, async () => {
			const draftBots: DraftBots = (['model', 'pick-order', 'split'] as const)[n % 3]!;
			const sim = await boot({ n, draftBots, seed: n });
			try {
				const pods = await draft(sim, n);
				expect(pods.map((p) => p.length)).toEqual(splitPods(n));
				for (const [k, members] of pods.entries()) {
					const room = sim.rooms.find(podsMod.podDraftId(sim.roomId, k))!;
					const state = roomsMod.stateOf(room);
					expect(state.status, `pod ${k + 1}`).toBe('complete');
					expect(state.seatCount, `pod ${k + 1} drafts a table of 8`).toBe(POD_SEATS);
					expect(state.pools.every((p) => p.length === 45), `pod ${k + 1}: every seat 45 picks`).toBe(true);
					expect(state.table.seats.filter((s) => s.occupant?.kind === 'human')).toHaveLength(members.length);
				}
				// Round 1 is dealt the moment the last pod finishes, while everyone builds.
				expect(pod(sim).phase).toBe('rounds');
				build(sim);
				const played = await playRounds(sim, n * 7, pods);
				console.log(JSON.stringify({ n, draftBots, pods: pods.map((p) => p.length), botsPerPod: pods.map((p) => POD_SEATS - p.length), rounds: played.rounds, standings: played.standings }));
				expect(played.problems).toEqual([]);
				expect(played.rounds).toHaveLength(3);
				// Round 1 is each pod across its own table: only the odd pods' leftovers cross, two at a time.
				expect(played.rounds[0]!.crossPod).toBe(Math.floor(pods.filter((p) => p.length % 2 === 1).length / 2));
				// Later rounds pair the whole field again: with more than one pod, some table of rounds 2 and 3 crosses a pod.
				if (pods.length > 1) expect(played.rounds[1]!.crossPod + played.rounds[2]!.crossPod).toBeGreaterThan(0);
				// The bots are spread: no pod has two more than another.
				expect(Math.max(...pods.map((p) => p.length)) - Math.min(...pods.map((p) => p.length))).toBeLessThanOrEqual(1);
				expect(played.standings).toBe(n);
				// Bots fill a pod's draft and never play a round of a field past one pod.
				expect(played.rounds.every((r) => r.botGames === 0)).toBe(true);
				expect(pod(sim).standings.some((row) => podsMod.isAiEntrant(row.id))).toBe(false);
			} finally {
				await sim.close();
			}
		}, 120_000);
	}

	it('one pod of 6 and 2 bots: the bots are entrants, play each other headless every round, and the Swiss is 8', async () => {
		const sim = await boot({ n: 6, draftBots: 'model', seed: 6 });
		try {
			const pods = await draft(sim, 6);
			build(sim);
			const played = await playRounds(sim, 42, pods);
			console.log(JSON.stringify({ n: 6, rounds: played.rounds, standings: played.standings }));
			expect(played.problems).toEqual([]);
			expect(played.standings).toBe(8);
		} finally {
			await sim.close();
		}
	}, 60_000);

	// The Draft Major's own setting (the operator, 2026-11-23: "in the real tournament i want bots to be automatically turned into a bye").
	it('one pod of 7 and a bot with Bots play off: the bot only drafts, a different person takes the bye each round, and the Swiss is 7', async () => {
		const sim = await boot({ n: 7, draftBots: 'model', seed: 7, botsPlay: false });
		try {
			const pods = await draft(sim, 7);
			build(sim);
			const played = await playRounds(sim, 77, pods);
			console.log(JSON.stringify({ n: 7, botsPlay: false, rounds: played.rounds, standings: played.standings }));
			expect(played.problems).toEqual([]);
			expect(played.rounds).toHaveLength(3);
			expect(played.rounds.every((r) => r.botGames === 0 && r.tables === 3 && r.byes.length === 1)).toBe(true);
			expect(played.rounds.flatMap((r) => r.byes).every((id) => !podsMod.isAiEntrant(id))).toBe(true);
			expect(played.standings).toBe(7);
			expect(pod(sim).standings.some((row) => podsMod.isAiEntrant(row.id))).toBe(false);
		} finally {
			await sim.close();
		}
	}, 60_000);

	it('24 drafters, one leaves the room in round 2 and one is disqualified in round 3: their opponents take byes and the Swiss stays whole', async () => {
		const sim = await boot({ n: 24, draftBots: 'model', seed: 2402 });
		try {
			const pods = await draft(sim, 2402);
			build(sim);
			const leaver = sim.drafters[5]!.id;
			const leader = sim.drafters[0]!.id;
			// Disqualified mid-match: someone seated at a round-3 table, never that round's bye (a bye has no opponent to win it).
			let cheat = '';
			const played = await playRounds(sim, 99, pods, (round) => {
				if (round === 2) expect(sim.lobby.leave(sim.roomId, leaver).ok).toBe(true);
				if (round === 3) {
					cheat = pod(sim).pairings.flatMap((p) => p.players).find((id) => id !== leader) ?? '';
					expect(sim.lobby.dqPlayer(sim.roomId, leader, cheat).ok).toBe(true);
				}
			});
			console.log(JSON.stringify({ n: 24, dropped: pod(sim).dropped, rounds: played.rounds, standings: played.standings }));
			expect(pod(sim).dropped).toEqual([leaver, cheat]);
			for (const [round, gone] of [[2, leaver], [3, cheat]] as const) {
				const theirs = pod(sim).results.find((r) => r.round === round && (r.playerA === gone || r.playerB === gone));
				expect(theirs, `round ${round}: ${gone}'s match is recorded`).toBeDefined();
				const [mine, other] = theirs!.playerA === gone ? [theirs!.gamesA, theirs!.gamesB] : [theirs!.gamesB, theirs!.gamesA];
				expect(other, `round ${round}: the opponent of ${gone} wins it`).toBeGreaterThan(mine);
			}
			// Gone players are paired no more: round 3 was paired without the leaver.
			expect(pod(sim).results.filter((r) => r.round === 3 && (r.playerA === leaver || r.playerB === leaver))).toEqual([]);
			expect(played.problems).toEqual([]);
		} finally {
			await sim.close();
		}
	}, 120_000);

	it('the leader leaving mid-tournament hands the room on, and the new leader can still disqualify', async () => {
		const sim = await boot({ n: 16, draftBots: 'pick-order', seed: 1616 });
		try {
			const pods = await draft(sim, 1616);
			build(sim);
			const leader = sim.drafters[0]!.id;
			let newLeader = '';
			const played = await playRounds(sim, 5, pods, (round) => {
				if (round === 2) {
					expect(sim.lobby.leave(sim.roomId, leader).ok).toBe(true);
					newLeader = sim.lobby.get(sim.roomId)!.leader;
					expect(newLeader).not.toBe(leader);
				}
				if (round === 3) {
					const target = pod(sim).drafters.find((id) => id !== newLeader && !(pod(sim).dropped ?? []).includes(id))!;
					expect(sim.lobby.dqPlayer(sim.roomId, newLeader, target).ok).toBe(true);
				}
			});
			expect(played.problems).toEqual([]);
		} finally {
			await sim.close();
		}
	}, 120_000);

	it('a drafter who never builds holds only their own table: every other table plays, and the leader can disqualify them', async () => {
		const sim = await boot({ n: 17, draftBots: 'split', seed: 1717 });
		try {
			await draft(sim, 1717);
			const afk = sim.drafters[3]!.id;
			build(sim, new Set([afk]));
			const view = pod(sim);
			const theirs = view.pairings.find((p) => p.players.includes(afk));
			for (const p of view.pairings) {
				if (p === theirs) continue;
				for (const g of [0, 1]) sim.lobby.recordGameResult(sim.roomId, p.tableId, { matchId: `m-${p.tableId}-${g}`, winner: 0 });
			}
			if (theirs !== undefined) {
				expect(pod(sim).round, 'the round waits on the one table').toBe(1);
				expect(sim.lobby.dqPlayer(sim.roomId, sim.drafters[0]!.id, afk).ok).toBe(true);
				expect(pod(sim).round, 'the DQ settles their table and the round moves on').toBe(2);
			} else {
				expect(view.bye).toBe(afk);
				expect(pod(sim).round, 'a bye holds no table, so the round moves on').toBe(2);
			}
		} finally {
			await sim.close();
		}
	}, 120_000);

	it('pick timer off: one drafter who stops picking holds their whole pod, and only their pod', async () => {
		const sim = await boot({ n: 16, draftBots: 'model', seed: 160 });
		try {
			const afk = sim.drafters[2]!;
			afk.afk = true;
			const leader = sim.drafters[0]!.id;
			expect(sim.lobby.splitPod(sim.roomId, leader).ok).toBe(true);
			expect(sim.lobby.startDraft(sim.roomId, leader).ok).toBe(true);
			await Promise.all(sim.drafters.map((d, i) => connect(sim, d, 160 * 100 + i)));
			const pods = pod(sim).pods!;
			const afkPod = pods.findIndex((p) => p.includes(afk.id));
			const otherPod = 1 - afkPod;
			await waitUntil(() => roomsMod.stateOf(sim.rooms.find(podsMod.podDraftId(sim.roomId, otherPod))!).status === 'complete', 'the other pod to finish', 30_000);
			// Every pack of the stuck pod has piled up in front of the AFK seat: nobody else has one to pick from.
			const afkSeat = pods[afkPod]!.indexOf(afk.id);
			const stuckState = () => roomsMod.stateOf(sim.rooms.find(podsMod.podDraftId(sim.roomId, afkPod))!);
			await waitUntil(() => waitingOn(stuckState()).join() === String(afkSeat), 'the AFK seat to hold every pack of its pod', 30_000);
			const stuck = stuckState();
			const done = stuck.pools.map((p) => p.length);
			console.log(JSON.stringify({ afkPod, poolsInAfkPod: done }));
			expect(stuck.status).not.toBe('complete');
			expect(pod(sim).phase, 'the whole room waits in drafting').toBe('drafting');
			// Everyone in the stuck pod is held within a pack of the AFK seat: nobody gets far ahead.
			expect(Math.max(...done)).toBeLessThanOrEqual(15);
		} finally {
			await sim.close();
		}
	}, 60_000);
});
