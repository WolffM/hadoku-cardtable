/**
 * `/api/trim` — the site's trim, one look for every player (the operator, 2026-10-21: "make it set
 * the look for every player").
 *
 *   GET /api/trim   → 200 { trim: Record<family, option> | null, canEdit }   (friend tier)
 *   PUT /api/trim   { trim } → 200 { trim } | 400 | 403                       (admin)
 *
 * `trim: null` is "never set": the client draws its own default. The catalogue of families and
 * options is the UI's (`apps/ui/src/settings/trim.ts`), which draws only what it knows; this
 * stores a small map of names and checks its shape, nothing more. One file, written atomically.
 */

import { readFile } from 'node:fs/promises';
import type { Request, Response } from 'express';
import { Router } from 'express';

import { rankOf, tierOf } from '../edge-auth.js';
import { jsonLogger, type JsonLog } from '../log.js';
import { bodyErrors } from './request.js';
import { atomicWriteJson } from './sounds.js';

export interface TrimDeps {
	/** The file the site's trim is kept in. Created on the first PUT, never on a read. */
	file: string;
	log?: JsonLog;
}

type Trim = Record<string, string>;

const FAMILY = /^[a-z][a-zA-Z]{0,31}$/;
const OPTION = /^[a-z][a-z-]{0,31}$/;
const MAX_FAMILIES = 16;

/** A trim map, or `null` for anything that is not one. */
export function parseTrim(value: unknown): Trim | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
	const entries = Object.entries(value);
	if (entries.length > MAX_FAMILIES) return null;
	for (const [family, option] of entries) {
		if (!FAMILY.test(family) || typeof option !== 'string' || !OPTION.test(option)) return null;
	}
	return Object.fromEntries(entries) as Trim;
}

async function readTrim(file: string, log: JsonLog): Promise<Trim | null> {
	let raw: string;
	try {
		raw = await readFile(file, 'utf8');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw err;
	}
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		log({ event: 'trim-file-corrupt', reason: 'invalid JSON' });
		return null;
	}
	const trim = parseTrim((json as { trim?: unknown } | null)?.trim);
	if (trim === null) log({ event: 'trim-file-corrupt', reason: 'not a trim' });
	return trim;
}

export function attachTrim(api: Router, deps: TrimDeps): void {
	const { file } = deps;
	const log = deps.log ?? jsonLogger('cardtable-trim');
	const trim = Router();

	trim.get('/', async (req: Request, res: Response) => {
		res.json({ trim: await readTrim(file, log), canEdit: rankOf(tierOf(req)) >= rankOf('admin') });
	});

	trim.put('/', async (req: Request, res: Response) => {
		if (rankOf(tierOf(req)) < rankOf('admin')) return res.status(403).json({ error: 'admin tier required' });
		const next = parseTrim((req.body as { trim?: unknown } | undefined)?.trim);
		if (next === null) return res.status(400).json({ error: 'trim must be a map of family names to option names' });
		await atomicWriteJson(file, { trim: next });
		log({ event: 'trim-saved', trim: JSON.stringify(next) });
		return res.json({ trim: next });
	});

	api.use('/trim', trim);
	api.use('/trim', bodyErrors((name) => log({ event: 'trim-error', name })));
}
