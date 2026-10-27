import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import { sha256Hex } from '../../server/src/play/remote/wire.ts';
import { KEEP_PER_KIND, Store } from './store.ts';

const dirs: string[] = [];
const scratch = (): string => {
	const d = mkdtempSync(join(tmpdir(), 'agent-store-'));
	dirs.push(d);
	return d;
};
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A gzipped tarball of one directory holding `file` = `text`. */
function tarball(where: string, name: string, text: string): { bytes: Buffer; sha: string } {
	mkdirSync(join(where, name), { recursive: true });
	writeFileSync(join(where, name, 'file'), text);
	const out = spawnSync('tar', ['-czf', '-', '-C', where, name]);
	return { bytes: out.stdout, sha: sha256Hex(out.stdout) };
}

describe('artifact store', () => {
	it('keeps a blob only when its bytes hash to its name', async () => {
		const store = new Store(scratch());
		const bytes = Buffer.from('a jar');
		await expect(store.put(sha256Hex('another jar'), Readable.from([bytes]))).rejects.toThrow(/hashed to/);
		expect(store.has(sha256Hex('another jar'))).toBe(false);
		await store.put(sha256Hex(bytes), Readable.from([bytes]));
		expect(store.has(sha256Hex(bytes))).toBe(true);
	});

	it('hashes a blob again before installing it, and deletes one that changed on disk', async () => {
		const home = scratch();
		const store = new Store(home);
		const bytes = Buffer.from('a jar');
		const sha = sha256Hex(bytes);
		await store.put(sha, Readable.from([bytes]));
		writeFileSync(join(home, 'blobs', sha), 'swapped by someone else');
		await expect(store.install('jar', sha)).rejects.toThrow(/hashes to/);
		expect(existsSync(join(home, 'blobs', sha))).toBe(false);
		expect(store.installed('jar', sha)).toBeNull();
	});

	it('unpacks a tarball kind, drops its blob, and keeps the newest two of a kind plus any in use', async () => {
		const home = scratch();
		const src = scratch();
		let now = 1;
		const store = new Store(home, () => now++);
		const made = ['one', 'two', 'three', 'four'].map((n) => tarball(src, `res-${n}`, n));
		for (const t of made) {
			await store.put(t.sha, Readable.from([t.bytes]));
			const at = await store.install('res', t.sha, [{ jdk: 'x', jar: 'x', bridge: 'x', res: made[0]!.sha }]);
			expect(existsSync(join(at, 'file'))).toBe(true);
			expect(store.has(t.sha)).toBe(false);
		}
		// The first is in use by a live JVM; of the rest, the newest KEEP_PER_KIND stay.
		const kept = store.list().res.map((e) => e.sha);
		expect(KEEP_PER_KIND).toBe(2);
		expect(kept.sort()).toEqual([made[0]!.sha, made[2]!.sha, made[3]!.sha].sort());
		expect(readdirSync(join(home, 'res')).sort()).toEqual(kept.sort());
	});
});
