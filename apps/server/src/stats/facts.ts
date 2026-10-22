/**
 * What a finished match says about itself, read off what the server already
 * holds: Forge's winner, the concede and mulligan presses `Match` saw, and the
 * state frames a human seat was sent.
 *
 * ## What the frames can and cannot answer
 *
 * The bridge sends `"events": []` on every delta, and Forge's game log reaches
 * the server as worded text for the seats (`match.ts`'s `onGameLog`), not as
 * events, so there is no "spell cast" or "damage dealt" event to count. What there is: every player's and the
 * game's tracked properties, delta by delta. So the per-game counts below are
 * folds over those properties' CHANGES —
 *
 *   - `cardsDrawn`, `landsPlayed`: every rise of Forge's `NumDrawnThisTurn` /
 *     `NumLandThisTurn` (they reset each turn), from turn 1 — the opening hand
 *     and its mulligans are not draws here;
 *   - `lifeLost`, `lifeGained`: every fall and rise of `Life` from turn 1, so
 *     paid life counts as lost, which is what life loss is;
 *   - `spellsCast`, `abilitiesActivated`: distinct stack items by their
 *     `ActivatingPlayer`, split on `Ability`. Triggers are abilities here, and
 *     an item put on the stack and resolved between two flushes is never seen.
 *
 * The end-of-game state is the fold of the whole history, read once.
 *
 * Any human seat's history will do for all of this: players, the stack, the
 * battlefield, graveyards and exile are public, and the projector hides only
 * cards' faces, never a player's counters or the size of a zone.
 */

import type { Match } from '../play/match.js';
import { TYPE, foldFrames, keyOf, type StateFrame, type WireObj } from '../play/visibility.js';

/** How a game ended, from the loser's side. Same partition `LiveBoard.tsx`'s `reasonLost` draws. */
export type EndReason = 'life' | 'poison' | 'decking' | 'concede' | 'other';

export interface SeatEnd {
	life: number;
	poison: number;
	library: number;
	hand: number;
	graveyard: number;
	exile: number;
	permanents: number;
	lands: number;
	creatures: number;
	hasLost: boolean;
}

export interface SeatPlay {
	cardsDrawn: number;
	landsPlayed: number;
	lifeLost: number;
	lifeGained: number;
	spellsCast: number;
	abilitiesActivated: number;
}

export interface SeatFacts {
	seat: number;
	ai: boolean;
	/** Forge's name for the seat — what `Match.winner` names. */
	name: string;
	/** 1 = won; equal placements tie. */
	placement: number;
	/** Absent for the AI seat: its Keep/Mulligan never reaches us. */
	mulligans?: number;
	/** Absent when nobody saw who took turn 1. */
	onPlay?: boolean;
	end: SeatEnd | null;
	play: SeatPlay | null;
}

export interface MatchFacts {
	matchId: string;
	endedAt: number;
	turns: number | null;
	/** Null for a draw — nobody lost, so nobody lost to anything. */
	endReason: EndReason | null;
	seats: SeatFacts[];
}

type Tag = { t?: unknown; v?: unknown; core?: unknown } | undefined;

function tag(obj: WireObj | undefined, prop: string): Tag {
	const v = obj?.[prop];
	return typeof v === 'object' && v !== null ? (v as Tag) : undefined;
}

/** An absent int is 0: Forge's `null` in a delta deletes the property, and that is how a counter resets. */
function int(obj: WireObj | undefined, prop: string): number {
	const v = tag(obj, prop);
	return v !== undefined && v.t === 'int' && typeof v.v === 'number' ? v.v : 0;
}

function bool(obj: WireObj | undefined, prop: string): boolean {
	const v = tag(obj, prop);
	return v !== undefined && v.t === 'bool' && v.v === true;
}

function ids(obj: WireObj | undefined, prop: string): number[] {
	const v = tag(obj, prop);
	if (v === undefined || (v.t !== 'list' && v.t !== 'set') || !Array.isArray(v.v)) return [];
	const out: number[] = [];
	for (const item of v.v as Tag[]) if (item?.t === 'int' && typeof item.v === 'number' && item.v !== -1) out.push(item.v);
	return out;
}

function counter(obj: WireObj | undefined, name: string): number {
	const v = tag(obj, 'Counters');
	if (v === undefined || v.t !== 'multiset' || !Array.isArray(v.v)) return 0;
	const hit = (v.v as [unknown, unknown][]).find(([n]) => n === name);
	return typeof hit?.[1] === 'number' ? hit[1] : 0;
}

/** The core types of a card's CURRENT face (`Land`, `Creature`, …). */
function coreTypes(state: ReadonlyMap<string, WireObj>, cardId: number): string[] {
	const card = state.get(keyOf(TYPE.card, cardId));
	const face = state.get(keyOf(TYPE.cardState, cardId * 16 + int(card, 'CurrentState')));
	const type = tag(face, 'Type');
	return type?.t === 'cardtype' && Array.isArray(type.core) ? (type.core as string[]) : [];
}

const GAME_KEY = keyOf(TYPE.game, 1);

function endOf(state: ReadonlyMap<string, WireObj>, playerId: number): SeatEnd {
	const p = state.get(keyOf(TYPE.player, playerId));
	const battlefield = ids(p, 'Battlefield');
	const types = battlefield.map((id) => coreTypes(state, id));
	return {
		life: int(p, 'Life'),
		poison: counter(p, 'Poison'),
		library: ids(p, 'Library').length,
		hand: ids(p, 'Hand').length,
		graveyard: ids(p, 'Graveyard').length,
		exile: ids(p, 'Exile').length,
		permanents: battlefield.length,
		lands: types.filter((t) => t.includes('Land')).length,
		creatures: types.filter((t) => t.includes('Creature')).length,
		hasLost: bool(p, 'HasLost'),
	};
}

interface PlayFold {
	play: Map<number, SeatPlay>;
	firstPlayer: number | null;
}

const emptyPlay = (): SeatPlay => ({ cardsDrawn: 0, landsPlayed: 0, lifeLost: 0, lifeGained: 0, spellsCast: 0, abilitiesActivated: 0 });

/**
 * One pass over the history, folding only the game, the players and the stack
 * (Forge's apply rules, as `visibility.ts`'s `foldInto`), and counting each
 * tracked property's changes as it goes. See the module header for what each count is.
 */
function foldPlay(frames: readonly StateFrame[]): PlayFold {
	const state = new Map<string, WireObj>();
	const play = new Map<number, SeatPlay>();
	const last = new Map<number, { drawn: number; lands: number; life: number }>();
	const stackSeen = new Set<number>();
	let firstPlayer: number | null = null;
	const tracked = (o: WireObj): boolean => o._type === TYPE.player || o._type === TYPE.game || o._type === TYPE.stackItem;

	for (const frame of frames) {
		if (frame.method === 'setGameView') {
			state.clear();
			for (const [k, o] of Object.entries(frame.payload.gameView)) if (tracked(o)) state.set(k, strip(o));
		} else if (frame.method === 'applyDelta') {
			for (const [k, o] of Object.entries(frame.payload.packet.newObjects)) if (tracked(o)) state.set(k, strip(o));
			for (const [k, d] of Object.entries(frame.payload.packet.objectDeltas)) {
				const existing = state.get(k);
				if (existing === undefined) continue;
				const next: WireObj = { ...existing };
				for (const [prop, value] of Object.entries(d)) {
					if (prop === '_type' || prop === '_id') continue;
					if (value === null) delete next[prop];
					else next[prop] = value;
				}
				state.set(k, next);
			}
		} else continue;

		const game = state.get(GAME_KEY);
		const turn = int(game, 'Turn');
		if (turn < 1) continue;
		if (firstPlayer === null && tag(game, 'PlayerTurn')?.t === 'int') firstPlayer = int(game, 'PlayerTurn');

		for (const o of state.values()) {
			if (o._type === TYPE.player) {
				const now = { drawn: int(o, 'NumDrawnThisTurn'), lands: int(o, 'NumLandThisTurn'), life: int(o, 'Life') };
				const seen = last.get(o._id);
				last.set(o._id, now);
				if (seen === undefined) continue;
				const p = play.get(o._id) ?? emptyPlay();
				play.set(o._id, p);
				p.cardsDrawn += rise(seen.drawn, now.drawn);
				p.landsPlayed += rise(seen.lands, now.lands);
				if (now.life < seen.life) p.lifeLost += seen.life - now.life;
				if (now.life > seen.life) p.lifeGained += now.life - seen.life;
			} else if (o._type === TYPE.stackItem && !stackSeen.has(o._id) && tag(o, 'ActivatingPlayer')?.t === 'int') {
				stackSeen.add(o._id);
				const activator = int(o, 'ActivatingPlayer');
				const p = play.get(activator) ?? emptyPlay();
				play.set(activator, p);
				if (bool(o, 'Ability')) p.abilitiesActivated += 1;
				else p.spellsCast += 1;
			}
		}
	}
	return { play, firstPlayer };
}

/** A per-turn counter's growth: a fall is a reset to 0 and then the new value's worth of growth. */
function rise(before: number, after: number): number {
	return after >= before ? after - before : after;
}

function strip(o: WireObj): WireObj {
	const clean: WireObj = { _type: o._type, _id: o._id };
	for (const [prop, value] of Object.entries(o)) if (prop !== '_type' && prop !== '_id' && value !== null) clean[prop] = value;
	return clean;
}

function reasonLost(end: SeatEnd): EndReason {
	if (end.life <= 0) return 'life';
	if (end.poison >= 10) return 'poison';
	if (end.library === 0) return 'decking';
	return 'other';
}

/**
 * The facts of a finished game, or null when it did not finish or no seat can
 * be placed — both decided by `play/match.ts`'s `gameOutcome`, the one
 * classification the table's series reads too.
 */
export function matchFacts(match: Match): MatchFacts | null {
	const outcome = match.outcome();
	if (outcome === null || outcome.kind === 'unplaced' || match.endedAt === null) return null;
	const reader = match.seats.find((s) => !s.ai && s.history.length > 0);
	const frames = (reader?.history ?? []) as unknown as StateFrame[];
	const state = foldFrames(frames);
	const players = ids(state.get(GAME_KEY), 'Players');
	const known = new Set(match.seats.map((s) => s.playerId).filter((id): id is number => id !== null));
	const playerOf = (seat: number): number | null => {
		const own = match.seats[seat]?.playerId ?? null;
		if (own !== null) return own;
		const left = players.filter((id) => !known.has(id));
		return left.length === 1 ? left[0]! : null;
	};
	const { play, firstPlayer } = foldPlay(frames);

	const ends = match.seats.map((s) => {
		const pid = playerOf(s.seat);
		return pid === null || !state.has(keyOf(TYPE.player, pid)) ? null : endOf(state, pid);
	});

	const placements = match.seats.map((s) => (outcome.kind === 'won' && s.seat !== outcome.winner ? 2 : 1));
	const loserEnd = outcome.kind === 'won' ? ends[outcome.winner === 0 ? 1 : 0] : null;
	const endReason: EndReason | null =
		outcome.kind !== 'won' ? null : outcome.conceded ? 'concede' : loserEnd === null || loserEnd === undefined ? 'other' : reasonLost(loserEnd);

	const game = state.get(GAME_KEY);
	return {
		matchId: match.id,
		endedAt: match.endedAt,
		turns: game === undefined ? null : int(game, 'Turn'),
		endReason,
		seats: match.seats.map((s) => {
			const pid = playerOf(s.seat);
			return {
				seat: s.seat,
				ai: s.ai,
				name: match.spec.seats[s.seat]?.name ?? `Seat ${s.seat + 1}`,
				placement: placements[s.seat]!,
				...(s.ai ? {} : { mulligans: s.mulligans }),
				...(firstPlayer === null || pid === null ? {} : { onPlay: pid === firstPlayer }),
				end: ends[s.seat] ?? null,
				play: pid === null ? null : (play.get(pid) ?? emptyPlay()),
			};
		}),
	};
}
