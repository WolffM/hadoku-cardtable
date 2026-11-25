/**
 * The boot verdict against real files on disk, served by real express.
 * A superset of the app-bound pin test (`packages/game-server/src/base-path.test.ts`):
 * this one is generic over the app's own name and embed-entry filenames.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { checkBasePath, checkBundle, diagnosticPage, isEmbedEntry, probeIndex } from './index.ts';

const PREFIX = '/some-game';
const INDEX = `<!doctype html><html><head><script type="module" src="${PREFIX}/assets/app.js"></script></head><body></body></html>`;

let root: string;
let plain: string;
let dotted: string;

function fixture(dir: string): string {
	mkdirSync(dir, { recursive: true });
	const file = join(dir, 'index.html');
	writeFileSync(file, INDEX);
	return file;
}

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), 'kernel-base-path-'));
	const segments = root.split(sep);
	expect(segments.filter((s) => s.startsWith('.'))).toEqual([]);

	plain = fixture(join(root, 'repo', 'apps', 'ui', 'dist'));
	dotted = fixture(join(root, 'repo', '.worktrees', 'w', 'apps', 'ui', 'dist'));
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

describe('reading is not serving', () => {
	it('checkBasePath alone passes BOTH trees — that is the trap', () => {
		expect(checkBasePath(plain, PREFIX).ok).toBe(true);
		expect(checkBasePath(dotted, PREFIX).ok).toBe(true);
	});

	it('sendIndex (via probeIndex) serves both: a dot-directory above the bundle (an agent worktree) is no bar', async () => {
		expect(await probeIndex(plain)).toBe(200);
		// It used to 404 here: `send` refused the whole absolute path for its `.worktrees` segment.
		expect(await probeIndex(dotted)).toBe(200);
	});
});

describe('checkBundle', () => {
	it('is ok for a bundle outside any dot-directory', async () => {
		const verdict = await checkBundle(plain, PREFIX);
		expect(verdict.ok).toBe(true);
		expect(verdict.reason).toBe('ok');
	});

	it('is ok under a dot-directory too: an agent worktree serves its own bundle', async () => {
		const verdict = await checkBundle(dotted, PREFIX);
		expect(verdict.ok).toBe(true);
		expect(verdict.reason).toBe('ok');
	});

	it('still reports the cheaper failures first: missing, then unprefixed', async () => {
		expect((await checkBundle(join(root, 'nowhere', 'index.html'), PREFIX)).reason).toBe('missing');

		const bare = join(root, 'bare');
		mkdirSync(bare, { recursive: true });
		writeFileSync(join(bare, 'index.html'), '<script src="/assets/app.js"></script>');
		const verdict = await checkBundle(join(bare, 'index.html'), PREFIX);
		expect(verdict.reason).toBe('unprefixed');
		expect(verdict.offenders).toEqual(['/assets/app.js']);
	});
});

describe('diagnosticPage: generic over the app that binds it', () => {
	it('titles and headlines the page with the app-supplied name, never a fixed one', () => {
		const verdict = { ok: false, reason: 'unprefixed' as const, offenders: ['/assets/app.js'], detail: 'detail text' };
		const page = diagnosticPage(verdict, PREFIX, 'Bomberman');
		expect(page).toContain('<title>Bomberman — not serving</title>');
		expect(page).toContain('Bomberman is running, but its bundle would not load');
		expect(page).toContain('Served by the bomberman loopback server');
		expect(page).toContain(PREFIX);
		expect(page).toContain('/assets/app.js');
	});

	it('escapes the app name and the verdict detail against HTML injection', () => {
		const verdict = { ok: false, reason: 'missing' as const, offenders: [], detail: '<script>bad</script>' };
		const page = diagnosticPage(verdict, PREFIX, '<b>Game</b>');
		expect(page).not.toContain('<script>bad</script>');
		expect(page).toContain('&lt;script&gt;bad&lt;/script&gt;');
		expect(page).not.toContain('<b>Game</b></title>');
	});
});

describe('isEmbedEntry: generic over the app-supplied embed filenames', () => {
	it('matches only the app-supplied names, under an "embed" directory', () => {
		const entries = ['bomberman-embed.js', 'bomberman-embed.css'];
		expect(isEmbedEntry(join('dist', 'embed', 'bomberman-embed.js'), entries)).toBe(true);
		expect(isEmbedEntry(join('dist', 'embed', 'bomberman-embed.css'), entries)).toBe(true);
		expect(isEmbedEntry(join('dist', 'embed', 'cardtable-embed.js'), entries)).toBe(false);
		expect(isEmbedEntry(join('dist', 'assets', 'bomberman-embed.js'), entries)).toBe(false);
	});

	it('always matches the embed manifest, which keeps its name across releases', () => {
		expect(isEmbedEntry(join('dist', 'embed', 'manifest.json'), [])).toBe(true);
		expect(isEmbedEntry(join('dist', 'embed', 'assets', 'manifest.json'), [])).toBe(false);
		expect(isEmbedEntry(join('dist', 'manifest.json'), [])).toBe(false);
	});
});
