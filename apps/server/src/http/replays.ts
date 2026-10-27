/**
 * `/api/replays` — contract 2 of `docs/planning/wave77-2026-10-27.md` §C.
 *
 *   GET /api/replays?limit=20   → 200 { replays: ReplaySummary[] }   newest first
 *   GET /api/replays/:matchId   → 200 { header, envs, end } | 404
 *
 * Reads `CARDTABLE_RECORDINGS_DIR` directly — never the live recorder's
 * in-memory state, so this answers the same way across a restart. The list
 * only ever decompresses the PUBLIC stream (never the action log, which is
 * read only to ask `canRebuild`), and reads it a line at a time without
 * keeping every envelope in memory: it needs the header and the end, not the
 * body. The detail route is the one place a whole stream is read.
 *
 * Mounted on `api`, which is already behind `requireMinTier` (friend tier) —
 * same gate as every other `/api` route; `isAdmin` only decides whether a
 * testing room's rows are in the list at all, the same rule `http/rooms.ts`
 * applies to the room list itself.
 */

import { createReadStream, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { createGunzip } from 'node:zlib';
import type { Request, Response, Router } from 'express';
import { Router as makeRouter } from 'express';

import { isAdmin } from '../edge-auth.js';
import type { JsonLog } from '../log.js';
import { ACTIONS_SUFFIX, PUBLIC_SUFFIX } from '../play/recording/retention.js';

interface PublicHeaderLine {
	t: 'header';
	matchId: string;
	roomId: string | null;
	players: [string, string];
	ai: [boolean, boolean];
	decks: unknown[];
	startedAt: string;
}

interface PublicEndLine {
	t: 'end';
	endedAt: string;
	winner: 0 | 1 | null;
}

interface ActionsHeaderLine {
	t: 'header';
	matchId: string;
	roomId: string | null;
	pin: string | null;
	bridge: string;
	server: string;
	startedAt: string;
	spec: unknown;
}

export type RebuildResult = { header: PublicHeaderLine; envs: { at: number; env: unknown }[]; end: PublicEndLine } | null;

export interface ReplaysDeps {
	/** `CARDTABLE_RECORDINGS_DIR`, resolved — the same directory the recorder writes to. */
	dir: string;
	/** Is this room's recording hidden from a non-admin, same rule as `http/rooms.ts`'s own testing-room guard? */
	isTesting(roomId: string | null): boolean;
	/** Lane D's own check, injected. Absent: a match with no public stream always answers `source: 'none'`/404. */
	canRebuild?(header: ActionsHeaderLine): boolean;
	/** Lane D's own rebuild, injected. */
	rebuild?(matchId: string): Promise<RebuildResult>;
	log?: JsonLog;
}

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;
/** `newMatchId` (`match.ts`) mints `m-<12 hex>`; this is generous around that so a param that is not one never becomes a path segment. */
const MATCH_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Read a gzip JSONL file a line at a time, keeping only the first line and the running last one — never the whole body. */
async function firstAndLastLine(path: string): Promise<{ first: string; last: string } | null> {
	return new Promise((resolve, reject) => {
		const input = createReadStream(path);
		const gunzip = createGunzip();
		input.on('error', (err) => reject(err));
		gunzip.on('error', (err) => reject(err));
		const rl = createInterface({ input: input.pipe(gunzip), crlfDelay: Infinity });
		let first: string | null = null;
		let last: string | null = null;
		rl.on('line', (line) => {
			if (line === '') return;
			if (first === null) first = line;
			last = line;
		});
		rl.on('close', () => resolve(first === null || last === null ? null : { first, last }));
	});
}

/** Every line, in order — the detail route needs the whole stream. */
async function allLines(path: string): Promise<string[]> {
	return new Promise((resolve, reject) => {
		const input = createReadStream(path);
		const gunzip = createGunzip();
		input.on('error', (err) => reject(err));
		gunzip.on('error', (err) => reject(err));
		const rl = createInterface({ input: input.pipe(gunzip), crlfDelay: Infinity });
		const lines: string[] = [];
		rl.on('line', (line) => {
			if (line !== '') lines.push(line);
		});
		rl.on('close', () => resolve(lines));
	});
}

function parseJson<T>(text: string): T | null {
	try {
		return JSON.parse(text) as T;
	} catch {
		return null;
	}
}

interface Row {
	matchId: string;
	hasPublic: boolean;
	hasActions: boolean;
}

function rowsOf(dir: string): Row[] {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	const byMatch = new Map<string, Row>();
	for (const name of names) {
		const isPublic = name.endsWith(PUBLIC_SUFFIX);
		const isActions = !isPublic && name.endsWith(ACTIONS_SUFFIX);
		if (!isPublic && !isActions) continue;
		const matchId = name.slice(0, name.length - (isPublic ? PUBLIC_SUFFIX.length : ACTIONS_SUFFIX.length));
		const row = byMatch.get(matchId) ?? { matchId, hasPublic: false, hasActions: false };
		if (isPublic) row.hasPublic = true;
		else row.hasActions = true;
		byMatch.set(matchId, row);
	}
	return [...byMatch.values()];
}

export function attachReplays(api: Router, deps: ReplaysDeps): void {
	const log = deps.log ?? (() => undefined);
	const replays = makeRouter();

	replays.get('/', async (req: Request, res: Response) => {
		const admin = isAdmin(req);
		const limitParam = Number(req.query.limit ?? DEFAULT_LIST_LIMIT);
		const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(Math.floor(limitParam), MAX_LIST_LIMIT) : DEFAULT_LIST_LIMIT;

		const rows = rowsOf(deps.dir);
		const summaries: { header: PublicHeaderLine; endedAt: string | null; winner: 0 | 1 | null; source: 'stream' | 'rebuild' | 'none' }[] = [];
		for (const row of rows) {
			try {
				if (row.hasPublic) {
					const read = await firstAndLastLine(join(deps.dir, `${row.matchId}${PUBLIC_SUFFIX}`));
					const header = read === null ? null : parseJson<PublicHeaderLine>(read.first);
					if (header === null) continue;
					const end = read === null ? null : parseJson<PublicEndLine>(read.last);
					summaries.push({ header, endedAt: end?.t === 'end' ? end.endedAt : null, winner: end?.t === 'end' ? end.winner : null, source: 'stream' });
					continue;
				}
				if (!row.hasActions) continue;
				const read = await firstAndLastLine(join(deps.dir, `${row.matchId}${ACTIONS_SUFFIX}`));
				const actionsHeader = read === null ? null : parseJson<ActionsHeaderLine>(read.first);
				if (actionsHeader === null) continue;
				// A rebuildable row's players/ai are not otherwise known without rebuilding it; the
				// list still names it from what the action log's own spec carries, decks withheld
				// (the action log's `spec` holds the raw `.dck` text, which this route never reads out).
				const spec = actionsHeader.spec as { seats?: { name: string; ai: boolean }[] } | undefined;
				const seats = Array.isArray(spec?.seats) && spec.seats.length === 2 ? spec.seats : null;
				const header: PublicHeaderLine = {
					t: 'header',
					matchId: actionsHeader.matchId,
					roomId: actionsHeader.roomId,
					players: seats === null ? ['', ''] : [seats[0]!.name, seats[1]!.name],
					ai: seats === null ? [false, false] : [seats[0]!.ai, seats[1]!.ai],
					decks: [null, null],
					startedAt: actionsHeader.startedAt,
				};
				const end = read === null ? null : parseJson<{ t: 'end'; endedAt: string; reason: string }>(read.last);
				const canRebuild = deps.canRebuild?.(actionsHeader) ?? false;
				summaries.push({ header, endedAt: end?.t === 'end' ? end.endedAt : null, winner: null, source: canRebuild ? 'rebuild' : 'none' });
			} catch (err) {
				log({ evt: 'replay-list-read-failed', matchId: row.matchId, error: (err as Error).message });
			}
		}

		const visible = summaries.filter((s) => admin || !deps.isTesting(s.header.roomId));
		visible.sort((a, b) => (a.header.startedAt < b.header.startedAt ? 1 : a.header.startedAt > b.header.startedAt ? -1 : 0));
		res.json({
			replays: visible.slice(0, limit).map((s) => ({
				matchId: s.header.matchId,
				roomId: s.header.roomId,
				players: s.header.players,
				decks: s.header.decks,
				startedAt: s.header.startedAt,
				endedAt: s.endedAt,
				winner: s.winner,
				source: s.source,
			})),
		});
	});

	replays.get('/:matchId', async (req: Request, res: Response) => {
		const matchId = String(req.params.matchId);
		if (!MATCH_ID_RE.test(matchId)) {
			res.status(404).json({ error: 'no such replay' });
			return;
		}
		const publicPath = join(deps.dir, `${matchId}${PUBLIC_SUFFIX}`);
		const row = rowsOf(deps.dir).find((r) => r.matchId === matchId);
		if (row === undefined) {
			res.status(404).json({ error: 'no such replay' });
			return;
		}
		try {
			if (row.hasPublic) {
				const lines = await allLines(publicPath);
				const header = parseJson<PublicHeaderLine>(lines[0] ?? '');
				const end = parseJson<PublicEndLine>(lines[lines.length - 1] ?? '');
				if (header === null || header.t !== 'header' || end === null || end.t !== 'end') {
					res.status(404).json({ error: 'replay file is corrupt' });
					return;
				}
				if (!isAdmin(req) && deps.isTesting(header.roomId)) {
					res.status(404).json({ error: 'no such replay' });
					return;
				}
				const envs = lines
					.slice(1, -1)
					.map((l) => parseJson<{ t: 'env'; at: number; env: unknown }>(l))
					.filter((l): l is { t: 'env'; at: number; env: unknown } => l !== null && l.t === 'env')
					.map((l) => ({ at: l.at, env: l.env }));
				res.json({ header, envs, end });
				return;
			}
			const actionsLines = await allLines(join(deps.dir, `${matchId}${ACTIONS_SUFFIX}`));
			const actionsHeader = parseJson<ActionsHeaderLine>(actionsLines[0] ?? '');
			const hiddenFromCaller = actionsHeader !== null && !isAdmin(req) && deps.isTesting(actionsHeader.roomId);
			if (actionsHeader === null || hiddenFromCaller) {
				res.status(404).json({ error: 'no such replay' });
				return;
			}
			if (deps.rebuild === undefined || !(deps.canRebuild?.(actionsHeader) ?? false)) {
				res.status(404).json({ error: 'this replay can no longer be rebuilt' });
				return;
			}
			const result = await deps.rebuild(matchId);
			if (result === null) {
				res.status(404).json({ error: 'rebuild failed' });
				return;
			}
			res.json(result);
		} catch (err) {
			log({ evt: 'replay-detail-read-failed', matchId, error: (err as Error).message });
			res.status(404).json({ error: 'no such replay' });
		}
	});

	api.use('/replays', replays);
}
