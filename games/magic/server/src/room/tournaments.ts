/*
 * Past tournaments: every pod that played a round, kept once its room is done
 * or closed, for the stats popout's Tournaments tab (the operator, 2026-10-19:
 * *"room results should be viewable in the leaderboard page. maybe we need a
 * tab for past tournaments"*).
 *
 * A room is forgotten when its owner closes it or the sweep ages it out, so its
 * standings cannot live on the room. One JSON file, rewritten whole on each
 * record — a few hundred small records at most.
 *
 * The file is the one source of truth, not this process's copy of it: every
 * read and every write first re-reads it when it changed on disk since it was
 * last read. So an operator's correction made to the file while the server runs
 * (`cli/tournaments.ts`, the operator, 2026-11-08: *"update the database values
 * and refresh what shows on prod … without cache drift"*) is what the next
 * `GET /api/tournaments` serves, and the server's next own write keeps it rather
 * than writing its older copy back over it. No restart, no reload signal.
 */

import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { rankedStandings } from '@hadoku/draft';
import { TournamentSchema, type Tournament } from '@hadoku/shared';
import { replaceIds } from '@hadoku/game-server/erase/anonymise';

export interface Tournaments {
	/** Keeps the first record for an id: a pod archived when it finished is not overwritten by its room's close. */
	record(t: Tournament): void;
	/** Newest first, as the file holds them now. */
	list(): Promise<Tournament[]>;
}

/** What account erase asks of the store, beside what everyone else does. */
export interface AnonymisableTournaments extends Tournaments {
	/** Every tournament naming one of `ids` names `to` instead, with no name. Answers how many changed, once saved. */
	anonymise(ids: ReadonlySet<string>, to: string): Promise<number>;
}

/** The most kept; the oldest go first. */
const TOURNAMENTS_KEPT = 500;

/**
 * `t`'s standings recomputed from its results, by the same ranking a live pod
 * uses (`@hadoku/draft`'s `rankedStandings`, seeded by the tournament id).
 * Every entrant the record already ranks keeps a row, and anyone a result names
 * gains one. A result added after the pod ended, such as a playoff between two
 * players level on points, counts like any other.
 */
export function withStandings(t: Tournament): Tournament {
	const ids = new Set(t.standings.map((s) => s.id));
	for (const r of t.results) {
		ids.add(r.playerA);
		if (r.playerB !== null) ids.add(r.playerB);
	}
	const rounds = Math.max(t.rounds, ...t.results.map((r) => r.round));
	return { ...t, rounds, standings: rankedStandings([...ids].map((id) => ({ id })), t.results, t.id) };
}

/** What a file looked like when read: changes when it is rewritten, renamed over, or removed. */
async function stampOf(file: string): Promise<string | null> {
	try {
		const s = await stat(file);
		return `${s.ino}:${s.size}:${s.mtimeMs}`;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw err;
	}
}

/** Every record the file holds, the ones that do not parse logged and left out. */
export async function readTournaments(file: string, log: (entry: Record<string, unknown>) => void): Promise<Tournament[]> {
	try {
		const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
		if (!Array.isArray(parsed)) throw new Error('not an array');
		const all = parsed.flatMap((t) => TournamentSchema.safeParse(t).data ?? []);
		if (all.length !== parsed.length) log({ event: 'tournaments-dropped', dropped: parsed.length - all.length });
		return all;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log({ event: 'tournaments-unreadable', err: String(err) });
		return [];
	}
}

/**
 * Writes the whole list beside `file` and renames it into place, so a reader never sees half of it.
 * The temporary file is this process's own, so the server and the operator's CLI never share one.
 */
export async function writeTournaments(file: string, all: readonly Tournament[]): Promise<void> {
	await mkdir(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	await writeFile(tmp, JSON.stringify(all));
	await rename(tmp, file);
}

export async function openTournaments(file: string, log: (entry: Record<string, unknown>) => void): Promise<AnonymisableTournaments> {
	let all: Tournament[] = [];
	let read: string | null = null;

	// The file as it is now: re-read only when it changed since `all` was read from it.
	const fresh = async (): Promise<void> => {
		const now = await stampOf(file);
		if (now === read) return;
		all = await readTournaments(file, log);
		read = now;
	};
	await fresh();

	// One step at a time, reads included, so a re-read never lands between a change and its save.
	let queue: Promise<unknown> = Promise.resolve();
	const inTurn = <T>(step: () => Promise<T>): Promise<T> => {
		const run = queue.then(step);
		queue = run.catch(() => {});
		return run;
	};
	// Resolves false, logged, when the write failed.
	const save = async (): Promise<boolean> => {
		try {
			await writeTournaments(file, all);
			read = await stampOf(file);
			return true;
		} catch (err) {
			log({ event: 'tournaments-write-failed', err: String(err) });
			return false;
		}
	};

	return {
		record(t) {
			void inTurn(async () => {
				await fresh();
				if (all.some((x) => x.id === t.id)) return;
				all = [...all, t].slice(-TOURNAMENTS_KEPT);
				log({ event: 'tournament-recorded', id: t.id, closed: t.closed });
				await save();
			});
		},
		list() {
			return inTurn(async () => {
				await fresh();
				return [...all].sort((a, b) => b.endedAt - a.endedAt);
			});
		},
		anonymise(ids, to) {
			return inTurn(async () => {
				await fresh();
				let changed = 0;
				for (const t of all) {
					if (replaceIds(t, ids, to) === 0) continue;
					if (to in t.names) t.names[to] = '';
					changed++;
				}
				if (changed > 0 && !(await save())) throw new Error('tournaments: the anonymised list was not saved');
				return changed;
			});
		},
	};
}
