/**
 * Remote `--host` JVMs: one claw's host agent (`apps/agent`) as a `JvmLauncher`.
 *
 *   wire.ts       the protocol and its signing, shared with the agent
 *   client.ts     the signed requests and relay to one agent, heartbeats, the link clock
 *   launcher.ts   `JvmLauncher` / `JvmTransport` over a client
 *   artifacts.ts  the JDK, jar, res and bridge packed by sha256 and pushed, and the draft bot
 *
 * The signing key is the coordinator's Ed25519 private key, from the vault
 * (`.devvault.json`: `CARDTABLE_AGENT_SIGNING_KEY`) through the PM2 wrapper,
 * as a PEM or one line of base64 PKCS#8. Unset = no remote hosting.
 */

import { join } from 'node:path';

import { jsonLogger } from '@hadoku/service-kernel/log';
import type { JvmHostConfig } from '../host.js';
import { packDraftbot, packRuntime, pushDraftbot, pushRuntime } from './artifacts.js';
import { AgentClient } from './client.js';
import { RemoteJvmLauncher, type RemoteRuntime } from './launcher.js';
import { AGENT_PORT, privateKeyFrom } from '@hadoku/host-wire';

export { AgentClient } from './client.js';
export { RemoteJvmLauncher } from './launcher.js';

export const AGENT_KEY_ENV = 'CARDTABLE_AGENT_SIGNING_KEY';

/** The agent could not be given this coordinator's jar, `res`, JDK or bridge: it cannot run our pin. */
export class PinNotServable extends Error {
	constructor(
		readonly node: string,
		cause: string,
	) {
		super(`${node} cannot be given this server's pin: ${cause}`);
		this.name = 'PinNotServable';
	}
}

export interface RemoteHost {
	client: AgentClient;
	launcher: RemoteJvmLauncher;
	/** Settles once the agent holds this coordinator's runtime; rejects with {@link PinNotServable}. */
	runtime: Promise<RemoteRuntime>;
	/** The draft bot artifact's sha, once the agent holds it (after the runtime: matches come first). */
	draftbot: Promise<string>;
}

/**
 * Connect to the agent on `node` and hand back a launcher for it, while whatever of this
 * coordinator's runtime it lacks is packed and pushed beside it. The link does not wait for the
 * push: adopting the JVMs an earlier server left running needs only the link, and a new pin's push
 * took 13–20 s on prod's v0.53.0 restart (2026-11-06 16:00Z), all of it before `listen`. Only a
 * launch waits for the runtime (`RemoteJvmLauncher`).
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
	const cache = join(config.bridgeCache, '..');
	const runtime = packRuntime(config, join(cache, 'agent-artifacts'), log)
		.then((packed) => pushRuntime(client, packed, log))
		.catch((err: unknown) => {
			throw new PinNotServable(node, (err as Error).message);
		});
	// Reported here whoever else waits on it, so a failed push is never an unhandled rejection.
	void runtime.catch((err: unknown) => log({ evt: 'agent-runtime-failed', agent: node, error: (err as Error).message }));
	const draftbot = runtime
		.catch(() => undefined)
		.then(() => packDraftbot(cache, undefined, log))
		.then((packed) => pushDraftbot(client, packed, log));
	void draftbot.catch((err: unknown) => log({ evt: 'agent-draftbot-failed', agent: node, error: (err as Error).message }));
	await client.connect();
	return { client, launcher: new RemoteJvmLauncher(client, runtime), runtime, draftbot };
}
