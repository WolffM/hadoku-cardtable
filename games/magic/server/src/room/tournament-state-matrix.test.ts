/**
 * The draft pod's state machine, cell by cell: every PHASE a pod passes through, crossed with every EVENT
 * a real tournament night throws at it, over every FIELD shape a pod can seat. Each cell drives the real
 * `Lobby` (and its pod code) to its phase, fires its event, and checks what must hold after any event:
 *
 * - no AI entrant appears after the field is fixed (`tournament-mode-plan.md` ruling 5);
 * - every entrant still in plays exactly once this round, or has the bye, and nobody meets twice;
 * - every live pairing's human players are members seated at its table: nobody is stranded on a table
 *   that waits for someone who is not there;
 * - every entrant the standings and bracket name is named by the room (a member or a persona), never
 *   shown as a raw id;
 * - the pod still plays to its end, archived, from wherever the event left it;
 *
 * plus the event's own outcome (a DQ concedes, a reset keeps the score, a restart changes nothing).
 * The verdict of every cell is `docs/planning/tournament-state-matrix.md`. Forge is not here: a game is
 * `setTableMatch` then `recordGameResult`, as `play/` reports one, and a bot game answers at once.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { POD_SEATS, type PodView, type Tournament } from '@hadoku/shared';
import { afterAll, describe, expect, it } from 'vitest';

import { attachPeople, type People, type Person as Account } from '@hadoku/game-server/people';

import { openLobby, type Lobby, type MagicRoomView } from './lobby.ts';
import { magicView } from './magic-view.js';
import { roundNamesOf } from './plan.ts';
import { isAiEntrant, type GameHooks } from './pods.ts';

const dirs: string[] = [];
afterAll(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const now = () => 1_800_000_000_000;

interface Person {
	id: string;
	name: string;
	userId: string;
}

function person(n: number): Person {
	const hex = n.toString(16).padStart(2, '0');
	return { id: `fk:${hex.repeat(8)}`, name: `Player ${n}`, userId: `uid-player-${n}` };
}

/** The accounts behind every `person`: a name and a character each, as prefs-api answers them. */
const accounts: People = {
	resolve: async (ids) => new Map(ids.flatMap((id): [string, Account][] => {
		const n = /^uid-player-(\d+)$/.exec(id)?.[1];
		return n === undefined ? [] : [[id, { name: `Player ${n}`, sprite: `avatar-player-${n}`, look: undefined }]];
	})),
	peek: () => undefined,
};

/** A lobby with the server's account sweep attached (`attachPeople`), as `index.ts` wires it: names are never stored (R12). */
async function namedLobby(dir: string, archived: Tournament[]): Promise<Lobby> {
	const lobby = await openLobby({ dir, now, onTournament: (t) => archived.push(t) });
	const people = attachPeople(lobby, accounts);
	await people.sweep();
	return lobby;
}

/** The pod's fake game side: whether the draft is done, who has a legal build, and a bot game that ends at once. */
interface Side {
	complete: boolean;
	built: Set<string>;
	hooks: GameHooks;
}

function side(): Side {
	const s: Side = { complete: false, built: new Set(), hooks: undefined as unknown as GameHooks };
	s.hooks = {
		draftComplete: () => s.complete,
		built: (_pod, id) => s.built.has(id),
		seatState: (_pod, id) => (s.built.has(id) ? { seatedFor: id } : null),
		holdsSeriesDeck: () => true,
		roundNamesOf: (plan) => roundNamesOf(plan, (source) => (source.kind === 'cube' ? source.cubeId : source.code)),
		hasLegalSeatDeck: () => true,
		currentTournamentDeck: (_room, entrant) => ({ deckOf: entrant }),
		seatTournamentDeck: () => {},
		playBotGame: async () => ({ wins: [2, 1], gameMs: [] }),
	};
	return s;
}

/** A bot game's answer, and an account lookup's, arrive as settled promises: every queued continuation runs. */
async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

interface Field {
	name: string;
	humans: number;
	ai: number;
}

/** Sunday's shapes: a full table of people, people and bots, the two odd fields, and the nearly-empty ones. */
const FIELDS: readonly Field[] = [
	{ name: '8 humans', humans: 8, ai: 0 },
	{ name: '6 humans + 2 AI', humans: 6, ai: 2 },
	{ name: '7 humans (a bye)', humans: 7, ai: 0 },
	{ name: '5 humans (a bye)', humans: 5, ai: 0 },
	{ name: '2 humans + 6 AI', humans: 2, ai: 6 },
	{ name: '1 human + 7 AI', humans: 1, ai: 7 },
	// Past eight the room drafts as several pods and its humans alone play the Swiss.
	{ name: '9 humans (two pods, a bye)', humans: 9, ai: 0 },
	{ name: '16 humans (two full pods)', humans: 16, ai: 0 },
];

interface Pod {
	lobby: Lobby;
	dir: string;
	id: string;
	side: Side;
	players: Person[];
	/** A member who watches and never sits: the hub must still show them everything. */
	watcher: Person;
	leader: Person;
	archived: Tournament[];
	/** The entrants as the deal fixed them. */
	entrants: string[] | null;
	seq: number;
}

/** A draft room seating `field`, every human ready, its plan approved: one step from the deal. */
async function lobbyPod(field: Field, dir?: string): Promise<Pod> {
	const where = dir ?? (await mkdtemp(join(tmpdir(), 'cardtable-state-matrix-')));
	if (dir === undefined) dirs.push(where);
	const archived: Tournament[] = [];
	const lobby = await namedLobby(where, archived);
	const players = Array.from({ length: field.humans }, (_, i) => person(i + 1));
	const watcher = person(60);
	const leader = players[0]!;
	const made = lobby.create(leader, { name: `Matrix ${field.name}`, gameType: 'draft', clientMode: 'builtin' });
	if (!made.ok) throw new Error(made.reason);
	const id = made.room.id;
	for (const p of [...players.slice(1), watcher]) expect(lobby.join(id, p).ok).toBe(true);
	await settle();
	// The watcher was auto-seated like everyone; they stand to watch.
	expect(lobby.standSeat(id, watcher.id).ok).toBe(true);
	if (field.humans > POD_SEATS) {
		// Past one pod every joiner is auto-seated, a seat grown for each (`multi-pod.test.ts`).
		expect(lobby.get(id)!.game!.pod!.seats.filter((x) => x !== null && !isAiEntrant(x.memberId)).length).toBe(field.humans);
	} else {
		players.forEach((p, seat) => expect(lobby.sitSeat(id, p.id, seat).ok, `${p.name} sits`).toBe(true));
		for (let seat = field.humans; seat < POD_SEATS; seat++) {
			const r = seat < field.humans + field.ai ? lobby.aiSeat(id, leader.id, seat, true) : lobby.closeSeat(id, leader.id, seat, true);
			expect(r.ok, `seat ${seat}`).toBe(true);
		}
	}
	const s = side();
	lobby.useGameType('draft', s.hooks);
	lobby.useGameType('constructed-1v1', s.hooks);
	expect(lobby.setPodPlan(id, leader.id, lobby.get(id)!.game!.pod!.plan!, { ok: true, cards: 1 }).ok).toBe(true);
	for (const p of players) expect(lobby.setReady(id, p.id, true)).toBe(true);
	if (field.humans > POD_SEATS) expect(lobby.splitPod(id, leader.id).ok, 'the leader splits the room into pods').toBe(true);
	return { lobby, dir: where, id, side: s, players, watcher, leader, archived, entrants: null, seq: 0 };
}

function view(pod: Pod): MagicRoomView {
	const v = magicView(pod.lobby.get(pod.id));
	if (v === undefined) throw new Error('the room is gone');
	return v;
}

function podOf(pod: Pod): PodView {
	return view(pod).game!.pod!;
}

function startDraft(pod: Pod): void {
	expect(pod.lobby.startDraft(pod.id, pod.leader.id).ok, 'the draft deals').toBe(true);
	expect(podOf(pod).phase).toBe('drafting');
}

/** The draft finishes: round 1 is dealt at once, nobody built yet (`podDraftDone`). */
async function finishDraft(pod: Pod): Promise<void> {
	pod.side.complete = true;
	pod.lobby.podDraftDone(pod.id);
	await settle();
	pod.entrants = [...podOf(pod).drafters];
}

/** Every drafter still in the room saves a build and presses Play. */
function buildAll(pod: Pod): void {
	for (const id of podOf(pod).drafters) {
		if (isAiEntrant(id) || !isMember(pod, id)) continue;
		pod.side.built.add(id);
		expect(pod.lobby.playPod(pod.id, id).ok, `${id} plays`).toBe(true);
	}
}

const isMember = (pod: Pod, id: string) => pod.lobby.isMember(pod.id, id);

function liveTables(pod: Pod): { tableId: string; players: [string, string] }[] {
	const v = view(pod);
	return podOf(pod).pairings.filter((p) => v.tables.find((t) => t.id === p.tableId)?.series.phase !== 'done');
}

/** One game at `tableId`, won by seat `winner`. */
function game(pod: Pod, tableId: string, winner: 0 | 1): void {
	// A game already in play is the one that ends.
	const live = view(pod).tables.find((t) => t.id === tableId)?.matchId ?? null;
	const matchId = live ?? `m-${(++pod.seq).toString(16).padStart(12, '0')}`;
	if (live === null) expect(pod.lobby.setTableMatch(pod.id, tableId, matchId), `${tableId}: a game starts`).toBe(true);
	expect(pod.lobby.recordGameResult(pod.id, tableId, { matchId, winner }).ok).toBe(true);
}

/** A match to its end, seat 0 winning 2-0. */
function finishTable(pod: Pod, tableId: string): void {
	for (let guard = 0; view(pod).tables.find((t) => t.id === tableId)!.series.phase !== 'done'; guard++) {
		expect(guard, `${tableId} ends`).toBeLessThan(4);
		game(pod, tableId, 0);
	}
}

async function playRound(pod: Pod): Promise<void> {
	const round = podOf(pod).round;
	invariants(pod, `round ${round}`);
	for (const { tableId } of liveTables(pod)) finishTable(pod, tableId);
	await settle();
	expect(podOf(pod).round > round || podOf(pod).phase === 'done', `round ${round} advances`).toBe(true);
}

async function playOut(pod: Pod): Promise<void> {
	buildAll(pod);
	for (let guard = 0; podOf(pod).phase === 'rounds'; guard++) {
		expect(guard, 'the pod reaches its end').toBeLessThan(6);
		await playRound(pod);
	}
	expect(podOf(pod).phase).toBe('done');
}

type Phase = 'lobby' | 'drafting' | 'building' | 'in-play' | 'between' | 'last-round' | 'finished';
const PHASES: readonly Phase[] = ['lobby', 'drafting', 'building', 'in-play', 'between', 'last-round', 'finished'];

/** A pod driven to `phase`. `in-play` and `between` are round 1; `last-round` has a game in play too. */
async function podAt(field: Field, phase: Phase): Promise<Pod> {
	const pod = await lobbyPod(field);
	if (phase === 'lobby') return pod;
	startDraft(pod);
	if (phase === 'drafting') return pod;
	await finishDraft(pod);
	if (phase === 'building') return pod;
	buildAll(pod);
	if (phase === 'finished') {
		await playOut(pod);
		return pod;
	}
	if (phase === 'last-round') {
		while (podOf(pod).round < podOf(pod).rounds && podOf(pod).phase === 'rounds') await playRound(pod);
	}
	const [first, ...rest] = liveTables(pod);
	if (first !== undefined) expect(pod.lobby.setTableMatch(pod.id, first.tableId, `m-live-${phase}`)).toBe(true);
	// Between rounds: one table is done, the rest still play.
	if (phase === 'between' && rest.length > 0) {
		pod.lobby.releaseTableMatch(pod.id, first!.tableId);
		finishTable(pod, first!.tableId);
	}
	return pod;
}

/** What must hold after any event, in any phase. */
function invariants(pod: Pod, label: string): void {
	const p = podOf(pod);
	if (p.phase === 'lobby' || p.phase === 'drafting') return;
	const fixed = pod.entrants ?? p.drafters;
	// No AI joins the field after it is fixed, and nobody is swapped in.
	expect(p.drafters, `${label}: the field is the one dealt`).toEqual(fixed);
	const names = { ...Object.fromEntries(view(pod).members.map((m) => [m.id, m.name])), ...Object.fromEntries(Object.entries(p.personas).map(([id, x]) => [id, x.name])) };
	for (const row of p.standings) expect(names[row.id], `${label}: standings name ${row.id}`).toBeTruthy();
	if (p.phase !== 'rounds') return;
	const dropped = new Set(p.dropped);
	const round = p.round;
	const appear = new Map<string, number>();
	const count = (id: string) => appear.set(id, (appear.get(id) ?? 0) + 1);
	for (const pairing of p.pairings) pairing.players.forEach(count);
	for (const g of p.botGames ?? []) g.players.forEach(count);
	for (const r of p.results.filter((r) => r.round === round)) {
		if (p.pairings.some((x) => x.players.includes(r.playerA))) continue;
		if ((p.botGames ?? []).some((g) => g.players.includes(r.playerA))) continue;
		count(r.playerA);
		if (r.playerB !== null) count(r.playerB);
	}
	for (const id of fixed) {
		if (dropped.has(id)) continue;
		expect(appear.get(id) ?? 0, `${label}: ${id} plays once in round ${round}`).toBe(1);
	}
	const met = new Set<string>();
	for (const r of p.results) {
		if (r.playerB === null) continue;
		const key = [r.playerA, r.playerB].sort().join('|');
		expect(met.has(key), `${label}: ${key} meet twice`).toBe(false);
		met.add(key);
	}
	// Nobody is stranded: a live table's players are members, seated at it.
	for (const pairing of liveTables(pod)) {
		for (const id of pairing.players) {
			if (isAiEntrant(id)) continue;
			expect(dropped.has(id), `${label}: ${id} was dropped, yet their table is live`).toBe(false);
			expect(isMember(pod, id), `${label}: ${id} left, yet their table waits for them`).toBe(true);
			expect(pod.lobby.seats(pod.id, pairing.tableId).some((s) => s.memberId === id), `${label}: ${id} still holds their seat at ${pairing.tableId}`).toBe(true);
		}
	}
	// A spectator is still in the room, and the room's one view is the hub they see.
	expect(isMember(pod, pod.watcher.id), `${label}: the watcher is still here`).toBe(true);
}

/** After the event, the rest of the pod still plays to its end and is archived once. */
async function stillFinishes(pod: Pod, label: string): Promise<void> {
	const p = podOf(pod);
	if (p.phase === 'lobby') return;
	if (p.phase === 'drafting') {
		await finishDraft(pod);
		// Whoever left during the draft is in the field the deal fixed, out of it from the start.
		for (const id of p.drafters) if (!isAiEntrant(id) && !isMember(pod, id)) expect(podOf(pod).dropped, `${label}: ${id} left mid-draft`).toContain(id);
	}
	await playOut(pod);
	invariants(pod, `${label}, at the end`);
	expect(pod.archived.length, `${label}: archived once`).toBe(1);
}

/** The table `who` plays at this round, if any is live. */
function tableOf(pod: Pod, who: string): string | null {
	return liveTables(pod).find((p) => p.players.includes(who))?.tableId ?? null;
}

/** The entrant each cell's event happens to: a human who is not the leader, so leadership never moves under it. */
function target(pod: Pod): Person {
	return pod.players[pod.players.length - 1]!;
}

type Event = 'tab-short' | 'tab-long' | 'leave' | 'dq' | 'drop-table' | 'reset-game' | 'reset-room' | 'restart' | 'failover' | 'failover-lost' | 'clock-flag';
const EVENTS: readonly Event[] = ['tab-short', 'tab-long', 'leave', 'dq', 'drop-table', 'reset-game', 'reset-room', 'restart', 'failover', 'failover-lost', 'clock-flag'];

/** Fires `event` at `pod` and checks the event's own outcome. Answers the pod to go on with (a restart's is a new process). */
async function fire(pod: Pod, event: Event, phase: Phase): Promise<Pod> {
	const who = target(pod);
	const table = tableOf(pod, who.id) ?? liveTables(pod)[0]?.tableId ?? null;
	const before = podOf(pod);
	switch (event) {
		case 'tab-short':
			// A reload inside the seat window: the socket layer cancels the release (`socket.test.ts`); the room sees nothing.
			return pod;
		case 'tab-long': {
			// Gone past the seat window: the socket layer releases every seat it may (`releaseAbandonedSeats`).
			pod.lobby.releaseAbandonedSeats(who.id);
			if (phase === 'lobby') expect(podOf(pod).seats.some((s) => s?.memberId === who.id), 'a pod seat in the lobby is kept').toBe(true);
			return pod;
		}
		case 'leave': {
			expect(pod.lobby.leave(pod.id, who.id).ok).toBe(true);
			await settle();
			await settle();
			const after = podOf(pod);
			if (after.phase === 'rounds' || (after.phase === 'done' && before.phase === 'rounds')) expect(after.dropped, 'a leaver is dropped').toContain(who.id);
			return pod;
		}
		case 'dq': {
			const r = pod.lobby.dqPlayer(pod.id, pod.leader.id, who.id);
			if (before.phase === 'rounds') {
				expect(r.ok, 'the leader disqualifies an entrant mid-rounds').toBe(true);
				await settle();
				expect(podOf(pod).dropped).toContain(who.id);
				// Their match, if still under way, is conceded: the opponent has its majority. One the round had already
				// settled (they won it before the DQ) stands as it was: `#dropEntrant` forfeits nothing finished.
				const involves = (x: { round: number; playerA: string; playerB: string | null }): boolean => x.round === before.round && (x.playerA === who.id || x.playerB === who.id);
				if (r.ok && r.tableId !== null && !before.results.some(involves)) {
					const result = podOf(pod).results.find(involves);
					if (result !== undefined && result.playerB !== null) {
						const theirs = result.playerA === who.id ? result.gamesA : result.gamesB;
						const other = result.playerA === who.id ? result.gamesB : result.gamesA;
						expect(other, 'the DQ concedes the match').toBeGreaterThan(theirs);
					}
				}
			} else {
				expect(r.ok, `no DQ in ${before.phase}`).toBe(false);
			}
			return pod;
		}
		case 'drop-table': {
			if (table === null || !podOf(pod).pairings.find((x) => x.tableId === table)?.players.includes(who.id)) return pod;
			const r = pod.lobby.dropTableMatch(pod.id, who.id, table);
			expect(r.ok, 'a player concedes their own match').toBe(true);
			await settle();
			return pod;
		}
		case 'reset-game': {
			if (table === null) return pod;
			const t = view(pod).tables.find((x) => x.id === table)!;
			const seated = pod.lobby.seats(pod.id, table);
			const r = pod.lobby.resetGame(pod.id, pod.leader.id, table);
			expect(r.ok, 'a reset needs a game in play').toBe(t.matchId !== null && t.series.phase === 'playing');
			const after = view(pod).tables.find((x) => x.id === table)!;
			expect(after.series.wins, 'a reset keeps the score').toEqual(t.series.wins);
			expect(pod.lobby.seats(pod.id, table), 'a reset keeps the seats').toEqual(seated);
			expect(after.matchId).toBeNull();
			return pod;
		}
		case 'reset-room': {
			const r = pod.lobby.resetRoom(pod.id, pod.leader.id);
			expect(r.ok, 'a whole-room reset is refused once the draft is dealt').toBe(before.phase === 'lobby');
			return pod;
		}
		case 'restart': {
			// A plan's verdict is checked again by every new process (`restored`), so it is not part of the shape.
			const shapeOf = (p: Pod) => ({ ...view(p).game!.pod, verdict: null });
			const shape = JSON.stringify(shapeOf(pod));
			// A deploy's shutdown drains the snapshot writes before the process exits (`Lobby.flushed`).
			await pod.lobby.flushed();
			const lobby = await namedLobby(pod.dir, pod.archived);
			lobby.useGameType('draft', pod.side.hooks);
			lobby.useGameType('constructed-1v1', pod.side.hooks);
			const next = { ...pod, lobby };
			await settle();
			expect(shapeOf(next), 'a restart changes nothing the pod shows').toEqual(JSON.parse(shape));
			return next;
		}
		case 'failover':
			// A claw fails over and the match lives on under its id: the room's record does not move.
			return pod;
		case 'failover-lost': {
			// The failover failed: the game ended with no outcome (`releaseTableMatch`), the series stands, and the next start replays it.
			if (table === null) return pod;
			const t = view(pod).tables.find((x) => x.id === table)!;
			if (t.matchId === null) return pod;
			expect(pod.lobby.releaseTableMatch(pod.id, table)).toBe(true);
			const after = view(pod).tables.find((x) => x.id === table)!;
			expect(after.series.wins).toEqual(t.series.wins);
			expect(after.series.phase).toBe('playing');
			return pod;
		}
		case 'clock-flag': {
			// A seat's chess clock runs out: Forge ends the game, the other seat winning, like any loss.
			if (table === null) return pod;
			const t = view(pod).tables.find((x) => x.id === table)!;
			if (t.matchId === null) return pod;
			const flagged = pod.lobby.seats(pod.id, table).find((s) => s.memberId === who.id)?.seat ?? 0;
			const winner = flagged === 0 ? 1 : 0;
			expect(pod.lobby.recordGameResult(pod.id, table, { matchId: t.matchId, winner }).ok).toBe(true);
			const after = view(pod).tables.find((x) => x.id === table)!;
			expect(after.series.wins[winner]).toBe(t.series.wins[winner]! + 1);
			await settle();
			return pod;
		}
	}
}

describe('the pod state matrix: phase × event × field', () => {
	for (const field of FIELDS) {
		describe(field.name, () => {
			for (const phase of PHASES) {
				for (const event of EVENTS) {
					it(`${phase} × ${event}`, async () => {
						const label = `${field.name}, ${phase}, ${event}`;
						const at = await podAt(field, phase);
						invariants(at, `${label}, before`);
						const after = await fire(at, event, phase);
						invariants(after, `${label}, after`);
						await stillFinishes(after, label);
					});
				}
			}
		});
	}
});
