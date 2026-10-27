/**
 * What fleet-manager says about the claws, read the way its CLI prints it.
 *
 * fleet-manager's part is to get claws online, report their status and serve the declared slice
 * (the hosting rulings); placement is ours. Only the fields of its pinned tenant contract
 * (`TENANT_CONTRACT`) are read: `nodes[].node`, `reachable`, `ok`, `findings[]`,
 * `notices[]{event,at,kind}`, `hosting.state`, `hosting.declared.{memoryMb,cores,port}`,
 * `hosting.observed.{agent,portReach,memoryInUseMb}` and `hosting.until`.
 *
 * `node-status --json` ssh's to every node from the CLI (~10 s) and exits 1 whenever any node is not
 * ok, with the JSON still on stdout, so the exit code says nothing about readability: the JSON does.
 * Output that does not parse is "could not look", which holds the current state and never promotes
 * or demotes anything (forge-hosting-plan §4.3).
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
	/** When this coordinator read it. */
	at: number;
	nodes: FleetNode[];
}

/** Where the coordinator reads fleet-manager from. Both answer null when they could not look. */
export interface FleetSource {
	status(): Promise<FleetStatus | null>;
	/** `hosting-plan`'s top pick for the next slice: named in the Capacity alert, never declared by us. */
	nextSlice(): Promise<string | null>;
}

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

/** The contract's fields of one `node-status --json`, or null when it is not that. */
export function parseNodeStatus(text: string, now: number): FleetStatus | null {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return null;
	}
	if (!isObject(raw) || !Array.isArray(raw.nodes)) return null;
	const nodes: FleetNode[] = [];
	for (const n of raw.nodes) {
		if (!isObject(n) || typeof n.node !== 'string') return null;
		const h = isObject(n.hosting) ? n.hosting : null;
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
	return { at: now, nodes };
}

/** `hosting-plan --json`'s top-ranked node, or null. */
export function parseHostingPlan(text: string): string | null {
	try {
		const raw = JSON.parse(text) as { plan?: { ranked?: { node?: unknown }[] } };
		const top = raw.plan?.ranked?.[0]?.node;
		return typeof top === 'string' ? top : null;
	} catch {
		return null;
	}
}

export interface FleetCliOptions {
	/** fleet-manager's `dist/cli.js`. Default `~/repos/hadoku-fleet-manager/dist/cli.js`. */
	cli?: string;
	/** The repo slug `hosting-plan` reads `hosting.json` for. */
	repo?: string;
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
	now?: () => number;
	log?: (entry: Record<string, unknown>) => void;
}

/** fleet-manager's CLI, run as an operator runs it: `node <cli> node-status --json`. */
export function fleetCli(opts: FleetCliOptions = {}): FleetSource {
	const env = opts.env ?? process.env;
	const cli = opts.cli ?? env.CARDTABLE_FLEET_CLI ?? join(homedir(), 'repos', 'hadoku-fleet-manager', 'dist', 'cli.js');
	const now = opts.now ?? Date.now;
	const log = opts.log ?? (() => {});
	// fleet-manager finds the hadoku_site checkout through REPOS_DIR; without it, it refuses to run.
	const childEnv = { ...env, REPOS_DIR: env.REPOS_DIR ?? join(homedir(), 'repos') };
	const run = (args: string[]): Promise<string | null> =>
		new Promise((resolve) => {
			execFile(process.execPath, [cli, ...args], { env: childEnv, timeout: opts.timeoutMs ?? 120_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
				// Exit 1 is "some node is not ok", with the JSON on stdout all the same.
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
			const text = await run(['node-status', '--json']);
			const status = text === null ? null : parseNodeStatus(text, now());
			if (text !== null && status === null) log({ evt: 'fleet-unreadable', args: 'node-status', error: 'not the contract' });
			return status;
		},
		async nextSlice() {
			const text = await run(['hosting-plan', opts.repo ?? 'WolffM/hadoku-cardtable', '--json']);
			return text === null ? null : parseHostingPlan(text);
		},
	};
}
