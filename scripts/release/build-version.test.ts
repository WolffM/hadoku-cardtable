import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildVersion, newestReleaseFile } from './build-version.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

describe('newestReleaseFile', () => {
	it('compares numerically and ignores anything that is not vX.Y.Z.md', () => {
		expect(newestReleaseFile(['v0.9.0.md', 'v0.10.0.md', 'v0.10.0-rc.md', 'README.md', 'pending'])).toBe('v0.10.0.md');
		expect(newestReleaseFile(['README.md'])).toBeNull();
	});
});

describe('buildVersion', () => {
	it('is the newest release in the tree plus the commit', () => {
		const sha = execFileSync('git', ['-C', ROOT, 'rev-parse', '--short=9', 'HEAD'], { encoding: 'utf8' }).trim();
		expect(buildVersion(ROOT, {})).toMatch(new RegExp(`^v\\d+\\.\\d+\\.\\d+\\+${sha}$`));
	});

	it('takes CARDTABLE_VERSION as it stands', () => {
		expect(buildVersion(ROOT, { CARDTABLE_VERSION: 'v1.2.3' })).toBe('v1.2.3');
	});
});
