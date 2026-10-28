/**
 * What fleet-manager says about the claws, read the way its CLI prints it.
 *
 * fleet-manager's part is to get claws online, report their status and serve the declared slice
 * (the hosting rulings); placement is ours. Only the fields of its pinned tenant contract
 * (`TENANT_CONTRACT`, number `FLEET_CONTRACT`) are read: `contract`, `generatedAt`, `nodes[].node`,
 * `reachable`, `ok`, `findings[]`, `notices[]{event,at,kind}`, `hosting.state`,
 * `hosting.declared.{tenant,memoryMb,cores,port,role}`, `hosting.observed.{agent,portReach,memoryInUseMb}`
 * and `hosting.until`. Every non-guest node is a row, so a slice that ended reads `hosting: null`.
 * Only our tenant's primary slice counts: another tenant's slice, or a standby (`role: "standby"`,
 * for a tenant with `availability.standby`), reads as no slice of ours.
 *
 * Readable is stdout that parses AND carries our contract number; the exit code reports findings
 * only. Anything else is "could not look", which holds the current state and never promotes or
 * demotes anything (forge-hosting-plan §4.3). A live read ssh's to every node (~10 s), so the poll
 * takes a copy up to `STATUS_MAX_AGE_S` old, and the status is as of its own `generatedAt`.
 *
 * `hosting-demand` is how many slices we want: a count restated every poll (the same count is a
 * no-op), with the order fleet-manager's converger ends them in when the count drops. It declares
 * and ends them only while our registered `hosting.json` says `placement.auto`; otherwise it plans,
 * and the plan comes back in the same answer.
 */

import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface FleetNotice {
	event: string;
	at: string;
	kind: string;
}

export interface FleetHosting {
	/** `guaranteed` when the slice is served as declared. */
	state: string;
	declared: { memoryMb: number; cores: number; port: number } | null;
	observed: { agent?: string; portReach?: unknown; memoryInUseMb?: number } | null;
	/** When the slice ends, if it is scheduled to. */
	until: string | null;
}

export interface FleetNode {
	node: string;
	reachable: boolean;
	ok: boolean;
	findings: { class?: string; category?: string; why?: string }[];
	notices: FleetNotice[];
	/** Null on a node with no slice declared for us. */
	hosting: FleetHosting | null;
}

export interface FleetStatus {
	/** When fleet-manager read it (`generatedAt`), which a cached copy keeps. */
	at: number;
	nodes: FleetNode[];
}

/** fleet-manager's converger, as `hosting-demand` answers. */
export interface FleetDemand {
	/** Our registered request says `placement.auto`: it declares and ends. False: it only plans. */
	auto: boolean;
	/** Its last pass acted, rather than planning. */
	live: boolean;
	declared: string[];
	ending: string[];
	/** What its last pass did or would have done, as it says it. */
	actions: unknown[];
	/** Why its last pass held back, as it says it. */
	blocked: string[];
}

/** Where the coordinator reads fleet-manager from. Both answer null when they could not look. */
export interface FleetSource {
	status(): Promise<FleetStatus | null>;
	/** Ask for `slices` slices; when there are more, the converger ends them from `releaseOrder`'s head. */
	demand(slices: number, releaseOrder: readonly string[]): Promise<FleetDemand | null>;
}

/** The node-status and hosting-demand contract this reads. */
export const FLEET_CONTRACT = 1;
/** The oldest node-status copy a poll takes instead of a live read: under one poll. */
export const STATUS_MAX_AGE_S = 55;

/**
 * The claws' single-core speed, fastest first (`docs/spikes/forge-scale.md`): the tie-break between
 * two claws with the same free room. A claw not listed ranks after every listed one.
 */
export const CORE_SPEED: readonly (readonly string[])[] = [['claw-8'], ['claw-9'], ['claw-5', 'claw-6']];

export function coreRank(node: string): number {
	const i = CORE_SPEED.findIndex((tier) => tier.includes(node));
	return i < 0 ? CORE_SPEED.length : i;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

function parseContract(text: string): Record<string, unknown> | null {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return null;
	}
	return isObject(raw) && raw.contract === FLEET_CONTRACT ? raw : null;
}

/** Our app in fleet-manager's hosting registry. */
export const TENANT = 'cardtable';

/** A node's `hosting` when it is our tenant's primary slice, else null. */
function ourSlice(h: unknown): Record<string, unknown> | null {
	if (!isObject(h)) return null;
	const declared = isObject(h.declared) ? h.declared : {};
	if (declared.tenant !== TENANT) return null;
	return (h.role ?? declared.role ?? 'primary') === 'primary' ? h : null;
}

/** The contract's fields of one `node-status --json`, or null when it is not that. */
export function parseNodeStatus(text: string): FleetStatus | null {
	const raw = parseContract(text);
	const at = Date.parse(String(raw?.generatedAt ?? ''));
	if (raw === null || !Number.isFinite(at) || !Array.isArray(raw.nodes)) return null;
	const nodes: FleetNode[] = [];
	for (const n of raw.nodes) {
		if (!isObject(n) || typeof n.node !== 'string') return null;
		const h = ourSlice(n.hosting);
		const declared = h !== null && isObject(h.declared) ? h.declared : null;
		const observed = h !== null && isObject(h.observed) ? h.observed : null;
		nodes.push({
			node: n.node,
			reachable: n.reachable === true,
			ok: n.ok === true,
			findings: Array.isArray(n.findings) ? n.findings.filter(isObject).map((f) => ({ class: String(f.class ?? ''), category: String(f.category ?? ''), why: String(f.why ?? '') })) : [],
			notices: Array.isArray(n.notices)
				? n.notices.filter(isObject).map((x) => ({ event: String(x.event ?? ''), at: String(x.at ?? ''), kind: String(x.kind ?? '') }))
				: [],
			hosting:
				h === null
					? null
					: {
							state: String(h.state ?? ''),
							declared:
								declared === null ? null : { memoryMb: Number(declared.memoryMb) || 0, cores: Number(declared.cores) || 0, port: Number(declared.port) || 0 },
							observed:
								observed === null
									? null
									: {
											...(typeof observed.agent === 'string' ? { agent: observed.agent } : {}),
											...(observed.portReach === undefined ? {} : { portReach: observed.portReach }),
											...(typeof observed.memoryInUseMb === 'number' ? { memoryInUseMb: observed.memoryInUseMb } : {}),
										},
							until: typeof h.until === 'string' ? h.until : null,
						},
		});
	}
	return { at, nodes };
}

const names = (v: unknown): string[] =>
	Array.isArray(v) ? v.map((x) => (isObject(x) ? x.node : x)).filter((x): x is string => typeof x === 'string') : [];

/** The contract's fields of one `hosting-demand --json`, or null when it is not that. */
export function parseDemand(text: string): FleetDemand | null {
	const raw = parseContract(text);
	if (raw === null || typeof raw.auto !== 'boolean') return null;
	const pass = isObject(raw.lastPass) ? raw.lastPass : {};
	return {
		auto: raw.auto,
		live: pass.live === true,
		declared: names(raw.declared),
		ending: names(raw.ending),
		actions: Array.isArray(pass.actions) ? pass.actions : [],
		blocked: Array.isArray(pass.blocked) ? pass.blocked.filter(isObject).map((b) => String(b.why ?? '')) : [],
	};
}

export interface FleetCliOptions {
	/** fleet-manager's `dist/cli.js`. Default `~/repos/hadoku-fleet-manager/dist/cli.js`. */
	cli?: string;
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
	log?: (entry: Record<string, unknown>) => void;
}

/** fleet-manager's CLI, run as an operator runs it: `node <cli> node-status --json`. */
export function fleetCli(opts: FleetCliOptions = {}): FleetSource {
	const env = opts.env ?? process.env;
	const cli = opts.cli ?? env.CARDTABLE_FLEET_CLI ?? join(homedir(), 'repos', 'hadoku-fleet-manager', 'dist', 'cli.js');
	const log = opts.log ?? (() => {});
	// fleet-manager finds the hadoku_site checkout through REPOS_DIR; without it, it refuses to run.
	const childEnv = { ...env, REPOS_DIR: env.REPOS_DIR ?? join(homedir(), 'repos') };
	const run = (args: string[]): Promise<string | null> =>
		new Promise((resolve) => {
			execFile(process.execPath, [cli, ...args], { env: childEnv, timeout: opts.timeoutMs ?? 120_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
				// The exit code reports findings only: the contract on stdout says whether it was read.
				if (stdout.trim() === '') {
					log({ evt: 'fleet-unreadable', args: args[0], error: err?.message ?? 'no output' });
					resolve(null);
					return;
				}
				resolve(stdout);
			});
		});
	return {
		async status() {
			const text = await run(['node-status', '--json', '--max-age', String(STATUS_MAX_AGE_S)]);
			const status = text === null ? null : parseNodeStatus(text);
			if (text !== null && status === null) log({ evt: 'fleet-unreadable', args: 'node-status', error: `not contract ${FLEET_CONTRACT}` });
			return status;
		},
		async demand(slices, releaseOrder) {
			const args = ['hosting-demand', TENANT, '--slices', String(slices), '--json'];
			if (releaseOrder.length > 0) args.push('--release-order', releaseOrder.join(','));
			const text = await run(args);
			const demand = text === null ? null : parseDemand(text);
			if (text !== null && demand === null) log({ evt: 'fleet-unreadable', args: 'hosting-demand', error: `not contract ${FLEET_CONTRACT}` });
			return demand;
		},
	};
}
