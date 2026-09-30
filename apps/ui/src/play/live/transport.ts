/*
 * The A↔B transport contract: how a Forge frame travels between lane A's match
 * server and this client, on top of `@hadoku/forge-wire`'s envelope.
 *
 * **Lane A holds a mirror of these schemas at `apps/server/src/play/transport.ts`.**
 * The duplication is deliberate for Wave 9 (both lanes were written in
 * parallel against one contract the manager fixed) and is recorded as a
 * follow-up: the schemas belong in a shared package, once, like
 * `@hadoku/shared`'s draft wire. Until then a change here is a change there.
 *
 * ## Why a wrapper at all
 *
 * `ServerFrame` carries no sequence cursor, and this client runs
 * `classifySeq` on everything it applies — the same rule the draft socket
 * lives by (`apps/ui/src/draft/socket.ts`). So every frame crosses inside
 * `{ matchId, cursor, frame }`, and the cursor is **per recipient**: `seq`
 * starts at 1 and rises by exactly 1 per `forge:s2c` frame to THIS browser,
 * and `epoch` is minted once per match-process start.
 *
 * ## The events
 *
 *   client → server  `forge:join`    `{ matchId }`, ack → `MatchSnapshot | { error }`
 *   client → server  `forge:resync`  `{ matchId }`, ack → `MatchSnapshot | { error }`
 *   client → server  `forge:c2s`     `{ matchId, frame: ClientFrame }`
 *   client → server  `forge:full-control`  `{ matchId, on }` — this seat's escape
 *                    hatch (Wave 19 lane C's `play/auto.ts`); carries nothing
 *                    about the game, and no ack: the server only logs a refusal
 *   client → server  `forge:stop-preference`  `{ matchId, type: 'stopPreference',
 *                    stopAtEndStep }` — item 2/6 (wave 30), the settings
 *                    panel's *"always stop at end step"*. Client → server
 *                    only, same as full control's own no-ack shape; see
 *                    {@link StopPreferenceSchema}.
 *   server → client  `forge:s2c`     `{ matchId, cursor, frame: ServerFrame }`
 *
 * `POST <base>/api/play/matches` starts a match; its body is lane A's, and
 * nothing in this client needs it.
 *
 * ## `frame` is `unknown` in the envelope, on purpose
 *
 * The envelope is parsed first and the frame second, with forge-wire's own
 * `safeParseServerFrame`. Folding the two into one schema would lose the
 * cursor of a frame that fails to parse — and a frame that fails to parse is
 * exactly the one whose position in the stream the client needs, to know it
 * has missed state and must resync.
 *
 * ## No direct `zod` import — read before "fixing" the primitives
 *
 * `@hadoku/ui` does not depend on `zod` (its manifest is the manager's, not
 * this lane's), and pnpm's strict layout means it cannot resolve it. Every
 * schema below is therefore BUILT FROM schema instances the UI's existing
 * dependencies export, each chosen because it already means the thing it is
 * used for. When `zod` becomes a direct dependency, the `borrowed` block is the
 * only part that changes, to `z.string().min(1)` and friends; nothing else
 * moves.
 */

import { SeqCursorSchema, type WireCursor } from '@hadoku/shared';
import {
  CallIdSchema,
  ClientReplySchema,
  FORGE_CHANNEL,
  ServerFrameSchema,
  ShowConfirmDialogReplySchema,
  TrackableIdSchema,
  type BlockingMethod,
  type ClientAbort,
  type ClientFrame,
  type ClientReply,
} from '@hadoku/forge-wire';

/* ── Borrowed primitives (see the module header) ─────────────────────── */

/** `z.output<S>`, spelled without importing `zod`. */
type Output<S extends { _zod: { output: unknown } }> = S['_zod']['output'];

const borrowed = {
  /** A non-empty string: `CallIdSchema` is `z.string().min(1)`. */
  nonEmptyString: CallIdSchema,
  /** Any JSON value: `ClientReplySchema.shape.result` is `z.unknown()`. */
  unknown: ClientReplySchema.shape.result,
  /** A Forge id, a Java int: `TrackableIdSchema` is `z.number().int()`. */
  forgeId: TrackableIdSchema,
  /** A boolean: `ShowConfirmDialogReplySchema` is `z.boolean()`. */
  boolean: ShowConfirmDialogReplySchema,
  /** An empty object schema to extend — `z.object({})` by another route. */
  emptyObject: SeqCursorSchema.pick({}),
};

/* ── Event names ─────────────────────────────────────────────────────── */

/** Every socket.io event this contract uses. */
export const MATCH_EVENTS = {
  join: 'forge:join',
  resync: 'forge:resync',
  serverToClient: FORGE_CHANNEL.serverToClient,
  clientToServer: FORGE_CHANNEL.clientToServer,
  /** Wave 19 lane C: the full-control escape hatch, per seat, off by default. */
  fullControl: 'forge:full-control',
  /**
   * Item 2/6 (wave 30): *"always stop at end step — default off"*. Client →
   * server only; see {@link StopPreferenceSchema}. Named and shaped to match
   * `apps/server/src/play/transport.ts`'s own mirror exactly — that lane
   * built its handler off the wave brief's fallback shape before this file
   * existed to read, so this is the one place the two were reconciled rather
   * than the other way round.
   */
  stopPreference: 'forge:stop-preference',
  /**
   * Wave 29 §B's own event, not folded into {@link MatchSnapshotSchema}: that
   * schema is `.strict()` and mirrored byte for byte on the server
   * (`apps/server/src/play/transport.ts`), and widening it is a change to a
   * file neither wave-29 lane owns. `Match.seatIdentities()` sends the payload
   * on this event instead — every seat's `{ seat, claimed, playerId,
   * avatarId? }`, right after the full-control echo, on every join AND every
   * resync (`apps/server/src/play/socket.ts`'s `answer`). The server refers to
   * it by the bare string, because `MATCH_EVENTS` is this file's map, not its
   * own — see that emit site's own comment.
   */
  seats: 'forge:seats',
} as const;

/* ── Cursor ──────────────────────────────────────────────────────────── */

/** `{ epoch: string, seq: positive int }` — the draft's cursor, unchanged. */
export const WireCursorSchema = SeqCursorSchema;

export type { WireCursor };

/* ── Client → server ─────────────────────────────────────────────────── */

/** `forge:join` and `forge:resync` carry the same payload. */
export const MatchRequestSchema = borrowed.emptyObject
  .extend({ matchId: borrowed.nonEmptyString })
  .strict();

export type MatchRequest = Output<typeof MatchRequestSchema>;

/** `forge:c2s`. `frame` is validated by forge-wire's `safeParseClientFrame`. */
export const ClientEnvelopeSchema = borrowed.emptyObject
  .extend({ matchId: borrowed.nonEmptyString, frame: borrowed.unknown })
  .strict();

/** What this client emits: the schema's shape, with the frame's type known. */
export interface ClientEnvelope {
  matchId: string;
  frame: ClientFrame;
}

/**
 * `forge:full-control` — this seat wants every question and every stop, or
 * wants the shortcuts back (`play/auto.ts`). Nothing about the game crosses
 * here: it is a preference of the person sitting in the seat, and the server
 * binds it to the seat the socket claimed, never to a payload field.
 */
export const FullControlSchema = borrowed.emptyObject
  .extend({ matchId: borrowed.nonEmptyString, on: borrowed.boolean })
  .strict();

export type FullControlRequest = Output<typeof FullControlSchema>;

/** The payload of a `forge:full-control` emit, parsed through its own schema. */
export function fullControlFrame(matchId: string, on: boolean): FullControlRequest {
  return FullControlSchema.parse({ matchId, on });
}

/**
 * `forge:stop-preference` — item 2/6 (wave 30): *"always stop at end
 * step — default off."* Client → server only, and no echo: unlike full
 * control there is no seat-visible state this client needs told back, so a
 * fresh page reads the LAST value it itself persisted
 * (`@wolffm/prefs-client`, item 6) rather than anything the server answers.
 *
 * The shape is the wave brief's own suggestion, kept literally — `{ type:
 * 'stopPreference', stopAtEndStep }` beside `matchId` — because
 * `apps/server/src/play/transport.ts` already built its handler against
 * exactly this shape (see that file's own note on why: this lane's evidence
 * file had not landed when lane B reached the item). `type` rides on the
 * PAYLOAD even though the event name alone disambiguates it, for the same
 * reason that file gives: a client that logs the raw payload can tell what it
 * sent without cross-referencing the event name.
 */
export const StopPreferenceSchema = borrowed.emptyObject
  .extend({
    matchId: borrowed.nonEmptyString,
    type: borrowed.nonEmptyString.refine((v) => v === 'stopPreference', { message: "must be 'stopPreference'" }),
    stopAtEndStep: borrowed.boolean,
  })
  .strict();

export type StopPreferenceRequest = Output<typeof StopPreferenceSchema>;

/** The payload of a `forge:stop-preference` emit, parsed through its own schema. */
export function stopPreferenceFrame(matchId: string, stopAtEndStep: boolean): StopPreferenceRequest {
  return StopPreferenceSchema.parse({ matchId, type: 'stopPreference', stopAtEndStep });
}

/* ── Server → client ─────────────────────────────────────────────────── */

/** `forge:s2c`. `frame` is validated separately — see the module header. */
export const ServerEnvelopeSchema = borrowed.emptyObject
  .extend({
    matchId: borrowed.nonEmptyString,
    cursor: WireCursorSchema,
    frame: borrowed.unknown,
  })
  .strict();

export type ServerEnvelope = Output<typeof ServerEnvelopeSchema>;

/**
 * The answer to `forge:join` and `forge:resync`.
 *
 * `frames` is this recipient's WHOLE state-channel history, so replaying it
 * through `fold.ts` reproduces its state; `cursor` is the cursor of the last
 * frame included, or null when there is none yet. A pending ask is not in it:
 * the server re-sends that after the snapshot as an ordinary `forge:s2c`.
 */
export const MatchSnapshotSchema = borrowed.emptyObject
  .extend({
    matchId: borrowed.nonEmptyString,
    /** 0-based. */
    seat: borrowed.forgeId.min(0),
    /** This seat's Forge `PlayerView` id — who "me" is on the board. */
    playerId: borrowed.forgeId,
    cursor: WireCursorSchema.nullable(),
    frames: ServerFrameSchema.array(),
  })
  .strict();

export type MatchSnapshot = Output<typeof MatchSnapshotSchema>;

/**
 * A refused `forge:join` / `forge:resync`.
 *
 * `error` is the machine code every refusal carries, and it is unchanged.
 * `outcome` and `message` are **optional because exactly one refusal sends
 * them**: a match that is gone answers
 * `{ error: 'unknown-match', outcome: 'match-gone', message: '<a sentence>' }`
 * (wave 22 lane E — `matchGone` / `MATCH_GONE_WORDS` in
 * `apps/server/src/play/socket.ts`), while `match-full`, `not-joined`,
 * `match-starting` and `malformed: …` keep the bare `{ error }` they always
 * had. Do not "tidy" them into required fields: that would make every OTHER
 * refusal malformed. Their absence was the mirror bug — a `match-gone` ack
 * failed this schema, so `match.ts` folded it into *"answered with something
 * that is not a snapshot"*, `LiveBoard`'s `isMatchGone` never saw the refusal
 * word, and the player was told something generic about the match that had
 * just ended.
 *
 * `outcome` is a non-empty string rather than the literal `'match-gone'` on
 * purpose: pinning the literal here would refuse the next outcome the server
 * learns to send, which is this same bug again. The object stays `.strict()`,
 * so a MISSPELLED field (`outcom`, `mesage`) is still an error rather than
 * being quietly swallowed.
 *
 * The mirror named at the top of this file has not been brought across: the
 * server BUILDS this shape and never parses it, so nothing there is broken by
 * the difference, but it is the one place the two copies currently disagree.
 */
export const MatchErrorSchema = borrowed.emptyObject
  .extend({
    error: borrowed.nonEmptyString,
    outcome: borrowed.nonEmptyString.optional(),
    message: borrowed.nonEmptyString.optional(),
  })
  .strict();

export const MatchAckSchema = MatchSnapshotSchema.or(MatchErrorSchema);

export type MatchAck = Output<typeof MatchAckSchema>;

/**
 * `forge:seats` — item 4, wave 29 §B: one entry per seat, the shape
 * `Match.seatIdentities()` builds and the join-envelope log line at
 * `apps/server/src/play/socket.ts` (the "adopted match" line) has always used
 * for `seat`/`claimed`/`playerId`. `avatarId` is `unknown` here rather than a
 * typed string on purpose — three states can arrive over the wire (a string,
 * `null`, absent) even though the server's own two-state rule
 * (`D-avatar-field.md` §3) means it should only ever send a string or omit the
 * key. Typing it as a string would make a stray `null` fail this object's
 * `.strict()` parse and refuse the WHOLE seat list for one seat's bad avatar,
 * which is worse than drawing that one seat's bust. `match.ts`'s `adoptSeats`
 * folds all three the same way `avatarSquareUrl` already does.
 */
export const SeatIdentitySchema = borrowed.emptyObject
  .extend({
    seat: borrowed.forgeId.min(0),
    claimed: borrowed.boolean,
    /** Null until that seat's `openView` has landed — see `MatchSnapshot.playerId`'s own note. */
    playerId: borrowed.forgeId.nullable(),
    avatarId: borrowed.unknown.optional(),
  })
  .strict();

export type SeatIdentity = Output<typeof SeatIdentitySchema>;

export const MatchSeatsSchema = borrowed.emptyObject
  .extend({
    matchId: borrowed.nonEmptyString,
    seats: SeatIdentitySchema.array(),
  })
  .strict();

export type MatchSeats = Output<typeof MatchSeatsSchema>;

/* ── Parsing, with paths ─────────────────────────────────────────────── */

export interface TransportIssue {
  path: string;
  message: string;
}

export type TransportParse<T> = { ok: true; value: T } | { ok: false; errors: TransportIssue[] };

/** `$`, `$.cursor.seq`, `$.frames[3].payload` — forge-wire's spelling. */
function formatPath(path: readonly PropertyKey[]): string {
  let out = '$';
  for (const segment of path) out += typeof segment === 'number' ? `[${segment}]` : `.${String(segment)}`;
  return out;
}

function outcome<T>(
  result:
    | { success: true; data: T }
    | { success: false; error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] } },
): TransportParse<T> {
  if (result.success) return { ok: true, value: result.data };
  return { ok: false, errors: result.error.issues.map((i) => ({ path: formatPath(i.path), message: i.message })) };
}

export function parseServerEnvelope(raw: unknown): TransportParse<ServerEnvelope> {
  return outcome(ServerEnvelopeSchema.safeParse(raw));
}

/**
 * Branches on `error` rather than parsing the union: a union's failure is one
 * issue at `$`, and a snapshot that fails should say WHICH frame, at which
 * path, is wrong.
 */
export function parseMatchAck(raw: unknown): TransportParse<MatchAck> {
  const isError = typeof raw === 'object' && raw !== null && 'error' in raw;
  return isError ? outcome(MatchErrorSchema.safeParse(raw)) : outcome(MatchSnapshotSchema.safeParse(raw));
}

export function parseMatchSeats(raw: unknown): TransportParse<MatchSeats> {
  return outcome(MatchSeatsSchema.safeParse(raw));
}

/* ── Frame builders ──────────────────────────────────────────────────── */

export function replyFrame(callId: string, method: BlockingMethod, result: unknown): ClientReply {
  return { kind: 'reply', callId, method, result };
}

export function abortFrame(
  callId: string,
  reason: ClientAbort['reason'],
  detail?: string,
): ClientAbort {
  return detail === undefined ? { kind: 'abort', callId, reason } : { kind: 'abort', callId, reason, detail };
}
