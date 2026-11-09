/**
 * The quarantine canary (`coordinator.ts`'s `frameCanary`) on a real bridge: the one match that lets a
 * failed claw take matches again, so a canary that cannot pass keeps every failed claw out for good.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { jvmHostConfig, jvmHostFactory, type JvmHostFactory } from '../host.js';
import { frameCanary } from './coordinator.js';

const available = jvmHostConfig({ ...process.env, CARDTABLE_PLAY_WARM_JVM: '0' });
const title = available.ok ? 'the quarantine canary on a real bridge' : `the quarantine canary on a real bridge — SKIPPED: ${available.reason}`;

describe.skipIf(!available.ok)(title, () => {
	let pool: JvmHostFactory | null = null;
	afterEach(() => {
		pool?.close();
		pool = null;
	});

	it('passes on a healthy JVM: its match reaches a first frame', async () => {
		if (!available.ok) return;
		pool = jvmHostFactory(available.config, { warm: true });
		const why = await frameCanary(90_000)('local', pool);
		expect(why).toBeNull();
	}, 120_000);
});
