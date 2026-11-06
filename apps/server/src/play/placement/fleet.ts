/**
 * What fleet-manager says about the claws, read the way its CLI prints it.
 *
 * fleet-manager's part is to get claws online, report their status and serve the declared slice
 * (the hosting rulings); placement is ours. Only the fields of its pinned tenant contract
 * (number `FLEET_CONTRACT`) are read: `contract`, `generatedAt`, `nodes[].node`, `reachable`, `ok`,
 * `findings[]`, `notices[]{event,at,kind}`, and of each slice in `tenants[]` (or `hosting`, the
 * node's oldest slice, from a fleet-manager before `tenants`) `state`,
 * `declared.{tenant,memoryMb,cores,port,role}`, `observed.{agent,portReach,memoryInUseMb,memoryMinMb,cores}` and
 * `until`. Every non-guest node is a row, so a slice that ended reads `hosting: null`. Only our
 * tenant's primary slice counts: another tenant's slice, or a standby (`declared.role: "standby"`,
 * for a tenant with `availability.standby`; absent is primary), reads as no slice of ours.
 *
 * Readable is stdout that parses AND carries our contract number; the exit code reports findings
 * only. Anything else is "could not look", which holds the current state and never promotes or
 * demotes anything (forge-hosting-plan §4.3), and is logged with the document's own `reason` when it
 * gives one (`unreadableWhy`). A live read ssh's to every node (~10 s), so the poll takes a copy up
 * to `STATUS_MAX_AGE_S` old, and the status is as of its own `generatedAt`.
 *
 * The CLI is the install mgmt-api runs (`MGMT_API_FLEET_CLI`), so we read the fleet with the build
 * that writes it: a stale `~/repos/hadoku-fleet-manager/dist` read the list-of-slices format as "no
 * slice of ours" and promoted hokon for nothing (2026-10-31 17:54Z).
 *
 * `hosting-demand` is how many slices we want: a count restated every poll (the same count is a
 * no-op), with the order fleet-manager's converger ends them in when the count drops. It declares
 * and ends them only while our registered `hosting.json` says `placement.auto`; otherwise it plans,
 * and the plan comes back in the same answer.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface FleetNotice {
	event: string;
	at: string;
	kind: string;
	/** On a hosting `ends`: the slice is not ending, it shrinks to this many MB and cores at `at`. */
	shrinkTo?: { memoryMb: number; cores: number };
}

export interface FleetHosting {
	/** `guaranteed` when the slice is served as declared. */
	state: string;
	declared: { memoryMb: number; cores: number; port: number } | null;
	/** What fleet-manager measured: `memoryMinMb` is the memory guarantee in force (`memory.min`). */
	observed: { agent?: string; portReach?: unknown; memoryInUseMb?: number; memoryMinMb?: number; cores?: number } | null;
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
	/** The count we last asked for (`demand.slices`); null before we ever asked. */
	demanded: number | null;
	/** Its last pass's slices of ours that serve: declared, not ending, and placeable. */
	serving: string[];
	/** Its last pass's slices of ours it does not count as serving, each with its reason in its words. */
	unplaceable: { node: string; why: string; reachable: boolean }[];
	/** Each declared slice's memory: a claw holds one slice of k units (k × `slices.unit.memoryMb`). */
	declaredMb: Record<string, number>;
	/** The fewest claws the fleet holds us on (`limits.minNodes`); null from a fleet-manager before it. */
	minNodes: number | null;
	/** Its last pass's serving units; null from a fleet-manager before units. */
	servingUnits: number | null;
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

/**
 * Why a document the parsers refused is unreadable, in its own words when it has them:
 * fleet-manager answers a failure as `{contract, ok: false, reason}` (hosting-demand's "not a
 * registered tenant", "cannot read fleet state: …"). 157 such answers on 2026-10-31 logged only
 * "not contract 1" and could not be diagnosed.
 */
export function unreadableWhy(text: string): string {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return `not JSON: ${text.trim().slice(0, 200)}`;
	}
	if (!isObject(raw)) return 'not a JSON object';
	if (typeof raw.reason === 'string' && raw.reason !== '') return raw.reason;
	if (raw.contract !== FLEET_CONTRACT) return `contract ${JSON.stringify(raw.contract ?? null)}, not ${FLEET_CONTRACT}`;
	return `contract ${FLEET_CONTRACT} without the fields it promises (ok: ${JSON.stringify(raw.ok ?? null)})`;
}

/** Our app in fleet-manager's hosting registry. */
export const TENANT = 'cardtable';

/** Our tenant's primary slice on a node: among its `tenants`, else its `hosting`; else null. */
function ourSlice(n: Record<string, unknown>): Record<string, unknown> | null {
	const ours = (h: unknown): h is Record<string, unknown> => {
		if (!isObject(h)) return false;
		const declared = isObject(h.declared) ? h.declared : {};
		return declared.tenant === TENANT && (declared.role ?? 'primary') === 'primary';
	};
	const slices = Array.isArray(n.tenants) ? n.tenants : [n.hosting];
	return slices.find(ours) ?? null;
}

/** The contract's fields of one `node-status --json`, or null when it is not that. */
export function parseNodeStatus(text: string): FleetStatus | null {
	const raw = parseContract(text);
	const at = Date.parse(String(raw?.generatedAt ?? ''));
	if (raw === null || !Number.isFinite(at) || !Array.isArray(raw.nodes)) return null;
	const nodes: FleetNode[] = [];
	for (const n of raw.nodes) {
		if (!isObject(n) || typeof n.node !== 'string') return null;
		const h = ourSlice(n);
		const declared = h !== null && isObject(h.declared) ? h.declared : null;
		const observed = h !== null && isObject(h.observed) ? h.observed : null;
		nodes.push({
			node: n.node,
			reachable: n.reachable === true,
			ok: n.ok === true,
			findings: Array.isArray(n.findings) ? n.findings.filter(isObject).map((f) => ({ class: String(f.class ?? ''), category: String(f.category ?? ''), why: String(f.why ?? '') })) : [],
			notices: Array.isArray(n.notices)
				? n.notices.filter(isObject).map((x) => ({
						event: String(x.event ?? ''),
						at: String(x.at ?? ''),
						kind: String(x.kind ?? ''),
						...(isObject(x.shrinkTo) ? { shrinkTo: { memoryMb: Number(x.shrinkTo.memoryMb) || 0, cores: Number(x.shrinkTo.cores) || 0 } } : {}),
					}))
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
											...(typeof observed.memoryMinMb === 'number' ? { memoryMinMb: observed.memoryMinMb } : {}),
											...(typeof observed.cores === 'number' ? { cores: observed.cores } : {}),
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
		demanded: isObject(raw.demand) && typeof raw.demand.slices === 'number' ? raw.demand.slices : null,
		serving: names(pass.serving),
		declaredMb: Object.fromEntries(
			(Array.isArray(raw.declared) ? raw.declared : []).filter(isObject).filter((x) => typeof x.node === 'string' && typeof x.memoryMb === 'number').map((x) => [String(x.node), Number(x.memoryMb)]),
		),
		minNodes: isObject(raw.limits) && typeof raw.limits.minNodes === 'number' ? raw.limits.minNodes : null,
		servingUnits: typeof pass.servingUnits === 'number' ? pass.servingUnits : null,
		unplaceable: Array.isArray(pass.unplaceable)
			? pass.unplaceable.filter(isObject).filter((u) => typeof u.node === 'string').map((u) => ({ node: String(u.node), why: String(u.why ?? ''), reachable: u.reachable === true }))
			: [],
	};
}

/** The fleet-manager install mgmt-api runs: cardtable reads the fleet through the same build. */
export const MGMT_API_FLEET_CLI = join(homedir(), 'srv', 'hadoku_site', 'services', 'mgmt-api', 'node_modules', '@wolffm', 'fleet-manager', 'dist', 'cli.js');
/** The fallback when that install is missing: the checkout, which may lag it. */
export const CHECKOUT_FLEET_CLI = join(homedir(), 'repos', 'hadoku-fleet-manager', 'dist', 'cli.js');

/**
 * Which fleet-manager CLI to run: `CARDTABLE_FLEET_CLI` when set, else mgmt-api's install, else
 * (with `fallback` set, for a loud log) the checkout.
 */
export function fleetCliPath(env: NodeJS.ProcessEnv, exists: (path: string) => boolean = existsSync): { cli: string; fallback: string | null } {
	if (env.CARDTABLE_FLEET_CLI) return { cli: env.CARDTABLE_FLEET_CLI, fallback: null };
	if (exists(MGMT_API_FLEET_CLI)) return { cli: MGMT_API_FLEET_CLI, fallback: null };
	return { cli: CHECKOUT_FLEET_CLI, fallback: `mgmt-api's fleet-manager install is missing (${MGMT_API_FLEET_CLI}); reading the fleet through the checkout, which may lag it` };
}

export interface FleetCliOptions {
	/** fleet-manager's `dist/cli.js`. Default `fleetCliPath`'s answer. */
	cli?: string;
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
	log?: (entry: Record<string, unknown>) => void;
}

/**
 * fleet-manager's CLI, run as an operator runs it: `node <cli> node-status --json`. `standing`
 * reads the converger's view without restating a count (`hosting-demand` writes only with
 * `--slices`), for a reader that is not the coordinator.
 */
export function fleetCli(opts: FleetCliOptions = {}): FleetSource & { standing(): Promise<FleetDemand | null> } {
	const env = opts.env ?? process.env;
	const log = opts.log ?? (() => {});
	const path = opts.cli === undefined ? fleetCliPath(env) : { cli: opts.cli, fallback: null };
	const cli = path.cli;
	if (path.fallback !== null) {
		log({ evt: 'fleet-cli-fallback', level: 'error', cli, why: path.fallback });
	}
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
	const readDemand = async (args: string[]): Promise<FleetDemand | null> => {
		const text = await run(args);
		const demand = text === null ? null : parseDemand(text);
		if (text !== null && demand === null) log({ evt: 'fleet-unreadable', args: 'hosting-demand', error: unreadableWhy(text) });
		return demand;
	};
	return {
		async status() {
			const text = await run(['node-status', '--json', '--max-age', String(STATUS_MAX_AGE_S)]);
			const status = text === null ? null : parseNodeStatus(text);
			if (text !== null && status === null) log({ evt: 'fleet-unreadable', args: 'node-status', error: unreadableWhy(text) });
			return status;
		},
		async demand(slices, releaseOrder) {
			const args = ['hosting-demand', TENANT, '--slices', String(slices), '--json'];
			if (releaseOrder.length > 0) args.push('--release-order', releaseOrder.join(','));
			return readDemand(args);
		},
		standing() {
			return readDemand(['hosting-demand', TENANT, '--json']);
		},
	};
}

/** The longest a read taken during boot stands in for the coordinator's first poll. */
export const PRIMED_MAX_AGE_MS = 15_000;

/**
 * `source`, with its first `status()` read already under way.
 *
 * A restart is down until the new server listens, and it listens only once every match the last
 * one handed over is adopted (`index.ts`, `play.adopted`). Adopting starts with this read: a CLI
 * run of a second or more on a busy host, which used to begin only when placement was built, late
 * in the boot. Started first, it runs beside the catalog load instead of after it.
 */
export function primeFleet<S extends FleetSource>(source: S, now: () => number = Date.now): S {
	const startedAt = now();
	let first: Promise<FleetStatus | null> | null = source.status();
	return {
		...source,
		status() {
			const primed = first;
			first = null;
			if (primed !== null && now() - startedAt <= PRIMED_MAX_AGE_MS) return primed;
			return source.status();
		},
	};
}
