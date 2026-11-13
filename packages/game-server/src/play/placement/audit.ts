/**
 * Where fleet-manager is not keeping our hosting contract (`docs/HOSTING_CONTRACT.md`), from its own
 * reports: `node-status` for each slice, and `hosting-demand`'s last converger pass for the count
 * and for its own verdict on whether a node holding our slice still meets our `require` rules.
 * Pure. The coordinator runs it every poll and pages a violation that holds (`coordinator.ts`);
 * `scripts/hosting/contract-check.ts` runs it by hand.
 *
 * Notice (§5) needs to remember when a notice first appeared, so the coordinator checks it itself.
 */

import type { HostingContract } from './contract.js';
import type { FleetDemand, FleetStatus } from './fleet.js';
import { rebootOf } from './rules.js';

/** The contract's sections, as `docs/HOSTING_CONTRACT.md` numbers them. */
export const SECTION = { count: 1, kept: 3, slice: 4, notice: 5 } as const;
export type Clause = keyof typeof SECTION;

export interface Violation {
	/** Stable while the same thing stays wrong: the alert key. */
	key: string;
	clause: Clause;
	node: string | null;
	what: string;
}

/** fleet-manager's words for a node that fails a placement rule (`hosting-converge.mjs` `faultOf`). */
const FAILS = /^fails "([^"]+)"$/;

export function contractViolations(contract: HostingContract, status: FleetStatus, demand: FleetDemand, now: number): Violation[] {
	const out: Violation[] = [];
	const live = demand.declared.filter((n) => !demand.ending.includes(n));

	// §3: a node holding our slice keeps meeting every rule we require. fleet-manager's own verdict.
	for (const u of demand.unplaceable) {
		const rule = FAILS.exec(u.why)?.[1];
		if (rule === undefined || !contract.require.includes(rule) || !live.includes(u.node)) continue;
		out.push({ key: `kept:${u.node}:${rule}`, clause: 'kept', node: u.node, what: `${u.node} holds one of our slices but ${u.why}` });
	}

	// §1: units and claws. A claw holds one slice of k units; the fleet holds max(demand, minNodes)
	// units on at least minNodes claws. A slice on a box that cannot be reached may be replaced; one
	// fleet-manager made unplaceable is §3's, and its replacement is still too many.
	if (demand.demanded !== null) {
		const unitsOn = (node: string): number => Math.max(1, Math.round((demand.declaredMb[node] ?? contract.unit.memoryMb) / contract.unit.memoryMb));
		const sum = (nodes: string[]): number => nodes.reduce((n, node) => n + unitsOn(node), 0);
		const minNodes = demand.minNodes ?? 0;
		const wantUnits = Math.min(Math.max(demand.demanded, minNodes), contract.max);
		const down = demand.unplaceable.filter((u) => live.includes(u.node) && !u.reachable).map((u) => u.node);
		const held = sum(live);
		if (held > wantUnits + sum(down)) {
			out.push({
				key: 'count:over',
				clause: 'count',
				node: null,
				what: `fleet-manager holds ${held} units on ${live.length} claws for our ${wantUnits} (${live.map((n) => `${n} ×${unitsOn(n)}`).join(', ')}; it counts ${demand.serving.join(', ') || 'none'} as serving)`,
			});
		}
		const serving = demand.servingUnits ?? sum(demand.serving);
		if (serving < wantUnits || demand.serving.length < minNodes) {
			out.push({
				key: 'count:short',
				clause: 'count',
				node: null,
				what: `fleet-manager serves ${serving} of the ${wantUnits} units we asked for${minNodes > 0 ? `, on ${demand.serving.length} of at least ${minNodes} claws` : ''}${demand.blocked.length === 0 ? '' : `: ${demand.blocked.join('; ')}`}`,
			});
		}
	}

	// §4: what each slice gives. A box that is down or inside its announced reboot is §1's to replace.
	for (const n of status.nodes) {
		const h = n.hosting;
		if (h === null || !live.includes(n.node) || !n.reachable || rebootOf(n, now)?.underway === true) continue;
		const slice = (part: string, what: string): void => {
			out.push({ key: `slice:${n.node}:${part}`, clause: 'slice', node: n.node, what: `${n.node}: ${what}` });
		};
		const d = h.declared;
		if (d !== null) {
			if (d.memoryMb < contract.unit.memoryMb) slice('memory', `its slice is declared at ${d.memoryMb} MB, under our ${contract.unit.memoryMb} MB`);
			if (d.cores < contract.unit.cores) slice('cores', `its slice is declared with ${d.cores} cores, under our ${contract.unit.cores}`);
			if (!contract.ports.includes(d.port)) slice('port', `its slice is declared on port ${d.port}, not ours (${contract.ports.join(', ')})`);
		}
		if (h.state !== 'guaranteed') slice('state', `its slice is ${h.state || 'unknown'}, not guaranteed`);
		const min = h.observed?.memoryMinMb;
		if (min !== undefined && min < contract.unit.memoryMb) slice('guarantee', `it guarantees ${min} MB of our ${contract.unit.memoryMb} MB (memory.min)`);
		const cores = h.observed?.cores;
		if (cores !== undefined && cores < contract.unit.cores) slice('observed-cores', `it gives our slice ${cores} cores of ${contract.unit.cores}`);
	}
	return out;
}
