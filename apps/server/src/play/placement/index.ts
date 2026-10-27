/**
 * Placement across hosts (`CARDTABLE_PLAY_HOSTS=claws`): which claw runs each match, failover when
 * one fails, and the alerts.
 *
 *   coordinator.ts  the factory: hosts, placement, failover, planned moves, restart grace
 *   rules.ts        eligibility, ranking and the backstop, pure
 *   fleet.ts        fleet-manager's status, read through its CLI
 *   alerts.ts       Discord, one message per incident
 *   restore.ts      `MatchRegistry.restore` behind the `Restorer` seam
 */

import type { JvmHostConfig } from '../host.js';
import { connectRemoteHost } from '../remote/index.js';
import { Alerts, discordSink } from './alerts.js';
import { placement, type Placement } from './coordinator.js';
import { fleetCli } from './fleet.js';

export { registryRestorer } from './restore.js';
export type { HostsView, Placement } from './coordinator.js';

export interface ClawPlacementOptions {
	webhook: string;
	forceFile: string;
	restartGraceMs: number;
	log: (entry: Record<string, unknown>) => void;
}

/** The production wiring: fleet-manager's CLI, the agents on the claws, Discord. */
export function clawPlacement(config: JvmHostConfig, opts: ClawPlacementOptions): Placement {
	return placement({
		config,
		fleet: fleetCli({ log: opts.log }),
		connect: (node) => connectRemoteHost(node, config),
		alerts: new Alerts({ sink: opts.webhook === '' ? null : discordSink(opts.webhook), log: opts.log }),
		forceFile: opts.forceFile,
		restartGraceMs: opts.restartGraceMs,
		log: opts.log,
	});
}
