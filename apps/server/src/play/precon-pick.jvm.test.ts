/**
 * The precon a seed deals a seat with no deck is the same on every host.
 *
 * A seat with no deck plays a random quest precon (`PlayBridge.randomPrecon`),
 * shuffled with the match's seeded `Random` so a seeded match is reproducible.
 * The files come from `File.listFiles`, whose order is the filesystem's:
 * unspecified, and different on hokon and the claws. Shuffling that listing
 * gave the same seed a different precon on each CI host, and a spec's
 * behaviour turned on which machine ran it.
 *
 * For a handful of seeds, the two precons dealt in a row (both seats of a
 * match) from the directory's listing and from the same files reversed.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… \
 *   pnpm exec vitest run apps/server/src/play/precon-pick.jvm.test.ts
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { bridgeLaunch, jvmHostConfig } from './host.js';

const available = jvmHostConfig();
const title = available.ok
	? 'a seed deals the same precons whatever order the directory lists them in'
	: `a seed deals the same precons whatever order the directory lists them in — SKIPPED: ${available.reason}`;

const CHECK = join(dirname(fileURLToPath(import.meta.url)), 'jvm', 'PreconPickCheck.java');
const SEEDS = ['1', '7', '42', '1234', '20261020'];

describe.skipIf(!available.ok)(title, () => {
	it('the listing and its reverse deal each seed the same two precons', { timeout: 190_000 }, () => {
		if (!available.ok) return;
		const launch = bridgeLaunch(available.config, (e) => console.log(`[precon-pick.jvm] ${JSON.stringify(e)}`));
		expect(launch.how, 'the bridge compiles, so the check can load its classes').toBe('compiled');
		const dir = mkdtempSync(join(tmpdir(), 'precon-pick-'));
		try {
			// Compiled beside the bridge's classes rather than source-launched: `randomPrecon` is package-private.
			const javac = spawnSync(join(dirname(available.config.java), 'javac'), ['-proc:none', '-nowarn', '-cp', launch.args[1]!, '-d', dir, CHECK], { encoding: 'utf8', timeout: 120_000 });
			expect(javac.status, javac.stderr).toBe(0);
			const run = spawnSync(available.config.java, ['-cp', `${dir}:${launch.args[1]!}`, 'PreconPickCheck', available.config.res, ...SEEDS], {
				encoding: 'utf8',
				maxBuffer: 16 * 1024 * 1024,
				timeout: 180_000,
			});
			expect(run.status, run.stderr.slice(-4000)).toBe(0);
			const dealt: Record<string, Record<string, string>> = {};
			for (const row of run.stdout.split('\n')) {
				const cells = row.split('\t');
				if (cells.length !== 4) continue;
				const [seed, order, first, second] = cells as [string, string, string, string];
				console.log(`[precon-pick.jvm] seed ${seed} ${order}: ${first} v ${second}`);
				(dealt[order] ??= {})[seed] = `${first} v ${second}`;
			}
			expect(Object.keys(dealt.listed ?? {}).sort()).toEqual([...SEEDS].sort());
			expect(dealt.reversed).toEqual(dealt.listed);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
