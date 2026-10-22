/**
 * Keep `catalog.ts`'s card data current with Scryfall's daily bulk file, with
 * no restart.
 *
 * The Scryfall sync under the catalog was frozen 2026-09-15
 * (`packages/carddata/data/manifest.json`): any set released after that has
 * no card text, and every source with a later card is refused for
 * `missingText` (`room/plan.ts`'s verdict). This job is how that stops being
 * true without a deploy.
 *
 * Once at boot and every 24 h:
 *
 *   1. `sync()` (`@hadoku/carddata`, already exported, already network-safe —
 *      it throws rather than exits) against `scryfallDir`. It does its own
 *      ONE paced `fetchBulkListing()` call and compares the result's
 *      `updated_at` against the LOCAL manifest at `scryfallDir`; `upToDate`
 *      answers "older or equal" directly, so there is nothing else to check.
 *   2. `upToDate` → nothing. This is the common case on every run but the
 *      first after a real Scryfall release.
 *   3. Not up to date → `sync()` already downloaded the fresh `cards.jsonl`
 *      into `scryfallDir`. Rebuild the catalog from it with `runBuildCatalog`
 *      (`@hadoku/carddata`) to a TEMP path beside `catalogPath`, then rename
 *      into place — the same temp-then-rename discipline `cubes.ts`'s
 *      `writeAtomic` uses, so a crash mid-rebuild never leaves a half-written
 *      catalog where the server (or the next refresh) would find it.
 *   4. `catalog.swap(catalogPath)` — reload the just-renamed file and flip
 *      every holder of the `CardCatalog` object onto it, with no restart
 *      (`catalog.ts`'s own header).
 *   5. Call `onSwap()` — the injected hook, not this file's job: wave 74 §E's
 *      verdict cache (`room/plan.ts`) owns which of its cached `PoolVerdict`s
 *      have a non-empty `missingText`, and clears exactly those, so a source
 *      refused for missing text can pass on its next check. This file knows
 *      nothing about verdicts; it just calls the hook after a real swap.
 *
 * One run at a time (`running`): the 24 h timer and an operator-triggered run
 * (not built yet; the hook is `runOnce`) can never overlap. Every run logs
 * `catalog-refresh-start` then exactly one of `catalog-refresh-finish` /
 * `catalog-refresh-fault` — never a throw past this module's boundary, so a
 * bad Scryfall response or a bad local disk can never take the server down
 * with it. A fault at ANY stage (the sync, the rebuild, the swap) leaves
 * `catalogPath` and the live `catalog` exactly as they were.
 *
 * `rebuild`'s peak RSS measured locally at ~1.03 GB for the full 2026-09-15
 * cache (118,026 printings) — see this lane's closing note — comfortably
 * under the 2 GB figure the brief named for moving this to a child process,
 * so it runs on the server's own heap.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

import { runBuildCatalog, sync, type RunBuildCatalogOptions, type RunBuildCatalogResult, type SyncOptions, type SyncResult } from '@hadoku/carddata';
import { jsonLogger } from '../log.js';
import type { CardCatalog } from './catalog.ts';

const log = jsonLogger('cardtable-pools');

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface CreateCatalogRefreshOpts {
	/** The live catalog object held by every reader (`index.ts`'s `createCubeStore` call, `room/plan.ts`'s checker, …). */
	catalog: CardCatalog;
	/** Where the Scryfall bulk cache lives — `CARDTABLE_SCRYFALL_DIR`, default `~/.local/share/cardtable/scryfall`. Shared with land.sh; never the lane's own fixture dir outside a test. */
	scryfallDir: string;
	/** Where the live catalog file lives — `CONFIG.catalogPath`. Rebuilt to a sibling temp file first, then renamed here. */
	catalogPath: string;
	/** Called once, only after a real swap. Clearing missing-text verdicts is the caller's cache's job, not this file's. */
	onSwap?: () => void;
	/** Injectable for a test; default `sync` from `@hadoku/carddata`. Never let a test call the real one — it hits the network. */
	syncFn?: (options: SyncOptions) => Promise<SyncResult>;
	/** Injectable for a test; default `runBuildCatalog` from `@hadoku/carddata`. */
	buildFn?: (options: RunBuildCatalogOptions) => Promise<RunBuildCatalogResult>;
	log?: (entry: Record<string, unknown>) => void;
}

export interface CatalogRefreshOutcome {
	/** False only when a run was already in flight; the caller's trigger was dropped, not queued. */
	ran: boolean;
	/** True only after a real `catalog.swap()`. */
	changed: boolean;
	/** The fault's message, or null. A fault never throws past `runOnce`. */
	fault: string | null;
}

export interface CatalogRefresh {
	/** Run now. Concurrency-guarded: a run already in flight answers `{ ran: false, ... }` immediately rather than queuing. */
	runOnce(): Promise<CatalogRefreshOutcome>;
	/** Run once immediately, then every `intervalMs` (default 24 h). Returns a function that stops the timer (no further runs; an in-flight one still finishes). */
	start(intervalMs?: number): () => void;
}

/**
 * Build the refresh job. Nothing here reads `process.env` or `CONFIG` —
 * every path and hook is a parameter, so `index.ts` (E's wiring commit)
 * decides them the same way it already decides `createCubeStore`'s.
 */
export function createCatalogRefresh(opts: CreateCatalogRefreshOpts): CatalogRefresh {
	const { catalog, scryfallDir, catalogPath, onSwap } = opts;
	const syncFn = opts.syncFn ?? sync;
	const buildFn = opts.buildFn ?? runBuildCatalog;
	const warn = opts.log ?? log;

	let running = false;

	async function runOnce(): Promise<CatalogRefreshOutcome> {
		if (running) {
			warn({ evt: 'catalog-refresh-skipped', reason: 'already running' });
			return { ran: false, changed: false, fault: null };
		}
		running = true;
		warn({ evt: 'catalog-refresh-start', scryfallDir, catalogPath });

		try {
			let syncResult: SyncResult;
			try {
				syncResult = await syncFn({ outDir: scryfallDir, bulkType: 'default_cards' });
			} catch (err) {
				const detail = (err as Error).message;
				warn({ evt: 'catalog-refresh-fault', stage: 'sync', detail });
				return { ran: true, changed: false, fault: detail };
			}

			if (syncResult.upToDate) {
				warn({ evt: 'catalog-refresh-finish', changed: false, reason: 'up-to-date', sourceUpdatedAt: syncResult.manifest.sourceUpdatedAt });
				return { ran: true, changed: false, fault: null };
			}

			const tmpPath = `${catalogPath}.${process.pid}.${randomUUID()}.tmp`;
			let built: RunBuildCatalogResult;
			try {
				built = await buildFn({ dataDir: scryfallDir, outPath: tmpPath });
			} catch (err) {
				const detail = (err as Error).message;
				warn({ evt: 'catalog-refresh-fault', stage: 'build', detail });
				await rm(tmpPath, { force: true }).catch(() => {});
				return { ran: true, changed: false, fault: detail };
			}

			try {
				await mkdir(dirname(catalogPath), { recursive: true });
				await rename(built.outPath, catalogPath);
			} catch (err) {
				const detail = (err as Error).message;
				warn({ evt: 'catalog-refresh-fault', stage: 'rename', detail });
				await rm(tmpPath, { force: true }).catch(() => {});
				return { ran: true, changed: false, fault: detail };
			}

			const swapped = catalog.swap(catalogPath);
			if (!swapped) {
				// `catalog.swap` already logged `catalog-swap-faulted`; this just adds
				// the refresh's own framing. The RENAMED file is now what `catalogPath`
				// holds — the next boot (a fresh `loadCardCatalog`) picks it up even if
				// this in-process swap somehow failed, so nothing is lost permanently.
				warn({ evt: 'catalog-refresh-fault', stage: 'swap' });
				return { ran: true, changed: false, fault: 'catalog.swap reported a fault' };
			}

			onSwap?.();
			warn({ evt: 'catalog-refresh-finish', changed: true, cardCount: built.cardCount, aliasCount: built.aliasCount, sourceUpdatedAt: syncResult.manifest.sourceUpdatedAt });
			return { ran: true, changed: true, fault: null };
		} finally {
			running = false;
		}
	}

	function start(intervalMs: number = DEFAULT_INTERVAL_MS): () => void {
		void runOnce();
		const timer = setInterval(() => void runOnce(), intervalMs);
		return () => clearInterval(timer);
	}

	return { runOnce, start };
}
