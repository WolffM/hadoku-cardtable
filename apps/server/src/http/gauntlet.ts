/**
 * A Gauntlet room's routes, under the tables router (`/api/tables`):
 *
 *   GET  /gauntlet/eras                 the eras a Gauntlet can be played in (≥ ten decks)
 *   GET  /rooms/:roomId/gauntlet        the caller's view (`GauntletView`)
 *   POST /rooms/:roomId/gauntlet/ready  { ready, ai? }  a seat readies; `ai` plays the AI from the other seat
 *   POST /rooms/:roomId/gauntlet/act    { act, deck }   a ban or a pick
 *   POST /rooms/:roomId/gauntlet/choose { deck }        the hidden choice before a game
 *
 * Every move is `room/gauntlet.ts`'s; this file stores what it answers in the
 * room (so the feed pings every screen) and runs the timers: the reveal's end,
 * and the AI's moves a beat apart. A timer re-reads the room when it fires, so
 * one that outlives its Gauntlet does nothing, and `resume` restarts them all
 * at boot from what the rooms stored.
 *
 * The draw happens once both seats of the room's first table are ready (or
 * one, with the AI): era, ten decks and the coin flip, all from the server's
 * `random`, stored before anyone is answered. When both hidden choices are in,
 * `dealGame` hands each seat its deck; the match itself starts the way every
 * room match does (`POST /api/play/matches`).
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
	newGauntlet,
	seatOfMember,
	setGauntletReady,
	startBanpick,
	viewOfGauntlet,
	type GauntletDeckInfo,
	type GauntletResult,
	type GauntletState,
} from '../room/gauntlet.js';
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
		gauntlet(roomId: string): GauntletState | null;
		setGauntlet(roomId: string, gauntlet: GauntletState | null): boolean;
	};
	library: TablesLibrary;
	/** Who sits at the room's first table, in seat order. */
	seated(room: GauntletRoom): { memberId: string; name: string }[];
	/** Deal the game's two decks, by seat, at the room's first table in the Gauntlet's era (`http/routes.ts`'s `dealDecks`). */
	dealGame(room: GauntletRoom, decks: [string, string], players: [GauntletPlayer, GauntletPlayer], era: string): void;
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
	/** True once a Gauntlet room has drawn: its seats are fixed and its decks are dealt, never loaded. */
	holdsTable(room: GauntletRoom): boolean;
	/** Why a match may not start in this room now, or null. Null for any room that is not a Gauntlet. */
	startRefusal(room: GauntletRoom): string | null;
	/** A table game of this room has ended; `seriesOver` is the room series' own verdict. */
	afterGame(roomId: string, result: { seriesOver: boolean; winner: 0 | 1 | null }): void;
	/** At boot: restart every timer the stored Gauntlets are waiting on. */
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

	const stateOf = (room: GauntletRoom): GauntletState => rooms.gauntlet(room.id) ?? newGauntlet();

	/** Store a move, and whatever follows from it: a dealt game, the reveal's end, the AI's next move. */
	function commit(room: GauntletRoom, before: GauntletState, after: GauntletState): void {
		rooms.setGauntlet(room.id, after);
		if (after.phase === 'playing' && after.games.length !== before.games.length) {
			const decks = gameDecks(after)!;
			deps.dealGame(room, decks, after.players!, after.era!.id);
			log({ evt: 'gauntlet-game-dealt', room: room.id, game: after.games.length, decks });
		}
		if (after.phase !== before.phase) log({ evt: 'gauntlet-phase', room: room.id, phase: after.phase });
		wake(room.id, after);
	}

	/** Start whatever timer `state` waits on. */
	function wake(roomId: string, state: GauntletState): void {
		if (state.phase === 'reveal') {
			schedule(() => {
				const room = rooms.get(roomId);
				const current = room === undefined ? null : rooms.gauntlet(roomId);
				if (room === undefined || current === null || current.phase !== 'reveal' || current.decks.join() !== state.decks.join()) return;
				commit(room, current, startBanpick(current));
			}, Math.max(0, (state.revealAt ?? 0) + GAUNTLET_REVEAL_MS - now()));
			return;
		}
		if (aiMove(state, deps.random) === null) return;
		schedule(() => {
			const room = rooms.get(roomId);
			const current = room === undefined ? null : rooms.gauntlet(roomId);
			if (room === undefined || current === null || !isGauntlet(room)) return;
			const move = aiMove(current, deps.random);
			if (move === null) return;
			const seat = aiSeat(current)!;
			const out = move.kind === 'act' ? act(current, seat, move.act, move.deck) : choose(current, seat, move.deck);
			if (!out.ok) {
				log({ evt: 'gauntlet-ai-refused', room: roomId, reason: out.reason });
				return;
			}
			log({ evt: 'gauntlet-ai', room: roomId, move: move.kind === 'act' ? move.act : 'choose' });
			commit(room, current, out.state);
		}, GAUNTLET_AI_BEAT_MS);
	}

	/** The room and the caller's Gauntlet seat, or an answer already sent. */
	function found(req: Request, res: Response): { room: GauntletRoom; me: string; state: GauntletState } | null {
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
		return { room, me, state: stateOf(room) };
	}

	function viewer(room: GauntletRoom, state: GauntletState, me: string): GauntletSeatIndex | null {
		if (state.players !== null) return seatOfMember(state, me);
		const at = deps.seated(room).findIndex((p) => p.memberId === me);
		return at === 0 || at === 1 ? at : null;
	}

	function answer(res: Response, room: GauntletRoom, me: string): void {
		const state = stateOf(room);
		res.json(viewOfGauntlet(state, viewer(room, state, me), deckInfo(state.era?.id)));
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
		const f = found(req, res);
		if (f !== null) answer(res, f.room, f.me);
	});

	tables.post('/rooms/:roomId/gauntlet/ready', json, (req: Request, res: Response) => {
		const f = found(req, res);
		if (f === null) return;
		const body = (req.body ?? {}) as Record<string, unknown>;
		if (typeof body.ready !== 'boolean' || (body.ai !== undefined && body.ai !== true) || Object.keys(body).some((k) => k !== 'ready' && k !== 'ai')) {
			res.status(400).json({ error: 'body is { ready: boolean, ai?: true }' });
			return;
		}
		const { room, me, state } = f;
		const seated = deps.seated(room);
		const seat = seated.findIndex((p) => p.memberId === me);
		if (seat !== 0 && seat !== 1) {
			res.status(409).json({ error: 'sit at the table before you ready up' });
			return;
		}
		if (body.ai === true && seated.length !== 1) {
			res.status(409).json({ error: 'the AI plays a table with one seated player' });
			return;
		}
		const readied = setGauntletReady(state, seat, body.ready);
		if (!readied.ok) {
			refuse(res, readied);
			return;
		}
		const players: GauntletPlayer[] = seated.map((p) => ({ memberId: p.memberId, name: p.name }));
		const vsAi = body.ai === true && body.ready;
		if (vsAi) players.push({ memberId: null, name: room.ai?.name ?? 'AI' });
		const everyone = vsAi || (seated.length === 2 && readied.state.ready.every(Boolean));
		if (!everyone) {
			commit(room, state, readied.state);
			log({ evt: 'gauntlet-ready', room: room.id, seat, ready: body.ready });
			answer(res, room, me);
			return;
		}
		const options = GauntletOptionsSchema.safeParse(room.modeOptions ?? {});
		const drawn = drawGauntlet(readied.state, {
			players: players as [GauntletPlayer, GauntletPlayer],
			eras,
			options: options.success ? options.data : {},
			random: deps.random,
			now: now(),
		});
		if (!drawn.ok) {
			refuse(res, drawn);
			return;
		}
		commit(room, state, drawn.state);
		log({ evt: 'gauntlet-drawn', room: room.id, era: drawn.state.era!.id, first: drawn.state.first, decks: drawn.state.decks, ai: vsAi });
		answer(res, room, me);
	});

	tables.post('/rooms/:roomId/gauntlet/act', json, (req: Request, res: Response) => {
		const f = found(req, res);
		if (f === null) return;
		const body = (req.body ?? {}) as Record<string, unknown>;
		const kind = GauntletActSchema.safeParse(body.act);
		if (!kind.success || typeof body.deck !== 'string' || Object.keys(body).some((k) => k !== 'act' && k !== 'deck')) {
			res.status(400).json({ error: "body is { act: 'ban' | 'pick', deck }" });
			return;
		}
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
		commit(f.room, f.state, out.state);
		log({ evt: 'gauntlet-act', room: f.room.id, seat, act: kind.data, deck: body.deck });
		answer(res, f.room, f.me);
	});

	tables.post('/rooms/:roomId/gauntlet/choose', json, (req: Request, res: Response) => {
		const f = found(req, res);
		if (f === null) return;
		const body = (req.body ?? {}) as Record<string, unknown>;
		if (typeof body.deck !== 'string' || Object.keys(body).some((k) => k !== 'deck')) {
			res.status(400).json({ error: 'body is { deck }' });
			return;
		}
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
		commit(f.room, f.state, out.state);
		// The deck itself is never logged before both are revealed: the log is not a side channel.
		log({ evt: 'gauntlet-chose', room: f.room.id, seat });
		answer(res, f.room, f.me);
	});

	return {
		isGauntlet,
		holdsTable: (room) => isGauntlet(room) && stateOf(room).phase !== 'options',
		startRefusal(room) {
			if (!isGauntlet(room)) return null;
			return stateOf(room).phase === 'playing' ? null : 'a Gauntlet game starts once both decks are chosen';
		},
		afterGame(roomId, result) {
			const room = rooms.get(roomId);
			if (room === undefined || !isGauntlet(room)) return;
			const state = stateOf(room);
			const out = gameOver(state, result);
			if (!out.ok) return;
			commit(room, state, out.state);
		},
		resume() {
			for (const room of rooms.list()) {
				const state = rooms.gauntlet(room.id);
				if (state !== null && isGauntlet(room)) wake(room.id, state);
			}
		},
	};
}
