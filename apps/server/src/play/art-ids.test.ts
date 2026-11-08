// @reads e2e/fixtures/sets-catalog.json apps/server/src/play/art-ids.json
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadCardCatalog } from '../pools/catalog.js';
import { createArtIds } from './art-ids.js';
import TABLE from './art-ids.json' with { type: 'json' };

/** The e2e stack's own committed catalog (ISD, ALA, ARB): never the host's. */
const CATALOG = loadCardCatalog(resolve(import.meta.dirname, '../../../../e2e/fixtures/sets-catalog.json'));

const SQUIRE_ALA_1 = '59fdc045-b938-4321-aec3-51685cbbaa52';
const SCHOLAR_ISD = '7bf864db-4754-433d-9d77-6695f78f6c09';

describe('which Scryfall id a card is', () => {
	it('a set-draft card no committed table holds: from the catalog, by the printing its deck names', () => {
		const ids = createArtIds(CATALOG, ['[main]\n1 Akrasan Squire|ALA|1|[1]\n']);
		expect(ids.face({ name: 'Akrasan Squire', set: 'ALA' })).toEqual({ scryfallId: SQUIRE_ALA_1 });
		expect(createArtIds(null).face({ name: 'Akrasan Squire', set: 'ALA' }), 'the table alone never knew it').toBeUndefined();
	});

	it("a deck's own printing wins over the set's lowest-numbered one", () => {
		const plains = { name: 'Plains', set: 'ALA' };
		expect(createArtIds(CATALOG, ['[main]\n17 Plains|ALA|1|[232]\n']).face(plains)?.scryfallId).toBe('bcdd1595-d94d-46b1-b87f-b910ae35fa3a');
		// No collector: the committed table's row for Plains|ALA, as the board always drew it.
		expect(createArtIds(CATALOG).face(plains)?.scryfallId).toBe('e94e2710-7b95-46d0-8261-0afa6b192e70');
	});

	it('a set the catalog has no printing in: any printing of the name', () => {
		expect(createArtIds(CATALOG).card('Akrasan Squire', 'M10')).toEqual({ scryfallId: SQUIRE_ALA_1 });
		expect(createArtIds(CATALOG).card('Akrasan Squire')).toEqual({ scryfallId: SQUIRE_ALA_1 });
	});

	it("a transformed card's back is its front's printing, as its back image", () => {
		const ids = createArtIds(CATALOG, ['[main]\n1 Civilized Scholar|ISD|1|[47]\n']);
		expect(ids.face({ name: 'Homicidal Brute', set: 'ISD', front: 'Civilized Scholar' })).toEqual({ scryfallId: `${SCHOLAR_ISD}#back` });
		expect(ids.face({ name: 'Civilized Scholar', set: 'ISD', front: 'Civilized Scholar' })).toEqual({ scryfallId: SCHOLAR_ISD });
		expect(ids.images('Civilized Scholar', 'ISD'), 'a preload warms the back beside the front').toEqual([SCHOLAR_ISD, `${SCHOLAR_ISD}#back`]);
	});

	it("a token by its tokenscript, never its shared name; an effect by its source's image key; an emblem by its card", () => {
		const ids = createArtIds(CATALOG);
		const wurm = (script: string) => ids.face({ name: 'Phyrexian Wurm Token', set: '2XM', imageKey: `t:${script}|2XM|30|1` })?.scryfallId;
		expect(wurm('c_3_3_a_phyrexian_wurm_lifelink')).toBe(TABLE.ids['t:c_3_3_a_phyrexian_wurm_lifelink|2XM']);
		expect(wurm('c_3_3_a_phyrexian_wurm_deathtouch')).toBe(TABLE.ids['t:c_3_3_a_phyrexian_wurm_deathtouch|2XM']);
		expect(wurm('c_3_3_a_phyrexian_wurm_lifelink')).not.toBe(wurm('c_3_3_a_phyrexian_wurm_deathtouch'));
		expect(ids.face({ name: "Akrasan Squire's Effect", set: 'ALA', imageKey: 'c:Akrasan Squire|ALA|1' })).toEqual({ scryfallId: SQUIRE_ALA_1 });
		expect(ids.face({ name: 'Emblem — Akrasan Squire', set: 'ALA' })).toEqual({ scryfallId: SQUIRE_ALA_1 });
	});

	it("a card the decks name is drawn as the deck's own line names it, whatever set Forge reports", () => {
		// Forge reports a set of its own for a printing it could not find: the deck's line still decides.
		expect(createArtIds(CATALOG, ['[main]\n17 Plains|ALA|1|[232]\n']).face({ name: 'Plains', set: 'M10' })?.scryfallId).toBe('bcdd1595-d94d-46b1-b87f-b910ae35fa3a');
		expect(createArtIds(CATALOG, ['[main]\n17 Plains|ALA\n']).face({ name: 'Plains', set: 'M10' })?.scryfallId).toBe('e94e2710-7b95-46d0-8261-0afa6b192e70');
	});

	it("a library deck's card: what a peek or the sideboard step asks for by name and set is what the board stamps", () => {
		const deck = '[main]\n17 Plains|ALA\n4 Akrasan Squire|ALA\n[sideboard]\n2 Civilized Scholar|ISD\n';
		const board = createArtIds(CATALOG, [deck]);
		const lookup = createArtIds(CATALOG);
		for (const [name, set] of [['Plains', 'ALA'], ['Akrasan Squire', 'ALA'], ['Civilized Scholar', 'ISD']] as const) {
			expect(lookup.card(name, set), name).toEqual(board.face({ name, set }));
		}
		// The name alone finds another printing: why the browser asks with the set.
		expect(lookup.card('Plains')).not.toEqual(board.face({ name: 'Plains', set: 'ALA' }));
	});

	it('a card nobody knows, and a face with no name, have none', () => {
		expect(createArtIds(CATALOG).face({ name: 'Not A Card Anyone Printed', set: 'XYZ' })).toBeUndefined();
		expect(createArtIds(CATALOG).face({ name: '', set: 'ALA' })).toBeUndefined();
	});
});
