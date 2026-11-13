/*
 * A port for a test to start a real server on.
 *
 * Not `listen(0)`: that hands out a port from the kernel's ephemeral range
 * (32768-60999 here), which it also gives every outgoing connection, and a
 * test that probes one, lets it go and starts a server on it a second later
 * lost it to a connection in between on a busy host (index.test.ts,
 * 2026-10-19: EADDRINUSE on 43357). Below that range only another explicit
 * bind can take it, and the e2e harnesses keep to 19xxx and 29xxx.
 */

import { createServer } from 'node:net';

const FROM = 30000;
const TO = 32767;

export async function testPort(): Promise<number> {
	for (let tries = 0; tries < 50; tries++) {
		const port = FROM + Math.floor(Math.random() * (TO - FROM + 1));
		const probe = createServer();
		const free = await new Promise<boolean>((resolve) => {
			probe.once('error', () => resolve(false));
			probe.listen(port, '127.0.0.1', () => resolve(true));
		});
		if (!free) continue;
		await new Promise<void>((r) => probe.close(() => r()));
		return port;
	}
	throw new Error(`no free port in ${FROM}-${TO} after 50 tries`);
}
