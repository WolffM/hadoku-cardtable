/**
 * The pool JVM's boot is not the first call's time. Forge loads every card before the
 * service says `{"t":"ready"}` (5 s idle, 54 s on a loaded host), and a call's own
 * deadline only starts once it has. A real child process stands in for the JVM: a
 * `java` that boots slowly and answers the line protocol, beside a `javac` that
 * "compiles" by writing the class file `bridgeLaunch` looks for.
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { JvmHostConfig } from '@hadoku/game-server/play/host';
import { POOL_SERVICE_SOURCE } from '../root.js';
import { createForgePools, type ForgePools } from './forge.js';

const FAKE_JAVAC = `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-d" ]; then shift; touch "$1/PoolService.class"; fi
  shift
done
`;

/** `BOOT_MS` before ready (or a fatal line with `FATAL`), then one reply per request line. */
const FAKE_JAVA = `#!/usr/bin/env node
const boot = Number(process.env.BOOT_MS ?? '0');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
setTimeout(() => {
  if (process.env.FATAL) { out({ t: 'fatal', message: process.env.FATAL }); process.exit(1); }
  out({ t: 'ready' });
  require('node:readline').createInterface({ input: process.stdin }).on('line', (text) => {
    const req = JSON.parse(text);
    if (req.op === 'stop') { out({ id: req.id, ok: true }); process.exit(0); }
    if (req.op === 'boosters') return;
    out({ id: req.id, ok: true, sets: [{ code: 'TST', name: 'Test Set', date: '2026-01-01', type: 'EXPANSION' }] });
  });
}, boot);
`;

const dirs: string[] = [];
const pools: ForgePools[] = [];

afterEach(async () => {
	await Promise.all(pools.splice(0).map((p) => p.close()));
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	delete process.env.BOOT_MS;
	delete process.env.FATAL;
});

function fakeJvm(): JvmHostConfig {
	const root = mkdtempSync(join(tmpdir(), 'pool-boot-'));
	dirs.push(root);
	const bin = join(root, 'bin');
	mkdirSync(bin);
	writeFileSync(join(bin, 'java'), FAKE_JAVA);
	writeFileSync(join(bin, 'javac'), FAKE_JAVAC);
	chmodSync(join(bin, 'java'), 0o755);
	chmodSync(join(bin, 'javac'), 0o755);
	writeFileSync(join(root, 'forge.jar'), '');
	mkdirSync(join(root, 'res'));
	return {
		java: join(bin, 'java'),
		jar: join(root, 'forge.jar'),
		res: join(root, 'res'),
		workDir: join(root, 'work'),
		jvmOpts: [],
		bridgeSource: POOL_SERVICE_SOURCE,
		bridgeCache: join(root, 'bridge-cache'),
		stopGraceMs: 1000,
		warmJvm: false,
	};
}

function open(timing: { callTimeoutMs: number; bootTimeoutMs: number }): ForgePools {
	const config = fakeJvm();
	mkdirSync(config.workDir);
	const p = createForgePools(config, () => {}, timing);
	pools.push(p);
	return p;
}

describe('the pool JVM boot', () => {
	it('answers a first call whose JVM takes longer to boot than a call may take', async () => {
		process.env.BOOT_MS = '1200';
		const p = open({ callTimeoutMs: 400, bootTimeoutMs: 10_000 });
		const sets = await p.sets();
		expect(sets.map((s) => s.code)).toEqual(['TST']);
	});

	it('still times out a call the booted JVM never answers within the call deadline', async () => {
		process.env.BOOT_MS = '0';
		const p = open({ callTimeoutMs: 400, bootTimeoutMs: 10_000 });
		await p.sets();
		await expect(p.boosters('TST', 1, 'seed')).rejects.toThrow(/did not answer "boosters" within 400ms/);
	});

	it('fails a waiting call with the fatal line when Forge does not initialise', async () => {
		process.env.FATAL = 'no StaticData';
		const p = open({ callTimeoutMs: 400, bootTimeoutMs: 10_000 });
		await expect(p.sets()).rejects.toThrow(/no StaticData/);
	});

	it('gives up on a boot that outlasts the boot deadline', async () => {
		process.env.BOOT_MS = '5000';
		const p = open({ callTimeoutMs: 400, bootTimeoutMs: 800 });
		await expect(p.sets()).rejects.toThrow(/did not boot within 800ms/);
	});
});
