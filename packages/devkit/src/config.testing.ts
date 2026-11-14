/** A valid devkit.config.json for a made-up app, for tests that run the devkit against a scratch repo. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function fixtureConfig(stateDir: string, over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		appId: 'fixture',
		repo: 'example/fixture',
		envPrefix: 'FIXTURE',
		stateDir,
		scratchDir: join(stateDir, 'scratch'),
		nodeBin: '/usr/bin',
		trees: { deploy: join(stateDir, 'deploy') },
		ci: { workflow: 'ci.yml', name: 'CI', checkJob: 'check' },
		releases: { dir: 'docs/releases' },
		land: { lock: join(stateDir, 'land.lock'), devVault: 'vault.mjs', botCommits: '^chore: bot' },
		health: { prod: 9100 },
		...over,
	};
}

/** Writes `config` as `<root>/devkit.config.json` and returns the root. */
export function writeConfig(root: string, config: Record<string, unknown>): string {
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, 'devkit.config.json'), `${JSON.stringify(config, null, 2)}\n`);
	return root;
}
