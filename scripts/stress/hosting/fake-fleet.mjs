#!/usr/bin/env node
/*
 * A stand-in for fleet-manager's CLI (`CARDTABLE_FLEET_CLI`), for a scratch coordinator whose claws are
 * host agents this run started itself: it answers `node-status --json` and `hosting-demand … --json`
 * in contract 1 from a state file the run edits, so a test can take a claw away from fleet-manager's
 * view (`reachable: false`) without touching the real fleet.
 *
 *   FAKE_FLEET_STATE=<file.json> node fake-fleet.mjs node-status --json
 *
 * The state file: `{ "nodes": [{ "node": "127.0.0.2", "reachable": true, "memoryMb": 6000 }, …] }`.
 * Every node listed holds a guaranteed cardtable slice; the converger is `auto` and serves them all.
 */
import { readFileSync } from 'node:fs';

const file = process.env.FAKE_FLEET_STATE;
if (!file) {
	process.stdout.write(JSON.stringify({ contract: 1, ok: false, reason: 'FAKE_FLEET_STATE is not set' }));
	process.exit(2);
}
const state = JSON.parse(readFileSync(file, 'utf8'));
const nodes = state.nodes ?? [];
const generatedAt = new Date().toISOString();
const cmd = process.argv[2];

if (cmd === 'node-status') {
	process.stdout.write(
		JSON.stringify({
			contract: 1,
			generatedAt,
			nodes: nodes.map((n) => ({
				node: n.node,
				reachable: n.reachable !== false,
				ok: n.reachable !== false,
				findings: [],
				notices: n.notices ?? [],
				tenants: [
					{
						declared: { tenant: 'cardtable', role: 'primary', memoryMb: n.memoryMb ?? 6000, cores: n.cores ?? 4, port: 7621 },
						state: 'guaranteed',
						observed: { agent: 'listening', memoryMinMb: n.memoryMb ?? 6000, cores: n.cores ?? 4 },
						until: null,
					},
				],
			})),
		}),
	);
} else if (cmd === 'hosting-demand') {
	const i = process.argv.indexOf('--slices');
	const asked = i > 0 ? Number(process.argv[i + 1]) : null;
	const serving = nodes.filter((n) => n.reachable !== false).map((n) => n.node);
	process.stdout.write(
		JSON.stringify({
			contract: 1,
			auto: true,
			declared: nodes.map((n) => ({ node: n.node, memoryMb: n.memoryMb ?? 6000 })),
			ending: [],
			demand: { slices: asked ?? nodes.length },
			limits: { minNodes: 1 },
			lastPass: { live: true, actions: [], blocked: [], serving, unplaceable: [], servingUnits: serving.length },
		}),
	);
} else {
	process.stdout.write(JSON.stringify({ contract: 1, ok: false, reason: `fake-fleet: no ${String(cmd)}` }));
	process.exit(2);
}
