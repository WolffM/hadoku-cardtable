/**
 * The tables and everything a table's deck comes from: table actions, the featured match, the
 * deck library and the deck gate, drafts and decks, the cube, set and preset pickers, Rally's
 * catalogues, and the catalog's daily refresh.
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { jsonLogger } from '@hadoku/service-kernel/log';
import { CONFIG } from '../config.js';
import { attachDecks } from '../http/decks.js';
import { attachDrafts } from '../http/drafts.js';
import { attachTables } from '../http/index.js';
import { attachRally } from '../http/rally.js';
import { rallySymbols } from '../http/rally-symbols.js';
import { attachTableActions } from '../http/table-actions.js';
import { createFeatured, featuredCandidates } from '../play/index.js';
import { attachCubeRoutes } from '../pools/cubes.js';
import { attachPresetRoutes, createPresetStore } from '../pools/presets.js';
import { createCatalogRefresh } from '../pools/refresh.js';
import { attachSetRoutes } from '../pools/sets.js';
import { checkCards } from '../room/plan.js';
import type { CardtablePlugin } from './state.js';

export const tablesPlugin: CardtablePlugin = {
	name: 'tables',
	phase: 'routes',
	setup(ctx) {
		const { api, state } = ctx;
		const { lobby, draftRooms } = state;
		// A table's game resolved from its card: concede, abandon, drop match (`http/table-actions.ts`).
		attachTableActions(api, { lobby, match: (id) => state.play?.matches.get(id), seriesEnded: (roomId, tableId) => state.tables.seriesEnded(roomId, tableId) });

		// The front page's featured match. Built before play, whose `liveChanged` re-picks it; its
		// candidates are read from play when asked.
		state.featured = createFeatured({
			candidates: (now) => featuredCandidates(state.play?.matches.active() ?? [], (id) => lobby.roomOfMatch(id), now),
			// A new pick changes what the room list says: the feed pings list followers on any room's change.
			changed: (previous, next) => {
				for (const pick of [previous, next]) if (pick !== null) state.roomFeed.changed(pick.roomId);
			},
		});
		// Formats, the deck library, and the deck gate on POST /api/play/matches. MUST come before play:
		// the gate is a handler on play's own path and runs only if it is registered first
		// (src/http/README.md). `matches` is read when asked, since play is attached later.
		state.tables = attachTables(api, { library: state.library, draftRooms, rooms: lobby, matches: () => state.play?.matches ?? null });
		// A drafter's own pool and the build saved against it.
		attachDrafts(api, { draftRooms });
		// Every finished draft as the drafter's deck.
		attachDecks(api, { draftRooms, room: (id) => lobby.get(id) });
		// The cube picker: the shortlist plus any Cube Cobra import, re-verified fresh at import and at
		// refresh with the same `checkCards` `room/plan.ts` runs.
		attachCubeRoutes(api, { store: state.cubeStore, check: (cards) => checkCards(cards, state.forgePools, { uncheckedWithoutJar: CONFIG.testUncheckedPools }) });
		// Every set Forge can draft, newest first, each with its set-cube size and a cache-only verdict.
		attachSetRoutes(api, { store: state.setsStore });
		// Named custom plans, shared with the group, in `data/presets.json`.
		state.presetStore = createPresetStore({ path: join(CONFIG.dataDir, 'presets.json') });
		attachPresetRoutes(api, { store: state.presetStore });
		// The presets, sets and cubes as Rally's pick catalogues, and each option's two view pages' data.
		attachRally(api, {
			symbols: rallySymbols(resolve(state.repoRoot, 'apps/ui/src/symbols')),
			cubes: state.cubeStore,
			sets: state.setsStore,
			presets: state.presetStore,
			boosters: state.forgePools,
			catalog: state.catalog,
			art: state.artKeys,
			...(CONFIG.testNoRateLimits ? { packRateLimit: null } : {}),
		});

		// Keep the catalog current with Scryfall's daily bulk file, with no restart. A swap can turn a
		// `missingText` refusal into a pass, so every cached set verdict refused for missing text is
		// dropped. Off (`CARDTABLE_CATALOG_REFRESH=0`) on every server that is not production, which
		// would otherwise download into the shared cache at its own boot; the e2e harnesses set it off.
		const catalogRefresh = createCatalogRefresh({
			catalog: state.catalog,
			scryfallDir: process.env.CARDTABLE_SCRYFALL_DIR ?? resolve(homedir(), '.local/share/cardtable/scryfall'),
			catalogPath: CONFIG.catalogPath,
			onSwap: () => state.setsStore.clearMissingTextVerdicts(),
			log: jsonLogger('cardtable-pools'),
		});
		const stopCatalogRefresh = CONFIG.catalogRefresh ? catalogRefresh.start() : (): void => undefined;
		if (!CONFIG.catalogRefresh) console.log('[cardtable] catalog refresh disabled (CARDTABLE_CATALOG_REFRESH=0)');
		ctx.bootPhase('tables');
		// Stops the 24 h timer; an in-flight run finishes on its own.
		return { shutdown: () => stopCatalogRefresh() };
	},
};
