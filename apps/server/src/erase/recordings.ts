/**
 * Account erase in the match recordings (the operator's ruling, 2026-11-05: anonymise the
 * seat). A recording keeps each seat holder's userId on its public stream's `end` line, and
 * both files carry the seat's name as it was played: the public header's `players`, the action
 * log's `spec.seats`, and Forge's own views, which name each player.
 *
 * So a recording whose end line names the person loses that userId, and the name its seat was
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
import { UNNAMED } from '../room/lobby.js';
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

interface RecordedSeat {
	seat: number;
	userId?: string;
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
			let changed = 0;
			for (const file of files.filter((f) => f.endsWith(PUBLIC_SUFFIX))) {
				const publicPath = join(dir, file);
				const lines = readLines(publicPath);
				const end = lines.findLast((l) => l.t === 'end');
				const seats = (Array.isArray(end?.seats) ? end.seats : []) as RecordedSeat[];
				const theirs = seats.filter((s) => s.userId === userId);
				if (theirs.length === 0) continue;
				const header = lines.find((l) => l.t === 'header');
				const players = (Array.isArray(header?.players) ? header.players : []) as unknown[];
				const names = new Set(theirs.flatMap((s) => (typeof players[s.seat] === 'string' && players[s.seat] !== UNNAMED ? [players[s.seat] as string] : [])));
				for (const seat of theirs) delete seat.userId;
				replaceIds(lines, names, UNNAMED);
				writeLines(publicPath, lines);
				const actionsPath = join(dir, file.slice(0, -PUBLIC_SUFFIX.length) + ACTIONS_SUFFIX);
				if (names.size > 0 && files.includes(file.slice(0, -PUBLIC_SUFFIX.length) + ACTIONS_SUFFIX)) {
					const actions = readLines(actionsPath);
					if (replaceIds(actions, names, UNNAMED) > 0) writeLines(actionsPath, actions);
				}
				changed++;
			}
			return changed;
		},
	};
}
