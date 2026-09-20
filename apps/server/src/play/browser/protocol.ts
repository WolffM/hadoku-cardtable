/**
 * The browser bridge's message shapes — socket.io's four events, respelled for
 * a transport that has no events and no acks.
 *
 * ## It is the same contract, not a second one
 *
 * `../transport.ts` defines what a match frame is (`ClientEnvelope`,
 * `ServerEnvelope`, `MatchSnapshot`) and `@hadoku/forge-wire` defines what a
 * frame is. Neither is re-stated here. All this file adds is the two things a
 * raw WebSocket does not have and socket.io does:
 *
 *   `t`    which of the four messages this is, since there is no event name.
 *   `rid`  the caller's correlation id for a request that has an answer, since
 *          there is no ack callback. Echoed back verbatim on the answer and on
 *          nothing else. Optional: a client that never resyncs can omit it.
 *
 * Everything inside is parsed by the existing parsers, so a frame that would be
 * refused on the socket.io path is refused identically here. That is the point:
 * a second client type must not be a second validation surface.
 *
 * ## `rid` is not an identity and not a seat
 *
 * It is echoed and never read. The seat a message acts on is ALWAYS the seat
 * the connection claimed (`match.claim`, permanent for the match) — there is no
 * field on this wire by which a client can name a seat, exactly as there is
 * none on the socket.io wire.
 */

import type { ClientFrame } from '@hadoku/forge-wire';

import {
	parseClientEnvelope,
	parseMatchRequest,
	type MatchSnapshot,
	type Parsed,
	type ServerEnvelope,
} from '../transport.js';

/** Bumped when a shape changes. Sent in `hello` so a stale client says so loudly. */
export const BROWSER_PROTOCOL_VERSION = 1;

/** The endpoint's path on this server. The edge strips `/cardtable` before we see it. */
export const BROWSER_WS_PATH = '/play/ws';

/* ── Browser → server ────────────────────────────────────────────────── */

export type BrowserRequest =
	| { t: 'join'; rid: string | null; matchId: string }
	| { t: 'resync'; rid: string | null; matchId: string }
	| { t: 'c2s'; matchId: string; frame: ClientFrame };

/* ── Server → browser ────────────────────────────────────────────────── */

export type BrowserMessage =
	| { t: 'hello'; protocol: number }
	| ({ t: 'snapshot'; rid: string | null } & MatchSnapshot)
	| { t: 'error'; rid: string | null; error: string }
	| ({ t: 's2c' } & ServerEnvelope);

function isRecord(x: unknown): x is Record<string, unknown> {
	return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** `rid` is a short opaque string or absent. Anything else is a malformed message. */
function ridOf(raw: Record<string, unknown>): { ok: true; rid: string | null } | { ok: false } {
	if (!('rid' in raw) || raw.rid === null || raw.rid === undefined) return { ok: true, rid: null };
	if (typeof raw.rid !== 'string' || raw.rid.length === 0 || raw.rid.length > 64) return { ok: false };
	return { ok: true, rid: raw.rid };
}

/**
 * One text frame → one request. The `t`/`rid` wrapper is stripped and the rest
 * is handed to `transport.ts`'s parsers unchanged, so the error paths — and the
 * error text — are the ones the socket.io path already produces.
 */
export function parseBrowserRequest(text: string): Parsed<BrowserRequest> {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return { ok: false, errors: [{ path: '$', message: 'not JSON' }] };
	}
	if (!isRecord(raw)) return { ok: false, errors: [{ path: '$', message: 'a message is an object' }] };
	const rid = ridOf(raw);
	if (!rid.ok) return { ok: false, errors: [{ path: '$.rid', message: 'rid is a string of 1..64 characters' }] };
	const { t, rid: _rid, ...body } = raw;

	if (t === 'join' || t === 'resync') {
		const parsed = parseMatchRequest(body);
		if (!parsed.ok) return parsed;
		return { ok: true, value: { t, rid: rid.rid, matchId: parsed.value.matchId } };
	}
	if (t === 'c2s') {
		const parsed = parseClientEnvelope(body);
		if (!parsed.ok) return parsed;
		return { ok: true, value: { t: 'c2s', matchId: parsed.value.matchId, frame: parsed.value.frame } };
	}
	return { ok: false, errors: [{ path: '$.t', message: "t is 'join', 'resync' or 'c2s'" }] };
}

export function encodeBrowserMessage(message: BrowserMessage): string {
	return JSON.stringify(message);
}
