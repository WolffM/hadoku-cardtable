/**
 * Which CDN object holds a card image: the art mirror's log
 * (`@hadoku/carddata/art/mirror`), read into a map, under the committed
 * `art-manifest.json`'s hand-made rows.
 *
 * `upload-art` appends to the log while the server runs (a new set in the
 * catalog is a rerun that copies its cards), so `keyFor` re-reads the file when
 * it has grown, at most once per `recheckMs`, in the background and only the
 * new lines: a lookup answers from what was last read and never waits on the disk. A missing log is a server
 * whose art all comes from Scryfall, not a fault: `keyFor` answers undefined.
 *
 * A manifest row wins over the mirror: a `cdn` row names its own key, and a
 * `scryfall` row pins the card upstream (no key). That is how one card is
 * repointed with a one-line data edit, whatever the mirror holds.
 */

import { readFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { isCdnKey, type ArtManifest } from '@hadoku/carddata/art';
import { parseMirrorLog } from '@hadoku/carddata/art/mirror';
import { jsonLogger } from '../log.js';

const log = jsonLogger('cardtable-art');

export interface ArtKeys {
	/** The CDN key for `scryfallId` (`<id>#back` for a back face), or undefined for Scryfall's own image. */
	keyFor(scryfallId: string): string | undefined;
	/** Resolves once no background read of the log is in flight. */
	settled(): Promise<void>;
}

export function loadArtKeys(opts: { mirrorPath: string; manifest: ArtManifest; recheckMs?: number; now?: () => number }): ArtKeys {
	const { mirrorPath, manifest, recheckMs = 60_000, now = Date.now } = opts;
	const keys = new Map<string, string>();
	/** Bytes of the log already taken: up to its last whole line. */
	let readTo = 0;
	let checkedAt = now();
	let reading: Promise<void> | null = null;

	/** Merge the whole lines in `chunk`; returns the bytes consumed (a torn last line waits for the next read). */
	const take = (chunk: Buffer): number => {
		const end = chunk.lastIndexOf(0x0a) + 1;
		const parsed = parseMirrorLog(chunk.subarray(0, end).toString('utf8'));
		for (const [id, key] of parsed.keys) keys.set(id, key);
		if (parsed.keys.size > 0 || parsed.skipped > 0) log({ evt: 'art-mirror-read', mirrorPath, added: parsed.keys.size, images: keys.size, skipped: parsed.skipped });
		return end;
	};
	const missing = (err: unknown): void => {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log({ evt: 'art-mirror-unreadable', mirrorPath, error: String(err) });
	};

	// The first read is at boot, before any request; every later one is off the request path.
	try {
		readTo = take(readFileSync(mirrorPath));
	} catch (err) {
		missing(err);
	}
	const refresh = async (): Promise<void> => {
		try {
			const file = await open(mirrorPath, 'r');
			try {
				const { size } = await file.stat();
				if (size < readTo) {
					// Rewritten shorter than what was read: start over.
					keys.clear();
					readTo = 0;
				}
				if (size > readTo) {
					const chunk = Buffer.alloc(size - readTo);
					const { bytesRead } = await file.read(chunk, 0, chunk.length, readTo);
					readTo += take(chunk.subarray(0, bytesRead));
				}
			} finally {
				await file.close();
			}
		} catch (err) {
			missing(err);
		} finally {
			checkedAt = now();
			reading = null;
		}
	};

	return {
		keyFor(scryfallId) {
			const row = manifest[scryfallId];
			if (row !== undefined) return row.source === 'cdn' && isCdnKey(row.key) ? row.key : undefined;
			if (reading === null && now() - checkedAt >= recheckMs) reading = refresh();
			return keys.get(scryfallId);
		},
		settled: async () => {
			await reading;
		},
	};
}
