/**
 * Remote `--host` JVMs: one claw's host agent (`apps/agent`) as a `JvmLauncher`.
 *
 *   wire.ts       the protocol and its signing, shared with the agent
 *   client.ts     the signed requests and relay to one agent, heartbeats, the link clock
 *   launcher.ts   `JvmLauncher` / `JvmTransport` over a client
 *   artifacts.ts  the JDK, jar, res and bridge packed by sha256 and pushed
 *
 * The signing key is the coordinator's Ed25519 private key, from the vault
 * (`.devvault.json`: `CARDTABLE_AGENT_SIGNING_KEY`) through the PM2 wrapper,
 * as a PEM or one line of base64 PKCS#8. Unset = no remote hosting.
 */

import { join } from 'node:path';

import { jsonLogger } from '../../log.js';
import type { JvmHostConfig } from '../host.js';
import { packRuntime, pushRuntime } from './artifacts.js';
import { AgentClient } from './client.js';
import { RemoteJvmLauncher } from './launcher.js';
import { AGENT_PORT, privateKeyFrom } from './wire.js';

export { AgentClient } from './client.js';
export { RemoteJvmLauncher } from './launcher.js';

export const AGENT_KEY_ENV = 'CARDTABLE_AGENT_SIGNING_KEY';

export interface RemoteHost {
	client: AgentClient;
	launcher: RemoteJvmLauncher;
}

/**
 * Connect to the agent on `node`, push whatever of this coordinator's runtime
 * it lacks, and hand back a launcher for it.
 */
export async function connectRemoteHost(
	node: string,
	config: JvmHostConfig,
	env: NodeJS.ProcessEnv = process.env,
	opts: { port?: number; fenceMs?: number; log?: (entry: Record<string, unknown>) => void } = {},
): Promise<RemoteHost> {
	const keyText = env[AGENT_KEY_ENV] ?? '';
	if (keyText === '') throw new Error(`${AGENT_KEY_ENV} is not set`);
	const log = opts.log ?? jsonLogger('remote');
	const client = new AgentClient({ url: `http://${node}:${opts.port ?? AGENT_PORT}`, key: privateKeyFrom(keyText), fenceMs: opts.fenceMs, log });
	const runtime = await pushRuntime(client, await packRuntime(config, join(config.bridgeCache, '..', 'agent-artifacts'), log), log);
	await client.connect();
	return { client, launcher: new RemoteJvmLauncher(client, runtime) };
}
