/**
 * All Random's draw (ruling 4): a random era of the chosen pool's family, or
 * of any family for Full, then two DIFFERENT decks from that one era. Proven
 * against the real catalog where the property is about the catalog, and
 * against a small fixture where it is about the draw itself.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { loadTablesLibrary } from '../http/library.js';
import { drawRandomDeck, drawRandomDecks, randomEras } from './random-decks.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// @reads decks/
const REPO_ROOT = resolve(HERE, '../../../..');

/** A seeded uniform [0,1) (mulberry32), so a draw can be pinned. */
function seeded(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const FIXTURE = {
	formats: [
		{ id: '2010-07-01', family: 'standard' as const },
		{ id: '2011-07-01', family: 'standard' as const },
		{ id: 'modern-2015-07-01', family: 'modern' as const },
		{ id: 'legacy-2015-07-01', family: 'legacy' as const },
	],
	decks: [
		{ id: 'a', era: '2010-07-01' },
		{ id: 'b', era: '2010-07-01' },
		{ id: 'c', era: '2010-07-01' },
		// An era with one deck cannot give two players different decks.
		{ id: 'lonely', era: '2011-07-01' },
		{ id: 'm1', era: 'modern-2015-07-01' },
		{ id: 'm2', era: 'modern-2015-07-01' },
		{ id: 'l1', era: 'legacy-2015-07-01' },
		{ id: 'l2', era: 'legacy-2015-07-01' },
	],
};

describe('drawRandomDecks', () => {
	const library = loadTablesLibrary(REPO_ROOT);

	it('draws two different decks from one era of the chosen family, on the real catalog', () => {
		expect(library.faults).toEqual([]);
		for (const pool of ['standard', 'modern', 'legacy'] as const) {
			for (let seed = 0; seed < 40; seed++) {
				const draw = drawRandomDecks(seeded(seed), pool, library);
				expect(draw, `${pool} seed ${seed}`).not.toBeNull();
				const [a, b] = draw!.decks;
				expect(a).not.toBe(b);
				expect(library.format(draw!.era)?.family).toBe(pool);
				expect(library.deck(a)?.era).toBe(draw!.era);
				expect(library.deck(b)?.era).toBe(draw!.era);
			}
		}
	});

	it('Full spans every family the catalog holds', () => {
		const families = new Set<string>();
		for (let seed = 0; seed < 200; seed++) {
			const draw = drawRandomDecks(seeded(seed), 'full', library)!;
			families.add(library.format(draw.era)!.family);
		}
		expect([...families].sort()).toEqual([...new Set(library.formats.map((f) => f.family))].sort());
	});

	it('a seeded random gives a stable draw', () => {
		expect(drawRandomDecks(seeded(7), 'full', library)).toEqual(drawRandomDecks(seeded(7), 'full', library));
		expect(drawRandomDecks(() => 0, 'standard', FIXTURE)).toEqual({ era: '2010-07-01', decks: ['a', 'b'] });
		expect(drawRandomDecks(() => 0.99, 'standard', FIXTURE)).toEqual({ era: '2010-07-01', decks: ['c', 'b'] });
	});

	it('never draws an era with fewer than two decks', () => {
		expect(randomEras('standard', FIXTURE).map((f) => f.id)).toEqual(['2010-07-01']);
		for (let seed = 0; seed < 100; seed++) expect(drawRandomDecks(seeded(seed), 'full', FIXTURE)!.era).not.toBe('2011-07-01');
	});

	it('answers null when no era of the pool can seat two decks', () => {
		expect(drawRandomDecks(() => 0.5, 'modern', { formats: FIXTURE.formats, decks: FIXTURE.decks.filter((d) => d.id !== 'm2') })).toBeNull();
	});
});

/** `drawRandomDeck` (singular, tournament lock): one random deck for ONE player, from an era needing only one deck, not two. */
describe('drawRandomDeck', () => {
	const library = loadTablesLibrary(REPO_ROOT);

	it('draws one deck from an era of the chosen family, on the real catalog', () => {
		for (const pool of ['standard', 'modern', 'legacy'] as const) {
			for (let seed = 0; seed < 20; seed++) {
				const draw = drawRandomDeck(seeded(seed), pool, library);
				expect(draw, `${pool} seed ${seed}`).not.toBeNull();
				expect(library.format(draw!.era)?.family).toBe(pool);
				expect(library.deck(draw!.deckId)?.era).toBe(draw!.era);
			}
		}
	});

	it('draws from an era with only ONE deck, unlike the pairwise draw', () => {
		expect(randomEras('standard', FIXTURE, 1).map((f) => f.id)).toEqual(['2010-07-01', '2011-07-01']);
		const draw = drawRandomDeck(() => 0, 'standard', { formats: FIXTURE.formats, decks: FIXTURE.decks.filter((d) => d.era === '2011-07-01') });
		expect(draw).toEqual({ era: '2011-07-01', deckId: 'lonely' });
	});

	it('answers null when no era of the pool holds any deck', () => {
		expect(drawRandomDeck(() => 0.5, 'legacy', { formats: FIXTURE.formats, decks: FIXTURE.decks.filter((d) => !d.id.startsWith('l')) })).toBeNull();
	});
});
