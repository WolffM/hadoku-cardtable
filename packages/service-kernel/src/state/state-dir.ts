/**
 * The boot move from an in-clone layout to a state directory the app sets up
 * outside its deploy clone.
 *
 * Until a deploy builds its new clone aside and swaps it in, everything a
 * server writes lives in the clone (e.g. `apps/server/data`, `apps/server/logs`).
 * A swapped clone has none of it, so the state has to live outside before that
 * deploy is turned on. The first boot that has a state dir moves each entry of
 * the old directory into the new one; an entry already there is never
 * overwritten, and is left where it was and reported. Runs before anything opens
 * a store.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface StateMove {
	from: string;
	to: string;
	/** Entries moved into `to`. */
	moved: string[];
	/** Entries left in `from` because `to` already holds one of that name. */
	kept: string[];
}

/** Rename, or copy then delete when `to` is on another filesystem. */
function moveEntry(from: string, to: string): void {
	try {
		renameSync(from, to);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
		cpSync(from, to, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
		rmSync(from, { recursive: true, force: true });
	}
}

/**
 * Move every entry of `from` into `to` that `to` lacks, then remove `from` if
 * that emptied it. Null when there was nothing to move: `from` missing, or the
 * same directory as `to`.
 */
export function moveLegacyDir(from: string, to: string): StateMove | null {
	const src = resolve(from);
	const dst = resolve(to);
	if (src === dst || !existsSync(src)) return null;
	mkdirSync(dst, { recursive: true });
	const move: StateMove = { from: src, to: dst, moved: [], kept: [] };
	for (const name of readdirSync(src).sort()) {
		if (existsSync(join(dst, name))) {
			move.kept.push(name);
			continue;
		}
		moveEntry(join(src, name), join(dst, name));
		move.moved.push(name);
	}
	if (move.kept.length === 0) rmdirSync(src);
	return move;
}

/**
 * The boot move for a server: its in-clone `data/` and `logs/` into the state
 * dir, when one is set. Logs one `state-moved` line per directory that held
 * anything, so the cutover is visible in pm2's log.
 */
export function moveLegacyState(
	config: { stateDir: string; dataDir: string; logDir: string },
	legacy: { dataDir: string; logDir: string },
	log: (entry: Record<string, unknown>) => void,
): StateMove[] {
	if (!config.stateDir) return [];
	const moves = [moveLegacyDir(legacy.dataDir, config.dataDir), moveLegacyDir(legacy.logDir, config.logDir)].filter((m): m is StateMove => m !== null);
	for (const m of moves) log({ event: m.kept.length ? 'state-moved-partly' : 'state-moved', ...m });
	return moves;
}
