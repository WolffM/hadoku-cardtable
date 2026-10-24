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

import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { LIBRARY, formatIdOf, poolFixturePath, type FormatFamily, type LibraryCollection } from '@hadoku/deck/library';

import { loadTablesLibrary } from './library.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// A slow case's own budget, which must never undercut CI's (vitest.config.ts):
// 20 s here, 60 s on a shared CI runner where the default is already 30 s.
const SLOW_TIMEOUT = process.env.CI ? 60_000 : 20_000;

// @reads decks/
const REPO_ROOT = resolve(HERE, '../../../..');

describe('the picker offers exactly the catalogued eras', () => {
	it('loadTablesLibrary(repoRoot) answers one format per catalogued era id, no more', () => {
		const library = loadTablesLibrary(REPO_ROOT);
		expect(library.faults).toEqual([]);
		// Derived from LIBRARY's own ids, never a hardcoded count: wave 34 pinned
		// "nine" here, and wave 48 (Modern, Legacy, 2003-2007) would have moved that
		// number for no reason connected to this test's actual claim, which is "one
		// format per id, no more, no directory scan". `formatIdOf` is `c.date` for
		// Standard and `<family>-<date>` otherwise (library.ts's doc), so this holds
		// across every family T adds.
		const expectedIds = [...new Set(LIBRARY.map((c) => formatIdOf(c)))];
		expect(library.formats.map((f) => f.id)).toEqual(expectedIds);
	});

	let tempDir: string | null = null;
	afterEach(() => {
		if (tempDir !== null) rmSync(tempDir, { recursive: true, force: true });
		tempDir = null;
	});

	// Copies the whole decks/ tree (46 MB of pools since the library ran to 2025) and loads
	// the library twice, so it gets 20 s rather than the default 5.
	it('a fixture pool under an UNCATALOGUED date never reaches the picker', { timeout: SLOW_TIMEOUT }, () => {
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

		const before = loadTablesLibrary(REPO_ROOT).formats.length;
		const library = loadTablesLibrary(tempDir);
		expect(library.faults).toEqual([]);
		// Same count as the real catalog — the stray file changed nothing.
		expect(library.formats).toHaveLength(before);
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

/*
 * Wave 48 §U: Standard, Modern and Legacy can snapshot the SAME date (§T lines
 * a year's three formats up together), so the format id can no longer be the
 * bare date for anything but Standard, and a pool fixture has to be looked up
 * by (family, date), not date alone. Built against FIXTURE collections, never
 * the real `LIBRARY`, so this exercises the general (family, date) arithmetic
 * rather than whichever eras T has landed so far.
 */
describe('a format id carries its family once Standard, Modern and Legacy share a date (w48 §U)', () => {
	function collection(id: string, family: FormatFamily, date: string): LibraryCollection {
		return { id, directory: `decks/${id}`, event: id, format: id, date, source: 'test', decks: [], family };
	}

	function minimalFixtureJson(date: string): Record<string, unknown> {
		return { date, name: `Test (${date})`, effective: date, source: 'test', sets: ['AAA'], banned: [], cards: ['Test Card'], manaCost: {}, colors: {} };
	}

	let tempDir: string | null = null;
	afterEach(() => {
		if (tempDir !== null) rmSync(tempDir, { recursive: true, force: true });
		tempDir = null;
	});

	it('three families sharing one date resolve to three distinct ids and three distinct pools', () => {
		tempDir = mkdtempSync(join(tmpdir(), 'cardtable-w48-families-'));
		mkdirSync(join(tempDir, 'decks', 'pools'), { recursive: true });
		const SHARED_DATE = '2012-07-13';
		const families: FormatFamily[] = ['standard', 'modern', 'legacy'];
		for (const family of families) {
			writeFileSync(join(tempDir, poolFixturePath(SHARED_DATE, family)), JSON.stringify(minimalFixtureJson(SHARED_DATE)), { flag: 'wx' });
		}
		const library = families.map((family) => collection(`fx-${family}`, family, SHARED_DATE));
		const loaded = loadTablesLibrary(tempDir, library);
		expect(loaded.faults).toEqual([]);
		expect(loaded.formats.map((f) => f.id).sort()).toEqual(['2012-07-13', 'legacy-2012-07-13', 'modern-2012-07-13']);
		expect(loaded.formats.map((f) => f.family).sort()).toEqual(['legacy', 'modern', 'standard']);
		// Each era loaded ITS OWN pool, not a shared one — the three fixture files
		// above are byte-distinct only in which path wrote them, so this proves the
		// path resolution rather than the content.
		for (const f of loaded.formats) expect(f.pool).not.toBeNull();
	});

	it('two collections of the same family and date collapse to one format, like Standard always did', () => {
		tempDir = mkdtempSync(join(tmpdir(), 'cardtable-w48-collapse-'));
		mkdirSync(join(tempDir, 'decks', 'pools'), { recursive: true });
		writeFileSync(join(tempDir, poolFixturePath('2012-07-13', 'modern')), JSON.stringify(minimalFixtureJson('2012-07-13')), { flag: 'wx' });
		const library = [collection('fx-a', 'modern', '2012-07-13'), collection('fx-b', 'modern', '2012-07-13')];
		const loaded = loadTablesLibrary(tempDir, library);
		expect(loaded.faults).toEqual([]);
		expect(loaded.formats.map((f) => f.id)).toEqual(['modern-2012-07-13']);
	});
});
