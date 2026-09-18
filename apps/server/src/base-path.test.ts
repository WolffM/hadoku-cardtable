/**
 * The boot verdict against real files on disk, served by real express.
 *
 * The trap this pins: `checkBasePath` READS index.html with `readFileSync`,
 * the SPA fallback SERVES it with `res.sendFile`, and the two disagree about a
 * path with a dot-segment in it — `send`'s `dotfiles: 'ignore'` refuses it, so
 * every page 404s while a read-only check says all is well. Two fixture trees,
 * identical but for one `.`-prefixed directory, and one invariant over both:
 * the verdict is `ok` exactly when `sendIndex` answers 200.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { checkBasePath, checkBundle, probeIndex } from './base-path.js';

const PREFIX = '/cardtable';
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
	root = mkdtempSync(join(tmpdir(), 'cardtable-base-path-'));
	// The whole test rests on the plain tree having NO dot-segment anywhere in
	// its absolute path. A TMPDIR under a dot-directory would make both trees
	// unservable and the comparison meaningless — so say so, rather than pass.
	const segments = root.split(sep);
	expect(segments.filter((s) => s.startsWith('.'))).toEqual([]);

	plain = fixture(join(root, 'repo', 'apps', 'ui', 'dist'));
	dotted = fixture(join(root, 'repo', '.claude', 'worktrees', 'w', 'apps', 'ui', 'dist'));
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

describe('reading is not serving', () => {
	it('checkBasePath alone passes BOTH trees — that is the trap', () => {
		expect(checkBasePath(plain, PREFIX).ok).toBe(true);
		expect(checkBasePath(dotted, PREFIX).ok).toBe(true);
	});

	it('sendIndex serves the plain tree and refuses the dotted one', async () => {
		expect(await probeIndex(plain)).toBe(200);
		expect(await probeIndex(dotted)).toBe(404);
	});
});

describe('checkBundle', () => {
	it('is ok for a bundle outside any dot-directory', async () => {
		const verdict = await checkBundle(plain, PREFIX);
		expect(verdict.ok).toBe(true);
		expect(verdict.reason).toBe('ok');
	});

	it('is unservable under a dot-directory, and names the segment', async () => {
		const verdict = await checkBundle(dotted, PREFIX);
		expect(verdict.ok).toBe(false);
		expect(verdict.reason).toBe('unservable');
		expect(verdict.detail).toContain('.claude');
		expect(verdict.detail).toContain('404');
	});

	it('never says ok while sendIndex would not answer 200', async () => {
		for (const file of [plain, dotted]) {
			const [verdict, status] = await Promise.all([checkBundle(file, PREFIX), probeIndex(file)]);
			expect({ file, ok: verdict.ok }).toEqual({ file, ok: status === 200 });
		}
	});

	it('still reports the cheaper failures first', async () => {
		expect((await checkBundle(join(root, 'nowhere', 'index.html'), PREFIX)).reason).toBe('missing');

		const bare = join(root, 'bare');
		mkdirSync(bare, { recursive: true });
		writeFileSync(join(bare, 'index.html'), '<script src="/assets/app.js"></script>');
		const verdict = await checkBundle(join(bare, 'index.html'), PREFIX);
		expect(verdict.reason).toBe('unprefixed');
		expect(verdict.offenders).toEqual(['/assets/app.js']);
	});
});
