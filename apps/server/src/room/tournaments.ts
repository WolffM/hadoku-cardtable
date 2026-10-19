/*
 * Past tournaments: every pod that played a round, kept once its room is done
 * or closed, for the stats popout's Tournaments tab (the operator, 2026-10-19:
 * *"room results should be viewable in the leaderboard page. maybe we need a
 * tab for past tournaments"*).
 *
 * A room is forgotten when its owner closes it or the sweep ages it out, so its
 * standings cannot live on the room. One JSON file, read at boot, rewritten
 * whole on each record — a few hundred small records at most.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { MatchResult, StandingsRow } from '@hadoku/draft';

export interface Tournament {
	/** `<roomId>-<draftStartedAt>`: one per pod, so a room that drafts twice keeps both. */
	id: string;
	name: string;
	/** ms since epoch: the draft's deal, and the last round's end or the close. */
	startedAt: number;
	endedAt: number;
	/** Closed by its owner before its last round finished. */
	closed: boolean;
	rounds: number;
	/** Display names by id, the AI included — the room that knew them is gone. */
	names: Record<string, string>;
	standings: (StandingsRow & { rank: number })[];
	results: MatchResult[];
}

export interface Tournaments {
	/** Keeps the first record for an id: a pod archived when it finished is not overwritten by its room's close. */
	record(t: Tournament): void;
	/** Newest first. */
	list(): Tournament[];
}

/** The most kept; the oldest go first. */
export const TOURNAMENTS_KEPT = 500;

function isTournament(v: unknown): v is Tournament {
	if (typeof v !== 'object' || v === null) return false;
	const t = v as Record<string, unknown>;
	return (
		typeof t.id === 'string' &&
		typeof t.name === 'string' &&
		typeof t.startedAt === 'number' &&
		typeof t.endedAt === 'number' &&
		typeof t.closed === 'boolean' &&
		typeof t.rounds === 'number' &&
		typeof t.names === 'object' &&
		t.names !== null &&
		Array.isArray(t.standings) &&
		Array.isArray(t.results)
	);
}

export async function openTournaments(file: string, log: (entry: Record<string, unknown>) => void): Promise<Tournaments> {
	let all: Tournament[] = [];
	try {
		const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
		if (!Array.isArray(parsed)) throw new Error('not an array');
		all = parsed.filter(isTournament);
		if (all.length !== parsed.length) log({ event: 'tournaments-dropped', dropped: parsed.length - all.length });
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log({ event: 'tournaments-unreadable', err: String(err) });
	}

	// One write at a time, each of the whole list as it then is.
	let writing: Promise<void> = Promise.resolve();
	const save = (): void => {
		const body = JSON.stringify(all);
		writing = writing
			.then(async () => {
				await mkdir(dirname(file), { recursive: true });
				await writeFile(`${file}.tmp`, body);
				await rename(`${file}.tmp`, file);
			})
			.catch((err: unknown) => log({ event: 'tournaments-write-failed', err: String(err) }));
	};

	return {
		record(t) {
			if (all.some((x) => x.id === t.id)) return;
			all = [...all, t].slice(-TOURNAMENTS_KEPT);
			log({ event: 'tournament-recorded', id: t.id, closed: t.closed });
			save();
		},
		list() {
			return [...all].sort((a, b) => b.endedAt - a.endedAt);
		},
	};
}
