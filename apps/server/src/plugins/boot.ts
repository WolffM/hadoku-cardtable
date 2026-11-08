/**
 * The first two steps: the state directory, then the fleet read. The kernel checks the bundle
 * between them; the boot clock keeps cardtable's names (`imports`, `bundle`).
 */
import { mkdirSync } from 'node:fs';
import { jsonLogger } from '@hadoku/service-kernel/log';
import { moveLegacyState } from '@hadoku/service-kernel/state';
import { CONFIG, LEGACY_STATE } from '../config.js';
import { fleetCli, primeFleet } from '../play/placement/index.js';
import { reportingAlerts } from '../telemetry.js';
import type { CardtablePlugin } from './state.js';

export const stateDirPlugin: CardtablePlugin = {
	name: 'state-dir',
	phase: 'config',
	setup(ctx) {
		// Before any store opens: a first boot with a state dir moves the in-clone one into it.
		moveLegacyState(CONFIG, LEGACY_STATE, jsonLogger('cardtable'));
		mkdirSync(CONFIG.logDir, { recursive: true });
		ctx.bootPhase('imports');
	},
};

export const fleetPlugin: CardtablePlugin = {
	name: 'fleet',
	phase: 'bundle',
	setup(ctx) {
		ctx.bootPhase('bundle');
		// The claws' fleet read, started now so it runs beside the rest of the boot: a seat back after a
		// restart waits for its match to be adopted, and adopting waits on this read (`primeFleet`).
		ctx.state.placementLog = jsonLogger('cardtable-placement');
		ctx.state.primedFleet = CONFIG.playHosts === 'claws' ? primeFleet(fleetCli({ log: reportingAlerts(ctx.state.placementLog) })) : undefined;
	},
};
