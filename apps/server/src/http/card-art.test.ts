// @reads e2e/fixtures/sets-catalog.json
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadCardCatalog } from '../pools/catalog.js';
import { createArtIds } from '../play/art-ids.js';
import { namedArt } from './card-art.js';

const ART = createArtIds(loadCardCatalog(resolve(import.meta.dirname, '../../../../e2e/fixtures/sets-catalog.json')));

describe('the art of a card known only by its name', () => {
	it('is the id the server would stamp, with the faces drawn as its back; a name with none is left out', () => {
		expect(namedArt(['Akrasan Squire', 'Civilized Scholar', 'Not A Card Anyone Printed', 'Akrasan Squire'], ART)).toEqual({
			'Akrasan Squire': { scryfallId: '59fdc045-b938-4321-aec3-51685cbbaa52' },
			'Civilized Scholar': { scryfallId: '7bf864db-4754-433d-9d77-6695f78f6c09', backs: ['Homicidal Brute'] },
		});
	});
});
