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
 *   client → server  `forge:full-control`  `{ matchId, on }`
 *   server → client  `forge:full-control`  `{ matchId, on }` — the seat's
 *                    current state, sent to a socket that has just been
 *                    answered a snapshot. One event, one schema, both ways.
 *   client → server  `forge:stop-preference`  `{ matchId, type: 'stopPreference', stopAtEndStep }`
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
	ShowConfirmDialogReplySchema,
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
	/** `ShowConfirmDialogReplySchema` is `z.boolean()`. */
	boolean: ShowConfirmDialogReplySchema,
	/** `z.object({})` by another route. */
	emptyObject: SeqCursorSchema.pick({}),
};

/* ── Event names ─────────────────────────────────────────────────────── */

export const MATCH_EVENTS = {
	join: 'forge:join',
	resync: 'forge:resync',
	serverToClient: FORGE_CHANNEL.serverToClient,
	clientToServer: FORGE_CHANNEL.clientToServer,
	/** Wave 19 lane C: the full-control escape hatch, per seat, off by default. */
	fullControl: 'forge:full-control',
	/**
	 * Wave 30 §B item 2/6: the one setting the operator asked for — *"i think by
	 * default this should be off, but can be turned on in settings (always stop
	 * at endstep)."* Client → server only; see {@link StopPreferenceSchema}.
	 */
	stopPreference: 'forge:stop-preference',
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

/**
 * `forge:full-control` — this seat wants every question and every stop, or
 * wants the shortcuts back (`play/auto.ts`). Nothing about the game crosses
 * here: it is a preference of the person sitting in the seat.
 *
 * **It travels both ways, on one event and one schema.** Client → server it is
 * a request; server → client it is the seat's CURRENT state, sent to a socket
 * that has just been answered a snapshot. Full control is a per-seat
 * preference the server holds and the state channel does not carry, so it
 * belongs with the prompt and the bar in the set of things a fresh page needs
 * after a join (`Match.resendAfterSnapshot`'s docstring names that set) — and
 * without it a refresh drew the toggle off while the server still held the
 * seat in full control. The payload is identical in both directions, so
 * neither side needs a second schema and a drift is impossible.
 */
export const FullControlSchema = borrowed.emptyObject
	.extend({ matchId: borrowed.nonEmptyString, on: borrowed.boolean })
	.strict();
export type FullControlRequest = Output<typeof FullControlSchema>;

/**
 * The server → client payload of `forge:full-control`, built THROUGH the
 * schema so an echo that does not satisfy the client's parse cannot be sent.
 */
export function fullControlEcho(matchId: string, on: boolean): FullControlRequest {
	return FullControlSchema.parse({ matchId, on });
}

/**
 * `forge:stop-preference` — wave 30 §B item 6: *"a settings surface, holding
 * at least two preferences… always stop at end step — default off."* This is
 * that one preference, travelling from the settings panel to the seat's own
 * {@link StopPolicy} (`auto.ts`) through the ALREADY-EXISTING per-seat setter,
 * `Match.setStopPolicy` (wave 26 §E) — nothing here is a second mechanism.
 *
 * **Fallback shape.** Lane A (§A) owns the settings panel and was to write its
 * chosen message shape to `docs/planning/wave30-evidence/A-stop-pref-message.md`
 * before this lane reached this item; that file did not exist when it did. Per
 * the wave brief this is the shape the brief itself specifies —
 * `{ type: 'stopPreference', stopAtEndStep: boolean }` — implemented as its own
 * event, the way `forge:full-control` is, rather than folded onto `forge:c2s`
 * (a `ClientFrame` is `@hadoku/forge-wire`'s sealed union and a seat preference
 * is not a Forge frame, exactly the reasoning `forge:full-control`'s own
 * doc-comment already gives). `type` is carried on the PAYLOAD, as the brief's
 * literal shape has it, even though the event name alone already disambiguates
 * it — so a client that logs the raw payload can tell what it sent without
 * cross-referencing the event name. **Client → server only**: unlike
 * `forge:full-control` there is no echo, because nothing server-side changed
 * the meaning of "sent it" — the manager reconciles this against whatever §A
 * actually built.
 */
export const StopPreferenceSchema = borrowed.emptyObject
	.extend({
		matchId: borrowed.nonEmptyString,
		type: borrowed.nonEmptyString.refine((v) => v === 'stopPreference', { message: "must be 'stopPreference'" }),
		stopAtEndStep: borrowed.boolean,
	})
	.strict();

export interface StopPreferenceRequest {
	matchId: string;
	type: 'stopPreference';
	stopAtEndStep: boolean;
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

/**
 * A refused `forge:join` / `forge:resync`.
 *
 * **Deliberately identical to the client mirror's `MatchErrorSchema`**
 * (`apps/ui/src/play/live/transport.ts`). The two are one contract, and the
 * module header's rule applies here like everywhere else: a change here is a
 * change there.
 *
 * `error` is the machine code every refusal carries, and it is unchanged.
 * `outcome` and `message` are optional because **exactly one refusal sends
 * them**: a match that is gone answers
 * `{ error: 'unknown-match', outcome: 'match-gone', message: '<a sentence>' }`
 * (Wave 22 lane E — `matchGone` / `MATCH_GONE_WORDS` in `socket.ts`), while
 * `match-full`, `not-joined`, `match-starting` and `malformed: …` keep the bare
 * `{ error }` they always had. Requiring the two fields would make every OTHER
 * refusal malformed.
 *
 * `outcome` is a non-empty string rather than the literal `'match-gone'`: a
 * PARSE schema that pins the literal refuses the next outcome the system learns
 * to send, which is this class of bug again. The object stays `.strict()`, so a
 * misspelled `outcom` or `mesage` is still an error and not quietly dropped.
 *
 * **Nothing on this server parses through this schema today.**
 * `grep -rn MatchErrorSchema apps/server/src` finds this definition and two
 * comments, nothing else; the shape is BUILT by lane E's `MatchRefusal`
 * (`socket.ts`), which pins `outcome` to `'match-gone'` — a builder is narrow
 * where a parser is wide. So widening this is not fixing a live bug: it is
 * keeping the two mirrors one contract, so that the day something does validate
 * an outbound refusal against the server's own schema, a `match-gone` passes.
 *
 * `MatchError` below stays the bare `{ error }` on purpose — it is what
 * `browser/session.ts`'s `snapshotFor` returns, and that bridge forwards only
 * the code. The refusal that carries the extra fields is `MatchRefusal`.
 */
export const MatchErrorSchema = borrowed.emptyObject
	.extend({
		error: borrowed.nonEmptyString,
		outcome: borrowed.nonEmptyString.optional(),
		message: borrowed.nonEmptyString.optional(),
	})
	.strict();

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

export function parseFullControl(raw: unknown): Parsed<FullControlRequest> {
	return fromZod(FullControlSchema.safeParse(raw));
}

export function parseStopPreference(raw: unknown): Parsed<StopPreferenceRequest> {
	return fromZod(StopPreferenceSchema.safeParse(raw)) as Parsed<StopPreferenceRequest>;
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
