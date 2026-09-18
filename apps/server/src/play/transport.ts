/**
 * The A↔B transport contract, server side: how a Forge frame travels between
 * this match server and a browser, on top of `@hadoku/forge-wire`'s envelope.
 *
 * **Lane B holds a mirror of these schemas at `apps/ui/src/play/live/transport.ts`.**
 * The duplication is the manager's call for Wave 9 (both halves were written in
 * parallel against one fixed contract) and is recorded as a follow-up: the
 * schemas belong in one shared package. Until then a change here is a change
 * there.
 *
 *   client → server  `forge:join`    `{ matchId }`, ack → `MatchSnapshot | { error }`
 *   client → server  `forge:resync`  `{ matchId }`, ack → `MatchSnapshot | { error }`
 *   client → server  `forge:c2s`     `{ matchId, frame: ClientFrame }`
 *   server → client  `forge:s2c`     `{ matchId, cursor, frame: ServerFrame }`
 *
 * ## The cursor, and the one place the contract's wording was sharpened
 *
 * Per recipient. `seq` starts at 1 and rises by exactly 1 for every `forge:s2c`
 * frame that seat is sent — state, notify or ask alike. `epoch` is minted once
 * per match-process start.
 *
 * `MatchSnapshot.cursor` is that seat's LATEST cursor, of any kind — not the
 * cursor of the last STATE frame in `frames`. The manager confirmed this with
 * lane B mid-wave: with the literal reading, a prompt sent after the last state
 * frame leaves the snapshot's cursor behind the stream, the pending ask re-sent
 * after the snapshot then arrives as a `gap`, and the client resyncs forever.
 *
 * ## No direct `zod` import
 *
 * `@hadoku/server` does not depend on `zod` (its manifest is the manager's), and
 * pnpm's strict layout will not resolve it from here. Every schema is therefore
 * built from schema instances the server's existing dependencies export — the
 * same device lane B used, for the same reason, so the two mirrors are built the
 * same way. When `zod` is a direct dependency, only `borrowed` changes.
 */

import { SeqCursorSchema, type WireCursor } from '@hadoku/shared';
import {
	CallIdSchema,
	ClientReplySchema,
	FORGE_CHANNEL,
	ServerFrameSchema,
	TrackableIdSchema,
	safeParseClientFrame,
	type ClientFrame,
	type ServerFrame,
	type WireIssue,
} from '@hadoku/forge-wire';

/* ── Borrowed primitives (see the module header) ─────────────────────── */

type Output<S extends { _zod: { output: unknown } }> = S['_zod']['output'];

const borrowed = {
	/** `CallIdSchema` is `z.string().min(1)`. */
	nonEmptyString: CallIdSchema,
	/** `ClientReplySchema.shape.result` is `z.unknown()`. */
	unknown: ClientReplySchema.shape.result,
	/** `TrackableIdSchema` is `z.number().int()`. */
	forgeId: TrackableIdSchema,
	/** `z.object({})` by another route. */
	emptyObject: SeqCursorSchema.pick({}),
};

/* ── Event names ─────────────────────────────────────────────────────── */

export const MATCH_EVENTS = {
	join: 'forge:join',
	resync: 'forge:resync',
	serverToClient: FORGE_CHANNEL.serverToClient,
	clientToServer: FORGE_CHANNEL.clientToServer,
} as const;

/* ── Cursor ──────────────────────────────────────────────────────────── */

export const WireCursorSchema = SeqCursorSchema;
export type { WireCursor };

/* ── Client → server ─────────────────────────────────────────────────── */

/** `forge:join` and `forge:resync`. */
export const MatchRequestSchema = borrowed.emptyObject.extend({ matchId: borrowed.nonEmptyString }).strict();
export type MatchRequest = Output<typeof MatchRequestSchema>;

/** `forge:c2s`. `frame` is checked second, by forge-wire's `safeParseClientFrame`. */
export const ClientEnvelopeSchema = borrowed.emptyObject
	.extend({ matchId: borrowed.nonEmptyString, frame: borrowed.unknown })
	.strict();

export interface ClientEnvelope {
	matchId: string;
	frame: ClientFrame;
}

/* ── Server → client ─────────────────────────────────────────────────── */

export const ServerEnvelopeSchema = borrowed.emptyObject
	.extend({ matchId: borrowed.nonEmptyString, cursor: WireCursorSchema, frame: ServerFrameSchema })
	.strict();

export interface ServerEnvelope {
	matchId: string;
	cursor: WireCursor;
	frame: ServerFrame;
}

/**
 * The answer to `forge:join` and `forge:resync`. `frames` is this seat's whole
 * state-channel history (`setGameView` / `openView` / `applyDelta`, already
 * projected for the seat); a pending ask is re-sent after it as an ordinary
 * `forge:s2c` frame.
 */
export const MatchSnapshotSchema = borrowed.emptyObject
	.extend({
		matchId: borrowed.nonEmptyString,
		seat: borrowed.forgeId.min(0),
		playerId: borrowed.forgeId,
		cursor: WireCursorSchema.nullable(),
		frames: ServerFrameSchema.array(),
	})
	.strict();

export interface MatchSnapshot {
	matchId: string;
	seat: number;
	playerId: number;
	cursor: WireCursor | null;
	frames: ServerFrame[];
}

export const MatchErrorSchema = borrowed.emptyObject.extend({ error: borrowed.nonEmptyString }).strict();
export interface MatchError {
	error: string;
}

/* ── Parsing, with paths ─────────────────────────────────────────────── */

export type Parsed<T> = { ok: true; value: T } | { ok: false; errors: WireIssue[] };

function formatPath(path: readonly PropertyKey[]): string {
	let out = '$';
	for (const segment of path) out += typeof segment === 'number' ? `[${segment}]` : `.${String(segment)}`;
	return out;
}

function fromZod<T>(
	result:
		| { success: true; data: T }
		| { success: false; error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] } },
): Parsed<T> {
	if (result.success) return { ok: true, value: result.data };
	return { ok: false, errors: result.error.issues.map((i) => ({ path: formatPath(i.path), message: i.message })) };
}

export function parseMatchRequest(raw: unknown): Parsed<MatchRequest> {
	return fromZod(MatchRequestSchema.safeParse(raw));
}

/** Envelope first, then the frame — a reply's `result` is checked against its method here. */
export function parseClientEnvelope(raw: unknown): Parsed<ClientEnvelope> {
	const envelope = fromZod(ClientEnvelopeSchema.safeParse(raw));
	if (!envelope.ok) return envelope;
	const frame = safeParseClientFrame(envelope.value.frame);
	if (!frame.ok) {
		return { ok: false, errors: frame.errors.map((e) => ({ path: `$.frame${e.path.slice(1)}`, message: e.message })) };
	}
	return { ok: true, value: { matchId: envelope.value.matchId, frame: frame.value } };
}
