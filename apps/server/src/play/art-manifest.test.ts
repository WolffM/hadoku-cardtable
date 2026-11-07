/*
 * The committed art manifest: the hand-made layer over the art mirror (`pools/art-keys.ts`), where
 * repointing one card is a one-line edit. It stores CDN keys, never URLs: the CDN hostname is
 * expected to move (`@wolffm/cdn-client`'s rule), and a hostname baked into committed data fails
 * silently when it does.
 */
import { describe, expect, it } from 'vitest';
import type { ArtManifestFile } from '@hadoku/carddata/art';

import manifestData from './art-manifest.json' with { type: 'json' };

const manifest = manifestData as ArtManifestFile;

describe('the committed art manifest stores keys, never URLs', () => {
	it('is a version-1 manifest file', () => {
		expect(manifest.version).toBe(1);
		expect(typeof manifest.entries).toBe('object');
	});

	it('carries no absolute URL and no hostname of any kind', () => {
		const json = JSON.stringify(manifest.entries);
		expect(json).not.toMatch(/https?:\/\//);
		expect(json).not.toContain('cards.scryfall.io');
		expect(json).not.toContain('hadoku.me');
	});

	it('gives every entry a known source, and a key when it is ours', () => {
		for (const [id, entry] of Object.entries(manifest.entries)) {
			expect(id, `entry key ${id} is not a card id`).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(#back)?$/i);
			expect(['cdn', 'scryfall']).toContain(entry.source);
			if (entry.source === 'cdn') expect(typeof entry.key).toBe('string');
		}
	});
});
