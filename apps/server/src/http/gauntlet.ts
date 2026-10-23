/**
 * A Gauntlet room's routes, under the tables router (`/api/tables`):
 *
 *   GET  /gauntlet/eras                 the eras a Gauntlet can be played in (≥ ten decks)
 *   GET  /rooms/:roomId/gauntlet?table=       the caller's view (`GauntletView`)
 *   POST /rooms/:roomId/gauntlet/ready  { ready, ai?, table? }  a seat readies; `ai` plays the AI from the other seat
 *   POST /rooms/:roomId/gauntlet/act    { act, deck, table? }   a ban or a pick
 *   POST /rooms/:roomId/gauntlet/choose { deck, table? }        the hidden choice before a game
 *
 * Every move is `room/gauntlet.ts`'s; this file stores what it answers in the
 * room (so the feed pings every screen) and runs the timers: the reveal's end,
 * and the AI's moves a beat apart. A timer re-reads the room when it fires, so
 * one that outlives its Gauntlet does nothing, and `resume` restarts them all
 * at boot from what the rooms stored.
 *
 * `table` is a table id of the room, defaulting to its first (`tables[0]`) —
 * a plain Gauntlet room (one table) never has to name it. A Constructed
 * tournament's round pairs several Gauntlet tables at once
 * (`docs/planning/tournament-mode-plan.md`), each with its OWN Gauntlet:
 * every move here is scoped by `(roomId, table)`, never `roomId` alone.
 *
 * The draw happens once both seats of the NAMED table are ready (or one,
 * with the AI): era, ten decks and the coin flip, all from the server's
 * `random`, stored before anyone is answered. When both hidden choices are
 * in, `dealGame` hands each seat its deck; the match itself starts the way
 * every room match does (`POST /api/play/matches`).
 *
 * **A tournament has no locked Gauntlet decks.** Every table draws fresh and
 * bans/picks between its own two seats, whatever the room's deck policy says
 * (`room/lobby.ts`'s `tournamentDecksOf`).
 */

import express, { type Request, type Response, type Router } from 'express';
import { deckColorsByName } from '@hadoku/deck';
import { GAUNTLET_REVEAL_MS, GauntletActSchema, GauntletOptionsSchema, type GauntletPlayer, type GauntletSeatIndex, type RoomModeState } from '@hadoku/shared';

import {
	act,
	aiMove,
	aiSeat,
	choose,
	drawGauntlet,
	gameDecks,
	gameOver,
	gauntletEras,
	gauntletHoldsTable,
	newGauntlet,
	readyFor,
	seatOfMember,
	startBanpick,
	viewOfGauntlet,
	type GauntletDeckInfo,
	type GauntletResult,
	type GauntletState,
} from '../room/gauntlet.js';
import { isAiEntrant } from '../room/lobby.js';
import { roomDeckCosts } from '../play/deck-colors.js';
import { deckLines, type TablesLibrary } from './library.js';

/** How long the AI waits before each of its moves. */
export const GAUNTLET_AI_BEAT_MS = 600;

/** The room, as this file reads it. */
export interface GauntletRoom {
	id: string;
	gameType: string;
	mode?: RoomModeState['mode'];
	modeOptions?: RoomModeState['modeOptions'];
	members: { id: string; name: string }[];
	ai?: { name: string };
	tables: { id: string; matchId: string | null }[];
}

export interface GauntletDeps {
	rooms: {
		get(roomId: string): GauntletRoom | undefined;
		list(): GauntletRoom[];
		/** `tableId` defaults to `tables[0]`'s — `room/lobby.ts`'s `Lobby.gauntlet`'s own doc on why. */
		gauntlet(roomId: string, tableId?: string): GauntletState | null;
		setGauntlet(roomId: string, gauntlet: GauntletState | null, tableId?: string): boolean;
		/**
		 * `room/lobby.ts`'s `Lobby.tournamentPairingOf` — this table's entrants,
		 * or `null` outside a tournament. Optional (and
		 * `undefined` read as "no tournament") ONLY so an adapter that has not
		 * yet been given it — `http/routes.ts`'s today, this lane's report
		 * names its exact patch — still satisfies this type: a plain Gauntlet
		 * room, which never had a pairing anyway, is unaffected either way.
		 */
		tournamentPairingOf?(roomId: string, tableId: string): { entrants: [string, string] } | null;
	};
	library: TablesLibrary;
	/** Who sits at `tableId`, in Gauntlet seat order, with each seat's Ready. `tableId` defaults to `room.tables[0]`'s. */
	seated(room: GauntletRoom, tableId?: string): { memberId: string; name: string; ready: boolean }[];
	/** A seat's Ready at `tableId` — LAST and optional, defaulting to `room.tables[0]`'s, so an existing 3-argument call keeps its original meaning (`Lobby.setGauntlet`'s own doc on why). */
	setReady(room: GauntletRoom, memberId: string, ready: boolean, tableId?: string): void;
	/** Deal the game's two decks, by seat, at `tableId` (defaulting to `room.tables[0]`'s, LAST for the same reason as `setReady`'s) in the Gauntlet's era (`http/routes.ts`'s `dealDecks`). */
	dealGame(room: GauntletRoom, decks: [string, string], players: [GauntletPlayer, GauntletPlayer], era: string, tableId?: string): void;
	/** The caller's participant id. */
	callerOf(req: Request): string;
	random: () => number;
	/** Epoch ms; `Date.now` unless a test holds the clock. */
	now?: () => number;
	log: (entry: Record<string, unknown>) => void;
	/** Injected for tests; `setTimeout` otherwise. */
	schedule?: (fn: () => void, ms: number) => void;
}

export interface GauntletHandle {
	/** A Constructed room in Gauntlet mode: its decks are dealt, never loaded. */
	isGauntlet(room: GauntletRoom): boolean;
	/**
	 * True from `tableId`'s draw until it is decided: that table's seats are
	 * fixed and its decks are dealt, never loaded. `tableId` defaults to
	 * `room.tables[0]`'s — `GauntletDeps.rooms.gauntlet`'s own doc on why;
	 * `http/routes.ts` needs to pass the real one per table for a tournament
	 * round's several Gauntlet tables to hold independently (this lane's
	 * report names the exact patch).
	 */
	holdsTable(room: GauntletRoom, tableId?: string): boolean;
	/** Why a match may not start at `tableId` now, or null. Null for any room that is not a Gauntlet. */
	startRefusal(room: GauntletRoom, tableId?: string): string | null;
	/** `tableId`'s game has ended; `seriesOver` is the room series' own verdict. */
	afterGame(roomId: string, result: { seriesOver: boolean; winner: 0 | 1 | null }, tableId?: string): void;
	/** At boot: restart every timer every table's stored Gauntlet is waiting on. */
	resume(): void;
}

function isGauntlet(room: GauntletRoom): boolean {
	return room.gameType === 'constructed-1v1' && room.mode === 'gauntlet';
}

const REFUSALS: Record<string, [number, string]> = {
	drawn: [409, 'the Gauntlet has already been drawn'],
	'no-era': [409, 'no era with ten decks matches the Gauntlet options'],
	'not-banpick': [409, 'it is not time to ban or pick'],
	'not-your-turn': [409, 'it is not your turn'],
	'wrong-act': [409, 'this step is the other act'],
	'no-such-deck': [404, 'no such deck in this Gauntlet'],
	taken: [409, 'that deck is already taken'],
	'not-choose': [409, 'it is not time to choose a deck'],
	'not-yours': [409, 'that is not one of your picks'],
	played: [409, 'that deck has been played'],
	'not-playing': [409, 'no Gauntlet game is under way'],
};

export function attachGauntlet(tables: Router, deps: GauntletDeps): GauntletHandle {
	const { rooms, library, log } = deps;
	const schedule = deps.schedule ?? ((fn: () => void, ms: number) => void setTimeout(fn, ms));
	const now = deps.now ?? Date.now;
	const eras = gauntletEras(library.formats, library.decks);
	const costs = roomDeckCosts(library, null);

	function deckInfo(eraId: string | undefined): (id: string) => GauntletDeckInfo {
		return (id) => {
			const d = library.deck(id);
			if (d === undefined) return { id, name: id, archetype: id, pilot: '', colors: [], main: [], sideboard: [] };
			const lines = deckLines(d);
			return {
				id,
				name: d.deck.name,
				archetype: d.deck.archetype,
				pilot: d.deck.pilot,
				colors: deckColorsByName(
					lines.main.map((l) => l.name),
					costs(eraId),
				),
				...lines,
			};
		};
	}

	const stateOf = (room: GauntletRoom, tableId: string): GauntletState => rooms.gauntlet(room.id, tableId) ?? newGauntlet();

	/** Store a move, and whatever follows from it: a dealt game, the reveal's end, the AI's next move. */
	function commit(room: GauntletRoom, tableId: string, before: GauntletState, after: GauntletState): void {
		rooms.setGauntlet(room.id, after, tableId);
		if (after.phase === 'playing' && after.games.length !== before.games.length) {
			const decks = gameDecks(after)!;
			deps.dealGame(room, decks, after.players!, after.era!.id, tableId);
			log({ evt: 'gauntlet-game-dealt', room: room.id, table: tableId, game: after.games.length, decks });
		}
		if (after.phase !== before.phase) log({ evt: 'gauntlet-phase', room: room.id, table: tableId, phase: after.phase });
		wake(room.id, tableId, after);
	}

	/** Start whatever timer `state` waits on. */
	function wake(roomId: string, tableId: string, state: GauntletState): void {
		if (state.phase === 'reveal') {
			schedule(() => {
				const room = rooms.get(roomId);
				const current = room === undefined ? null : rooms.gauntlet(roomId, tableId);
				if (room === undefined || current === null || current.phase !== 'reveal' || current.decks.join() !== state.decks.join()) return;
				commit(room, tableId, current, startBanpick(current));
			}, Math.max(0, (state.revealAt ?? 0) + GAUNTLET_REVEAL_MS - now()));
			return;
		}
		if (aiMove(state, deps.random) === null) return;
		schedule(() => {
			const room = rooms.get(roomId);
			const current = room === undefined ? null : rooms.gauntlet(roomId, tableId);
			if (room === undefined || current === null || !isGauntlet(room)) return;
			const move = aiMove(current, deps.random);
			if (move === null) return;
			const seat = aiSeat(current)!;
			const out = move.kind === 'act' ? act(current, seat, move.act, move.deck) : choose(current, seat, move.deck);
			if (!out.ok) {
				log({ evt: 'gauntlet-ai-refused', room: roomId, table: tableId, reason: out.reason });
				return;
			}
			log({ evt: 'gauntlet-ai', room: roomId, table: tableId, move: move.kind === 'act' ? move.act : 'choose' });
			commit(room, tableId, current, out.state);
		}, GAUNTLET_AI_BEAT_MS);
	}

	/** `raw` (a GET's `?table=`, or a POST body's `table`) resolved to a table id of `room`, defaulting to its first. `null` for one that names no table of this room. */
	function tableIdOf(room: GauntletRoom, raw: unknown): string | null {
		if (raw === undefined) return room.tables[0]?.id ?? null;
		if (typeof raw !== 'string' || raw.trim() === '') return null;
		return room.tables.some((t) => t.id === raw) ? raw : null;
	}

	/** The room, the NAMED table and the caller's Gauntlet seat, or an answer already sent. */
	function found(req: Request, res: Response, rawTable: unknown): { room: GauntletRoom; me: string; tableId: string; state: GauntletState } | null {
		const room = rooms.get(String(req.params.roomId));
		const me = deps.callerOf(req);
		if (room === undefined || !room.members.some((m) => m.id === me)) {
			res.status(404).json({ error: 'no such room' });
			return null;
		}
		if (!isGauntlet(room)) {
			res.status(409).json({ error: 'this room is not playing a Gauntlet' });
			return null;
		}
		const tableId = tableIdOf(room, rawTable);
		if (tableId === null) {
			res.status(404).json({ error: 'no such table' });
			return null;
		}
		return { room, me, tableId, state: stateOf(room, tableId) };
	}

	function viewer(room: GauntletRoom, tableId: string, state: GauntletState, me: string): GauntletSeatIndex | null {
		if (state.players !== null) return seatOfMember(state, me);
		const at = deps.seated(room, tableId).findIndex((p) => p.memberId === me);
		return at === 0 || at === 1 ? at : null;
	}

	function answer(res: Response, room: GauntletRoom, tableId: string, me: string): void {
		const state = stateOf(room, tableId);
		const seated = deps.seated(room, tableId);
		res.json(viewOfGauntlet(state, viewer(room, tableId, state, me), [seated[0]?.ready === true, seated[1]?.ready === true], deckInfo(state.era?.id)));
	}

	function refuse(res: Response, out: Extract<GauntletResult, { ok: false }>): void {
		const [status, error] = REFUSALS[out.reason] ?? [409, out.reason];
		res.status(status).json({ error, reason: out.reason });
	}

	const json = express.json({ limit: '4kb' });

	tables.get('/gauntlet/eras', (_req: Request, res: Response) => {
		res.json({ eras: eras.map((e) => ({ id: e.id, family: e.family, title: e.title })) });
	});

	tables.get('/rooms/:roomId/gauntlet', (req: Request, res: Response) => {
		const f = found(req, res, typeof req.query.table === 'string' ? req.query.table : undefined);
		if (f !== null) answer(res, f.room, f.tableId, f.me);
	});

	tables.post('/rooms/:roomId/gauntlet/ready', json, (req: Request, res: Response) => {
		const body = (req.body ?? {}) as Record<string, unknown>;
		if (
			typeof body.ready !== 'boolean' ||
			(body.ai !== undefined && body.ai !== true) ||
			(body.table !== undefined && typeof body.table !== 'string') ||
			Object.keys(body).some((k) => k !== 'ready' && k !== 'ai' && k !== 'table')
		) {
			res.status(400).json({ error: 'body is { ready: boolean, ai?: true, table?: string }' });
			return;
		}
		const f = found(req, res, body.table);
		if (f === null) return;
		const { room, me, tableId, state } = f;
		const seated = deps.seated(room, tableId);
		const seat = seated.findIndex((p) => p.memberId === me);
		if (seat !== 0 && seat !== 1) {
			res.status(409).json({ error: 'sit at the table before you ready up' });
			return;
		}
		// A tournament's vs-AI table (`tournamentPairingOf`'s entrants, the AI
		// always last — its own doc): the AI has no HTTP caller of its own and
		// "AI entrants are always ready" (ruling 5), so a human's plain Ready
		// here plays it exactly as `ai: true` already does for a non-tournament
		// table — no extra flag the tournament UI has to know to send.
		const pairing = rooms.tournamentPairingOf?.(room.id, tableId) ?? null;
		const tournamentAi = pairing !== null && isAiEntrant(pairing.entrants[1]);
		if ((body.ai === true || tournamentAi) && seated.length !== 1) {
			res.status(409).json({ error: 'the AI plays a table with one seated player' });
			return;
		}
		const readied = readyFor(state);
		if (!readied.ok) {
			refuse(res, readied);
			return;
		}
		const players: GauntletPlayer[] = seated.map((p) => ({ memberId: p.memberId, name: p.name }));
		const vsAi = (body.ai === true || tournamentAi) && body.ready;
		if (vsAi) players.push({ memberId: null, name: room.ai?.name ?? 'AI' });
		const everyone = vsAi || (seated.length === 2 && body.ready && seated.every((p) => p.memberId === me || p.ready));
		if (!everyone) {
			deps.setReady(room, me, body.ready, tableId);
			commit(room, tableId, state, readied.state);
			log({ evt: 'gauntlet-ready', room: room.id, table: tableId, seat, ready: body.ready });
			answer(res, room, tableId, me);
			return;
		}
		const options = GauntletOptionsSchema.safeParse(room.modeOptions ?? {});
		const opts = options.success ? options.data : {};
		const drawn = drawGauntlet(readied.state, { players: players as [GauntletPlayer, GauntletPlayer], eras, options: opts, random: deps.random, now: now() });
		if (!drawn.ok) {
			refuse(res, drawn);
			return;
		}
		deps.setReady(room, me, true, tableId);
		commit(room, tableId, state, drawn.state);
		log({
			evt: 'gauntlet-drawn',
			room: room.id,
			table: tableId,
			era: drawn.state.era!.id,
			first: drawn.state.first,
			decks: drawn.state.decks,
			ai: vsAi,
		});
		answer(res, room, tableId, me);
	});

	tables.post('/rooms/:roomId/gauntlet/act', json, (req: Request, res: Response) => {
		const body = (req.body ?? {}) as Record<string, unknown>;
		const kind = GauntletActSchema.safeParse(body.act);
		if (
			!kind.success ||
			typeof body.deck !== 'string' ||
			(body.table !== undefined && typeof body.table !== 'string') ||
			Object.keys(body).some((k) => k !== 'act' && k !== 'deck' && k !== 'table')
		) {
			res.status(400).json({ error: "body is { act: 'ban' | 'pick', deck, table?: string }" });
			return;
		}
		const f = found(req, res, body.table);
		if (f === null) return;
		const seat = seatOfMember(f.state, f.me);
		if (seat === null) {
			res.status(409).json({ error: 'you are not playing this Gauntlet' });
			return;
		}
		const out = act(f.state, seat, kind.data, body.deck);
		if (!out.ok) {
			refuse(res, out);
			return;
		}
		commit(f.room, f.tableId, f.state, out.state);
		log({ evt: 'gauntlet-act', room: f.room.id, table: f.tableId, seat, act: kind.data, deck: body.deck });
		answer(res, f.room, f.tableId, f.me);
	});

	tables.post('/rooms/:roomId/gauntlet/choose', json, (req: Request, res: Response) => {
		const body = (req.body ?? {}) as Record<string, unknown>;
		if (typeof body.deck !== 'string' || (body.table !== undefined && typeof body.table !== 'string') || Object.keys(body).some((k) => k !== 'deck' && k !== 'table')) {
			res.status(400).json({ error: 'body is { deck, table?: string }' });
			return;
		}
		const f = found(req, res, body.table);
		if (f === null) return;
		const seat = seatOfMember(f.state, f.me);
		if (seat === null) {
			res.status(409).json({ error: 'you are not playing this Gauntlet' });
			return;
		}
		const out = choose(f.state, seat, body.deck);
		if (!out.ok) {
			refuse(res, out);
			return;
		}
		commit(f.room, f.tableId, f.state, out.state);
		// The deck itself is never logged before both are revealed: the log is not a side channel.
		log({ evt: 'gauntlet-chose', room: f.room.id, table: f.tableId, seat });
		answer(res, f.room, f.tableId, f.me);
	});

	return {
		isGauntlet,
		holdsTable: (room, tableId = room.tables[0]?.id) => tableId !== undefined && isGauntlet(room) && gauntletHoldsTable(stateOf(room, tableId)),
		startRefusal(room, tableId = room.tables[0]?.id) {
			if (!isGauntlet(room) || tableId === undefined) return null;
			return stateOf(room, tableId).phase === 'playing' ? null : 'a Gauntlet game starts once both decks are chosen';
		},
		afterGame(roomId, result, tableId) {
			const room = rooms.get(roomId);
			const table = tableId ?? room?.tables[0]?.id;
			if (room === undefined || table === undefined || !isGauntlet(room)) return;
			const state = stateOf(room, table);
			const out = gameOver(state, result);
			if (!out.ok) return;
			commit(room, table, state, out.state);
		},
		resume() {
			for (const room of rooms.list()) {
				if (!isGauntlet(room)) continue;
				for (const table of room.tables) {
					const state = rooms.gauntlet(room.id, table.id);
					if (state !== null) wake(room.id, table.id, state);
				}
			}
		},
	};
}
