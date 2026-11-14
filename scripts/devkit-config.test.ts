/**
 * Cardtable's devkit.config.json reproduces what the lane, land, release and telemetry scripts
 * hardcoded before packages/devkit (each value beside the line it replaced, as of 93413b1bc).
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { loadConfig, shellVars } from '../packages/devkit/src/config.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HOME = homedir();

describe("cardtable's devkit config", () => {
	const c = loadConfig(ROOT);

	it('names the values the scripts hardcoded', () => {
		expect(c.appId).toBe('cardtable');
		expect(c.envPrefix).toBe('CARDTABLE'); // CARDTABLE_CLAIMS, CARDTABLE_REPO, CARDTABLE_VERSION, CARDTABLE_TELEMETRY_*
		expect(c.repo).toBe('WolffM/hadoku-cardtable'); // watch-run.sh:20, prove-and-land.sh:20, land.sh:209
		expect(c.claimsFile).toBe(join(HOME, '.local/state/cardtable/claims.tsv')); // claim.sh:21
		expect(c.scratchDir).toBe('/tmp/claude-1000'); // watch-run.sh:25, prove-and-land.sh:31, land.sh:48
		expect(c.nodeBin).toBe(join(HOME, '.local/share/fnm/node-versions/v24.18.0/installation/bin')); // land.sh:24, land-worktree.sh:25, daily.sh:28
		expect(c.trees).toEqual({ deploy: join(HOME, 'srv/hadoku-cardtable'), ppe: join(HOME, 'srv/hadoku-cardtable-ppe') });
		expect(c.ci).toEqual({ workflow: 'ci.yml', name: 'CI', checkJob: 'check' });
		expect(c.proof).toEqual({ workflow: 'forge.yml', maxInFlight: 3, select: join(ROOT, 'scripts/ci/select-forge-tests.ts') }); // prove-and-land.sh:49-58
		expect(c.releases.dir).toBe(join(ROOT, 'docs/releases')); // build-version.ts:42, credits.ts:16
		expect(c.ledger).toBe(join(ROOT, 'docs/planning/playtest-ledger.md')); // land.sh:64, collect.ts:20
		expect(c.land.lock).toBe('/tmp/claude-1000/land.lock'); // land.sh:23
		expect(c.land.devVault).toBe(join(HOME, 'repos/hadoku_site/scripts/secrets/dev-vault.mjs')); // land-worktree.sh:27, from ~/repos/hadoku-cardtable
		expect(c.land.linkDeps).toBe(join(ROOT, 'scripts/link-worktree-node-modules.sh')); // land.sh:121-123
		expect(c.land.unsetEnv).toEqual(['CARDTABLE_FORGE_JAR', 'CARDTABLE_FORGE_RES']); // land.sh:197
		expect(c.land.botCommits).toBe('^chore: auto-update @wolffm/'); // land.sh:213
		expect(c.land.tests.runAllList).toBe(join(ROOT, 'scripts/ci/run-all.txt')); // land.sh:161
		expect(c.land.hooks.beforeCheck).toEqual([join(ROOT, 'scripts/art/land-art-rows.sh')]); // land.sh:131-146
		expect(c.telemetry).toEqual({
			service: 'cardtable', // watch.ts:753
			path: '/cardtable', // watch.ts:752, :210
			keyFile: '/home/hadoku/repos/hadoku-cardtable/.devvault.local.json', // daily.sh:26
			outDir: '/home/hadoku/.local/state/cardtable/telemetry', // daily.sh:27
			backupJob: 'cardtable:state-backup', // watch.ts:53
			battletestJob: 'site:e2e-members', // watch.ts:54
			tourUserId: 'c8c59a87-f8af-4da7-9c99-d9e536b3fca8', // watch.ts:46
			discordWebhookSecret: 'DISCORD_CARDTABLE_DAILY_WEBHOOK', // watch.ts:719-725
		});
		expect(c.health).toEqual({ prod: 9008, ppe: 9011 });
	});

	it("gives land.sh the same whole-run patterns it had (land.sh:161)", () => {
		const vars = shellVars(c);
		expect(vars).toContain(`DK_TESTS_WHOLE='(^packages/)|(^games/[^/]+/packages/)|(^apps/ui/src/test-setup\\.ts$)'`);
		expect(vars).toContain(`DK_TESTS_RELATED_ONLY='(^packages/game-(server|ui)/src/)'`);
	});
});
