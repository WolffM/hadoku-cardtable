/**
 * One match's two recorded files (`docs/planning/wave77-2026-10-27.md` §C,
 * contract 1): `<matchId>.actions.jsonl.gz` and `<matchId>.public.jsonl.gz`.
 *
 * Buffered, not streamed: every line is held in memory as it comes and both
 * files are written once, gzipped, when the match ends. A long human game is
 * a few hundred to a few thousand small JSON lines — a few hundred KB before
 * gzip — so holding it costs nothing a match-sized process does not already
 * spend on everything else, and it means recording never does disk I/O on the
 * hot path: no write is on the way between Forge's line arriving and the next
 * command being sent. The cost of this choice is the one named in the plan: a
 * process that dies mid-match (not a clean end) loses that match's buffered
 * lines, same as `host.ts`'s own `stream.jsonl` would need the run directory
 * to survive the crash to replay — recording a match that outlives a restart
 * is future work, not this wave's.
 *
 * Nothing here may fail a match. Every public method swallows its own errors
 * into `log`; `finish` resolves even when the disk write failed.
 */

import { mkdirSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { gzip as gzipCb } from 'node:zlib';
import { promisify } from 'node:util';

import type { JsonLog } from '../../log.js';
import { ACTIONS_SUFFIX, PUBLIC_SUFFIX } from './retention.js';

const gzip = promisify(gzipCb);

/** Line 1 of the action log — contract 1. `spec` always carries a seed (the recorder assigns one if play did not). */
export interface ActionsHeader {
	t: 'header';
	v: 1;
	matchId: string;
	roomId: string | null;
	pin: string | null;
	bridge: string;
	server: string;
	startedAt: string;
	spec: unknown;
}

/** One `cmd` line of the action log — contract 1. `cmd` is the raw `BridgeCommand`. */
export interface ActionsCmdLine {
	t: 'cmd';
	seat: number | null;
	board: string;
	prompt: string;
	/**
	 * For a `reply` or `abort`: which of that seat's asks it answers, counted from 0 in the order Forge
	 * sent them. The callId is the live run's own; a rebuild finds its own ask by this number. Not
	 * the reply's place among replies: the server answers some asks itself and lets others lapse.
	 */
	ask?: number;
	cmd: unknown;
}

export interface ActionsEndLine {
	t: 'end';
	endedAt: string;
	reason: string;
}

/** Line 1 of the public stream — contract 1. */
export interface PublicHeader {
	t: 'header';
	v: 1;
	matchId: string;
	roomId: string | null;
	players: [string, string];
	ai: [boolean, boolean];
	decks: unknown[];
	startedAt: string;
}

/** One `env` line of the public stream — contract 1. `env` is the watcher channel's own `ServerEnvelope`. */
export interface PublicEnvLine {
	t: 'env';
	at: number;
	env: unknown;
}

export interface PublicEndLine {
	t: 'end';
	endedAt: string;
	winner: 0 | 1 | null;
}

/** Write `bytes` to `path` whole or not at all: a temp file beside it, renamed over it. */
async function writeFileAtomic(path: string, bytes: Buffer): Promise<void> {
	const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(tmp, bytes);
	await rename(tmp, path);
}

export interface MatchRecordingWriter {
	/** Append one `cmd` line. Buffered — nothing is written to disk yet. */
	actionCmd(line: Omit<ActionsCmdLine, 't'>): void;
	/** Append one `env` line. Buffered. */
	publicEnv(line: Omit<PublicEnvLine, 't'>): void;
	/**
	 * Write the `end` line onto both buffers, gzip each, and write both files.
	 * Never throws; a failed write is one `log` line, not a rejection. Resolves
	 * once both attempts (success or failure) are done.
	 */
	finish(actionsEnd: Omit<ActionsEndLine, 't'>, publicEnd: Omit<PublicEndLine, 't'>): Promise<void>;
}

export interface MatchRecordingWriterDeps {
	dir: string;
	matchId: string;
	actionsHeader: Omit<ActionsHeader, 't' | 'v'>;
	publicHeader: Omit<PublicHeader, 't' | 'v'>;
	log?: JsonLog;
}

async function flush(path: string, lines: readonly unknown[], log: JsonLog, which: 'actions' | 'public'): Promise<void> {
	try {
		const text = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
		const compressed = await gzip(Buffer.from(text, 'utf8'));
		await writeFileAtomic(path, compressed);
	} catch (err) {
		// A recording nobody can read is a loss, never a crash: the match this
		// came from already finished by the time this runs.
		log({ evt: 'recording-write-failed', which, path, error: (err as Error).message });
	}
}

export function createMatchRecordingWriter(deps: MatchRecordingWriterDeps): MatchRecordingWriter {
	const log = deps.log ?? (() => undefined);
	try {
		mkdirSync(deps.dir, { recursive: true });
	} catch (err) {
		log({ evt: 'recording-dir-failed', dir: deps.dir, error: (err as Error).message });
	}
	const actionLines: unknown[] = [{ t: 'header', v: 1, ...deps.actionsHeader }];
	const publicLines: unknown[] = [{ t: 'header', v: 1, ...deps.publicHeader }];

	return {
		actionCmd(line) {
			actionLines.push({ t: 'cmd', ...line });
		},
		publicEnv(line) {
			publicLines.push({ t: 'env', ...line });
		},
		async finish(actionsEnd, publicEnd) {
			actionLines.push({ t: 'end', ...actionsEnd });
			publicLines.push({ t: 'end', ...publicEnd });
			await Promise.all([
				flush(join(deps.dir, `${deps.matchId}${ACTIONS_SUFFIX}`), actionLines, log, 'actions'),
				flush(join(deps.dir, `${deps.matchId}${PUBLIC_SUFFIX}`), publicLines, log, 'public'),
			]);
		},
	};
}
