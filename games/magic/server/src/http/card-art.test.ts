// @reads e2e/fixtures/sets-catalog.json
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import express from 'express';
import { ALLOWED_ART_HOSTS } from '@hadoku/carddata/art';
import { describe, expect, it } from 'vitest';

import { loadCardCatalog } from '../pools/catalog.js';
import { createArtIds } from '../play/art-ids.js';
import type { ArtKeys } from '../pools/art-keys.js';
import { attachCardArt, namedArt } from './card-art.js';

const ART = createArtIds(loadCardCatalog(resolve(import.meta.dirname, '../../../../../e2e/fixtures/sets-catalog.json')));

describe('the art of a card known only by its name', () => {
	it('is the id the server would stamp, with the faces drawn as its back; a name with none is left out', () => {
		expect(namedArt(['Akrasan Squire', 'Civilized Scholar', 'Not A Card Anyone Printed', 'Akrasan Squire'], ART)).toEqual({
			'Akrasan Squire': { scryfallId: '59fdc045-b938-4321-aec3-51685cbbaa52' },
			'Civilized Scholar': { scryfallId: '7bf864db-4754-433d-9d77-6695f78f6c09', backs: ['Homicidal Brute'] },
		});
	});

	it('a card asked for by name and set is the printing that set names, keyed by what was asked', () => {
		const art = namedArt(['Plains|ALA', 'Plains', 'Akrasan Squire|ALA'], ART);
		expect(art['Plains|ALA']).toEqual(ART.card('Plains', 'ALA'));
		expect(art['Plains|ALA']).not.toEqual(art.Plains);
		// A card only the catalog knows, found by its set there.
		expect(art['Akrasan Squire|ALA']).toEqual({ scryfallId: '59fdc045-b938-4321-aec3-51685cbbaa52' });
	});
});

describe('GET /api/art/<id>: where every card image comes from', () => {
	const ID = '59fdc045-b938-4321-aec3-51685cbbaa52';
	const KEY = `${'e'.repeat(64)}.jpg`;
	const keys: ArtKeys = { keyFor: (id) => (id === ID || id === `${ID}#back` ? KEY : undefined), settled: async () => undefined };

	async function get(path: string): Promise<Response> {
		const api = express.Router();
		attachCardArt(api, { art: ART, keys });
		const app = express().use('/api', api);
		const server = app.listen(0);
		try {
			const { port } = server.address() as AddressInfo;
			return await fetch(`http://127.0.0.1:${port}${path}`, { redirect: 'manual' });
		} finally {
			server.close();
		}
	}

	it('sends a mirrored card to our CDN copy, front and back, cached a day', async () => {
		for (const path of [`/api/art/${ID}`, `/api/art/${ID}/back`]) {
			const res = await get(path);
			expect([res.status, res.headers.get('location'), res.headers.get('cache-control')]).toEqual([302, `https://cdn.hadoku.me/${KEY}`, 'private, max-age=86400']);
		}
	});

	it("sends a card the mirror lacks, or a size it does not copy, to Scryfall's image", async () => {
		const other = '7bf864db-4754-433d-9d77-6695f78f6c09';
		expect((await get(`/api/art/${other}/back`)).headers.get('location')).toBe(`https://cards.scryfall.io/normal/back/7/b/${other}.jpg`);
		expect((await get(`/api/art/${ID}?size=small`)).headers.get('location')).toBe(`https://cards.scryfall.io/small/front/5/9/${ID}.jpg`);
	});

	it('only ever sends a browser to an allowed art host, never to our own origin', async () => {
		const allowed = new Set(ALLOWED_ART_HOSTS.map((h) => (h.includes('://') ? new URL(h).origin : `https://${h}`)));
		for (const path of [`/api/art/${ID}`, `/api/art/${ID}/back`, `/api/art/${ID}?size=large`, '/api/art/7bf864db-4754-433d-9d77-6695f78f6c09']) {
			const location = (await get(path)).headers.get('location') as string;
			expect(allowed.has(new URL(location).origin), location).toBe(true);
		}
	});

	it('answers 404 for anything that is not a card id or a size', async () => {
		expect((await get('/api/art/not-an-id')).status).toBe(404);
		expect((await get(`/api/art/${ID}?size=huge`)).status).toBe(404);
	});
});
