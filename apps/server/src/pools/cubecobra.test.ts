/**
 * Cube Cobra link parsing, and the projection that keeps a mainboard card's
 * `name` + `scryfall_id` and drops everything else — including Cube Cobra's
 * own image fields, checked against a shape verified live against `LSVCube`
 * on 2026-10-21 (`fixtures/lsvcube-sample.json` is the already-trimmed
 * committed fixture `cubes.test.ts` imports through; this file's raw sample
 * below is deliberately UNtrimmed, the way the real API answers, so the strip
 * itself is under test).
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { fetchCubeCobraCube, parseCubeCobraLink, projectCubeCobraCube } from './cubecobra.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(HERE, 'fixtures', 'lsvcube-sample.json');

describe('parseCubeCobraLink', () => {
	it('reads the id out of an overview link', () => {
		const parsed = parseCubeCobraLink('https://cubecobra.com/cube/overview/LSVCube');
		expect(parsed).toEqual({ ok: true, id: 'LSVCube' });
	});

	it('reads the id out of a list link, query string and all', () => {
		const parsed = parseCubeCobraLink('https://cubecobra.com/cube/list/LSVCube?sort=cmc');
		expect(parsed).toEqual({ ok: true, id: 'LSVCube' });
	});

	it('accepts a bare id', () => {
		expect(parseCubeCobraLink('LSVCube')).toEqual({ ok: true, id: 'LSVCube' });
	});

	it('accepts a Mongo-style _id, trimmed', () => {
		expect(parseCubeCobraLink('  a525ebe1-c9c0-471c-aca3-772f91bf4145  ')).toEqual({
			ok: true,
			id: 'a525ebe1-c9c0-471c-aca3-772f91bf4145',
		});
	});

	it('refuses an empty link', () => {
		const parsed = parseCubeCobraLink('   ');
		expect(parsed.ok).toBe(false);
	});

	it('refuses a link to a page this does not recognise', () => {
		const parsed = parseCubeCobraLink('https://cubecobra.com/some/other/page');
		expect(parsed.ok).toBe(false);
	});
});

describe('projectCubeCobraCube', () => {
	it('keeps only name + scryfallId per mainboard card, from the real committed fixture', async () => {
		const raw = JSON.parse(await readFile(FIXTURE_PATH, 'utf8')) as unknown;
		const cube = projectCubeCobraCube(raw, 'fallback');
		expect(cube.name).toBe('LSV Cube (fixture)');
		expect(cube.cards).toHaveLength(36);
		for (const card of cube.cards) {
			expect(Object.keys(card).sort()).toEqual(['name', 'scryfallId']);
			expect(typeof card.name).toBe('string');
			expect(card.name.length).toBeGreaterThan(0);
		}
		expect(cube.cards[0]).toEqual({ name: 'Giver of Runes', scryfallId: '4e117771-5a8b-4812-b487-32ba34b7f724' });
	});

	/**
	 * The real `cubeJSON` response (verified live against `LSVCube`,
	 * 2026-10-21) carries a top-level `image` and, per mainboard card,
	 * `details.image_small` / `image_normal` / `art_crop` and a `tokens[]`
	 * array with its own image fields. None of that is in the committed
	 * fixture above — it was already stripped before being committed — so
	 * THIS is the one place the strip itself is exercised: comment out the
	 * `details` picking in `projectCubeCobraCube` (spread `...details`
	 * instead) and this test is the one that fails.
	 */
	it('strips every image field Cube Cobra sends, mainboard and otherwise (mutation: un-strip and this fails)', () => {
		const raw = {
			name: 'Untrimmed Sample',
			image: { uri: 'https://cubecobra.com/content/cube-cover.png', artist: 'Someone' },
			cards: {
				mainboard: [
					{
						tags: [],
						status: 'Not Owned',
						cardID: '4e117771-5a8b-4812-b487-32ba34b7f724',
						details: {
							name: 'Giver of Runes',
							scryfall_id: '4e117771-5a8b-4812-b487-32ba34b7f724',
							image_small: 'https://cards.scryfall.io/small/front/4/e/4e117771.jpg',
							image_normal: 'https://cards.scryfall.io/normal/front/4/e/4e117771.jpg',
							art_crop: 'https://cards.scryfall.io/art_crop/front/4/e/4e117771.jpg',
							set: 'mh1',
							rarity: 'rare',
							prices: { usd: 9.34 },
						},
					},
				],
				maybeboard: [],
			},
		};
		const cube = projectCubeCobraCube(raw, 'fallback');
		expect(cube.cards).toEqual([{ name: 'Giver of Runes', scryfallId: '4e117771-5a8b-4812-b487-32ba34b7f724' }]);
		const serialised = JSON.stringify(cube);
		expect(serialised).not.toMatch(/image|art_crop|thumbnail|picture/i);
	});

	it('drops a mainboard entry with no resolvable name rather than inventing one', () => {
		const raw = { name: 'X', cards: { mainboard: [{ details: { scryfall_id: 'abc' } }, { details: { name: 'Real Card' } }] } };
		const cube = projectCubeCobraCube(raw, 'fallback');
		expect(cube.cards).toEqual([{ name: 'Real Card', scryfallId: null }]);
	});

	it('refuses a cube with no mainboard cards', () => {
		expect(() => projectCubeCobraCube({ name: 'Empty', cards: { mainboard: [] } }, 'fallback')).toThrow();
	});
});

describe('fetchCubeCobraCube', () => {
	it('builds the cubeJSON URL from the id and hands the response to the projection', async () => {
		const seen: string[] = [];
		const fetchJson = async (url: string): Promise<unknown> => {
			seen.push(url);
			return { name: 'Injected', cards: { mainboard: [{ details: { name: 'Solitude', scryfall_id: '47a6234f-309f-4e03-9263-66da48b57153' } }] } };
		};
		const cube = await fetchCubeCobraCube('LSVCube', fetchJson);
		expect(seen).toEqual(['https://cubecobra.com/cube/api/cubeJSON/LSVCube']);
		expect(cube.cards).toEqual([{ name: 'Solitude', scryfallId: '47a6234f-309f-4e03-9263-66da48b57153' }]);
	});

	it('never touches the network in tests — fetchJson is always injected here', async () => {
		let called = 0;
		const fetchJson = async (): Promise<unknown> => {
			called++;
			return { name: 'X', cards: { mainboard: [{ details: { name: 'Y', scryfall_id: null } }] } };
		};
		await fetchCubeCobraCube('whatever', fetchJson);
		expect(called).toBe(1);
	});
});
