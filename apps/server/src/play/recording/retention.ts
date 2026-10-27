/**
 * What is kept of `CARDTABLE_RECORDINGS_DIR` and for how long
 * (`docs/planning/wave77-2026-10-27.md` §C): the public stream for 7 days, the
 * action log for 90, and the whole directory capped at 2 GB — the oldest
 * PUBLIC streams go first under the cap, because they are the rebuildable
 * half (`recording/rebuild.ts`, lane D) and the action logs are a few KB each
 * either way. Age is the file's own mtime: both files are written exactly
 * once, at the match's end, so mtime IS "when this match ended" with nothing
 * else ever touching it.
 *
 * Swept hourly (`recorder.ts`'s `watchRecordings`) and once at boot, same
 * discipline as `host.ts`'s own run-directory sweep. Never throws: one bad
 * stat or unlink is logged and skipped, not a reason to stop sweeping the rest.
 */

import { readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { JsonLog } from '../../log.js';

export const PUBLIC_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const ACTIONS_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
/** See the module header: the oldest public streams are dropped first when the directory is over this. */
export const RECORDINGS_CAP_BYTES = 2 * 1024 * 1024 * 1024;

export const ACTIONS_SUFFIX = '.actions.jsonl.gz';
export const PUBLIC_SUFFIX = '.public.jsonl.gz';

export interface SweepResult {
	/** Files removed for being past their own retention window, by suffix. */
	expiredActions: string[];
	expiredPublic: string[];
	/** Public streams removed to bring the directory back under {@link RECORDINGS_CAP_BYTES}. */
	overCap: string[];
	/** Directory size after the sweep, best-effort (0 if it could not be read at all). */
	bytesAfter: number;
	errors: { file: string; error: string }[];
}

interface Entry {
	name: string;
	path: string;
	size: number;
	mtimeMs: number;
}

function list(dir: string, errors: SweepResult['errors']): Entry[] {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch (err) {
		errors.push({ file: dir, error: (err as Error).message });
		return [];
	}
	const out: Entry[] = [];
	for (const name of names) {
		if (!name.endsWith(ACTIONS_SUFFIX) && !name.endsWith(PUBLIC_SUFFIX)) continue;
		try {
			const st = statSync(join(dir, name));
			out.push({ name, path: join(dir, name), size: st.size, mtimeMs: st.mtimeMs });
		} catch (err) {
			errors.push({ file: name, error: (err as Error).message });
		}
	}
	return out;
}

function remove(entry: Entry, log: JsonLog, evt: string, errors: SweepResult['errors']): void {
	try {
		rmSync(entry.path, { force: true });
		log({ evt, file: entry.name, ageMs: Date.now() - entry.mtimeMs, sizeBytes: entry.size });
	} catch (err) {
		errors.push({ file: entry.name, error: (err as Error).message });
	}
}

/** One pass over `dir`: age-based expiry, then the size cap. See the module header. `capBytes` is overridable for a test; production never passes one. */
export function sweepRecordings(dir: string, now: number = Date.now(), log: JsonLog = () => undefined, capBytes: number = RECORDINGS_CAP_BYTES): SweepResult {
	const errors: SweepResult['errors'] = [];
	const result: SweepResult = { expiredActions: [], expiredPublic: [], overCap: [], bytesAfter: 0, errors };
	let entries = list(dir, errors);

	const kept: Entry[] = [];
	for (const entry of entries) {
		const suffix = entry.name.endsWith(ACTIONS_SUFFIX) ? 'actions' : 'public';
		const limit = suffix === 'actions' ? ACTIONS_RETENTION_MS : PUBLIC_RETENTION_MS;
		if (now - entry.mtimeMs > limit) {
			remove(entry, log, 'recording-expired', errors);
			(suffix === 'actions' ? result.expiredActions : result.expiredPublic).push(entry.name);
		} else {
			kept.push(entry);
		}
	}
	entries = kept;

	let total = entries.reduce((sum, e) => sum + e.size, 0);
	if (total > capBytes) {
		const publicOldestFirst = entries.filter((e) => e.name.endsWith(PUBLIC_SUFFIX)).sort((a, b) => a.mtimeMs - b.mtimeMs);
		for (const entry of publicOldestFirst) {
			if (total <= capBytes) break;
			remove(entry, log, 'recording-over-cap', errors);
			result.overCap.push(entry.name);
			total -= entry.size;
			entries = entries.filter((e) => e !== entry);
		}
	}
	result.bytesAfter = total;
	if (errors.length > 0) log({ evt: 'recording-sweep-errors', count: errors.length, errors });
	return result;
}
