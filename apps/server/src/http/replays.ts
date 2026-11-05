/**
 * `/api/replays` — contract 2 of `docs/planning/wave77-2026-10-27.md` §C.
 *
 *   GET /api/replays?limit=20   → 200 { replays: ReplaySummary[] }   newest first, each with its `pace`
 *   GET /api/replays/:matchId   → 200 { header, envs, presence, end } | 404
 *
 * Reads `CARDTABLE_RECORDINGS_DIR` directly — never the live recorder's
 * in-memory state, so this answers the same way across a restart. The list
 * only ever decompresses the PUBLIC stream (never the action log, which is
 * read only to ask `canRebuild`), and reads it a line at a time without
 * keeping every envelope in memory: it needs the header and the end, not the
 * body. The detail route is the one place a whole stream is read.
 *
 * Mounted on `api`, which is already behind `requireMinTier` (member tier) —
 * same gate as every other `/api` route; `isAdmin` only decides whether a
 * testing room's rows are in the list at all, the same rule `http/rooms.ts`
 * applies to the room list itself. A game's replay is the watcher channel's stream, every hand face
 * up, so it is also withheld from the game's own players while their series may still go on
 * (`Lobby.stillPlaying`): a Bo3's game 1 is a hidden hand in games 2 and 3.
 */

import { createReadStream, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { createGunzip } from 'node:zlib';
import type { Request, Response, Router } from 'express';
import { Router as makeRouter } from 'express';

import { isAdmin } from '../edge-auth.js';
import { httpCaller } from './request.js';
import type { JsonLog } from '../log.js';
import { ACTIONS_SUFFIX, PUBLIC_SUFFIX } from '../play/recording/retention.js';
import { PUBLIC_VERSION, type PublicEndLine, type PublicEnvLine, type PublicPresenceLine } from '../play/recording/writer.js';
import type { PersonFace } from '@hadoku/shared';
import { faceOfPerson, type People, type Person } from '../people.js';

interface PublicHeaderLine {
	t: 'header';
	v: number;
	matchId: string;
	roomId: string | null;
	players: [string, string];
	ai: [boolean, boolean];
	decks: unknown[];
	art?: unknown[];
	startedAt: string;
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
	/** See `Lobby.stillPlaying`. Absent: no game is withheld from its players. */
	stillPlaying?(matchId: string, caller: string): boolean;
	/** Lane D's own check, injected. Absent: a match with no public stream always answers `source: 'none'`/404. */
	canRebuild?(header: ActionsHeaderLine): boolean;
	/** Lane D's own rebuild, injected. */
	rebuild?(matchId: string): Promise<RebuildResult>;
	/** Who played, looked up when a replay is watched (`GET /:matchId/people`). Absent: nobody is. */
	people?: People;
	log?: JsonLog;
}

/** A replay's people: who they are now can change, so this is not cached like the replay itself. */
const PEOPLE_CACHE = 'private, max-age=60';

/** The end line as it leaves the server: its seats' userIds stay on disk. */
function withoutUsers(end: PublicEndLine): PublicEndLine {
	return end.seats === undefined ? end : { ...end, seats: end.seats.map(({ userId: _userId, ...seat }) => seat) };
}

/**
 * A finished match's replay never changes, so a browser keeps it: the front page's second visit draws
 * its card from the cache. `private`, never `public`: every `/api` answer is friend-gated, and a shared
 * cache in front of the gate must not hold one.
 */
const REPLAY_CACHE = 'private, max-age=31536000, immutable';
/** The list changes with every finished match: short-lived. */
const LIST_CACHE = 'private, max-age=15';
/** What a viewer may report about a replay it could not play (`POST /api/replays/report`). */
const REPORT_KINDS: ReadonlySet<string> = new Set(['load-failed', 'player-error']);
const REPORT_MAX_CHARS = 2_000;
const REPORTS_PER_MINUTE = 30;

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;
/** `newMatchId` (`match.ts`) mints `m-<12 hex>`; this is generous around that so a param that is not one never becomes a path segment. */
const MATCH_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** A gap between two frames longer than this is someone thinking, not something happening. */
export const WAIT_GAP_MS = 5_000;
/** The writer puts `t` then `at` first (`writer.ts`), so a frame's time is read without parsing its envelope. */
const ENV_AT = /^\{"t":"env","at":(\d+)/;

/** How busy a recording is: its frames, how long they span, and how much of that was gaps over {@link WAIT_GAP_MS}. */
export interface ReplayPace {
	envs: number;
	durationMs: number;
	waitMs: number;
}

/**
 * Read a gzip JSONL file a line at a time, keeping only the first line and the running last one — never the
 * whole body — and the recording's {@link ReplayPace} on the way past.
 */
async function firstAndLastLine(path: string): Promise<{ first: string; last: string; pace: ReplayPace } | null> {
	return new Promise((resolve, reject) => {
		const input = createReadStream(path);
		const gunzip = createGunzip();
		input.on('error', (err) => reject(err));
		gunzip.on('error', (err) => reject(err));
		const rl = createInterface({ input: input.pipe(gunzip), crlfDelay: Infinity });
		let first: string | null = null;
		let last: string | null = null;
		const pace: ReplayPace = { envs: 0, durationMs: 0, waitMs: 0 };
		let startAt: number | null = null;
		let prevAt = 0;
		rl.on('line', (line) => {
			if (line === '') return;
			if (first === null) first = line;
			last = line;
			const at = ENV_AT.exec(line);
			if (at === null) return;
			const ms = Number(at[1]);
			startAt ??= ms;
			if (ms - prevAt > WAIT_GAP_MS && pace.envs > 0) pace.waitMs += ms - prevAt;
			prevAt = ms;
			pace.envs += 1;
			pace.durationMs = ms - startAt;
		});
		rl.on('close', () => resolve(first === null || last === null ? null : { first, last, pace }));
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
	/** Whether this caller may not see this game's replay: a testing room's, to a non-admin, or their own series' while it goes on. */
	const hiddenFrom = (req: Request, header: { matchId: string; roomId: string | null }): boolean =>
		(!isAdmin(req) && deps.isTesting(header.roomId)) || (deps.stillPlaying?.(header.matchId, httpCaller(req)) ?? false);

	replays.get('/', async (req: Request, res: Response) => {
		const limitParam = Number(req.query.limit ?? DEFAULT_LIST_LIMIT);
		const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(Math.floor(limitParam), MAX_LIST_LIMIT) : DEFAULT_LIST_LIMIT;

		const rows = rowsOf(deps.dir);
		const summaries: { header: PublicHeaderLine; endedAt: string | null; winner: 0 | 1 | null; source: 'stream' | 'rebuild' | 'none'; pace: ReplayPace | null }[] = [];
		for (const row of rows) {
			try {
				if (row.hasPublic) {
					const read = await firstAndLastLine(join(deps.dir, `${row.matchId}${PUBLIC_SUFFIX}`));
					const header = read === null ? null : parseJson<PublicHeaderLine>(read.first);
					// An older stream draws no hand: it is no replay, but its action log may still rebuild one.
					if (header !== null && header.v === PUBLIC_VERSION) {
						const end = read === null ? null : parseJson<PublicEndLine>(read.last);
						summaries.push({ header, endedAt: end?.t === 'end' ? end.endedAt : null, winner: end?.t === 'end' ? end.winner : null, source: 'stream', pace: read === null ? null : read.pace });
						continue;
					}
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
					v: PUBLIC_VERSION,
					matchId: actionsHeader.matchId,
					roomId: actionsHeader.roomId,
					players: seats === null ? ['', ''] : [seats[0]!.name, seats[1]!.name],
					ai: seats === null ? [false, false] : [seats[0]!.ai, seats[1]!.ai],
					decks: [null, null],
					startedAt: actionsHeader.startedAt,
				};
				const end = read === null ? null : parseJson<{ t: 'end'; endedAt: string; reason: string }>(read.last);
				const canRebuild = deps.canRebuild?.(actionsHeader) ?? false;
				summaries.push({ header, endedAt: end?.t === 'end' ? end.endedAt : null, winner: null, source: canRebuild ? 'rebuild' : 'none', pace: null });
			} catch (err) {
				log({ evt: 'replay-list-read-failed', matchId: row.matchId, error: (err as Error).message });
			}
		}

		// A recording that cannot be played is not offered (wave 81): the worst case is no replay.
		const visible = summaries.filter((s) => s.source !== 'none' && !hiddenFrom(req, s.header));
		visible.sort((a, b) => (a.header.startedAt < b.header.startedAt ? 1 : a.header.startedAt > b.header.startedAt ? -1 : 0));
		res.set('Cache-Control', LIST_CACHE);
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
				pace: s.pace,
			})),
		});
	});

	// A viewer's trouble with a replay, in the server log: the board shows none, so this is where it is seen.
	let reports = { minute: 0, count: 0 };
	replays.post('/report', (req: Request, res: Response) => {
		const body = (req.body ?? {}) as { what?: unknown; matchId?: unknown; ui?: unknown; detail?: unknown };
		const detail = typeof body.detail === 'object' && body.detail !== null && !Array.isArray(body.detail) ? body.detail : {};
		if (typeof body.what !== 'string' || !REPORT_KINDS.has(body.what) || JSON.stringify(detail).length > REPORT_MAX_CHARS) {
			res.status(400).json({ error: 'a report is { what, matchId, ui, detail } with a known what' });
			return;
		}
		const minute = Math.floor(Date.now() / 60_000);
		reports = reports.minute === minute ? { minute, count: reports.count + 1 } : { minute, count: 1 };
		if (reports.count <= REPORTS_PER_MINUTE) {
			const matchId = typeof body.matchId === 'string' && MATCH_ID_RE.test(body.matchId) ? body.matchId : null;
			log({ evt: 'replay-report', what: body.what, matchId, ui: typeof body.ui === 'string' ? body.ui.slice(0, 40) : null, detail });
		}
		res.status(204).end();
	});

	/**
	 * `GET /:matchId/people` → `{ people: { [seat]: { name?, avatarId?, look? } } }`: each seat holder
	 * as they are now (R12), from the userId the recording kept beside their seat. A seat with no
	 * userId (the AI, a recording from before it was kept) is absent, and the replay draws it from
	 * what it recorded.
	 */
	replays.get('/:matchId/people', async (req: Request, res: Response) => {
		const matchId = String(req.params.matchId);
		const row = MATCH_ID_RE.test(matchId) ? rowsOf(deps.dir).find((r) => r.matchId === matchId) : undefined;
		if (row === undefined || !row.hasPublic) {
			res.status(404).json({ error: 'no such replay' });
			return;
		}
		try {
			const read = await firstAndLastLine(join(deps.dir, `${matchId}${PUBLIC_SUFFIX}`));
			const header = parseJson<PublicHeaderLine>(read?.first ?? '');
			const end = parseJson<PublicEndLine>(read?.last ?? '');
			if (header === null || header.t !== 'header' || hiddenFrom(req, header)) {
				res.status(404).json({ error: 'no such replay' });
				return;
			}
			const seats = (end?.t === 'end' ? (end.seats ?? []) : []).flatMap((s) => (s.userId === undefined ? [] : [{ seat: s.seat, userId: s.userId }]));
			const found = deps.people === undefined ? new Map<string, Person>() : await deps.people.resolve(seats.map((s) => s.userId));
			const people: Record<string, { name?: string } & PersonFace> = {};
			for (const { seat, userId } of seats) {
				const person = found.get(userId);
				if (person !== undefined) people[String(seat)] = { ...(person.name === null ? {} : { name: person.name }), ...faceOfPerson(person) };
			}
			res.set('Cache-Control', PEOPLE_CACHE);
			res.json({ people });
		} catch (err) {
			log({ evt: 'replay-people-read-failed', matchId, error: (err as Error).message });
			res.status(404).json({ error: 'no such replay' });
		}
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
			const lines = row.hasPublic ? await allLines(publicPath) : [];
			const header = parseJson<PublicHeaderLine>(lines[0] ?? '');
			if (header !== null && header.v === PUBLIC_VERSION) {
				const end = parseJson<PublicEndLine>(lines[lines.length - 1] ?? '');
				if (header.t !== 'header' || end === null || end.t !== 'end') {
					res.status(404).json({ error: 'replay file is corrupt' });
					return;
				}
				if (hiddenFrom(req, header)) {
					res.status(404).json({ error: 'no such replay' });
					return;
				}
				const body = lines.slice(1, -1).map((l) => parseJson<PublicEnvLine | PublicPresenceLine>(l));
				const envs = body.filter((l): l is PublicEnvLine => l !== null && l.t === 'env').map((l) => ({ at: l.at, env: l.env }));
				const presence = body
					.filter((l): l is PublicPresenceLine => l !== null && l.t === 'presence')
					.map((l) => ({ at: l.at, seat: l.seat, playerId: l.playerId, presence: l.presence }));
				res.set('Cache-Control', REPLAY_CACHE);
				res.json({ header, envs, presence, end: withoutUsers(end) });
				return;
			}
			if (!row.hasActions) {
				res.status(404).json({ error: 'no such replay' });
				return;
			}
			const actionsLines = await allLines(join(deps.dir, `${matchId}${ACTIONS_SUFFIX}`));
			const actionsHeader = parseJson<ActionsHeaderLine>(actionsLines[0] ?? '');
			if (actionsHeader === null || hiddenFrom(req, actionsHeader)) {
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
			res.set('Cache-Control', REPLAY_CACHE);
			res.json(result);
		} catch (err) {
			log({ evt: 'replay-detail-read-failed', matchId, error: (err as Error).message });
			res.status(404).json({ error: 'no such replay' });
		}
	});

	api.use('/replays', replays);
}
