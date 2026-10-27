/**
 * The host agent's entry point: `/opt/hosting/cardtable/run` on a hosting claw,
 * one file bundled for node 22 by `scripts/agent/deploy.sh` (`agent.ts` says
 * what it does).
 *
 * The coordinator's public key and the build's version are written in at build
 * time; nothing secret is in the bundle. Environment:
 *
 *   CARDTABLE_AGENT_PORT       the port (fleet-manager sets it: 7621)
 *   CARDTABLE_AGENT_HOME       where everything lives; default the working directory (fleet-manager's home)
 *   CARDTABLE_AGENT_FENCE_MS   the fencing window; default `FENCE_MS` (10 s)
 *   CARDTABLE_AGENT_NO_CGROUPS `1` on a dev box: no delegation, JVMs stay in the agent's cgroup
 *   CARDTABLE_AGENT_MEMORY_MB  the memory bound when there is no slice to read it from (dev box)
 *   CARDTABLE_AGENT_LISTEN     the address to listen on; default every interface
 */

import { createPublicKey } from 'node:crypto';

import { Agent } from './agent.ts';

declare const AGENT_PUBLIC_KEY: string;
declare const AGENT_VERSION: string;

const env = process.env;
const port = Number(env.CARDTABLE_AGENT_PORT);
if (!Number.isInteger(port) || port <= 0) {
	console.error('CARDTABLE_AGENT_PORT is not set');
	process.exit(2);
}
const agent = new Agent({
	home: env.CARDTABLE_AGENT_HOME ?? process.cwd(),
	port,
	host: env.CARDTABLE_AGENT_LISTEN,
	publicKey: createPublicKey(AGENT_PUBLIC_KEY),
	version: AGENT_VERSION,
	fenceMs: env.CARDTABLE_AGENT_FENCE_MS ? Number(env.CARDTABLE_AGENT_FENCE_MS) : undefined,
	cgroupRoot: env.CARDTABLE_AGENT_NO_CGROUPS === '1' ? null : '/sys/fs/cgroup',
	memoryMaxMb: env.CARDTABLE_AGENT_MEMORY_MB ? Number(env.CARDTABLE_AGENT_MEMORY_MB) : null,
});
await agent.listen();
