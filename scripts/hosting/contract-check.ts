/**
 * Where fleet-manager is not keeping cardtable's hosting contract right now (docs/HOSTING_CONTRACT.md),
 * by the same check the coordinator pages from every poll (`packages/game-server/src/play/placement/audit.ts`).
 * Read-only: `node-status`, and `hosting-demand` without `--slices`, which restates nothing.
 *
 *   apps/server/node_modules/.bin/tsx scripts/hosting/contract-check.ts [--json]
 *
 * Exits 1 when it finds a violation, 2 when it could not read the fleet. §5 (notice) needs a
 * history this has not got: the coordinator checks it.
 */

import { SECTION, contractViolations } from '../../packages/game-server/src/play/placement/audit.js';
import { CONTRACT } from '../../packages/game-server/src/play/placement/contract.js';
import { fleetCli } from '../../packages/game-server/src/play/placement/fleet.js';

const json = process.argv.includes('--json');
const fleet = fleetCli({ log: (e) => process.stderr.write(`${JSON.stringify(e)}\n`) });
const [status, demand] = await Promise.all([fleet.status(), fleet.standing()]);
if (status === null || demand === null) {
	process.stderr.write(`contract-check: could not read the fleet (${status === null ? 'node-status' : 'hosting-demand'})\n`);
	process.exit(2);
}
const found = contractViolations(CONTRACT, status, demand, Date.now());
if (json) {
	process.stdout.write(`${JSON.stringify({ at: new Date(status.at).toISOString(), demanded: demand.demanded, declared: demand.declared, serving: demand.serving, violations: found }, null, 2)}\n`);
} else {
	process.stdout.write(
		`fleet as of ${new Date(status.at).toISOString()}: we asked for ${demand.demanded ?? '?'}; declared ${demand.declared.join(', ') || 'none'}; serving ${demand.serving.join(', ') || 'none'}\n`,
	);
	if (found.length === 0) process.stdout.write('the contract is kept\n');
	for (const v of found) process.stdout.write(`§${SECTION[v.clause]} ${v.clause}: ${v.what}\n`);
}
process.exit(found.length === 0 ? 0 : 1);
