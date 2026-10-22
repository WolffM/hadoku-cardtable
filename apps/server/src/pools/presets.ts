/**
 * `/api/pools/presets` — named custom draft plans, shared with the whole
 * group (`docs/planning/draft-pools-plan.md`'s Rulings 4/9, applied to a
 * preset the same way they apply to an imported cube: anyone saves and
 * anyone drafts from a preset, only the creator deletes).
 *
 *   GET    /api/pools/presets      → 200 DraftPreset[] (newest first)
 *   POST   /api/pools/presets      { name, plan } → 201 DraftPreset | 400
 *   DELETE /api/pools/presets/:id  → 204 | 403 | 404
 *
 * `createPresetStore` is the in-memory index E's `index.ts` builds once at
 * boot (this wave's wiring commit, after this lane lands) and hands to
 * `attachPresetRoutes` — the wire contract is
 * `docs/planning/wave74-2026-10-21.md`'s "Wire contract" section.
 *
 * ## Persistence
 *
 * One file, `data/presets.json` (the brief's own words: "the same data dir
 * as `data/cubes`"), holding every preset — unlike `cubes.ts`'s one file per
 * imported cube, because a preset is a small named `DraftPlan`, not a
 * resolved card list. Written atomically (temp file, then rename, same
 * discipline as `cubes.ts`'s `writeAtomic`) so a crash mid-write never
 * leaves a half-written file. The whole list is re-written on every change;
 * fine at the scale a friend group of named presets ever reaches.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, open, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import express, { type Request, type Response, type Router } from 'express';

import { DraftPresetSchema, SavePresetBodySchema, type DraftPlan, type DraftPreset } from '@hadoku/shared';
import { bodyErrors, httpCaller } from '../http/request.js';
import { jsonLogger } from '../log.js';

export interface PresetStore {
	list(): DraftPreset[];
	create(name: string, plan: DraftPlan, by: string): Promise<DraftPreset>;
	/** Throws a {@link PresetStoreRefusal}; never a silent no-op. */
	remove(id: string, by: string): Promise<void>;
}

/** A typed refusal `remove` throws — the HTTP status is already decided. */
export class PresetStoreRefusal extends Error {
	readonly status: 403 | 404;
	constructor(status: 403 | 404, message: string) {
		super(message);
		this.name = 'PresetStoreRefusal';
		this.status = status;
	}
}

const log = jsonLogger('cardtable-pools');

interface PresetsFile {
	presets?: unknown;
}

/** Re-validated against the real schema on every load — the D13-style control at the last point before a stored record is trusted. */
function isDraftPreset(value: unknown): value is DraftPreset {
	return DraftPresetSchema.safeParse(value).success;
}

/** Load `path`, or start empty on any fault (missing file, malformed JSON, a non-array `presets`) — same discipline as `cubes.ts`'s `loadShortlistFile`. */
function loadPresetsFile(path: string): DraftPreset[] {
	let text: string;
	try {
		text = readFileSync(path, 'utf8');
	} catch (err) {
		log({ evt: 'presets-load-failed', path, detail: (err as Error).message });
		return [];
	}
	let raw: PresetsFile;
	try {
		raw = JSON.parse(text) as PresetsFile;
	} catch (err) {
		log({ evt: 'presets-load-failed', path, detail: (err as Error).message });
		return [];
	}
	if (!Array.isArray(raw.presets)) {
		log({ evt: 'presets-load-failed', path, detail: 'expected { presets: [] }' });
		return [];
	}
	const presets: DraftPreset[] = [];
	let rejected = 0;
	for (const candidate of raw.presets) {
		if (isDraftPreset(candidate)) presets.push(candidate);
		else rejected++;
	}
	log({ evt: 'presets-loaded', path, presets: presets.length, rejected });
	return presets;
}

/** Temp file, then rename over the target — never a half-written presets file survives a crash. Same shape as `cubes.ts`'s `writeAtomic`. */
async function writeAtomic(target: string, data: unknown): Promise<void> {
	await mkdir(dirname(target), { recursive: true });
	const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
	const handle = await open(tmp, 'w');
	try {
		await handle.writeFile(JSON.stringify(data, null, 2));
	} finally {
		await handle.close();
	}
	await rename(tmp, target);
}

export interface CreatePresetStoreOpts {
	/** The full path to the one shared file, e.g. `join(CONFIG.dataDir, 'presets.json')`. */
	path: string;
}

export function createPresetStore(opts: CreatePresetStoreOpts): PresetStore {
	const { path } = opts;
	const presets = loadPresetsFile(path);

	const persist = (): Promise<void> => writeAtomic(path, { presets });

	return {
		list(): DraftPreset[] {
			return [...presets].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
		},

		async create(name: string, plan: DraftPlan, by: string): Promise<DraftPreset> {
			const preset: DraftPreset = {
				id: randomUUID(),
				name,
				plan,
				createdBy: by,
				createdAt: new Date().toISOString(),
			};
			presets.push(preset);
			await persist();
			return preset;
		},

		async remove(id: string, by: string): Promise<void> {
			const index = presets.findIndex((p) => p.id === id);
			if (index === -1) throw new PresetStoreRefusal(404, `no preset ${JSON.stringify(id)}`);
			const preset = presets[index];
			if (preset === undefined || preset.createdBy !== by) {
				throw new PresetStoreRefusal(403, 'only the creator may delete this preset');
			}
			presets.splice(index, 1);
			await persist();
		},
	};
}

function refusalStatus(res: Response, err: unknown): void {
	if (err instanceof PresetStoreRefusal) {
		res.status(err.status).json({ error: err.message });
		return;
	}
	throw err;
}

export interface AttachPresetRoutesDeps {
	store: PresetStore;
	log?: (entry: Record<string, unknown>) => void;
}

/**
 * Mounted by E's `index.ts` on the `api` router, the way `cubes.ts`'s
 * `attachCubeRoutes` is — this is the function name the wave file's "Wire
 * contract" names for E's wiring commit.
 */
export function attachPresetRoutes(api: Router, deps: AttachPresetRoutesDeps): void {
	const { store } = deps;
	const warn = deps.log ?? log;
	const presets = express.Router();
	presets.use(express.json({ limit: '8kb' }));

	presets.get('/', (_req: Request, res: Response) => {
		res.json(store.list());
	});

	presets.post('/', (req: Request, res: Response) => {
		const parsed = SavePresetBodySchema.safeParse(req.body);
		if (!parsed.success) {
			res.status(400).json({ error: 'body is { name: 1-60 chars, plan: DraftPlan }' });
			return;
		}
		const caller = httpCaller(req);
		store
			.create(parsed.data.name, parsed.data.plan, caller)
			.then((preset) => res.status(201).json(preset))
			.catch((err: unknown) => {
				warn({ evt: 'preset-create-failed', detail: (err as Error).message });
				res.status(400).json({ error: (err as Error).message });
			});
	});

	presets.delete('/:id', (req: Request, res: Response) => {
		const id = String(req.params.id);
		const caller = httpCaller(req);
		store
			.remove(id, caller)
			.then(() => res.status(204).end())
			.catch((err: unknown) => {
				try {
					refusalStatus(res, err);
				} catch {
					warn({ evt: 'preset-delete-failed', id, detail: (err as Error).message });
					res.status(400).json({ error: (err as Error).message });
				}
			});
	});

	api.use('/pools/presets', presets);
	api.use('/pools/presets', bodyErrors());
}
