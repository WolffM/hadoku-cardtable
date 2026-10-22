/**
 * `createCatalogRefresh` against FAKE `syncFn`/`buildFn` — never the real
 * `sync()` (network) or `runBuildCatalog` (a real 176 MB cache). Acceptance 3
 * (`docs/planning/wave74-2026-10-21.md`): given a fake bulk listing newer
 * than the manifest, downloads (here: the fake sync), rebuilds and swaps
 * the catalog with no restart; given an older or equal one, nothing; given a
 * failed download, the old catalog is kept and the fault is logged.
 *
 * `catalog` is the REAL `loadCardCatalog`, pointed at a real file in the
 * lane's scratch dir — so a passing "swapped" assertion here proves
 * `refresh.ts` and `catalog.ts`'s `swap` actually work together, not just
 * that `runOnce` returns the right flags.
 */

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RunBuildCatalogOptions, RunBuildCatalogResult, SyncOptions, SyncResult } from '@hadoku/carddata';
import { loadCardCatalog } from './catalog.ts';
import { createCatalogRefresh } from './refresh.ts';

const BOLT = {
	cardId: 'lightning bolt',
	name: 'Lightning Bolt',
	manaCost: ['R'],
	manaValue: 1,
	colors: ['R'],
	typeLine: 'Instant',
	oracleText: 'Lightning Bolt deals 3 damage to any target.',
	setCode: 'LEA',
	collectorNumber: '161',
	rarity: 'common',
};

const DELVER = {
	cardId: 'delver of secrets // insectile aberration',
	name: 'Delver of Secrets // Insectile Aberration',
	manaCost: ['U'],
	manaValue: 1,
	colors: ['U'],
	typeLine: 'Creature — Human Wizard',
	oracleText: 'At the beginning of your upkeep, look at the top card of your library...',
	setCode: 'ISD',
	collectorNumber: '51',
	rarity: 'common',
	power: '1',
	toughness: '1',
};

function manifestResult(overrides: Partial<SyncResult> & { upToDate: boolean }): SyncResult {
	return {
		upToDate: overrides.upToDate,
		outDir: overrides.outDir ?? '/scryfall',
		manifest: {
			bulkType: 'default_cards',
			sourceUpdatedAt: overrides.manifest?.sourceUpdatedAt ?? '2026-10-22T00:00:00Z',
			ingestedAt: '2026-10-22T00:00:01Z',
			cardCount: overrides.manifest?.cardCount ?? 1,
			limit: null,
			skippedLines: 0,
		},
	};
}

describe('createCatalogRefresh', () => {
	let dir: string;
	let catalogPath: string;
	let scryfallDir: string;
	let logs: Record<string, unknown>[];
	const log = (entry: Record<string, unknown>): void => {
		logs.push(entry);
	};

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'refresh-test-'));
		scryfallDir = join(dir, 'scryfall');
		catalogPath = join(dir, 'catalog', 'cards.json');
		logs = [];
		// catalog.ts has no mkdir-on-write of its own load path; give it a real file to start from.
		await mkdir(join(dir, 'catalog'), { recursive: true });
		await writeFile(catalogPath, JSON.stringify({ cards: { 'lightning bolt': BOLT }, aliases: {} }), 'utf8');
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it('a fake bulk listing newer than the manifest: downloads, rebuilds, and swaps with no restart', async () => {
		const catalog = loadCardCatalog(catalogPath);
		expect(catalog.byName('Delver of Secrets')).toBeNull();

		const syncFn = vi.fn(async (_options: SyncOptions): Promise<SyncResult> => manifestResult({ upToDate: false }));
		const buildFn = vi.fn(async (options: RunBuildCatalogOptions): Promise<RunBuildCatalogResult> => {
			await writeFile(
				options.outPath as string,
				JSON.stringify({ cards: { 'delver of secrets // insectile aberration': DELVER }, aliases: { 'delver of secrets': 'delver of secrets // insectile aberration' } }),
				'utf8',
			);
			return { outPath: options.outPath as string, cardCount: 1, aliasCount: 1, printings: 1 };
		});
		const onSwap = vi.fn();

		const refresh = createCatalogRefresh({ catalog, scryfallDir, catalogPath, syncFn, buildFn, onSwap, log });
		const outcome = await refresh.runOnce();

		expect(outcome).toEqual({ ran: true, changed: true, fault: null });
		expect(syncFn).toHaveBeenCalledWith({ outDir: scryfallDir, bulkType: 'default_cards' });
		// The catalog object held before the refresh now answers the NEW data — no reload by the caller.
		expect(catalog.byName('Delver of Secrets')?.name).toBe('Delver of Secrets // Insectile Aberration');
		expect(catalog.byName('Lightning Bolt')).toBeNull();
		expect(onSwap).toHaveBeenCalledTimes(1);

		// The rename landed at catalogPath, and no temp file is left behind.
		const onDisk = JSON.parse(await readFile(catalogPath, 'utf8')) as { cards: Record<string, unknown> };
		expect(onDisk.cards['delver of secrets // insectile aberration']).toBeDefined();
		const leftovers = (await readdir(join(dir, 'catalog'))).filter((f) => f.endsWith('.tmp'));
		expect(leftovers).toEqual([]);
	});

	it('an older or equal bulk listing: does nothing (no rebuild, no swap)', async () => {
		const catalog = loadCardCatalog(catalogPath);
		const syncFn = vi.fn(async (): Promise<SyncResult> => manifestResult({ upToDate: true }));
		const buildFn = vi.fn();
		const onSwap = vi.fn();

		const refresh = createCatalogRefresh({ catalog, scryfallDir, catalogPath, syncFn, buildFn, onSwap, log });
		const outcome = await refresh.runOnce();

		expect(outcome).toEqual({ ran: true, changed: false, fault: null });
		expect(buildFn).not.toHaveBeenCalled();
		expect(onSwap).not.toHaveBeenCalled();
		expect(catalog.byName('Lightning Bolt')?.name).toBe('Lightning Bolt');
	});

	it('a failed download: keeps the old catalog and logs the fault', async () => {
		const catalog = loadCardCatalog(catalogPath);
		const syncFn = vi.fn(async (): Promise<SyncResult> => {
			throw new Error('Scryfall answered 503');
		});
		const buildFn = vi.fn();
		const onSwap = vi.fn();

		const refresh = createCatalogRefresh({ catalog, scryfallDir, catalogPath, syncFn, buildFn, onSwap, log });
		const outcome = await refresh.runOnce();

		expect(outcome.ran).toBe(true);
		expect(outcome.changed).toBe(false);
		expect(outcome.fault).toMatch(/503/);
		expect(buildFn).not.toHaveBeenCalled();
		expect(onSwap).not.toHaveBeenCalled();
		expect(catalog.byName('Lightning Bolt')?.name).toBe('Lightning Bolt');
		expect(logs.some((l) => l.evt === 'catalog-refresh-fault' && l.stage === 'sync')).toBe(true);
	});

	it('a failed rebuild: keeps the old catalog, logs the fault, and leaves no temp file', async () => {
		const catalog = loadCardCatalog(catalogPath);
		const syncFn = vi.fn(async (): Promise<SyncResult> => manifestResult({ upToDate: false }));
		const buildFn = vi.fn(async (): Promise<RunBuildCatalogResult> => {
			throw new Error('No card cache at /scryfall/cards.jsonl');
		});
		const onSwap = vi.fn();

		const refresh = createCatalogRefresh({ catalog, scryfallDir, catalogPath, syncFn, buildFn, onSwap, log });
		const outcome = await refresh.runOnce();

		expect(outcome).toEqual({ ran: true, changed: false, fault: 'No card cache at /scryfall/cards.jsonl' });
		expect(onSwap).not.toHaveBeenCalled();
		expect(catalog.byName('Lightning Bolt')?.name).toBe('Lightning Bolt');
		const leftovers = (await readdir(join(dir, 'catalog'))).filter((f) => f.endsWith('.tmp'));
		expect(leftovers).toEqual([]);
	});

	it('one run at a time: an overlapping call is dropped, not queued', async () => {
		const catalog = loadCardCatalog(catalogPath);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const syncFn = vi.fn(async (): Promise<SyncResult> => {
			await gate;
			return manifestResult({ upToDate: true });
		});

		const refresh = createCatalogRefresh({ catalog, scryfallDir, catalogPath, syncFn, buildFn: vi.fn(), log });
		const first = refresh.runOnce();
		const second = await refresh.runOnce();
		expect(second).toEqual({ ran: false, changed: false, fault: null });

		release();
		const firstOutcome = await first;
		expect(firstOutcome.ran).toBe(true);
	});

	it('a swap fault (catalog.swap stubbed to no-op, returning false) is reported and nothing is lost: the renamed file still lands at catalogPath', async () => {
		const catalog = loadCardCatalog(catalogPath);
		// Stand in for the mutation "make swap a no-op": a catalog whose own
		// swap() never updates its data and reports failure, exactly what
		// catalog.ts's swap() does on a fault. If catalog.ts's real swap were
		// mutated to a no-op that still reported `true`, this refresh test
		// would NOT catch it from the outcome alone — which is why the first
		// test above also asserts byName() on the SAME catalog object
		// afterwards, not just the returned outcome.
		const noopCatalog = { ...catalog, swap: (): boolean => false };
		const syncFn = vi.fn(async (): Promise<SyncResult> => manifestResult({ upToDate: false }));
		const buildFn = vi.fn(async (options: RunBuildCatalogOptions): Promise<RunBuildCatalogResult> => {
			await writeFile(options.outPath as string, JSON.stringify({ cards: { 'delver of secrets // insectile aberration': DELVER }, aliases: {} }), 'utf8');
			return { outPath: options.outPath as string, cardCount: 1, aliasCount: 0, printings: 1 };
		});
		const onSwap = vi.fn();

		const refresh = createCatalogRefresh({ catalog: noopCatalog, scryfallDir, catalogPath, syncFn, buildFn, onSwap, log });
		const outcome = await refresh.runOnce();

		expect(outcome).toEqual({ ran: true, changed: false, fault: 'catalog.swap reported a fault' });
		expect(onSwap).not.toHaveBeenCalled();
		// The rename to catalogPath already happened before the swap call, so the
		// file on disk is the NEW data even though the in-process swap "failed" —
		// a fresh boot (a real loadCardCatalog of catalogPath) would pick it up.
		const onDisk = JSON.parse(await readFile(catalogPath, 'utf8')) as { cards: Record<string, unknown> };
		expect(onDisk.cards['delver of secrets // insectile aberration']).toBeDefined();
	});

	it('start() runs once immediately and then on the given interval; the returned stop function stops it', async () => {
		vi.useFakeTimers();
		try {
			const catalog = loadCardCatalog(catalogPath);
			const syncFn = vi.fn(async (): Promise<SyncResult> => manifestResult({ upToDate: true }));
			const refresh = createCatalogRefresh({ catalog, scryfallDir, catalogPath, syncFn, buildFn: vi.fn(), log });

			const stop = refresh.start(1000);
			await vi.advanceTimersByTimeAsync(0);
			expect(syncFn).toHaveBeenCalledTimes(1);

			await vi.advanceTimersByTimeAsync(1000);
			expect(syncFn).toHaveBeenCalledTimes(2);

			stop();
			await vi.advanceTimersByTimeAsync(5000);
			expect(syncFn).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});
});
