/*
 * `GET /api/discord/recent` — the cardtable Discord's recent #general messages, for the front
 * page's wildcard card. Friend-gated like every `/api` route: the snapshot never reaches the public.
 *
 * The messages are ArchiveBot's (`GET /api/messages/recent`, WolffM/ArchiveBot#37): it is already
 * in the server, and signs with the same `ARCHIVEBOT_CARDTABLE_WEBHOOK_SECRET` as the release
 * announcement (`../announce.ts`), so cardtable holds no bot token of its own. The signature is an
 * HMAC-SHA256 of the raw query string, without its `?`.
 *
 * One read a minute at most, whoever asks, and nobody waits on it once there is a snapshot: a
 * caller gets the kept one at once, and one older than `CACHE_MS` starts a read behind it for the
 * next caller (stale-while-revalidate). Front-page loads come minutes apart, so a cache that made
 * the caller wait on an expired read had every load wait on ArchiveBot (server p50 550 ms). A read
 * that fails keeps the last good snapshot. The first one starts at boot. Without the secret (PPE,
 * local dev), or with no snapshot yet but a refusal, the route answers 204 and the card leaves the
 * chat out.
 *
 *   GET /api/discord/recent → 200 { messages: [{ author, avatar, color, text, at }] } (newest last) | 204
 */

import { createHmac } from 'node:crypto';

import type { Request, Response, Router } from 'express';
import { DiscordRecentSchema, type DiscordRecent } from '@hadoku/shared';

import type { JsonLog } from '../log.js';

/** How old a kept answer gets before the next caller starts a fresh read behind it. */
export const CACHE_MS = 60_000;
/** How much #general history the card can scroll back through: ArchiveBot's own cap (`MAX_LIMIT`). */
export const RECENT_LIMIT = 50;

export interface DiscordDeps {
	/** `ARCHIVEBOT_CARDTABLE_WEBHOOK_SECRET`; empty = no snapshot (every environment but prod). */
	secret: string;
	archivebotUrl: string;
	log: JsonLog;
	fetch?: typeof fetch;
	now?: () => number;
}

/** The query ArchiveBot is asked, and the signature over exactly it. */
export function signedRecentQuery(secret: string, limit: number = RECENT_LIMIT): { query: string; signature: string } {
	const query = `channel=general&limit=${String(limit)}`;
	return { query, signature: `sha256=${createHmac('sha256', secret).update(query).digest('hex')}` };
}

/** The snapshot, read from ArchiveBot at most once per `CACHE_MS`, never waited on twice. `null`: there is none to show. */
export function discordSnapshot(deps: DiscordDeps): () => Promise<DiscordRecent | null> {
	const now = deps.now ?? Date.now;
	let kept: { at: number; value: DiscordRecent | null } | null = null;
	let reading: Promise<DiscordRecent | null> | null = null;

	const read = async (): Promise<DiscordRecent | null> => {
		const { query, signature } = signedRecentQuery(deps.secret);
		try {
			const res = await (deps.fetch ?? fetch)(`${deps.archivebotUrl}/api/messages/recent?${query}`, {
				headers: { 'X-Hadoku-Signature': signature, accept: 'application/json' },
				signal: AbortSignal.timeout(5_000),
			});
			if (!res.ok) {
				deps.log({ event: 'discord-snapshot', outcome: 'refused', status: res.status, reply: (await res.text()).slice(0, 200) });
				return null;
			}
			const parsed = DiscordRecentSchema.safeParse(await res.json());
			if (!parsed.success) {
				deps.log({ event: 'discord-snapshot', outcome: 'unreadable' });
				return null;
			}
			return parsed.data;
		} catch (err) {
			deps.log({ event: 'discord-snapshot', outcome: 'failed', error: err instanceof Error ? err.message : String(err) });
			return null;
		}
	};

	const refresh = (): Promise<DiscordRecent | null> =>
		(reading ??= read().then((value) => {
			kept = { at: now(), value: value ?? kept?.value ?? null };
			reading = null;
			return kept.value;
		}));

	return async () => {
		if (deps.secret === '') return null;
		if (kept === null) return refresh();
		if (now() - kept.at >= CACHE_MS) void refresh();
		return kept.value;
	};
}

export function attachDiscord(api: Router, deps: DiscordDeps): void {
	const snapshot = discordSnapshot(deps);
	void snapshot();
	api.get('/discord/recent', async (_req: Request, res: Response) => {
		const recent = await snapshot();
		if (recent === null || recent.messages.length === 0) return res.status(204).end();
		res.json(recent);
	});
}
