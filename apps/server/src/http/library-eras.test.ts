/**
 * Wave 34 §D: the picker offers exactly the nine catalogued power-summer eras
 * — never a stray file that happens to sit in `decks/pools/`.
 *
 * Before this wave, `loadTablesLibrary` `readdirSync`'d the whole pools
 * directory and offered every `standard-<date>.generated.json` it found as a
 * format. That is how the operator once saw nine "eras" that were really one
 * 18-month window, including `2011-07-01` — a TEST fixture
 * (`build-pool-fixture.ts`'s header: frozen to demonstrate the Jace/Stoneforge
 * ban path on real data, never meant to be played in). `library.ts` now reads
 * pool fixtures ONLY for the dates `LIBRARY`'s own collections name, so a file
 * dropped into that directory under an uncatalogued date cannot reach the
 * picker no matter what it is called.
 *
 * This is proven with a real fixture pool (a byte-for-byte copy of a committed
 * one, so it is real data and not a contrivance — only its `date` field and
 * filename are uncatalogued) dropped into a TEMP copy of `decks/`, never by
 * touching the real repo's files.
 */

import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { LIBRARY, poolFixturePath } from '@hadoku/deck/library';

import { loadTablesLibrary } from './library.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../..');

describe('the picker offers exactly the nine catalogued eras', () => {
	it('loadTablesLibrary(repoRoot) answers nine formats, one per era, no more', () => {
		const library = loadTablesLibrary(REPO_ROOT);
		expect(library.faults).toEqual([]);
		expect(library.formats).toHaveLength(9);
		expect(library.formats.map((f) => f.id)).toEqual(LIBRARY.map((c) => c.date));
	});

	let tempDir: string | null = null;
	afterEach(() => {
		if (tempDir !== null) rmSync(tempDir, { recursive: true, force: true });
		tempDir = null;
	});

	it('a fixture pool under an UNCATALOGUED date never reaches the picker', () => {
		// A temp copy of the real decks/ tree — real data, never the repo's own files.
		tempDir = mkdtempSync(join(tmpdir(), 'cardtable-w34-eras-'));
		cpSync(resolve(REPO_ROOT, 'decks'), join(tempDir, 'decks'), { recursive: true });

		// One MORE fixture, under a date no collection in LIBRARY names. Its
		// CONTENT is a real frozen pool, byte-for-byte — only the filename (and
		// therefore the `date` field inside it) is uncatalogued, which is exactly
		// the 2011-07-01 shape this wave removed: real pool data, no collection
		// claims it.
		const real = JSON.parse(readFileSync(resolve(REPO_ROOT, poolFixturePath(LIBRARY[0]!.date)), 'utf8')) as Record<string, unknown>;
		const strayDate = '1999-01-01';
		const stray = { ...real, date: strayDate };
		writeFileSync(join(tempDir, poolFixturePath(strayDate)), JSON.stringify(stray), 'utf8');

		const library = loadTablesLibrary(tempDir);
		expect(library.faults).toEqual([]);
		// Still exactly nine — the stray file changed nothing.
		expect(library.formats).toHaveLength(9);
		expect(library.formats.map((f) => f.id)).not.toContain(strayDate);
	});

	it('mutation check: a directory-scanning loader WOULD have offered the stray fixture', () => {
		// Same setup as above, proving the fixture itself is well-formed and that
		// the previous behaviour (`readdirSync` of the whole pools directory) is
		// exactly what this test would catch a regression back to.
		tempDir = mkdtempSync(join(tmpdir(), 'cardtable-w34-eras-mut-'));
		cpSync(resolve(REPO_ROOT, 'decks'), join(tempDir, 'decks'), { recursive: true });
		const real = JSON.parse(readFileSync(resolve(REPO_ROOT, poolFixturePath(LIBRARY[0]!.date)), 'utf8')) as Record<string, unknown>;
		const strayDate = '1999-01-01';
		writeFileSync(join(tempDir, poolFixturePath(strayDate)), JSON.stringify({ ...real, date: strayDate }), 'utf8');

		// The directory-scan a pre-wave-34 loader did, inlined rather than
		// imported, so this assertion does not depend on `library.ts` staying
		// vulnerable to prove the fixture is real: any `standard-*.generated.json`
		// in the pools dir, found by name alone.
		const POOL_FILE = /^standard-(\d{4}-\d{2}-\d{2})\.generated\.json$/;
		const files = readdirSync(join(tempDir, 'decks', 'pools')).filter((f) => POOL_FILE.test(f));
		const datesADirectoryScanWouldOffer = files.map((f) => POOL_FILE.exec(f)![1]);
		expect(datesADirectoryScanWouldOffer).toContain(strayDate);
	});
});
