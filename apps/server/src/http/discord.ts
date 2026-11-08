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
 * the caller wait on an expired read had every load wait on ArchiveBot (server p50 550 ms). Because
 * that only reads when someone asks, the first caller after a quiet stretch would get a snapshot of
 * any age, so the server also reads on its own every `REFRESH_MS`. A read that fails keeps the last
 * good snapshot. The first one starts at boot. Without the secret (PPE,
 * local dev), or with no snapshot yet but a refusal, the route answers 204 and the card leaves the
 * chat out.
 *
 *   GET /api/discord/recent → 200 { messages: [{ author, avatar, color, text, at }] } (newest last) | 204
 */

import { createHmac } from 'node:crypto';

import type { Request, Response, Router } from 'express';
import { DiscordRecentSchema, type DiscordRecent } from '@hadoku/shared';

import type { JsonLog } from '@hadoku/service-kernel/log';

/** How old a kept answer gets before the next caller starts a fresh read behind it. */
export const CACHE_MS = 60_000;
/** How often the server reads on its own, with nobody asking: the oldest snapshot a caller can get. */
export const REFRESH_MS = 60 * 60_000;
/** How much #general history the card can scroll back through: ArchiveBot's own cap (`MAX_LIMIT`). */
export const RECENT_LIMIT = 50;

export interface DiscordDeps {
	/** `ARCHIVEBOT_CARDTABLE_WEBHOOK_SECRET`; empty = no snapshot (every environment but prod). */
	secret: string;
	archivebotUrl: string;
	log: JsonLog;
	fetch?: typeof fetch;
	now?: () => number;
	/** Runs `read` every `ms`; defaults to an unref'd `setInterval`. */
	every?: (read: () => void, ms: number) => void;
}

/** The query ArchiveBot is asked, and the signature over exactly it. */
export function signedRecentQuery(secret: string, limit: number = RECENT_LIMIT): { query: string; signature: string } {
	const query = `channel=general&limit=${String(limit)}`;
	return { query, signature: `sha256=${createHmac('sha256', secret).update(query).digest('hex')}` };
}

/**
 * The snapshot, read from ArchiveBot at most once per `CACHE_MS`, never waited on twice. `get`'s `null`:
 * there is none to show. `refresh` reads now, whatever the snapshot's age.
 */
export function discordSnapshot(deps: DiscordDeps): { get: () => Promise<DiscordRecent | null>; refresh: () => Promise<DiscordRecent | null> } {
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

	const get = async (): Promise<DiscordRecent | null> => {
		if (deps.secret === '') return null;
		if (kept === null) return refresh();
		if (now() - kept.at >= CACHE_MS) void refresh();
		return kept.value;
	};
	return { get, refresh };
}

const unrefInterval = (read: () => void, ms: number): void => {
	setInterval(read, ms).unref();
};

export function attachDiscord(api: Router, deps: DiscordDeps): void {
	const snapshot = discordSnapshot(deps);
	void snapshot.get();
	if (deps.secret !== '') (deps.every ?? unrefInterval)(() => void snapshot.refresh(), REFRESH_MS);
	api.get('/discord/recent', async (_req: Request, res: Response) => {
		const recent = await snapshot.get();
		if (recent === null || recent.messages.length === 0) return res.status(204).end();
		res.json(recent);
	});
}
