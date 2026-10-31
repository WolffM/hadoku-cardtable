/*
 * What a fresh process does to the rooms an earlier one left on disk, in order: the lobby reads its
 * rooms back, the draft registry its drafts, a draft room whose draft did not come back goes back to
 * its lobby, and the idle rooms are swept.
 *
 * One function, called by `index.ts` and by `boot.test.ts`, so the test runs the boot the server
 * runs. The 2026-10-23 restarts reset two constructed tournaments mid-round (`releaseLostDrafts`
 * released every room with a started draft and no draft in the registry, and a tournament has the
 * one and never the other): each step had its own restart test, and none of them ran the steps
 * together. A step added to the boot goes here, where the round trip covers it.
 *
 * Imports only; nothing runs at import (the server is one bundle — see `index.ts`).
 */
import { createDraftRooms, type DraftRooms } from './room/draftRooms.js';
import { GAME_DRAWN_AFTER_MS, openLobby, type Lobby } from './room/lobby.js';
import type { Match } from './play/match.js';

export interface RestoreRoomsOptions {
	lobby: Parameters<typeof openLobby>[0];
	/** The draft registry's options, or null when no cube is loaded (draft rooms are disabled). */
	drafts: Parameters<typeof createDraftRooms>[0] | null;
	log: (entry: Record<string, unknown>) => void;
}

export interface RestoredRooms {
	lobby: Lobby;
	draftRooms: DraftRooms | null;
	/** The draft rooms sent back to their lobby: their draft did not come back. */
	lostDrafts: string[];
}

export async function restoreRooms(options: RestoreRoomsOptions): Promise<RestoredRooms> {
	const lobby = await openLobby(options.lobby);
	const draftRooms = options.drafts === null ? null : createDraftRooms(options.drafts);
	const lostDrafts = lobby.releaseLostDrafts((roomId) => draftRooms?.find(roomId) !== undefined);
	if (lostDrafts.length > 0) options.log({ event: 'drafts-lost', rooms: lostDrafts });
	sweepRooms(lobby, options.log);
	return { lobby, draftRooms, lostDrafts };
}

/** The part of a match the sweep reads and calls (`play/match.ts`'s `Match`). */
export type SweptMatch = Pick<Match, 'id' | 'status' | 'startedAt' | 'forceDraw'>;

export interface SweepOptions {
	/** Play's matches. None at boot: play adopts the running ones after the rooms are restored. */
	matches?: Iterable<SweptMatch>;
	/** The clock a match's age is read on. */
	now?: number;
}

/**
 * The lobby's one clock, at boot and every few minutes from `index.ts`. A game that has run
 * `GAME_DRAWN_AFTER_MS` from its own recorded start is called a draw, in any room; its end is the
 * room's activity, so its room's idle clock starts again from it. Then the rooms untouched for their
 * idle window are forgotten, on disk as well as in memory — never one with a game in progress.
 */
export function sweepRooms(lobby: Lobby, log: RestoreRoomsOptions['log'], options: SweepOptions = {}): void {
	const now = options.now ?? Date.now();
	const drawn: string[] = [];
	for (const match of options.matches ?? []) {
		if (match.status === 'running' && now - match.startedAt > GAME_DRAWN_AFTER_MS && match.forceDraw('time-limit')) drawn.push(match.id);
	}
	if (drawn.length > 0) log({ event: 'games-drawn', matches: drawn });
	const dropped = lobby.sweep();
	if (dropped.length > 0) log({ event: 'rooms-swept', rooms: dropped.length });
}

/**
 * The boot's own stopwatch: one `boot-phase` line per step between process start and listen, each
 * with its own `ms` and the `at` since the process began (`performance.now()`'s origin), logged as
 * the step ends. A boot that never listens has printed every phase it finished, so the last line
 * names the step after it as the one it is stuck in.
 */
export function bootClock(log: RestoreRoomsOptions['log']): (phase: string) => void {
	let last = 0;
	return (phase) => {
		const now = performance.now();
		log({ evt: 'boot-phase', phase, ms: Math.round(now - last), at: Math.round(now) });
		last = now;
	};
}
