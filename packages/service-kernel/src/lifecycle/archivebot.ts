/*
 * One signed POST to ArchiveBot: the body is HMAC-SHA256'd with the app's webhook secret and sent
 * as `X-Hadoku-Signature: sha256=<hex>` (contract: docs/requests/ARCHIVEBOT_DISCORD_INTEGRATION_REPLY.md).
 * Every caller that writes to the app's Discord through ArchiveBot goes through here: the release
 * announce (`announce.ts`) and the scheduled-event mirror (game-server's `room/discord-events.ts`).
 *
 * Imports only; nothing runs at import.
 */
import { createHmac } from 'node:crypto';

export interface ArchivebotTarget {
	/** The app's ArchiveBot webhook secret; the caller decides what an empty one means. */
	secret: string;
	archivebotUrl: string;
	fetch?: typeof fetch;
}

export interface ArchivebotReply {
	status: number;
	ok: boolean;
	/** The reply as sent, for a log line. */
	raw: string;
	/** The reply's JSON object, or `{}` when it was not one. */
	answer: Record<string, unknown>;
}

const TIMEOUT_MS = 10_000;

function parsed(raw: string): Record<string, unknown> {
	try {
		const value: unknown = JSON.parse(raw);
		return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

/** POST `body` (already JSON) to ArchiveBot's `path`, signed. Throws only when ArchiveBot could not be reached. */
export async function archivebotPost(target: ArchivebotTarget, path: string, body: string): Promise<ArchivebotReply> {
	const signature = createHmac('sha256', target.secret).update(body).digest('hex');
	const res = await (target.fetch ?? fetch)(`${target.archivebotUrl}${path}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'X-Hadoku-Signature': `sha256=${signature}` },
		body,
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	const raw = await res.text();
	return { status: res.status, ok: res.ok, raw, answer: parsed(raw) };
}
