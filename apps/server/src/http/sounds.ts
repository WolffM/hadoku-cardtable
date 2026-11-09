/**
 * `/api/sounds` — the sound-builder's catalogue, take audio, and assignments.
 *
 * Mounted on the `api` router the same way `/api/rooms` is (after
 * `requireMinTier`, so every caller here is already at the app's floor). Reads
 * are open at the floor on purpose — the game plays these takes to every
 * player — and every WRITE additionally requires admin:
 * `rankOf(tierOf(req)) >= rankOf('admin')`, the same ladder `edge-auth.ts`
 * defines and nothing here re-implements.
 *
 *   GET /api/sounds/catalogue            → 200 { takes: SoundTake[] }
 *   GET /api/sounds/audio/:folder/:file   [?v=version] → 200 audio/ogg | 206 | 304 | 400 | 404
 *   GET /api/sounds/assignments           → 200 { cells, gains, names, versions, pack, canEdit }
 *   GET /api/sounds/pack                  [?v=pack] → 200 every cue take (`sound-pack.ts`) | 304
 *   PUT /api/sounds/assignments/:cell     { files: string[], gain?: number } → 200 { cell, files, gain } | 400 | 403
 *   POST /api/sounds/music-review         MusicReviewBody → 200 MusicReviewRecord | 400 | 403 | 502   (friend tier; an admin's also writes the cells it changes)
 *   GET /api/sounds/music-review/mine     → 200 { review: MusicReviewRecord | null } | 403 | 502      (friend tier)
 *   GET /api/sounds/music-review          → 200 MusicReviewList | 403 | 502                         (admin)
 *
 * The music-review routes check friend tier THEMSELVES rather than lean on
 * the app's floor: the floor drops to `member` for the public release, and the
 * review stays a job for friends. A review is its author's own prefs-api row
 * (`musicReviewStore.ts`), not a file here.
 *
 * ## Storage, and what a missing directory means
 *
 * Everything lives under one directory (`CARDTABLE_SOUNDS_DIR`, resolved by
 * `index.ts`): `catalogue.json` (written by `scripts/sfx/import.py`, never by
 * this server), `takes/<folder>/<file>.ogg` (the audio bytes),
 * and `assignments.json` (written here, by an admin PUT). A directory, or any one
 * of those files, that does not exist yet is not an error — a fresh install
 * with no import run has an empty catalogue and an empty assignment map, not
 * a 500. `assignments.json` is written atomically (temp file, then rename),
 * so a process killed mid-write leaves the temp file behind and the previous
 * `assignments.json` untouched — never a half-written one.
 *
 * ## The traversal gate is the allow-list, not the path check
 *
 * `GET /audio/:folder/:file` resolves a path from two URL segments, which is
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

import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, open, readFile, rename, stat } from 'node:fs/promises';
import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { join, resolve as resolvePath, sep } from 'node:path';

import {
	CatalogueSchema,
	GainSchema,
	MarksSchema,
	MusicReviewBodySchema,
	PutAssignmentBodySchema,
	PutMarkBodySchema,
	RestoreBodySchema,
	RetireBodySchema,
	SoundTakeSchema,
	TAKE_FILE_RE,
	cueTakes,
	encodeSoundPack,
	isCellId,
	applyMusicReview,
	musicReviewProblems,
	musicReviewSlots,
	type Catalogue,
	type SoundTake,
} from '@hadoku/shared';
import { isAdmin, rankOf, tierOf, userIdOf, userKeyOf } from '../edge-auth.js';
import { jsonLogger, type JsonLog } from '@hadoku/service-kernel/log';
import type { MusicReviewStore } from './musicReviewStore.js';
import { bodyErrors } from './request.js';

export interface SoundsDeps {
	/** The sounds data directory (`CARDTABLE_SOUNDS_DIR`). Created on first write, never on a read. */
	dir: string;
	/** People's match-music reviews, in their own prefs rows. */
	reviews: MusicReviewStore;
	/** Structured log lines. */
	log?: JsonLog;
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
async function readCatalogue(file: string, log: JsonLog): Promise<Catalogue> {
	let raw: string;
	try {
		raw = await readFile(file, 'utf8');
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

/**
 * `readCatalogue`, read again only when the file changed (its inode, size or mtime: the import
 * tool's write, or a retire's atomic rename). Every page load asks `/assignments`, which used to
 * read, parse and validate the whole catalogue (~280 KB) to name a dozen music takes. Each caller
 * gets its own `takes` array, so one that pushes onto it before writing changes nothing kept.
 */
function keptCatalogue(dir: string, log: JsonLog): () => Promise<Catalogue> {
	const file = join(dir, 'catalogue.json');
	let kept: { stamp: string; catalogue: Promise<Catalogue> } | null = null;
	return async () => {
		let stamp: string;
		try {
			const s = await stat(file);
			stamp = `${String(s.ino)}-${String(s.size)}-${String(s.mtimeMs)}`;
		} catch (err) {
			if (!isEnoent(err)) throw err;
			kept = null;
			return { takes: [] };
		}
		if (kept?.stamp !== stamp) {
			const entry = { stamp, catalogue: readCatalogue(file, log) };
			kept = entry;
			entry.catalogue.catch(() => {
				if (kept === entry) kept = null;
			});
		}
		return { takes: [...(await kept.catalogue).takes] };
	};
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
async function readAssignments(dir: string, log: JsonLog): Promise<StoredAssignments> {
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
 * Temp file, then rename over the target — the same shape `@wolffm/rooms-server/store`
 * uses for its own snapshots. A process that dies between the two steps
 * leaves the `.tmp` file as evidence and the previous `assignments.json`
 * untouched; nothing ever reads a half-written file because nothing is ever
 * renamed into place until the write is complete.
 */
export async function atomicWriteJson(target: string, data: unknown): Promise<void> {
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

/**
 * `retired.jsonl`: one line per retirement and per restore, append-only. It is
 * the feedback the next generation batch reads — which prompts made a broken or
 * a bad take, and which cells had been given it — so a retirement is never only
 * a deletion. The take's whole catalogue entry rides along, which is also what
 * lets `restore` put it back exactly.
 */
interface RetiredLine {
	at: string;
	action: 'retire' | 'restore';
	file: string;
	reason?: string;
	take?: SoundTake;
	cells?: string[];
}

async function appendRetired(dir: string, line: RetiredLine): Promise<void> {
	await mkdir(dir, { recursive: true });
	await appendFile(join(dir, 'retired.jsonl'), `${JSON.stringify(line)}\n`);
}

/** The last retirement of `file` that no later restore has undone, or null. */
async function lastRetirement(dir: string, file: string): Promise<RetiredLine | null> {
	let raw: string;
	try {
		raw = await readFile(join(dir, 'retired.jsonl'), 'utf8');
	} catch (err) {
		if (isEnoent(err)) return null;
		throw err;
	}
	let open: RetiredLine | null = null;
	for (const text of raw.split('\n')) {
		if (text.trim() === '') continue;
		let line: RetiredLine;
		try {
			line = JSON.parse(text) as RetiredLine;
		} catch {
			continue;
		}
		if (line.file !== file) continue;
		open = line.action === 'retire' ? line : null;
	}
	return open;
}

export function attachSounds(api: Router, deps: SoundsDeps): void {
	const { dir, reviews } = deps;
	const log = deps.log ?? jsonLogger('cardtable-sounds');

	const sounds = Router();
	const takesDir = resolvePath(join(dir, 'takes'));
	const catalogueNow = keptCatalogue(dir, log);

	/** A take's version: its size and modification time, as a static server's ETag. `null`: no such take. */
	const versionOf = async (file: string): Promise<string | null> => {
		try {
			const s = await stat(join(takesDir, file));
			return `${s.size.toString(36)}-${Math.trunc(s.mtimeMs).toString(36)}`;
		} catch (err) {
			if (isEnoent(err)) return null;
			throw err;
		}
	};

	/** Every take's version, by file; a file the take dir does not hold is left out. */
	const versionsOf = async (files: Iterable<string>): Promise<Record<string, string>> => {
		const valid = [...new Set(files)].filter((f) => TAKE_FILE_RE.test(f));
		const found = await Promise.all(valid.map(async (f) => [f, await versionOf(f)] as const));
		return Object.fromEntries(found.filter((e): e is readonly [string, string] => e[1] !== null));
	};

	/** The cue pack's takes and version: a digest of every cue take and its version, so a re-cut, an addition or a removal moves it. */
	const cuePack = (cells: Readonly<Record<string, readonly string[]>>, versions: Readonly<Record<string, string>>): { files: string[]; version: string } => {
		const files = cueTakes(cells).filter((f) => versions[f] !== undefined);
		const version = files.length === 0 ? '' : createHash('sha1').update(files.map((f) => `${f}@${versions[f]!}`).join('\n')).digest('base64url').slice(0, 16);
		return { files, version };
	};

	/** The last pack built: its takes are read once per version, not once per visitor. */
	let built: { version: string; body: Promise<Buffer> } | null = null;
	const packBody = (version: string, files: readonly string[]): Promise<Buffer> => {
		if (built?.version === version) return built.body;
		const body = Promise.all(files.map(async (file) => ({ file, bytes: await readFile(join(takesDir, file)) }))).then((takes) => Buffer.from(encodeSoundPack(takes)));
		const entry = { version, body };
		built = entry;
		// A take that went between its stat and its read: the next ask builds again.
		body.catch(() => {
			if (built === entry) built = null;
		});
		return body;
	};

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
		res.json(await catalogueNow());
	});

	/*
	 * A take is re-cut in place (same name, new bytes) when the finishing limits change, as they did
	 * on 2026-10-10, so a bare take URL is revalidated, never cached blind. The game asks for
	 * `?v=<version>` (`/assignments`' `versions`), and only while that is still the take's version is
	 * the answer kept for good: a re-cut take has a new version, so a new URL, and a returning player
	 * asks for none of the takes they already hold. `sendFile` answers a revalidation from the file's
	 * stat, never reading the bytes, and a range when one is asked for.
	 */
	sounds.get('/audio/:folder/:file', async (req: Request, res: Response, next: NextFunction) => {
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
		const version = await versionOf(rel);
		if (version === null) return res.status(404).json({ error: 'no such take' });
		const pinned = req.query.v === version;
		res.sendFile(
			resolved,
			{ cacheControl: false, headers: { 'Content-Type': 'audio/ogg', 'Cache-Control': pinned ? 'private, max-age=31536000, immutable' : 'no-cache' } },
			(err?: Error) => {
				if (err !== undefined && !res.headersSent) next(err);
			},
		);
	});

	sounds.get('/assignments', async (req: Request, res: Response) => {
		const [{ cells, gains }, catalogue] = await Promise.all([readAssignments(dir, log), catalogueNow()]);
		// A music take's name, for the track picker in sound settings; a cue's is never shown.
		const music = new Set(Object.entries(cells).flatMap(([cell, files]) => (cell.startsWith('music.') ? files : [])));
		const names = Object.fromEntries(catalogue.takes.filter((t) => music.has(t.file)).map((t) => [t.file, t.name]));
		const versions = await versionsOf(Object.values(cells).flat());
		res.json({ cells, gains, names, versions, pack: cuePack(cells, versions).version, canEdit: isAdmin(req) });
	});

	/** Every cue take in one answer (`@hadoku/shared`'s `sound-pack.ts`), kept for good at the version `/assignments` gives. */
	sounds.get('/pack', async (req: Request, res: Response) => {
		const { cells } = await readAssignments(dir, log);
		const { files, version } = cuePack(cells, await versionsOf(cueTakes(cells)));
		const body = await packBody(version, files);
		res.setHeader('Content-Type', 'application/octet-stream');
		res.setHeader('Cache-Control', version !== '' && req.query.v === version ? 'private, max-age=31536000, immutable' : 'no-cache');
		res.setHeader('ETag', `"pack-${version}"`);
		res.send(body);
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
		const catalogue = await catalogueNow();
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

	/*
	 * Retire a take: out of the catalogue, out of every cell, its audio moved to
	 * `retired/` (kept, so `restore` can undo it), and a line in `retired.jsonl`.
	 * Under the same write lock as a PUT, because it rewrites `assignments.json`
	 * too. This is the one route besides `scripts/sfx/import.py` that writes
	 * `catalogue.json`.
	 */
	sounds.post('/retire', async (req: Request, res: Response) => {
		if (!isAdmin(req)) return res.status(403).json({ error: 'admin tier required' });
		const parsed = RetireBodySchema.safeParse(req.body);
		if (!parsed.success) return badRequest(res, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
		const { file, reason } = parsed.data;
		const outcome = await withWriteLock(async () => {
			const catalogue = await catalogueNow();
			const take = catalogue.takes.find((t) => t.file === file);
			if (take === undefined) return null;
			const stored = await readAssignments(dir, log);
			const cells = Object.keys(stored.cells).filter((c) => stored.cells[c]!.includes(file));
			for (const c of cells) stored.cells[c] = stored.cells[c]!.filter((f) => f !== file);
			const target = join(dir, 'retired', file);
			await mkdir(join(target, '..'), { recursive: true });
			try {
				await rename(join(takesDir, file), target);
			} catch (err) {
				// A take whose audio is already gone is exactly a broken one: retire the entry regardless.
				if (!isEnoent(err)) throw err;
			}
			await atomicWriteJson(join(dir, 'catalogue.json'), { takes: catalogue.takes.filter((t) => t.file !== file) });
			await writeAssignments(dir, stored);
			await appendRetired(dir, { at: new Date().toISOString(), action: 'retire', file, reason, take, cells });
			return { cells };
		});
		if (outcome === null) return res.status(404).json({ error: 'no such take' });
		log({ event: 'sounds-take-retired', file, reason, cells: outcome.cells.length });
		res.json({ file, reason, cells: outcome.cells });
	});

	/* Undo the last retirement of a take: back in the catalogue, back in the cells it left, its audio back. */
	sounds.post('/restore', async (req: Request, res: Response) => {
		if (!isAdmin(req)) return res.status(403).json({ error: 'admin tier required' });
		const parsed = RestoreBodySchema.safeParse(req.body);
		if (!parsed.success) return badRequest(res, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
		const { file } = parsed.data;
		const outcome = await withWriteLock(async () => {
			const line = await lastRetirement(dir, file);
			const take = SoundTakeSchema.safeParse(line?.take);
			if (line === null || !take.success) return null;
			try {
				await rename(join(dir, 'retired', file), join(takesDir, file));
			} catch (err) {
				if (!isEnoent(err)) throw err;
			}
			const catalogue = await catalogueNow();
			if (!catalogue.takes.some((t) => t.file === file)) catalogue.takes.push(take.data);
			const stored = await readAssignments(dir, log);
			const cells = (line.cells ?? []).filter(isCellId);
			for (const c of cells) if (!(stored.cells[c] ?? []).includes(file)) stored.cells[c] = [...(stored.cells[c] ?? []), file];
			await atomicWriteJson(join(dir, 'catalogue.json'), catalogue);
			await writeAssignments(dir, stored);
			await appendRetired(dir, { at: new Date().toISOString(), action: 'restore', file });
			return { take: take.data, cells };
		});
		if (outcome === null) return res.status(404).json({ error: 'nothing retired to restore' });
		log({ event: 'sounds-take-restored', file, cells: outcome.cells.length });
		res.json({ file, take: outcome.take, cells: outcome.cells });
	});

	/* The keep / delete marks: labels only, read by the picker and harvested by hand. */
	const readMarks = async (): Promise<Record<string, 'keep' | 'trash'>> => {
		let raw: string;
		try {
			raw = await readFile(join(dir, 'marks.json'), 'utf8');
		} catch (err) {
			if (isEnoent(err)) return {};
			throw err;
		}
		let json: unknown;
		try {
			json = JSON.parse(raw);
		} catch {
			log({ event: 'sounds-file-corrupt', file: 'marks.json', reason: 'invalid JSON' });
			return {};
		}
		const parsed = MarksSchema.safeParse(json);
		if (!parsed.success) {
			log({ event: 'sounds-file-corrupt', file: 'marks.json', reason: 'schema' });
			return {};
		}
		return parsed.data.marks;
	};

	sounds.get('/marks', async (_req: Request, res: Response) => {
		res.json({ marks: await readMarks() });
	});

	sounds.put('/marks', async (req: Request, res: Response) => {
		if (!isAdmin(req)) return res.status(403).json({ error: 'admin tier required' });
		const parsed = PutMarkBodySchema.safeParse(req.body);
		if (!parsed.success) return badRequest(res, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
		const { file, mark } = parsed.data;
		const catalogue = await catalogueNow();
		if (!catalogue.takes.some((t) => t.file === file)) return res.status(404).json({ error: 'no such take' });
		await withWriteLock(async () => {
			const marks = await readMarks();
			if (mark === null) delete marks[file];
			else marks[file] = mark;
			await atomicWriteJson(join(dir, 'marks.json'), { marks });
		});
		log({ event: 'sounds-take-marked', file, mark });
		res.json({ file, mark });
	});

	/*
	 * The match-music review: any friend may submit, because listening and choosing is the whole job. A
	 * friend's submission is only a review; an admin's also writes the cells it changes
	 * (`applyMusicReview`), under the same write lock as a PUT, so the operator's picks play at once. Every pick and
	 * rating must name a take its slot offers right now (`musicReviewSlots`, the same grouping the page
	 * draws from).
	 */
	sounds.use('/music-review', (req: Request, res: Response, next: NextFunction) => {
		if (rankOf(tierOf(req)) >= rankOf('friend')) return next();
		res.status(403).json({ error: 'friend tier required' });
	});

	/** A prefs-api failure is a 502: the review was neither stored nor read, and the page says so. */
	const prefsFailed = (res: Response, route: string, err: unknown): void => {
		const status = (err as { status?: unknown } | null)?.status;
		log({ event: 'sounds-music-review-prefs-error', route, ...(typeof status === 'number' ? { status } : {}), error: (err as Error)?.message ?? String(err) });
		res.status(502).json({ error: 'the review store is unreachable' });
	};

	sounds.post('/music-review', async (req: Request, res: Response) => {
		const parsed = MusicReviewBodySchema.safeParse(req.body);
		if (!parsed.success) return badRequest(res, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
		const [catalogue, { cells }] = await Promise.all([catalogueNow(), readAssignments(dir, log)]);
		const problems = musicReviewProblems(parsed.data, musicReviewSlots(catalogue.takes, cells));
		if (problems.length > 0) return badRequest(res, problems.join('; '));
		// The row is named by the submitter's own key; the edge stamps it on every vouched request.
		const key = userKeyOf(req);
		if (key === null) return res.status(403).json({ error: 'no user key on the request' });
		const record = { at: new Date().toISOString(), slots: parsed.data.slots };
		try {
			await reviews.save(key, record);
		} catch (err) {
			return prefsFailed(res, 'save', err);
		}
		log({ event: 'sounds-music-review-saved', userId: userIdOf(req), slots: Object.keys(record.slots).length });
		if (isAdmin(req)) {
			const applied = await withWriteLock(async () => {
				const stored = await readAssignments(dir, log);
				const changed = applyMusicReview(stored.cells, record.slots);
				if (Object.keys(changed).length === 0) return changed;
				Object.assign(stored.cells, changed);
				await writeAssignments(dir, stored);
				return changed;
			});
			for (const [cell, files] of Object.entries(applied)) log({ event: 'sounds-assignment-saved', cell, count: files.length, from: 'music-review' });
		}
		res.json(record);
	});

	sounds.get('/music-review/mine', async (req: Request, res: Response) => {
		try {
			res.json({ review: await reviews.mine(userIdOf(req)) });
		} catch (err) {
			prefsFailed(res, 'mine', err);
		}
	});

	sounds.get('/music-review', async (req: Request, res: Response) => {
		if (!isAdmin(req)) return res.status(403).json({ error: 'admin tier required' });
		try {
			res.json({ reviews: await reviews.all() });
		} catch (err) {
			prefsFailed(res, 'all', err);
		}
	});

	api.use('/sounds', sounds);

	// Any unexpected fs failure (a permissions error, not a missing file — those are handled above) lands here too.
	api.use('/sounds', bodyErrors((name) => log({ event: 'sounds-error', name })));
}
