/**
 * The draft room's cube pools: the card catalog, the cube shortlist and imports, the pool
 * service's own Forge JVM and every draftable set. Built before the rooms, whose plans these check.
 */
import type { ArtManifestFile } from '@hadoku/carddata/art';
import { jsonLogger } from '@hadoku/service-kernel/log';
import type { DraftPlan, PoolVerdict } from '@hadoku/shared';
import { CONFIG } from '@hadoku/game-server/config';
import artManifest from '../play/art-manifest.json' with { type: 'json' };
import { loadArtKeys } from '../pools/art-keys.js';
import { loadCardCatalog } from '../pools/catalog.js';
import { createCubeStore } from '../pools/cubes.js';
import { createForgePools } from '../pools/forge.js';
import { createSetsStore, warmSetsStore } from '../pools/sets.js';
import { DEFAULT_CUBE_ID } from '../room/draftRooms.js';
import { checkPlan } from '../room/plan.js';
import { SHORTLIST_DIR } from '../root.js';
import type { CardtablePlugin } from './state.js';

export const poolsPlugin: CardtablePlugin = {
	name: 'pools',
	phase: 'stores',
	setup(ctx) {
		const { state } = ctx;
		// `shortlistDir` is the committed, generated 8-cube list (`games/magic/packages/carddata/src/cli/build-pool.ts
		// --out-dir=`): read-only, never `CARDTABLE_*`-overridden, because it ships with the bundle.
		// `importDir` (`CARDTABLE_CUBES_DIR`) is writable: a friend's Cube Cobra imports, flat `<id>.json`.
		state.shortlistDir = SHORTLIST_DIR;
		state.catalog = loadCardCatalog(CONFIG.catalogPath);
		ctx.bootPhase('catalog');
		state.artKeys = loadArtKeys({ mirrorPath: CONFIG.artMirrorPath, manifest: (artManifest as ArtManifestFile).entries });
		state.cubeStore = createCubeStore({ shortlistDir: state.shortlistDir, importDir: CONFIG.cubesDir, catalog: state.catalog });
		if (state.cubeStore.list().length === 0) console.warn(`[cardtable] draft pool: no shortlist cubes loaded from ${state.shortlistDir} — draft rooms are disabled`);
		ctx.bootPhase('cubes');

		// The pool service's own long-lived JVM (`play/bridge/PoolService.java`), never the match
		// bridge, so a pool request can never stall a game. `null` without a configured Forge build.
		state.forgePools = state.forge.ok ? createForgePools(state.forge.config, jsonLogger('cardtable-pools')) : null;

		// Every set Forge has a draft template for, with each one's card list and name. Warmed in the
		// background, never awaited: on a slow host it is tens of seconds of pool-JVM round trips, and
		// nothing optional may keep the server from listening. Started this early so `sets()` is the
		// pool JVM's first call, and every name is known from that one answer (`setsStore.onNamed`,
		// wired to the lobby). `[]` without a jar.
		state.setsStore = createSetsStore({ forge: state.forgePools, catalog: state.catalog, log: jsonLogger('cardtable-pools') });
		void warmSetsStore(state.setsStore);
		ctx.bootPhase('pools');

		state.defaultCubeCards = state.cubeStore.cards(DEFAULT_CUBE_ID) ?? null;
		// Without a jar, `room/plan.ts`'s own rule applies: every source not already checked at this pin
		// is refused, with a reason, unless CONFIG.testUncheckedPools (the jar-less e2e stack's hatch).
		state.checkDraftPlan = (plan: DraftPlan): Promise<PoolVerdict> =>
			checkPlan(plan, { cubes: state.cubeStore, sets: state.setsStore, forge: state.forgePools, uncheckedWithoutJar: CONFIG.testUncheckedPools });

		const forgePools = state.forgePools;
		const say = jsonLogger('cardtable');
		return {
			// The pool service's own JVM, best-effort: the kernel's deadline bounds the shutdown even if this never resolves.
			shutdown: () => void forgePools?.close().catch((err: unknown) => say({ evt: 'shutdown-pool-service-failed', error: (err as Error).message })),
		};
	},
};
