import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mirrorLine } from '@hadoku/carddata/art/mirror';

import { loadArtKeys } from './art-keys.ts';

const A = '11bf83bb-c95b-4b4f-9a56-ce7a1816307a';
const B = '6f1c8cb0-38eb-408b-94e8-16db83999b3b';
const key = (c: string): string => `${c.repeat(64)}.jpg`;

describe('art keys', () => {
	let dir: string;
	let mirrorPath: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'art-keys-test-'));
		mirrorPath = join(dir, 'mirror.jsonl');
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it('answers the mirror log’s key, a back face by its own id, and nothing for a card never copied', async () => {
		await writeFile(mirrorPath, mirrorLine({ id: A, key: key('a') }) + mirrorLine({ id: `${A}#back`, key: key('b') }));
		const keys = loadArtKeys({ mirrorPath, manifest: {} });
		expect([keys.keyFor(A), keys.keyFor(`${A}#back`), keys.keyFor(B)]).toEqual([key('a'), key('b'), undefined]);
	});

	it('a manifest row wins: a cdn row names its key, a scryfall row pins the card upstream', async () => {
		await writeFile(mirrorPath, mirrorLine({ id: A, key: key('a') }) + mirrorLine({ id: B, key: key('b') }));
		const keys = loadArtKeys({ mirrorPath, manifest: { [A]: { source: 'cdn', key: key('c') }, [B]: { source: 'scryfall' } } });
		expect([keys.keyFor(A), keys.keyFor(B)]).toEqual([key('c'), undefined]);
	});

	it('takes the lines the mirror appends while it runs, in the background, and waits for a torn last line to finish', async () => {
		await writeFile(mirrorPath, mirrorLine({ id: A, key: key('a') }));
		let clock = 0;
		const keys = loadArtKeys({ mirrorPath, manifest: {}, recheckMs: 1000, now: () => clock });
		const line = mirrorLine({ id: B, key: key('b') });
		await appendFile(mirrorPath, line.slice(0, 20));
		clock = 1000;
		expect(keys.keyFor(B)).toBeUndefined();
		await keys.settled();
		expect(keys.keyFor(B)).toBeUndefined();
		await appendFile(mirrorPath, line.slice(20));
		expect(keys.keyFor(B)).toBeUndefined();
		clock = 2000;
		keys.keyFor(B);
		await keys.settled();
		expect(keys.keyFor(B)).toBe(key('b'));
		expect(keys.keyFor(A)).toBe(key('a'));
	});

	it('serves Scryfall for every card while there is no log yet', () => {
		expect(loadArtKeys({ mirrorPath, manifest: {} }).keyFor(A)).toBeUndefined();
	});
});
