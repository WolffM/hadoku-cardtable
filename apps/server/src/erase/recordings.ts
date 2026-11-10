/**
 * Account erase in the match recordings (the operator's ruling, 2026-11-05: anonymise the
 * seat). A recording keeps each seat holder's userId on an `end` line (the public stream's
 * `seats`, or a by-seat `users`, which the 90-day action log may carry), and both files carry the seat's name as it was played: the public header's `players`, the action
 * log's `spec.seats`, and Forge's own views, which name each player.
 *
 * So a recording whose end line, in either file, names the person loses that userId, and the name its seat was
 * played under becomes the room's own word for an unnamed member (`UNNAMED`) everywhere in
 * both files. Not blank: the action log's names are Forge's player names when a replay is
 * rebuilt, and Forge is given a name. Each file keeps its mtime, which is what retention ages
 * it by (`retention.ts`).
 *
 * A recording from before seats kept their userId names nobody this can match, and is left to
 * its retention, as the ruling says.
 */

import { readdirSync, readFileSync, renameSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { UNNAMED } from '../room/constants.js';
import { ACTIONS_SUFFIX, PUBLIC_SUFFIX } from '../play/recording/retention.js';
import { replaceIds } from './anonymise.js';
import type { EraseStep } from './index.js';

type Line = Record<string, unknown>;

function readLines(path: string): Line[] {
	return gunzipSync(readFileSync(path))
		.toString('utf8')
		.split('\n')
		.filter((l) => l.length > 0)
		.map((l) => JSON.parse(l) as Line);
}

/** Rewrite a recording file whole, keeping the mtime its retention reads. */
function writeLines(path: string, lines: readonly Line[]): void {
	const { atime, mtime } = statSync(path);
	const tmp = `${path}.erase.tmp`;
	writeFileSync(tmp, gzipSync(Buffer.from(lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8')));
	utimesSync(tmp, atime, mtime);
	renameSync(tmp, path);
}

/** The seats an end line names `userId` in: its recorded seats' `userId`, or its by-seat `users`. Drops each as it finds it. */
function dropUser(end: Line | undefined, userId: string): number[] {
	if (end === undefined) return [];
	const found: number[] = [];
	if (Array.isArray(end.seats)) {
		for (const s of end.seats as { seat: number; userId?: string }[]) {
			if (s.userId !== userId) continue;
			delete s.userId;
			found.push(s.seat);
		}
	}
	if (Array.isArray(end.users)) {
		const users = end.users as (string | null)[];
		users.forEach((u, seat) => {
			if (u !== userId) return;
			users[seat] = null;
			found.push(seat);
		});
	}
	return found;
}

/** The name each of `seats` was played under, from either file's header. */
function seatNames(header: Line | undefined, seats: readonly number[]): string[] {
	const players = Array.isArray(header?.players) ? (header.players as unknown[]) : [];
	const spec = header?.spec as { seats?: { name?: unknown }[] } | undefined;
	return seats.flatMap((seat) => [players[seat], spec?.seats?.[seat]?.name].filter((n): n is string => typeof n === 'string' && n !== '' && n !== UNNAMED));
}

export function recordingsStep(dir: string): EraseStep {
	return {
		what: 'recordings',
		erase: ({ userId }) => {
			let files: string[];
			try {
				files = readdirSync(dir);
			} catch {
				return 0;
			}
			const matchIds = new Set(files.flatMap((f) => (f.endsWith(PUBLIC_SUFFIX) ? [f.slice(0, -PUBLIC_SUFFIX.length)] : f.endsWith(ACTIONS_SUFFIX) ? [f.slice(0, -ACTIONS_SUFFIX.length)] : [])));
			let changed = 0;
			for (const matchId of matchIds) {
				const recording = [PUBLIC_SUFFIX, ACTIONS_SUFFIX]
					.filter((suffix) => files.includes(matchId + suffix))
					.map((suffix) => ({ path: join(dir, matchId + suffix), lines: readLines(join(dir, matchId + suffix)) }));
				const seats = recording.flatMap(({ lines }) => dropUser(lines.findLast((l) => l.t === 'end'), userId));
				if (seats.length === 0) continue;
				const names = new Set(recording.flatMap(({ lines }) => seatNames(lines.find((l) => l.t === 'header'), seats)));
				for (const { path, lines } of recording) {
					replaceIds(lines, names, UNNAMED);
					writeLines(path, lines);
				}
				changed++;
			}
			return changed;
		},
	};
}
