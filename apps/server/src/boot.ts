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
import { openLobby, type Lobby } from './room/lobby.js';

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

/** Forget the rooms untouched for the idle window, on disk as well as in memory: at boot, and hourly from `index.ts`. */
export function sweepRooms(lobby: Lobby, log: RestoreRoomsOptions['log']): void {
	const dropped = lobby.sweep();
	if (dropped.length > 0) log({ event: 'rooms-swept', rooms: dropped.length });
}
