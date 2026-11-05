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

import { TournamentSchema, type Tournament } from '@hadoku/shared';
import { replaceIds } from '../erase/anonymise.js';

export interface Tournaments {
	/** Keeps the first record for an id: a pod archived when it finished is not overwritten by its room's close. */
	record(t: Tournament): void;
	/** Newest first. */
	list(): Tournament[];
	/** Account erase: every tournament naming one of `ids` names `to` instead, with no name. Answers how many changed, once saved. */
	anonymise(ids: ReadonlySet<string>, to: string): Promise<number>;
}

/** The most kept; the oldest go first. */
const TOURNAMENTS_KEPT = 500;

export async function openTournaments(file: string, log: (entry: Record<string, unknown>) => void): Promise<Tournaments> {
	let all: Tournament[] = [];
	try {
		const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
		if (!Array.isArray(parsed)) throw new Error('not an array');
		all = parsed.flatMap((t) => TournamentSchema.safeParse(t).data ?? []);
		if (all.length !== parsed.length) log({ event: 'tournaments-dropped', dropped: parsed.length - all.length });
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log({ event: 'tournaments-unreadable', err: String(err) });
	}

	// One write at a time, each of the whole list as it then is. Resolves false, logged, when it failed.
	let writing: Promise<boolean> = Promise.resolve(true);
	const save = (): Promise<boolean> => {
		const body = JSON.stringify(all);
		writing = writing.then(async () => {
			try {
				await mkdir(dirname(file), { recursive: true });
				await writeFile(`${file}.tmp`, body);
				await rename(`${file}.tmp`, file);
				return true;
			} catch (err) {
				log({ event: 'tournaments-write-failed', err: String(err) });
				return false;
			}
		});
		return writing;
	};

	return {
		record(t) {
			if (all.some((x) => x.id === t.id)) return;
			all = [...all, t].slice(-TOURNAMENTS_KEPT);
			log({ event: 'tournament-recorded', id: t.id, closed: t.closed });
			void save();
		},
		list() {
			return [...all].sort((a, b) => b.endedAt - a.endedAt);
		},
		async anonymise(ids, to) {
			let changed = 0;
			for (const t of all) {
				if (replaceIds(t, ids, to) === 0) continue;
				if (to in t.names) t.names[to] = '';
				changed++;
			}
			if (changed > 0 && !(await save())) throw new Error('tournaments: the anonymised list was not saved');
			return changed;
		},
	};
}
