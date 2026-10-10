import { describe, expect, it } from 'vitest';

import { COVER_CARD, coverUrl } from './cover.js';

describe('the game-picker cover', () => {
	it("is the cover card's artwork alone, from Scryfall while the manifest has no row for it", () => {
		expect(coverUrl({ version: 1, entries: {} })).toBe(
			`https://cards.scryfall.io/art_crop/front/4/d/${COVER_CARD}.jpg`
		);
	});

	it('follows a manifest row, so repointing the cover is a data edit', () => {
		const key = `${'a'.repeat(64)}.jpg`;
		expect(coverUrl({ version: 1, entries: { [COVER_CARD]: { source: 'cdn', key } } })).toBe(
			`https://cdn.hadoku.me/${key}`
		);
	});

	it('reads the real manifest by default', () => {
		expect(coverUrl()).toMatch(/^https:\/\//);
	});
});
