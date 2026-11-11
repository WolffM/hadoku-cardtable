/**
 * Parked games: a game both players walked away from, kept on disk so either of them can pick it
 * up again later.
 *
 * The operator, 2026-11-02: a game nobody comes back to keeps running for the rejoin grace (five
 * minutes, *"5min keep seems fine"*), and is then **parked** — its JVM stopped and the match let go
 * of (`match.ts`'s registry), but its latest turn-start snapshot, its decks, its seats' owners and
 * its room's settings written here, one file per game. Parked games stay resumable for good (*"this
 * is just data on disk right?"*). Resuming *"means creating a new room and reconstructing the game
 * from snapshot"* (`http/parked.ts`): the new match opens at the start of the turn the snapshot
 * was taken at, with what `restoredSpec` says a restore loses.
 *
 * Only a game a room started is parked, and not a testing room's: a resumed game is played in a
 * new room and reported to the match stats when it finishes, which a game no room started (the
 * deck builder's) or a testing room's never was. A game abandoned before its first upkeep has no
 * snapshot and nothing to go back to; it is not parked either. Each is logged `match-not-parked`.
 *
 * A record names the game it was resumed as (`resumedAs`), so the second player resuming joins
 * the first's room rather than starting a second copy. A resumed game parked again supersedes its
 * record (the later turn is the game now), and one played to the end removes it: it is finished.
 *
 * Every record's summary is held in memory, read once at boot; the spec and the snapshot, the
 * heavy half, are read from disk only to resume.
 */

import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDck } from '@hadoku/carddata/dck';
import type { RoomMode, RoomSettings } from '@hadoku/shared';

import type { MatchSpec, TurnSnapshot } from './host.js';
import type { Match } from './match.js';
import type { RoomView } from '../room/lobby.js';

/** A parked record's file name is its match id; nothing else is ever read or written here. */
const MATCH_ID = /^m-[0-9a-f]{12}$/;
const SUFFIX = '.json';
const VERSION = 1;

export interface ParkedSeat {
	ai: boolean;
	/** Who held it; null for the AI. */
	owner: string | null;
	/** The holder's name in the room, else the seat's own; the AI's character for the AI. */
	name: string;
	/** From the deck's `.dck`, or null for a random Forge precon. */
	deckName: string | null;
}

/** What a resumed game's room is made from: the room the game was started in, as it was when it was parked. */
export interface ParkedRoom {
	id: string;
	name: string;
	clientMode: RoomView['game']['clientMode'];
	gameType: RoomView['gameType'];
	format: string;
	settings: RoomSettings;
	mode: RoomMode | null;
}

/** Where a parked game was picked up again. */
export interface ResumedAs {
	roomId: string;
	tableId: string;
	matchId: string;
	at: string;
}

export interface ParkedSummary {
	matchId: string;
	room: ParkedRoom;
	seats: [ParkedSeat, ParkedSeat];
	/** The room's pool, and its name. */
	format: string;
	formatName: string;
	/** The turn the snapshot opens on. */
	turn: number;
	/** The Forge build the game was played on; a resume runs on whatever this server has now. */
	pin: string | null;
	parkedAt: string;
	resumedAs?: ResumedAs;
}

export interface ParkedRecord extends ParkedSummary {
	v: typeof VERSION;
	/** The match's spec, without the opening a resume adds back (`restoredSpec`). */
	spec: MatchSpec;
	snapshot: TurnSnapshot;
	/** Each seat's chess-clock time left, absent in a game without a clock. */
	clockMs?: [number, number];
}

export interface ParkedStore {
	/** Park `match`, which nobody came back to. Null, with the reason logged, when it cannot be resumed. */
	park(match: Match): ParkedRecord | null;
	/** The whole record, read from disk, or null for one that is not here. */
	get(matchId: string): ParkedRecord | null;
	/** Every parked game in which `participantId` held a seat, the most recently parked first. */
	listFor(participantId: string): ParkedSummary[];
	/** `matchId` was picked up again as `as`. False when there is no such record. */
	resumed(matchId: string, as: Omit<ResumedAs, 'at'>): boolean;
	/** The game `matchId` was played to the end: the record it was resumed from, if any, is finished with. */
	finished(matchId: string): void;
	/** Account erase: every parked game `participantId` held a seat in is deleted. Answers how many. */
	forget(participantId: string): number;
}

export interface ParkedStoreDeps {
	dir: string;
	log(entry: Record<string, unknown>): void;
	/** The room that started a match, or undefined (`Lobby.roomOfMatch`). */
	roomOf(matchId: string): Pick<RoomView, 'id' | 'name' | 'gameType' | 'game' | 'settings' | 'testing' | 'members'> | undefined;
	/** A pool's name in words. */
	formatName(pool: string): string;
	/** The Forge build this server runs. */
	pin: string | null;
	now?: () => number;
}

function summaryOf({ v: _v, spec: _spec, snapshot: _snapshot, clockMs: _clockMs, ...summary }: ParkedRecord): ParkedSummary {
	return summary;
}

/** A record as written by this file, or null for anything else in the directory. */
function readRecord(file: string): ParkedRecord | null {
	const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<ParkedRecord> | null;
	if (parsed === null || parsed.v !== VERSION || typeof parsed.matchId !== 'string' || !Array.isArray(parsed.seats) || typeof parsed.snapshot?.state !== 'string') return null;
	return parsed as ParkedRecord;
}

export function openParkedStore(deps: ParkedStoreDeps): ParkedStore {
	const now = deps.now ?? Date.now;
	mkdirSync(deps.dir, { recursive: true });
	const pathOf = (matchId: string): string => join(deps.dir, `${matchId}${SUFFIX}`);
	const write = (record: ParkedRecord): void => {
		const target = pathOf(record.matchId);
		const tmp = `${target}.${process.pid}.${now()}.tmp`;
		writeFileSync(tmp, JSON.stringify(record));
		renameSync(tmp, target);
	};

	const index = new Map<string, ParkedSummary>();
	for (const name of readdirSync(deps.dir)) {
		const matchId = name.slice(0, -SUFFIX.length);
		if (!name.endsWith(SUFFIX) || !MATCH_ID.test(matchId)) continue;
		try {
			const record = readRecord(pathOf(matchId));
			if (record === null) deps.log({ evt: 'parked-unreadable', matchId, error: 'not a parked record' });
			else index.set(matchId, summaryOf(record));
		} catch (err) {
			deps.log({ evt: 'parked-unreadable', matchId, error: (err as Error).message });
		}
	}

	const get = (matchId: string): ParkedRecord | null => {
		if (!index.has(matchId)) return null;
		try {
			return readRecord(pathOf(matchId));
		} catch (err) {
			deps.log({ evt: 'parked-unreadable', matchId, error: (err as Error).message });
			return null;
		}
	};
	/** The record a resumed game came from: the one that names it as `resumedAs`. */
	const resumedFrom = (matchId: string): ParkedSummary | undefined => [...index.values()].find((s) => s.resumedAs?.matchId === matchId);
	const remove = (matchId: string): void => {
		index.delete(matchId);
		rmSync(pathOf(matchId), { force: true });
	};

	return {
		park(match) {
			const notParked = (reason: string): null => {
				deps.log({ evt: 'match-not-parked', matchId: match.id, reason });
				return null;
			};
			if (match.status !== 'running') return notParked(`it is ${match.status}`);
			const snapshot = match.latestSnapshot;
			if (snapshot === null) return notParked('it was left before its first turn began');
			const room = deps.roomOf(match.id);
			if (room === undefined) return notParked('no room started it');
			if (room.testing) return notParked('a testing room started it');
			const seat = (i: 0 | 1): ParkedSeat => {
				const spec = match.spec.seats[i];
				const owner = match.seats[i]?.owner ?? null;
				const member = owner === null ? undefined : room.members.find((m) => m.id === owner);
				const deck = spec.deck === null ? null : (parseDck(spec.deck).name ?? null);
				return { ai: spec.ai, owner: spec.ai ? null : owner, name: member?.name ?? match.seats[i]?.displayName ?? spec.name, deckName: deck };
			};
			// The opening a resume adds back (`restoredSpec`), and the board of the game this one was resumed from, go.
			const { scenario: _scenario, skipOpening: _skipOpening, restore: _restore, ...spec } = match.spec;
			const clockMs = match.clockLeft();
			const format = match.spec.format ?? room.game.format;
			const record: ParkedRecord = {
				v: VERSION,
				matchId: match.id,
				room: {
					id: room.id,
					name: room.name,
					clientMode: room.game.clientMode,
					gameType: room.gameType,
					format: room.game.format,
					settings: { ...room.settings },
					mode: room.game.mode === null || room.game.modeOptions === null ? null : ({ mode: room.game.mode, modeOptions: room.game.modeOptions } as RoomMode),
				},
				seats: [seat(0), seat(1)],
				format,
				formatName: deps.formatName(format),
				turn: snapshot.turn,
				pin: deps.pin,
				parkedAt: new Date(now()).toISOString(),
				spec,
				snapshot,
				...(clockMs === null ? {} : { clockMs }),
			};
			if (record.seats.every((s) => s.owner === null)) return notParked('nobody held a seat');
			write(record);
			index.set(record.matchId, summaryOf(record));
			// A resumed game parked again is that game now: the record it was resumed from goes.
			const superseded = resumedFrom(match.id);
			if (superseded !== undefined) remove(superseded.matchId);
			deps.log({ evt: 'match-parked', matchId: match.id, turn: snapshot.turn, room: room.id, ...(superseded === undefined ? {} : { supersedes: superseded.matchId }) });
			return record;
		},
		get,
		listFor(participantId) {
			return [...index.values()].filter((s) => s.seats.some((seat) => seat.owner === participantId)).sort((a, b) => b.parkedAt.localeCompare(a.parkedAt));
		},
		resumed(matchId, as) {
			const record = get(matchId);
			if (record === null) return false;
			const next: ParkedRecord = { ...record, resumedAs: { ...as, at: new Date(now()).toISOString() } };
			write(next);
			index.set(matchId, summaryOf(next));
			return true;
		},
		forget(participantId) {
			const theirs = [...index.values()].filter((s) => s.seats.some((seat) => seat.owner === participantId));
			for (const s of theirs) remove(s.matchId);
			if (theirs.length > 0) deps.log({ evt: 'parked-erased', matchIds: theirs.map((s) => s.matchId) });
			return theirs.length;
		},
		finished(matchId) {
			const from = resumedFrom(matchId);
			if (from === undefined) return;
			remove(from.matchId);
			deps.log({ evt: 'parked-finished', matchId: from.matchId, as: matchId });
		},
	};
}
