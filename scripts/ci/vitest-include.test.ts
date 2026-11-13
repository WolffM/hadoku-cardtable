/**
 * Every unit suite the repo tracks is one `vitest run` collects. A package that moves to a directory
 * the root config's `include` does not name keeps passing, with none of its suites run: the layer
 * ratchet and the Forge test selector went blind the same way when a package moved.
 * `e2e/` is out on purpose (node:test and Playwright run it), and `forge/` is Forge's.
 */
import { execFileSync } from 'node:child_process';
import { dirname, join, matchesGlob } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

import config from '../../vitest.config.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

it('collects every tracked *.test.ts outside e2e/ and forge/', () => {
	const include = config.test?.include ?? [];
	const exclude = config.test?.exclude ?? [];
	const tracked = execFileSync('git', ['ls-files', '*.test.ts', '*.test.tsx'], { cwd: ROOT, encoding: 'utf8' })
		.split('\n')
		.filter((f) => f !== '' && !/^(e2e|forge)\//.test(f));
	expect(tracked.length).toBeGreaterThan(100);
	// The packages that moved out of an app are in the list it checks, not only the apps they left.
	for (const dir of ['packages/game-server/', 'packages/game-ui/', 'games/magic/server/', 'games/magic/ui/']) expect(tracked.some((f) => f.startsWith(dir)), dir).toBe(true);
	const missed = tracked.filter((f) => !include.some((g) => matchesGlob(f, g)) || exclude.some((g) => matchesGlob(f, g)));
	expect(missed).toEqual([]);
});
