/*
 * `/cover`: cardtable's tile in watchparty's game picker. The catalog's
 * `cover` must be a same-origin path, and image bytes never live in this repo
 * (AGENTS.md), so this answers with a redirect to the art instead.
 *
 * The art is a lookup like every card's: a scryfallId, resolved through
 * `art-manifest.json`. Repointing the cover is a row in the manifest (or this
 * one id), never a URL in code. Placeholder until the operator picks real art.
 */

import { resolveArtUrl, type ArtManifestFile } from '@hadoku/carddata/art';
import type { Request, Response } from 'express';

import manifestFile from '../../ui/src/draft/art-manifest.json' with { type: 'json' };

/** Lightning Bolt (Alpha): a dark storm the picker's white label reads well on. */
export const COVER_CARD = '4dbd1cd7-521d-4a59-af53-e5cae451712f';

/** Where the cover's art is today: artwork alone, no frame. */
export function coverUrl(manifest: ArtManifestFile = manifestFile as ArtManifestFile): string | null {
	return resolveArtUrl(COVER_CARD, manifest.entries, { size: 'art_crop' });
}

export function serveCover(_req: Request, res: Response): void {
	const url = coverUrl();
	if (url === null) {
		res.status(404).type('text').send('no cover art');
		return;
	}
	// An hour: a repointed cover reaches the picker within one.
	res.setHeader('Cache-Control', 'public, max-age=3600');
	res.redirect(302, url);
}
