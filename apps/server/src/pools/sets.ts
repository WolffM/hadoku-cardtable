/**
 * `/api/pools/sets` — the set half of a draft room's pool picker: every set
 * Forge has a draft booster template for (ruling 8), searchable, newest
 * first, each with the set-cube size and a cached playability verdict.
 *
 *   GET /api/pools/sets → 200 SetSummary[]
 *
 * This is the whole of the route; `verdict` is read from THIS module's own
 * cache and never triggers a check — "`verdict` comes from cache only;
 * listing never triggers a check" (`docs/planning/wave74-2026-10-21.md`'s
 * Wire contract). A leader actually picking the source is what warms the
 * cache, through `room/plan.ts`'s `checkSource` calling `cardsFor` below (the
 * SAME function this module's own listing reads `cards`'s COUNT from).
 *
 * `forge.ts` already exports its own Forge-side `SetSummary` (code, name,
 * date, type — no `cards`/`verdict`, those are this wave's wire addition) —
 * imported here under an alias (`ForgeSetSummary`) and mapped, per the wave
 * file's own instruction. `forge.ts` is unowned this wave (stable, landed in
 * wave 73); this file only reads its exported types, never edits it.
 *
 * ## `cardsFor`: the land/DFC slot `setCards` alone would miss
 *
 * `forge.setCards(code)` is Forge's `CardEdition.getAllCardsInSet()`, minus
 * basics — the Design's own definition of set-cube size. But a REALISTIC
 * pack's land/DFC slot (Innistrad's double-faced cards, ruling 1's own
 * example) can come from a sheet `getAllCardsInSet()` does not enumerate at
 * all; the wave file's own words are "every name Forge's booster template
 * CAN emit for that set, so the land slot and DFC slot are covered." There is
 * no third `ForgePools` method that lists those sheets analytically, so this
 * samples: a deterministic, fixed-seed run of `boosters` whose packs' names
 * are unioned onto `setCards`'s own list before either style's verdict is
 * checked. `SAMPLE_BOOSTERS` is a judgment call, not a spec number — large
 * enough to see a GUARANTEED per-pack slot (Innistrad's DFC) reliably, too
 * small to make every set's first check a slow Forge round-trip.
 *
 * ## Caching
 *
 * Every cache here is in-memory and keyed by `code` alone (never by style —
 * realistic and set-cube of the same code need the exact same names
 * checked, so they share one verdict), and lives for the process's life —
 * the same assumption `pools/cubes.ts`'s own verdict cache already makes: a
 * Forge jar swap restarts this process (`docs/WAVE_WORKTREE.md`,
 * `prod-jar-switch-is-operators.md`), so "per (code, Forge pin)" and
 * "for this process's life" are the same cache. `clearMissingTextVerdicts`
 * is this module's own hook for `pools/refresh.ts` (G, wave 74 §G step 2):
 * a catalog swap can turn a `missingText` refusal into a pass, so every
 * cached verdict that was refused for missing text is dropped on a swap —
 * `index.ts` wires the call once G's refresh job exists (wave 74 §E step 5).
 */

import type { DraftCard, PoolVerdict, SetSummary } from '@hadoku/shared';
import express, { type Request, type Response, type Router } from 'express';
import type { BoosterCard, SetSummary as ForgeSetSummary } from './forge.js';
import { jsonLogger } from '../log.js';

/** The slice of D's `ForgePools` this module consumes — structural, like `room/plan.ts`'s own `ForgeChecker`. */
export interface SetsForge {
	sets(): Promise<ForgeSetSummary[]>;
	setCards(code: string): Promise<string[]>;
	boosters(code: string, count: number, seed: string): Promise<BoosterCard[][]>;
}

/** The slice of G's `CardCatalog` this module consumes — `byName` only; set sources carry no printing until `deal()` maps a realistic pack through `byPrinting` (`room/draftRooms.ts`'s own concern, not this store's). */
export interface CatalogLookup {
	byName(name: string): DraftCard | null;
}

export interface SetsStore {
	/** `GET /api/pools/sets` — every draftable set, newest first, each with its cached verdict and set-cube size. `[]` without a jar. */
	list(): Promise<SetSummary[]>;
	/**
	 * A set's own display name — `null` for a code `list()` has never seen
	 * (including: no jar, or `list()` has not run yet). Synchronous:
	 * `room/draftRooms.ts`'s `PoolSourceResolver.name` needs this with no
	 * await, and `index.ts` warms it with one `await store.list()` at boot.
	 */
	nameOf(code: string): string | null;
	/**
	 * Every card a code's styles could draw, resolved through the catalog by
	 * name — `setCards`'s non-basic singletons unioned with a booster sample
	 * (see this file's header). `typeLine: ''` marks a name the catalog could
	 * not resolve (`missingText`, same signal `pools/cubes.ts` uses). `null`
	 * for an unknown code or when Forge cannot answer at all. Cached.
	 */
	cardsFor(code: string): Promise<readonly DraftCard[] | null>;
	/** `cardsFor`'s own cache, read synchronously — `null` if it has never resolved (or was asked and failed). `room/draftRooms.ts`'s set-cube `PoolSourceResolver.cards` reads this: by the time a plan naming this source was ever ACCEPTED, `checkSource` already warmed it. */
	cachedCards(code: string): readonly DraftCard[] | null;
	cachedVerdict(code: string): PoolVerdict | null;
	setVerdict(code: string, verdict: PoolVerdict): void;
	/** `pools/refresh.ts`'s hook: drop every cached verdict that was refused for `missingText`, so a set a refresh just gave text to can pass on the next pick. */
	clearMissingTextVerdicts(): void;
}

const DEFAULT_SAMPLE_BOOSTERS = 24;

const log = jsonLogger('cardtable-pools');

export interface CreateSetsStoreOpts {
	forge: SetsForge | null;
	catalog: CatalogLookup;
	sampleBoosters?: number;
	log?: (entry: Record<string, unknown>) => void;
}

export function createSetsStore(opts: CreateSetsStoreOpts): SetsStore {
	const warn = opts.log ?? log;
	const sampleBoosters = opts.sampleBoosters ?? DEFAULT_SAMPLE_BOOSTERS;

	const nameCache = new Map<string, string>();
	const cardsCache = new Map<string, readonly DraftCard[] | null>();
	const verdictCache = new Map<string, PoolVerdict>();
	let listCache: SetSummary[] | null = null;
	let listPromise: Promise<SetSummary[]> | null = null;

	function missingTextCard(name: string, code: string): DraftCard {
		return {
			cardId: `set:${code}:${name}`,
			name,
			manaCost: [],
			manaValue: 0,
			colors: [],
			typeLine: '',
			oracleText: '',
			setCode: code,
			collectorNumber: '0',
			rarity: 'special',
		};
	}

	async function resolveCards(code: string): Promise<readonly DraftCard[] | null> {
		const forge = opts.forge;
		if (forge === null) return null;
		let setNames: string[];
		try {
			setNames = await forge.setCards(code);
		} catch (err) {
			warn({ evt: 'set-cards-failed', code, detail: (err as Error).message });
			return null;
		}
		let boosterNames: string[] = [];
		try {
			const boosters = await forge.boosters(code, sampleBoosters, `verdict:${code}`);
			boosterNames = boosters.flat().map((c) => c.name);
		} catch (err) {
			// No draft booster template for this set, or a transient JVM fault —
			// `setNames` alone still answers the question for a set-cube-only
			// source; a realistic pick of this same code will fail loudly on its
			// own `boosters` call later, which is the honest place for that error.
			warn({ evt: 'set-booster-sample-failed', code, detail: (err as Error).message });
		}
		const names = Array.from(new Set([...setNames, ...boosterNames]));
		return names.map((name) => opts.catalog.byName(name) ?? missingTextCard(name, code));
	}

	return {
		async list() {
			if (listCache !== null) return listCache;
			if (listPromise !== null) return listPromise;
			if (opts.forge === null) {
				listCache = [];
				return listCache;
			}
			const forge = opts.forge;
			listPromise = (async () => {
				const sets = await forge.sets();
				const sorted = [...sets].sort((a, b) => b.date.localeCompare(a.date));
				const out: SetSummary[] = [];
				for (const s of sorted) {
					nameCache.set(s.code, s.name);
					const cards = await resolveCards(s.code);
					cardsCache.set(s.code, cards);
					out.push({
						code: s.code,
						name: s.name,
						date: s.date,
						type: s.type,
						cards: cards?.length ?? 0,
						verdict: verdictCache.get(s.code) ?? null,
					});
				}
				listCache = out;
				return out;
			})().finally(() => {
				// Cleared whether this attempt succeeded or failed: a failure must
				// not wedge every later `list()` call behind one dead promise — the
				// next call is a fresh attempt (`listCache` staying `null` is what
				// makes that happen above).
				listPromise = null;
			});
			return listPromise;
		},
		nameOf(code) {
			return nameCache.get(code) ?? null;
		},
		async cardsFor(code) {
			const cached = cardsCache.get(code);
			if (cached !== undefined) return cached;
			const cards = await resolveCards(code);
			cardsCache.set(code, cards);
			return cards;
		},
		cachedCards(code) {
			return cardsCache.get(code) ?? null;
		},
		cachedVerdict(code) {
			return verdictCache.get(code) ?? null;
		},
		setVerdict(code, verdict) {
			verdictCache.set(code, verdict);
		},
		clearMissingTextVerdicts() {
			for (const [code, verdict] of verdictCache) {
				if (!verdict.ok && verdict.missingText.length > 0) verdictCache.delete(code);
			}
		},
	};
}

export interface AttachSetRoutesDeps {
	store: SetsStore;
	log?: (entry: Record<string, unknown>) => void;
}

/** Mounted by `index.ts` on the `api` router, beside `attachCubeRoutes`. */
export function attachSetRoutes(api: Router, deps: AttachSetRoutesDeps): void {
	const warn = deps.log ?? log;
	const sets = express.Router();

	sets.get('/', (_req: Request, res: Response) => {
		deps.store
			.list()
			.then((list) => res.json(list))
			.catch((err: unknown) => {
				warn({ evt: 'sets-list-failed', detail: (err as Error).message });
				res.status(503).json({ error: 'the pool service is not available to list sets' });
			});
	});

	api.use('/pools/sets', sets);
}
