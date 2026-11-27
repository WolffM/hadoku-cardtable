import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { FromAgent } from '@hadoku/host-wire';
import { jvmHostFactory } from '../host.js';
import { AgentClient } from './client.js';
import { RemoteJvmLauncher } from './launcher.js';

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('RemoteJvmLauncher over a lost link', () => {
	it('the pool launches nothing more onto it: the warm JVM the loss ended is not replaced, and nothing is staged on disk', async () => {
		const workDir = mkdtempSync(join(tmpdir(), 'launcher-lost-'));
		dirs.push(workDir);
		const clock = { t: 1_000_000 };
		const client = new AgentClient({ url: 'http://claw-9:7621', key: generateKeyPairSync('ed25519').privateKey, fenceMs: 10_000, now: () => clock.t });
		const launcher = new RemoteJvmLauncher(client, { artifacts: { files: [] } as never, main: 'Main' });
		const logs: Record<string, unknown>[] = [];
		const pool = jvmHostFactory({ java: 'java', jar: 'unused.jar', res: workDir, workDir, jvmOpts: [], bridgeSource: 'unused', bridgeCache: workDir, stopGraceMs: 1000, warmJvm: true }, { launcher, warm: true, log: (e) => logs.push(e) });
		// The agent's frames, as the relay delivers them (`receive` is the relay's reader).
		const agent = (f: FromAgent) => (client as unknown as { receive(f: FromAgent): void }).receive(f);
		agent({ t: 'running', req: 1, hostIds: [] });
		await pool.orphans();
		const [first] = pool.jvms();
		expect(first).toBeDefined();
		agent({ t: 'line', h: first!.hostId, off: 1, line: JSON.stringify({ t: 'warm', bootMs: 1, match: first!.hostId }) });
		expect(pool.room()).toBe('warm');
		const staged = readdirSync(workDir).sort();

		for (let i = 0; i < 11; i++) {
			clock.t += 1000;
			client.watch();
		}
		expect(client.lost).not.toBeNull();

		expect(readdirSync(workDir).sort()).toEqual(staged);
		expect(logs.filter((l) => l.evt === 'jvm-launched')).toHaveLength(1);
		expect(logs.filter((l) => l.evt === 'jvm-boot-failed' || l.evt === 'jvm-launch-failed')).toEqual([]);
		expect(pool.room()).toBe('none');
		pool.close();
	});
});
