/**
 * Once the server answers: the boot clock's `listen`, then everything that may not hold it back,
 * which is the eras' pools, the testing rooms and the release announcement, and the startup lines
 * that say which features are up.
 */
import { resolve } from 'node:path';
import { announceRelease } from '../announce.js';
import { jsonLogger } from '@hadoku/service-kernel/log';
import { CONFIG } from '../config.js';
import type { CardtablePlugin } from './state.js';

export const listenPlugin: CardtablePlugin = {
	name: 'listen',
	phase: 'listen',
	setup(ctx) {
		ctx.bootPhase('listen');
	},
};

export const warmPlugin: CardtablePlugin = {
	name: 'warm',
	phase: 'warm',
	setup(ctx) {
		const { state } = ctx;
		const warmedFrom = performance.now();
		void state.library.warm().then((faults) => {
			jsonLogger('cardtable')({ evt: 'library-warmed', formats: state.library.formats.length, ms: Math.round(performance.now() - warmedFrom), faults });
		});
		void state.runTestingRoomSeed();
		console.log(`[cardtable] tier floor: ${CONFIG.minTier}`);
		const cubes = state.cubeStore.list().length;
		if (cubes > 0) {
			console.log(`[cardtable] draft socket ready — ${cubes} cube(s) in the store`);
		} else {
			// The server is up and one feature is not, and saying which keeps "it just does nothing" from
			// being a state anyone has to debug from the outside.
			console.error(`[cardtable] NO CUBE SHORTLIST at ${state.shortlistDir} — every draft join will answer unknown-draft`);
		}
		if (CONFIG.edgeAuthSecret === '') {
			console.warn(
				CONFIG.allowUnverifiedEdge
					? '[cardtable] EDGE_AUTH_SECRET unset and INSECURE_NO_EDGE_AUTH=1 — identity headers are TRUSTED UNVERIFIED. Local dev only.'
					: '[cardtable] EDGE_AUTH_SECRET unset — failing closed, every request degraded to public/anon.',
			);
		}
		if (CONFIG.testNoRateLimits) {
			console.warn('[cardtable] CARDTABLE_E2E_NO_RATE_LIMITS=1 — no per-caller limit on page loads, rooms, events, match starts or restarts. e2e stacks only, never production.');
		}
		if (CONFIG.testPeopleStandIn) {
			console.warn('[cardtable] CARDTABLE_E2E_PEOPLE_STAND_IN=1 — people are looked up with no service key, from the e2e stand-in. e2e stacks only, never production.');
		}
		if (CONFIG.testUncheckedPools) {
			console.warn('[cardtable] CARDTABLE_E2E_UNCHECKED_POOLS=1 — a plan with no jar passes unchecked (missingText still refuses). e2e/harness.ts only, never production.');
		}
		if (!ctx.bundle.ok) {
			// Loud, because the alternative is a blank page nobody can diagnose from the outside.
			console.error(`[cardtable] BUNDLE NOT SERVABLE (${ctx.bundle.reason}): ${ctx.bundle.detail}`);
		} else {
			console.log(`[cardtable] ${ctx.bundle.detail}`);
		}
		void announceRelease({
			releasesDir: resolve(state.repoRoot, 'docs/releases'),
			secret: CONFIG.archivebotSecret,
			archivebotUrl: CONFIG.archivebotUrl,
			appUrl: `https://hadoku.me${CONFIG.basePrefix}/`,
			log: jsonLogger('cardtable-release'),
		});
	},
};
