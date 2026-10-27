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

/**
 * Line 1 of the action log — contract 1, `v:2` since wave 78 §A. `spec` always carries a seed (the
 * recorder assigns one if play did not).
 *
 * `v:1`'s `cmd` line carried `board`/`prompt`: a seat's folded-board digest and last prompt at
 * `host.send` time, which `rebuild.ts` polled for before resending a command. Gone in `v:2` — see
 * `ActionsCmdLine`'s own doc for why, and for what replaces it.
 */
export interface ActionsHeader {
	t: 'header';
	v: 2;
	matchId: string;
	roomId: string | null;
	pin: string | null;
	bridge: string;
	server: string;
	startedAt: string;
	spec: unknown;
}

/**
 * One `cmd` line of the action log — contract 1, `v:2`. `cmd` is the raw `BridgeCommand`: a
 * `reply`/`abort`, or an `act` built from the bridge's own `applied` echo (`PlayBridge.java`'s
 * `SeatController.applied`, wired in `recorder.ts`'s `line` hook) rather than the browser's act at
 * send time — `docs/planning/front-page-and-replay-plan.md`'s "Wave 77 results" is why: Forge can
 * drop a sent act (no input was open) or apply two in a different order than they were sent, so a
 * log of what was SENT is not a log of what the game did.
 *
 * No `board`/`prompt`. `v:1` carried them so `rebuild.ts` could poll for a seat reaching that
 * position before resending its next command — dead now that an `act` line IS the applied act, in
 * applied order, and a rebuild instead resends the next one once it sees ITS OWN `applied` echo
 * (same ordinal, fresh JVM) for that seat. A `reply`/`abort` never used them either: it is gated on
 * its own ask (`ask`, below), a separate channel from board/prompt that can read a different stage
 * of the game depending on how Forge batches the two.
 *
 * Only `act`/`reply`/`abort` are ever logged: `stop`, `resend-pending`, `cancel-payment` and
 * `probe` are connection/UI housekeeping, never part of the deterministic move sequence a rebuild
 * replays, and `seat` is always a real seat, never null, for exactly that reason.
 */
export interface ActionsCmdLine {
	t: 'cmd';
	seat: number;
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
	/**
	 * Each seat's final board digest (`position.ts`), taken live. A rebuild that does not reach both
	 * is refused rather than served: the log alone does not yet reproduce every game (plan,
	 * "Wave 78 results"), so this is what keeps a wrong replay off the page.
	 */
	boards?: [string, string];
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
	const actionLines: unknown[] = [{ t: 'header', v: 2, ...deps.actionsHeader }];
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
