import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { getField, loadConfig, parseConfig, shellVars } from './config.ts';
import { fixtureConfig } from './config.testing.ts';

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const scratch = () => {
	const d = mkdtempSync(join(tmpdir(), 'devkit-config-'));
	dirs.push(d);
	return d;
};

describe('parseConfig', () => {
	it('fills the defaults and makes every path absolute', () => {
		const c = parseConfig(fixtureConfig('~/.local/state/fixture', { ledger: 'docs/ledger.md' }), '/repo');
		expect(c.stateDir).toBe(join(homedir(), '.local/state/fixture'));
		expect(c.claimsFile).toBe(join(homedir(), '.local/state/fixture/claims.tsv'));
		expect(c.releases.dir).toBe('/repo/docs/releases');
		expect(c.ledger).toBe('/repo/docs/ledger.md');
		expect(c.land.devVault).toBe('/repo/vault.mjs');
		expect(c.land.unsetEnv).toEqual([]);
		expect(c.land.hooks.beforeCheck).toEqual([]);
		expect(c.proof).toBeUndefined();
		expect(c.telemetry).toBeUndefined();
	});

	it('lists every issue with its field, in words a person can act on', () => {
		const bad = { ...fixtureConfig('/s'), appId: 'Card Table', repo: 'cardtable', health: { prod: 70000 }, proof: { workflow: 'forge.yml' }, landing: {} };
		expect(() => parseConfig(bad, '/repo', '/repo/devkit.config.json')).toThrow(
			[
				'devkit: /repo/devkit.config.json is not a valid devkit config:',
				'  /repo/devkit.config.json: appId: lower-case letters, digits and dashes, starting with a letter (e.g. "cardtable")',
				'  /repo/devkit.config.json: repo: write it as "owner/name", e.g. "WolffM/hadoku-cardtable"',
				'  /repo/devkit.config.json: proof.maxInFlight: a number is required',
				'  /repo/devkit.config.json: health.prod: not a port',
				'  /repo/devkit.config.json: unknown field(s) "landing": not part of the devkit config (a typo?)',
			].join('\n'),
		);
	});

	it('names a missing block', () => {
		const { land: _land, ...noLand } = fixtureConfig('/s');
		expect(() => parseConfig(noLand, '/repo')).toThrow(/land: \{ "lock", "devVault", "botCommits", … \} is required/);
	});

	it('refuses a pattern that is not a regular expression', () => {
		const c = fixtureConfig('/s', { land: { lock: '/l', devVault: 'v', botCommits: '^chore: (' } });
		expect(() => parseConfig(c, '/repo')).toThrow(/land\.botCommits .*not a valid regular expression/);
	});
});

describe('loadConfig', () => {
	it('says where the file was expected when there is none', () => {
		expect(() => loadConfig(scratch())).toThrow(/no devkit\.config\.json at /);
	});

	it('says when the file is not JSON', () => {
		const d = scratch();
		writeFileSync(join(d, 'devkit.config.json'), '{ appId: ');
		expect(() => loadConfig(d)).toThrow(/is not JSON/);
	});
});

describe('the shell view', () => {
	it("quotes values for eval and leaves an absent block's values empty", () => {
		const c = parseConfig(fixtureConfig("/s/it's"), '/repo');
		const vars = shellVars(c);
		expect(vars).toContain(`DK_STATE_DIR='/s/it'\\''s'`);
		expect(vars).toContain(`DK_PROOF_WORKFLOW=''`);
		expect(getField(c, 'ci.workflow')).toBe('ci.yml');
		expect(() => getField(c, 'ci.nope')).toThrow(/has no "ci.nope"/);
	});
});
