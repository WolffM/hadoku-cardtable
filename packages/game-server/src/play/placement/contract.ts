/**
 * cardtable's hosting contract with fleet-manager, from the one file both sides read: `hosting.json`
 * at the repo root, which fleet-manager registers as our request (`fleet hosting-request`). What it
 * promises is written out in `docs/HOSTING_CONTRACT.md`; `audit.ts` checks fleet-manager's reports
 * against it every poll.
 *
 * Placement reads the host order and the slice limits from here, never from a copy: a copy in
 * `rules.ts` that a test pinned equal drifted from `hosting.json` on 2026-11-04 (840e5b631 added
 * claw-10 to one of them) and held CI red for 12 h.
 */

import hosting from '../../../../../hosting.json' with { type: 'json' };

export interface HostingContract {
	/** What each slice gives us. */
	unit: { memoryMb: number; cores: number };
	/** How many slices we may ask for (`hosting-demand` restates the count inside this). */
	min: number;
	max: number;
	/** The ports the controller reaches each slice's agent on. */
	ports: readonly number[];
	/** fleet-manager placement rules every node holding one of our slices must meet. */
	require: readonly string[];
	/** The nodes we want, most wanted first. */
	order: readonly string[];
	/** Minutes of notice before a slice ends or its node reboots. */
	noticeMin: number;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** The contract's fields of a `hosting.json`. A file that lacks one throws: nothing runs on a guess. */
export function contractOf(raw: unknown): HostingContract {
	const fail = (what: string): never => {
		throw new Error(`hosting.json: ${what}`);
	};
	if (!isObject(raw)) return fail('not an object');
	const slices = isObject(raw.slices) ? raw.slices : fail('no slices');
	const unit = isObject(slices.unit) ? slices.unit : fail('no slices.unit');
	const placement = isObject(raw.placement) ? raw.placement : fail('no placement');
	const network = isObject(raw.network) ? raw.network : fail('no network');
	const availability = isObject(raw.availability) ? raw.availability : fail('no availability');
	const num = (v: unknown, what: string): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fail(`${what} is not a number`));
	const strings = (v: unknown, what: string): string[] => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : fail(`${what} is not a list of names`));
	const contract: HostingContract = {
		unit: { memoryMb: num(unit.memoryMb, 'slices.unit.memoryMb'), cores: num(unit.cores, 'slices.unit.cores') },
		min: num(slices.min, 'slices.min'),
		max: num(slices.max, 'slices.max'),
		ports: Array.isArray(network.ports) && network.ports.every((p) => typeof p === 'number') ? (network.ports as number[]) : fail('network.ports is not a list of ports'),
		require: strings(placement.require, 'placement.require'),
		order: strings(placement.order, 'placement.order'),
		noticeMin: num(availability.noticeMin, 'availability.noticeMin'),
	};
	if (contract.min < 1 || contract.min > contract.max) fail(`slices.min..max is ${contract.min}..${contract.max}`);
	if (new Set(contract.order).size !== contract.order.length) fail('placement.order names a node twice');
	return contract;
}

export const CONTRACT: HostingContract = contractOf(hosting);
