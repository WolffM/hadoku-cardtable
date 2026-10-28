/**
 * Forge cutting an AI decision short reaches the pool as a `cutoff` for the match whose game it
 * was, against a REAL `--host` bridge JVM running two matches at once.
 *
 * `AiController.chooseSpellAbilityToPlayFromList` gives each AI scan `Game.AI_TIMEOUT` (5 s) and,
 * past it, prints `AI eval thread at timeout:` on the game thread and plays its best so far. The
 * test-only `-Dcardtable.aiTimeoutSec=0` (never set by `host.ts`) makes every scan a cutoff, so
 * each match's AI, active in its main phase with a spell to cast (`scenarios/aa-ai-turn.state`),
 * is cut short at once. What it proves:
 * - each match's cutoffs are named for that match, both matches in the one JVM;
 * - each reaches `JvmPoolOptions.onCutoff` and the match's own log, never the match's lines;
 * - Forge's own text still reaches the JVM's stderr.
 *
 * Skips visibly without a Forge build, like every `*.jvm.test.ts`:
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=… \
 *   CI=1 node_modules/.bin/vitest run apps/server/src/play/ai-cutoff.jvm.test.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { jvmHostFactory, liveJvmCount, type AiCutoff, type BridgeLine, type HostEvents, type JvmHostFactory, type MatchHost, type MatchSpec } from './host.js';
import { available, deck, scenarioText, waitUntil } from './scenario.js';

const title = available.ok
	? 'an AI cutoff in a shared JVM is counted for its own match, against a real bridge'
	: `an AI cutoff in a shared JVM is counted for its own match, against a real bridge — SKIPPED: ${available.reason}`;

interface Rec extends HostEvents {
	lines: BridgeLine[];
	logs: Record<string, unknown>[];
}

function rec(): Rec {
	const r: Rec = { lines: [], logs: [], line: (l) => r.lines.push(l), exit: () => undefined, log: (e) => r.logs.push(e) };
	return r;
}

describe.skipIf(!available.ok)(title, () => {
	const poolLog: Record<string, unknown>[] = [];
	const cutoffs: AiCutoff[] = [];
	const hosts: MatchHost[] = [];
	let pool: JvmHostFactory | null = null;

	afterAll(async () => {
		for (const h of hosts) h.stop();
		pool?.close();
		await waitUntil(() => liveJvmCount() === 0, 'every JVM to exit', 60_000);
	}, 90_000);

	it('two matches in one JVM: each cutoff names its own match, reaches onCutoff and the match log, and stays on stderr', async () => {
		if (!available.ok) throw new Error('unreachable');
		const config = { ...available.config, perJvm: 2, jvmOpts: [...available.config.jvmOpts, '-Dcardtable.aiTimeoutSec=0'] };
		pool = jvmHostFactory(config, { warm: false, sweep: false, log: (e) => poolLog.push(e), onCutoff: (c) => cutoffs.push(c) });
		const spec: MatchSpec = {
			seed: 20261027,
			skipOpening: true,
			scenario: scenarioText('aa-ai-turn'),
			seats: [
				{ name: 'Seat 1', ai: false, deck: deck('Seat one', ['30 Swamp', '30 Grizzly Bears']) },
				{ name: 'Seat 2', ai: true, deck: deck('Seat two', ['30 Swamp', '30 Hill Giant']) },
			],
		};
		const ids = [`m-cut${process.pid}a`, `m-cut${process.pid}b`];
		const recs = ids.map(() => rec());
		ids.forEach((id, i) => hosts.push(pool!(id, spec, recs[i]!)));
		const detail = (): string => `cutoffs ${JSON.stringify(cutoffs)}; pool log tail ${JSON.stringify(poolLog.slice(-8))}`;
		await waitUntil(() => ids.every((id) => cutoffs.some((c) => c.matchId === id)), 'a cutoff for each match', 180_000);

		const jvms = pool.jvms();
		console.log(`[jvm] ai-cutoff: ${jvms.length} JVM(s) ${JSON.stringify(jvms.map((j) => ({ hostId: j.hostId, matches: j.matches })))}; cutoffs ${JSON.stringify(cutoffs)}`);
		expect(jvms, detail()).toHaveLength(1);
		expect(jvms[0]!.matches.sort()).toEqual([...ids].sort());
		const hostId = jvms[0]!.hostId;
		for (const c of cutoffs) expect(c.hostId).toBe(hostId);
		for (const [i, id] of ids.entries()) {
			const own = cutoffs.filter((c) => c.matchId === id);
			// At a 0 s cutoff Forge can stop an eval thread before it reaches Forge's code: that
			// cutoff has no frame to name.
			expect(own.every((c) => c.where === null || /^[A-Za-z]+\.[A-Za-z$<>]+$/.test(c.where)), detail()).toBe(true);
			expect(recs[i]!.logs.filter((l) => l.evt === 'ai-cutoff').length).toBeGreaterThanOrEqual(own.length);
			expect(recs[i]!.lines.some((l) => (l as { t: string }).t === 'cutoff')).toBe(false);
		}
		expect(cutoffs.filter((c) => c.matchId === null), 'every cutoff came from a game thread the bridge knows').toEqual([]);

		const spawned = poolLog.find((l) => l.evt === 'jvm-spawned' && l.id === hostId) as { run: string } | undefined;
		const stderr = readFileSync(join(spawned!.run, 'bridge.stderr.txt'), 'utf8');
		expect(stderr).toContain('AI eval thread at timeout:');
	}, 240_000);
});
