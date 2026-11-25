/**
 * Reading each hosted external game's `manifest.json` (`@hadoku/platform-wire/external-game-manifest`):
 * fetched through the edge beside the game's embed entry, checked against the schema, and kept on
 * disk as the last good copy.
 *
 * The last good copy is what keeps a room type alive across a bad release or an unreachable edge.
 * A host that boots without a type registered quarantines every saved room of it, so a manifest
 * that cannot be fetched or read never unregisters a game that was read once: the copy on disk
 * stands in, and the reason is logged. Only a game never read anywhere has no manifest.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { JsonLog } from '@hadoku/service-kernel/log';
import {
	externalGameManifest,
	manifestPathOf,
	type ExternalGameManifest,
	type ExternalGameManifestInput,
} from '@hadoku/platform-wire/external-game-manifest';

/** A hosted game as the reader needs it: where its embed is, or (a test fixture) its manifest inline. */
export interface ManifestedGame {
	id: string;
	embedSrc: string;
	/** A fixture with no publisher behind it carries its manifest here, and nothing is fetched. */
	manifest?: ExternalGameManifestInput;
}

export interface ManifestReaderOptions {
	/** The origin the embed paths are under: `https://hadoku.me`. */
	origin: string;
	/** Sent as `X-User-Key`, which the edge needs for a gated bundle route. */
	serviceKey?: string;
	/** Where each game's last good manifest is kept, `<id>.json`. */
	cacheDir: string;
	log: JsonLog;
	fetch?: typeof fetch;
	timeoutMs?: number;
}

/** Where a manifest came from: the game's own file just now, the copy on disk, or the host's config. */
export type ManifestSource = 'fetched' | 'cached' | 'inline';

export interface ReadManifest {
	manifest: ExternalGameManifest;
	source: ManifestSource;
}

const DEFAULT_TIMEOUT_MS = 5_000;

function describe(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function parsed(raw: unknown): ExternalGameManifest {
	const checked = externalGameManifest.safeParse(raw);
	if (!checked.success) throw new Error(checked.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '));
	return checked.data;
}

/** Reads every game's manifest the same way; one reader per server. */
export function manifestReader(opts: ManifestReaderOptions): (game: ManifestedGame) => Promise<ReadManifest | null> {
	const doFetch = opts.fetch ?? fetch;
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const cacheFile = (id: string): string => join(opts.cacheDir, `${id}.json`);

	const fetchOne = async (game: ManifestedGame): Promise<ExternalGameManifest> => {
		const url = `${opts.origin}${manifestPathOf(game.embedSrc)}`;
		const res = await doFetch(url, {
			headers: { 'User-Agent': 'Mozilla/5.0 hadoku-cardtable', ...(opts.serviceKey ? { 'X-User-Key': opts.serviceKey } : {}) },
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!res.ok) throw new Error(`${url} answered ${res.status}`);
		return parsed(await res.json());
	};

	const readCache = (id: string): ExternalGameManifest | null => {
		let text: string;
		try {
			text = readFileSync(cacheFile(id), 'utf8');
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
			throw err;
		}
		return parsed(JSON.parse(text));
	};

	const writeCache = (id: string, manifest: ExternalGameManifest): void => {
		mkdirSync(opts.cacheDir, { recursive: true });
		const tmp = `${cacheFile(id)}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
		renameSync(tmp, cacheFile(id));
	};

	return async (game) => {
		if (game.manifest !== undefined) return { manifest: parsed(game.manifest), source: 'inline' };
		let cached: ExternalGameManifest | null = null;
		let cacheProblem: string | null = null;
		try {
			cached = readCache(game.id);
		} catch (err) {
			cacheProblem = describe(err);
		}
		try {
			const manifest = await fetchOne(game);
			if (JSON.stringify(manifest) !== JSON.stringify(cached)) writeCache(game.id, manifest);
			return { manifest, source: 'fetched' };
		} catch (err) {
			const reason = describe(err);
			if (cached !== null) {
				opts.log({ evt: 'external-game-manifest-stale', gameType: game.id, reason });
				return { manifest: cached, source: 'cached' };
			}
			opts.log({ evt: 'external-game-manifest-missing', gameType: game.id, reason, ...(cacheProblem === null ? {} : { cache: cacheProblem }) });
			return null;
		}
	};
}
