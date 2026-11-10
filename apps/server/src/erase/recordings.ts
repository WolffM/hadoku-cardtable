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
 *
 * ## Off the event loop (#55, 2026-11-10)
 *
 * Every erase used to gunzip and parse every line of every recording, synchronously: 181–197 ms of
 * blocked server for the 23 MB the archive held on 2026-11-10, growing with every match played,
 * and prod's loop showed it on each of ~90 erases in an hour. Now the files are read and unzipped
 * asynchronously (zlib on libuv's pool), and a recording is parsed only when its text holds the
 * person's userId. An end line names them by that exact string, so a file without it cannot name
 * them, and the screen costs a substring search.
 */

import { readdir, readFile, rename, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gunzip as gunzipCb, gzip as gzipCb } from 'node:zlib';
import { UNNAMED } from '../room/constants.js';
import { ACTIONS_SUFFIX, PUBLIC_SUFFIX } from '../play/recording/retention.js';
import { replaceIds } from './anonymise.js';
import type { EraseStep } from './index.js';

const gunzip = promisify(gunzipCb);
const gzip = promisify(gzipCb);

type Line = Record<string, unknown>;

/** A recording file's text, read and unzipped off the event loop. */
async function readText(path: string): Promise<string> {
	return (await gunzip(await readFile(path))).toString('utf8');
}

function parseLines(text: string): Line[] {
	return text
		.split('\n')
		.filter((l) => l.length > 0)
		.map((l) => JSON.parse(l) as Line);
}

/** Rewrite a recording file whole, keeping the mtime its retention reads. */
async function writeLines(path: string, lines: readonly Line[]): Promise<void> {
	const { atime, mtime } = await stat(path);
	const tmp = `${path}.erase.tmp`;
	await writeFile(tmp, await gzip(Buffer.from(lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8')));
	await utimes(tmp, atime, mtime);
	await rename(tmp, path);
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
		erase: async ({ userId }) => {
			let files: string[];
			try {
				files = await readdir(dir);
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
				throw err;
			}
			const matchIds = new Set(files.flatMap((f) => (f.endsWith(PUBLIC_SUFFIX) ? [f.slice(0, -PUBLIC_SUFFIX.length)] : f.endsWith(ACTIONS_SUFFIX) ? [f.slice(0, -ACTIONS_SUFFIX.length)] : [])));
			let changed = 0;
			for (const matchId of matchIds) {
				const texts: { path: string; text: string }[] = [];
				for (const suffix of [PUBLIC_SUFFIX, ACTIONS_SUFFIX]) {
					if (!files.includes(matchId + suffix)) continue;
					const path = join(dir, matchId + suffix);
					const text = await readText(path).catch((err: NodeJS.ErrnoException) => {
						// Retention may age a file out between the listing and this read: it names no one now.
						if (err.code === 'ENOENT') return null;
						throw err;
					});
					if (text !== null) texts.push({ path, text });
				}
				if (!texts.some(({ text }) => text.includes(userId))) continue;
				const recording = texts.map(({ path, text }) => ({ path, lines: parseLines(text) }));
				const seats = recording.flatMap(({ lines }) => dropUser(lines.findLast((l) => l.t === 'end'), userId));
				if (seats.length === 0) continue;
				const names = new Set(recording.flatMap(({ lines }) => seatNames(lines.find((l) => l.t === 'header'), seats)));
				for (const { path, lines } of recording) {
					replaceIds(lines, names, UNNAMED);
					await writeLines(path, lines);
				}
				changed++;
			}
			return changed;
		},
	};
}
