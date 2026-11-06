import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pinnedJar } from './warm-bridges.ts';

/** A tree recording `pin` as its forge submodule, and a HOME holding the given jars. */
function fixture(pin: string, jars: { pinned?: boolean; fallback?: boolean }) {
	const root = mkdtempSync(join(tmpdir(), 'warm-bridges-'));
	const tree = join(root, 'tree');
	mkdirSync(tree);
	const git = (...args: string[]) => execFileSync('git', ['-C', tree, ...args], { encoding: 'utf8' });
	git('init', '-q');
	git('update-index', '--add', '--cacheinfo', `160000,${pin},forge`);
	git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'pin');
	const home = join(root, 'home');
	const share = join(home, '.local', 'share', 'cardtable');
	mkdirSync(join(share, 'jars'), { recursive: true });
	if (jars.pinned) writeFileSync(join(share, 'jars', `${pin}.jar`), '');
	if (jars.fallback) writeFileSync(join(share, 'forge.jar'), '');
	return { tree, home, share };
}

const PIN = 'd3601870534de5dc9313a9c1b152dcb481906c45';

describe('pinnedJar', () => {
	it("is the jar built for the tree's forge pin, as the wrapper resolves it", () => {
		const f = fixture(PIN, { pinned: true, fallback: true });
		expect(pinnedJar(f.tree, { HOME: f.home })).toBe(join(f.share, 'jars', `${PIN}.jar`));
	});

	it('falls back to forge.jar when no jar was built for the pin, and is null with neither', () => {
		const f = fixture(PIN, { fallback: true });
		expect(pinnedJar(f.tree, { HOME: f.home })).toBe(join(f.share, 'forge.jar'));
		const none = fixture(PIN, {});
		expect(pinnedJar(none.tree, { HOME: none.home })).toBeNull();
	});

	it('is CARDTABLE_FORGE_JAR when that is set', () => {
		const f = fixture(PIN, { pinned: true });
		expect(pinnedJar(f.tree, { HOME: f.home, CARDTABLE_FORGE_JAR: '/opt/forge.jar' })).toBe('/opt/forge.jar');
	});
});
