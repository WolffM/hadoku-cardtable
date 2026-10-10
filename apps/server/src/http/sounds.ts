/**
 * `/api/sounds` — the sound-builder's catalogue, take audio, and assignments.
 *
 * Mounted on the `api` router the same way `/api/rooms` is (after
 * `requireMinTier`, so every caller here is already friend tier). Reads are
 * friend tier on purpose — the game will play these takes to every player,
 * later — and every WRITE additionally requires admin:
 * `rankOf(tierOf(req)) >= rankOf('admin')`, the same ladder `edge-auth.ts`
 * defines and nothing here re-implements.
 *
 *   GET /api/sounds/catalogue            → 200 { takes: SoundTake[] }
 *   GET /api/sounds/takes/:folder/:file   → 200 audio/ogg | 400 | 404
 *   GET /api/sounds/assignments           → 200 { cells, gains, canEdit }
 *   PUT /api/sounds/assignments/:cell     { files: string[], gain?: number } → 200 { cell, files, gain } | 400 | 403
 *
 * ## Storage, and what a missing directory means
 *
 * Everything lives under one directory (`CARDTABLE_SOUNDS_DIR`, resolved by
 * `index.ts`): `catalogue.json` (written by `scripts/sfx/import.py`, never by
 * this server), `takes/<folder>/<file>.ogg` (the audio bytes), and
 * `assignments.json` (written here, by an admin PUT). A directory, or any one
 * of those files, that does not exist yet is not an error — a fresh install
 * with no import run has an empty catalogue and an empty assignment map, not
 * a 500. `assignments.json` is written atomically (temp file, then rename),
 * so a process killed mid-write leaves the temp file behind and the previous
 * `assignments.json` untouched — never a half-written one.
 *
 * ## The traversal gate is the allow-list, not the path check
 *
 * `GET /takes/:folder/:file` resolves a path from two URL segments, which is
 * exactly the shape that goes wrong. The real defence is `TAKE_FILE_RE`
 * (`@hadoku/shared`): its folder segment must START with a letter or digit,
 * which makes `..` and an absolute path syntactically impossible, and it
 * excludes `/` from both segments entirely, so neither can smuggle in a
 * second path separator. The resolved-path-stays-inside-the-directory check
 * below is kept anyway, as a second and independent gate — belt and
 * suspenders, not either/or.
 *
 * ## Every file in a PUT body must already be in the catalogue
 *
 * The body names takes by their `file` path; a path that is not in
 * `catalogue.json` is refused with 400 rather than stored. This is what keeps
 * `assignments.json` from ever pointing at audio that was never imported (or
 * was renamed/removed by a later import run).
 */

import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { join, resolve as resolvePath, sep } from 'node:path';

import { CatalogueSchema, GainSchema, PutAssignmentBodySchema, TAKE_FILE_RE, isCellId, type Catalogue } from '@hadoku/shared';
import { rankOf, tierOf } from '../edge-auth.js';

export interface SoundsDeps {
	/** The sounds data directory (`CARDTABLE_SOUNDS_DIR`). Created on first write, never on a read. */
	dir: string;
	/** Structured log lines. */
	log?: (entry: Record<string, unknown>) => void;
}

type Log = (entry: Record<string, unknown>) => void;

function isAdmin(req: Request): boolean {
	return rankOf(tierOf(req)) >= rankOf('admin');
}

function isEnoent(err: unknown): boolean {
	return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT';
}

function badRequest(res: Response, error: string): void {
	res.status(400).json({ error });
}

/**
 * `catalogue.json`. Missing file, missing directory, or a file that fails to
 * parse or fails the schema: all mean empty — but never SILENTLY. Each of
 * those last two logs `sounds-file-corrupt` with the reason, because "the
 * builder shows no sounds" and "the builder shows no sounds AND nobody can
 * tell why" are different bugs and only the file being readable at all tells
 * them apart.
 */
async function readCatalogue(dir: string, log: Log): Promise<Catalogue> {
	let raw: string;
	try {
		raw = await readFile(join(dir, 'catalogue.json'), 'utf8');
	} catch (err) {
		if (isEnoent(err)) return { takes: [] };
		throw err;
	}
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		log({ event: 'sounds-file-corrupt', file: 'catalogue.json', reason: 'invalid JSON' });
		return { takes: [] };
	}
	const parsed = CatalogueSchema.safeParse(json);
	if (!parsed.success) {
		log({ event: 'sounds-file-corrupt', file: 'catalogue.json', reason: 'schema', issues: parsed.error.issues.length });
		return { takes: [] };
	}
	return parsed.data;
}

interface StoredAssignments {
	cells: Record<string, string[]>;
	gains: Record<string, number>;
}

/**
 * `assignments.json`'s `cells` and `gains` maps, read loosely rather than
 * through the full `AssignmentsSchema` — that schema's `canEdit` is never
 * stored on disk, it is computed per request. A key that is not a valid
 * `CellId`, a cell that is not an array of strings, or a gain outside
 * `GainSchema`, is DROPPED rather than failing the whole read: a corrupt or
 * hand-edited file degrades to "that one cell is empty", not a 500. Every
 * degrade path is logged — a whole-file corruption as `sounds-file-corrupt`,
 * one or more dropped cells as `sounds-assignments-cells-dropped` with the
 * count — so "silently empty" is never the only trace left.
 */
async function readAssignments(dir: string, log: Log): Promise<StoredAssignments> {
	let raw: string;
	try {
		raw = await readFile(join(dir, 'assignments.json'), 'utf8');
	} catch (err) {
		if (isEnoent(err)) return { cells: {}, gains: {} };
		throw err;
	}
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		log({ event: 'sounds-file-corrupt', file: 'assignments.json', reason: 'invalid JSON' });
		return { cells: {}, gains: {} };
	}
	if (typeof json !== 'object' || json === null || Array.isArray(json)) {
		log({ event: 'sounds-file-corrupt', file: 'assignments.json', reason: 'not an object' });
		return { cells: {}, gains: {} };
	}
	const cellsRaw = (json as Record<string, unknown>).cells;
	if (typeof cellsRaw !== 'object' || cellsRaw === null || Array.isArray(cellsRaw)) {
		log({ event: 'sounds-file-corrupt', file: 'assignments.json', reason: 'cells is not an object' });
		return { cells: {}, gains: {} };
	}
	const cells: Record<string, string[]> = {};
	let dropped = 0;
	for (const [key, value] of Object.entries(cellsRaw as Record<string, unknown>)) {
		if (!isCellId(key) || !Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
			dropped += 1;
			continue;
		}
		cells[key] = value as string[];
	}
	const gains: Record<string, number> = {};
	const gainsRaw = (json as Record<string, unknown>).gains;
	if (typeof gainsRaw === 'object' && gainsRaw !== null && !Array.isArray(gainsRaw)) {
		for (const [key, value] of Object.entries(gainsRaw as Record<string, unknown>)) {
			if (!isCellId(key) || !GainSchema.safeParse(value).success) {
				dropped += 1;
				continue;
			}
			gains[key] = value as number;
		}
	}
	if (dropped > 0) log({ event: 'sounds-assignments-cells-dropped', count: dropped });
	return { cells, gains };
}

/**
 * Temp file, then rename over the target — the same shape `@hadoku/room-store`
 * uses for its own snapshots. A process that dies between the two steps
 * leaves the `.tmp` file as evidence and the previous `assignments.json`
 * untouched; nothing ever reads a half-written file because nothing is ever
 * renamed into place until the write is complete.
 */
async function atomicWriteJson(target: string, data: unknown): Promise<void> {
	await mkdir(join(target, '..'), { recursive: true });
	const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
	const handle = await open(tmp, 'w');
	try {
		await handle.writeFile(JSON.stringify(data, null, 2));
		await handle.sync();
	} finally {
		await handle.close();
	}
	await rename(tmp, target);
}

async function writeAssignments(dir: string, stored: StoredAssignments): Promise<void> {
	await atomicWriteJson(join(dir, 'assignments.json'), stored);
}

export function attachSounds(api: Router, deps: SoundsDeps): void {
	const { dir } = deps;
	const log =
		deps.log ??
		((entry: Record<string, unknown>) =>
			console.log(JSON.stringify({ t: new Date().toISOString(), svc: 'cardtable-sounds', ...entry })));

	const sounds = Router();
	const takesDir = resolvePath(join(dir, 'takes'));

	/**
	 * Serializes `assignments.json`'s read-modify-write across every PUT this
	 * instance handles. Without it, two overlapping PUTs (a drag sends one for
	 * the source cell and one for the target) can each read the SAME prior
	 * `cells` object before either writes — B's read misses A's not-yet-saved
	 * change, B writes its own change on top of the stale copy, and A's change
	 * is silently gone. A promise chain is enough: every call waits for the
	 * previous one to settle (success OR failure) before it starts its own
	 * read, so the three steps together are atomic with respect to each other.
	 */
	let writeChain: Promise<void> = Promise.resolve();
	function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
		const run = writeChain.then(fn, fn);
		writeChain = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	sounds.get('/catalogue', async (_req: Request, res: Response) => {
		res.json(await readCatalogue(dir, log));
	});

	sounds.get('/takes/:folder/:file', async (req: Request, res: Response) => {
		const folder = String(req.params.folder);
		const file = String(req.params.file);
		const rel = `${folder}/${file}`;
		if (!TAKE_FILE_RE.test(rel)) return badRequest(res, 'not a valid take path');
		const resolved = resolvePath(takesDir, folder, file);
		// Second, independent gate: the resolved path must still be inside
		// takesDir. `TAKE_FILE_RE` already makes this impossible to fail, but a
		// path check that trusts a regex alone is one refactor away from not
		// trusting anything.
		if (resolved !== takesDir && !resolved.startsWith(takesDir + sep)) {
			return badRequest(res, 'not a valid take path');
		}
		let data: Buffer;
		try {
			data = await readFile(resolved);
		} catch (err) {
			if (isEnoent(err)) return res.status(404).json({ error: 'no such take' });
			throw err;
		}
		res.setHeader('Content-Type', 'audio/ogg');
		res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
		res.status(200).send(data);
	});

	sounds.get('/assignments', async (req: Request, res: Response) => {
		const { cells, gains } = await readAssignments(dir, log);
		res.json({ cells, gains, canEdit: isAdmin(req) });
	});

	sounds.put('/assignments/:cell', async (req: Request, res: Response) => {
		if (!isAdmin(req)) return res.status(403).json({ error: 'admin tier required' });
		const cell = String(req.params.cell);
		if (!isCellId(cell)) return badRequest(res, 'not a valid cell id');
		const parsed = PutAssignmentBodySchema.safeParse(req.body);
		if (!parsed.success) {
			return badRequest(res, parsed.error.issues.map((i) => `${i.path.join('.') || 'files'}: ${i.message}`).join('; '));
		}
		const { files, gain } = parsed.data;
		// Read-only; does not need the write lock below.
		const catalogue = await readCatalogue(dir, log);
		const known = new Set(catalogue.takes.map((t) => t.file));
		const unknown = files.filter((f) => !known.has(f));
		if (unknown.length > 0) return badRequest(res, `unknown file(s): ${unknown.join(', ')}`);
		// The read-modify-write is the critical section: see `withWriteLock`'s header.
		const saved = await withWriteLock(async () => {
			const stored = await readAssignments(dir, log);
			stored.cells[cell] = files;
			if (gain !== undefined) stored.gains[cell] = gain;
			await writeAssignments(dir, stored);
			return stored.gains[cell] ?? 1;
		});
		log({ event: 'sounds-assignment-saved', cell, count: files.length });
		res.json({ cell, files, gain: saved });
	});

	api.use('/sounds', sounds);

	// Errors on /sounds — chiefly `express.json()`'s parse failure, raised on
	// the api router BEFORE `sounds` runs, and any unexpected fs failure (e.g.
	// a permissions error, not a missing file — those are handled above).
	api.use('/sounds', (err: unknown, _req: Request, res: Response, next: NextFunction) => {
		if (res.headersSent) return next(err);
		const e = err as { type?: unknown; status?: unknown; name?: unknown };
		if (e.type === 'entity.parse.failed') {
			return badRequest(res, 'body is not valid JSON');
		}
		if (typeof e.status === 'number' && e.status >= 400 && e.status < 500) {
			return badRequest(res, 'the request body could not be read');
		}
		log({ event: 'sounds-error', name: typeof e.name === 'string' ? e.name : 'unknown' });
		res.status(500).json({ error: 'internal error' });
	});
}
