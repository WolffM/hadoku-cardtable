import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { fixtureConfig, writeConfig } from '../config.testing.ts';
import { buildVersion, newestReleaseFile } from './build-version.ts';

/** A scratch app repo with two releases' notes in its config's releases dir, and one commit. */
const ROOT = mkdtempSync(join(tmpdir(), 'build-version-'));
writeConfig(ROOT, fixtureConfig(join(ROOT, 'state'), { releases: { dir: 'notes' } }));
mkdirSync(join(ROOT, 'notes'));
for (const name of ['v0.9.0.md', 'v0.10.0.md', 'README.md']) writeFileSync(join(ROOT, 'notes', name), '# notes\n');
const git = (...args: string[]) => execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' }).trim();
git('init', '-q');
git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'one');
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe('newestReleaseFile', () => {
	it('compares numerically and ignores anything that is not vX.Y.Z.md', () => {
		expect(newestReleaseFile(['v0.9.0.md', 'v0.10.0.md', 'v0.10.0-rc.md', 'README.md', 'pending'])).toBe('v0.10.0.md');
		expect(newestReleaseFile(['README.md'])).toBeNull();
	});
});

describe('buildVersion', () => {
	it("is the newest release in the config's releases dir plus the commit", () => {
		expect(buildVersion(ROOT, {})).toBe(`v0.10.0+${git('rev-parse', '--short=9', 'HEAD')}`);
	});

	it('takes <envPrefix>_VERSION as it stands, and no other app\'s', () => {
		expect(buildVersion(ROOT, { FIXTURE_VERSION: 'v1.2.3' })).toBe('v1.2.3');
		expect(buildVersion(ROOT, { CARDTABLE_VERSION: 'v1.2.3' })).toMatch(/^v0\.10\.0\+/);
	});
});
