/*
 * The transport envelope around `DraftView`.
 *
 * `draft.ts` says what a draft payload IS. This file says how one crosses a
 * wire: the event names, joining and leaving, the pick action, the resync
 * request, the full-state response, and the error shape. The two are separable
 * on purpose — the payload is the same object whether it came from a socket or
 * from the in-process engine in `apps/ui/src/draft/live.ts`, and keeping the
 * envelope out of `draft.ts` is what lets the local source keep working with no
 * transport at all.
 *
 * ## One cursor, not two
 *
 * `DraftView` already carries `{ epoch, seq }` — `@wolffm/rooms-protocol`'s
 * `SeqCursor` by another name. A server→client envelope carries a `cursor` so
 * `classifySeq` runs over the envelope directly without reaching inside the
 * payload, but that cursor is NOT a second, independent pair: for every
 * envelope that carries a view, `cursor` must equal the view's own `epoch` and
 * `seq`, and `serverMessageIssues` rejects a message where they disagree. The
 * builders below (`stateMessage`, `updateMessage`) derive the cursor from the
 * view, so the only way to produce a disagreeing pair is to hand-assemble an
 * object and skip them — and then the parse helper says so.
 *
 * ## The client never says who it is
 *
 * Every client→server schema is a STRICT object. That is the whole mechanism:
 * a `participantId` (or `seatId`, or `token`) added to a join or a pick is a
 * parse error, not a silently stripped field. Zod's default is to strip
 * unknown keys, which would make a client claiming an identity *parse clean*
 * and leave the server free to trust it. Identity comes from the edge headers
 * the friend gate sets; it is never a value the browser supplies. See
 * `apps/server/src/edge-auth.ts`.
 *
 * `clientMessageIssues` additionally names identity-shaped keys explicitly,
 * because "unrecognized key: participantId" is a true but uninformative way to
 * report the one mistake this rule exists to stop.
 *
 * ## Hidden information, still structural
 *
 * Nothing added here can carry cards except the `view` field, which is a
 * `DraftView` and therefore already incapable of holding another seat's pack or
 * pool (see `draft.ts`'s header). An error is a code plus an optional string:
 * a rejection reason never quotes the card it rejected from someone else's
 * pack. `serverMessageIssues` runs the full `semanticIssues` pass over the
 * embedded view, so the D13 no-images control and the seat-leak control apply
 * to anything arriving over the wire, not just to committed fixtures.
 */

import { z } from 'zod';
import type { SeqCursor } from '@wolffm/rooms-protocol';

import { DraftIdSchema, DraftViewSchema, SeatIdSchema, type DraftView } from './draft.ts';
import { formatPath, semanticIssues, type ValidationFailure } from './semantics.ts';

/* ── The cursor ──────────────────────────────────────────────────────── */

/**
 * `{ epoch, seq }` — structurally `@wolffm/rooms-protocol`'s `SeqCursor`.
 *
 * Declared here as a Zod schema rather than imported, because that package is
 * deliberately zod-free; `asSeqCursor` below is the compile-time proof the two
 * have not drifted.
 */
export const SeqCursorSchema = z.object({
  epoch: z.string().min(1),
  seq: z.number().int().positive(),
});

export type WireCursor = z.infer<typeof SeqCursorSchema>;

/**
 * Hand a wire cursor to anything expecting a `SeqCursor` — `classifySeq`,
 * `missedCount`, `needsResync`.
 *
 * The body is the identity function; the point is the signature. If the two
 * shapes ever diverge, this file stops compiling, which is cheaper than
 * discovering it when gap detection quietly stops working.
 */
export function asSeqCursor(cursor: WireCursor): SeqCursor {
  return cursor;
}

/** The cursor a payload already carries. There is no other source for one. */
export function cursorOf(view: DraftView): WireCursor {
  return { epoch: view.epoch, seq: view.seq };
}

/* ── Event names ─────────────────────────────────────────────────────── */

/**
 * One socket.io event name per DIRECTION, not per message type.
 *
 * A per-type event name (`draft:pick`, `draft:join`, …) reads nicer and is
 * worse: each one is a separate `socket.on` registration, and the first handler
 * somebody adds without routing through `parseClientMessage` is an unvalidated
 * entry point nobody notices. One name per direction means one handler per
 * direction, and the tagged union below is what dispatches. It also keeps
 * ordering trivially total — socket.io guarantees order within a connection,
 * and interleaving several event names makes "the envelope after this one" a
 * question with no answer.
 */
export const DRAFT_CHANNEL = {
  /** Client → server. Payload: `ClientMessage`. */
  clientToServer: 'draft:c2s',
  /** Server → client. Payload: `ServerMessage`. */
  serverToClient: 'draft:s2c',
} as const;

/* ── Client → server ─────────────────────────────────────────────────── */

/**
 * Join a draft.
 *
 * A room id and nothing else. Which seat the joiner gets, and whether they get
 * one at all, is the server's answer — derived from the edge-authenticated
 * participant — not the client's request.
 */
export const JoinDraftSchema = z.strictObject({
  type: z.literal('join'),
  draftId: DraftIdSchema,
});

/** Leave a draft. Seat reservation TTL, not the client, decides what happens next. */
export const LeaveDraftSchema = z.strictObject({
  type: z.literal('leave'),
  draftId: DraftIdSchema,
});

/**
 * Take a card from the pack in front of you.
 *
 * `cardId`, not an index: an index is a claim about a pack the client may be
 * holding a stale copy of, and two clients disagreeing about the order of a
 * pack would silently pick different cards. The `cardId` is stable within a
 * draft, so a stale pick fails loudly as `card-not-in-pack`.
 *
 * There is no seat field. The seat is the server's business.
 */
export const PickActionSchema = z.strictObject({
  type: z.literal('pick'),
  draftId: DraftIdSchema,
  cardId: z.string().min(1),
});

/**
 * "I think I missed something — send me the whole state."
 *
 * `have` is the cursor the client last applied, or null when it has applied
 * nothing. It is a hint for the server's logs and for deciding how much to
 * send; the response is a full `state` message either way, because a draft
 * payload is small and a delta protocol is a second thing to get wrong.
 */
export const ResyncRequestSchema = z.strictObject({
  type: z.literal('resync'),
  draftId: DraftIdSchema,
  have: SeqCursorSchema.nullable(),
});

/**
 * "Show me this drafter's pack and picks." A spectator's choice of whose
 * shoulder to look over; a seated drafter's view is their own seat whatever
 * they send. `drafter`, not `seatId`: it names somebody else's seat, never the
 * sender's own (the identity-key rule above).
 */
export const WatchDraftSchema = z.strictObject({
  type: z.literal('watch'),
  draftId: DraftIdSchema,
  drafter: SeatIdSchema,
});

/** Everything a browser may say. Strict — see the module header. */
export const ClientMessageSchema = z.discriminatedUnion('type', [
  JoinDraftSchema,
  LeaveDraftSchema,
  PickActionSchema,
  ResyncRequestSchema,
  WatchDraftSchema,
]);

export type JoinDraft = z.infer<typeof JoinDraftSchema>;
export type LeaveDraft = z.infer<typeof LeaveDraftSchema>;
export type PickAction = z.infer<typeof PickActionSchema>;
export type ResyncRequest = z.infer<typeof ResyncRequestSchema>;
export type WatchDraft = z.infer<typeof WatchDraftSchema>;
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

/* ── Errors ──────────────────────────────────────────────────────────── */

/**
 * The engine's own `PickRejection`, verbatim.
 *
 * `packages/draft/src/engine.ts` returns these as values rather than throwing,
 * and the wire must be able to carry every one of them or the server is forced
 * to flatten a known reason into a string. Kept as a literal list rather than
 * imported because `@hadoku/draft` depends on this package, not the other way
 * round; `wire.test.ts` pins the five so a change there fails here.
 */
export const PICK_REJECTION_CODES = [
  'draft-complete',
  'unknown-seat',
  'empty-pack',
  'already-picked',
  'card-not-in-pack',
] as const;

/**
 * Failures that happen before the engine is ever consulted.
 *
 * `malformed-message` is what the server answers junk with — the parse helpers
 * exist so it can reject without a cast, and a rejection needs a code to be a
 * value rather than a string.
 */
export const TRANSPORT_ERROR_CODES = [
  'not-seated',
  'rate-limited',
  'unknown-draft',
  'not-your-turn',
  'malformed-message',
] as const;

export const WireErrorCodeSchema = z.enum([...PICK_REJECTION_CODES, ...TRANSPORT_ERROR_CODES]);

/**
 * An error is a value.
 *
 * `code` is what anything branches on. `detail` is for a human reading a log
 * and is never the only thing carried — a UI that wants to say something
 * useful reads the code, so a server that changes its prose does not change
 * the client's behaviour.
 */
export const WireErrorSchema = z.strictObject({
  code: WireErrorCodeSchema,
  detail: z.string().optional(),
});

export type PickRejectionCode = (typeof PICK_REJECTION_CODES)[number];
export type TransportErrorCode = (typeof TRANSPORT_ERROR_CODES)[number];
export type WireErrorCode = z.infer<typeof WireErrorCodeSchema>;
export type WireError = z.infer<typeof WireErrorSchema>;

/** Whether a code came from the draft engine rather than the transport. */
export function isPickRejection(code: WireErrorCode): code is PickRejectionCode {
  return (PICK_REJECTION_CODES as readonly string[]).includes(code);
}

/* ── Server → client ─────────────────────────────────────────────────── */

/**
 * What cube this draft is being run from. Descriptive only.
 *
 * Optional because the engine does not know it — `createDraft` takes a pool of
 * cards, not a cube name — so a server that has not been told cannot invent
 * one. The UI shows it when it is there and says nothing when it is not,
 * rather than printing a placeholder that looks like data.
 */
export const CubeMetaSchema = z.strictObject({
  name: z.string().min(1),
  size: z.number().int().positive(),
});

export type CubeMeta = z.infer<typeof CubeMetaSchema>;

/**
 * The full state. A BASELINE, not a step.
 *
 * Sent on join, in answer to a resync, and after an epoch change. The client
 * adopts it wholesale and sets its cursor from it rather than requiring it to
 * follow the previous one — see `resync.d.ts`: "a client joining mid-stream has
 * missed everything by definition, and its snapshot — not a resync request — is
 * what establishes the baseline".
 */
export const DraftStateMessageSchema = z.object({
  type: z.literal('state'),
  cursor: SeqCursorSchema,
  view: DraftViewSchema,
  cube: CubeMetaSchema.optional(),
});

/**
 * What an update envelope's payload is, said by the envelope.
 *
 * `classifySeq` models a DELTA stream: each step is only meaningful on top of
 * the one before it, so a skipped seq is lost information and the only safe
 * answer is a resync. A `DraftView` is not that. It is the whole state for its
 * recipient, so a step that arrives after a skipped seq still describes the
 * table completely — the skipped steps are superseded, not missing. Wave 10
 * measured what treating one as the other costs: the room takes a human pick
 * and every bot pick behind it in one call, `seq` moves by ~7, one envelope
 * goes out, and every browser answered every round with a resync (90 picks,
 * 90 resyncs).
 *
 * - `'full-state'` — self-contained. Applied whatever its seq jump, EXCEPT
 *   across an epoch: a different room incarnation still discards local state
 *   and refetches, because a restart is the one thing a complete payload does
 *   not make safe to adopt as a step.
 * - `'delta'`, or absent — a step. `classifySeq` governs it exactly as before,
 *   gap included. Absent means delta on purpose: an envelope that does not say
 *   it is complete is not assumed to be.
 *
 * This is a statement about the envelope, not a loosening of `classifySeq`:
 * the verdict is still computed and still reported as `gap`; what changes is
 * that a self-contained payload does not need the recovery path to recover.
 */
const UpdateCarriesSchema = z.enum(['full-state', 'delta']);

type UpdateCarries = z.infer<typeof UpdateCarriesSchema>;

/**
 * One step of the stream. `classifySeq` decides whether it applies, and
 * `carries` decides what a `gap` verdict means for it — see `UpdateCarriesSchema`.
 */
export const DraftUpdateMessageSchema = z.object({
  type: z.literal('update'),
  cursor: SeqCursorSchema,
  carries: UpdateCarriesSchema.optional(),
  view: DraftViewSchema,
});

/**
 * A rejection.
 *
 * Carries a cursor like everything else in this direction, so one handler can
 * classify every inbound envelope without first asking what kind it is. The
 * cursor is the state the error was evaluated against, so it does NOT advance
 * the stream: `classifySeq` answers `duplicate` for it, `needsResync` answers
 * false, and the error surfaces through the error path rather than the
 * state-application path. That is deliberate — an error that advanced the
 * sequence would leave every other client with a permanent gap.
 */
export const DraftErrorMessageSchema = z.object({
  type: z.literal('error'),
  cursor: SeqCursorSchema,
  error: WireErrorSchema,
});

export const ServerMessageSchema = z.discriminatedUnion('type', [
  DraftStateMessageSchema,
  DraftUpdateMessageSchema,
  DraftErrorMessageSchema,
]);

export type DraftStateMessage = z.infer<typeof DraftStateMessageSchema>;
export type DraftUpdateMessage = z.infer<typeof DraftUpdateMessageSchema>;
export type DraftErrorMessage = z.infer<typeof DraftErrorMessageSchema>;
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

/** A message that carries a payload, as opposed to a rejection. */
export function carriesView(msg: ServerMessage): msg is DraftStateMessage | DraftUpdateMessage {
  return msg.type === 'state' || msg.type === 'update';
}

/* ── Builders ────────────────────────────────────────────────────────── */
/*
 * These exist so the cursor is never typed twice. Every one of them derives it
 * from the thing that already has it.
 */

export function joinDraft(draftId: string): JoinDraft {
  return { type: 'join', draftId };
}

export function leaveDraft(draftId: string): LeaveDraft {
  return { type: 'leave', draftId };
}

export function pickCard(draftId: string, cardId: string): PickAction {
  return { type: 'pick', draftId, cardId };
}

export function resyncRequest(draftId: string, have: WireCursor | null): ResyncRequest {
  return { type: 'resync', draftId, have };
}

export function watchDraft(draftId: string, drafter: number): WatchDraft {
  return { type: 'watch', draftId, drafter };
}

export function stateMessage(view: DraftView, cube?: CubeMeta): DraftStateMessage {
  return cube === undefined
    ? { type: 'state', cursor: cursorOf(view), view }
    : { type: 'state', cursor: cursorOf(view), view, cube };
}

/**
 * A step. Unmarked unless `carries` is given, and unmarked reads as `delta` —
 * the caller that knows its payload is complete is the one that says so.
 */
export function updateMessage(view: DraftView, carries?: UpdateCarries): DraftUpdateMessage {
  return carries === undefined
    ? { type: 'update', cursor: cursorOf(view), view }
    : { type: 'update', cursor: cursorOf(view), carries, view };
}

export function errorMessage(
  cursor: WireCursor,
  code: WireErrorCode,
  detail?: string,
): DraftErrorMessage {
  return detail === undefined
    ? { type: 'error', cursor, error: { code } }
    : { type: 'error', cursor, error: { code, detail } };
}

/* ── The rules a schema cannot state ─────────────────────────────────── */

/** Keys that would be a client claiming an identity. Reported by name. */
const IDENTITY_SHAPED = new Set([
  'participantId',
  'participant',
  'userId',
  'user',
  'playerId',
  'seatId',
  'seat',
  'identity',
  'token',
  'auth',
  'displayName',
  'name',
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Identity-shaped keys on a client message, named for what they are.
 *
 * The strict schemas already reject them; this only improves the message. A
 * developer who reads "unrecognized key: participantId" adds it to the schema.
 * A developer who reads the sentence below does not.
 */
export function clientMessageIssues(raw: unknown): ValidationFailure[] {
  const out: ValidationFailure[] = [];
  if (!isRecord(raw)) return out;
  for (const key of Object.keys(raw)) {
    if (!IDENTITY_SHAPED.has(key)) continue;
    out.push({
      path: formatPath([key]),
      message:
        `a client never supplies its own identity: "${key}" is derived from the ` +
        `edge headers, and accepting it from the browser is the impersonation bug ` +
        `this rule exists to stop`,
    });
  }
  return out;
}

/**
 * The envelope's cursor must be the view's cursor, plus every semantic rule
 * `draft.ts` already applies to a payload.
 *
 * Run over the RAW input, for the same reason `semanticIssues` is: Zod strips
 * unknown keys, so by the time a message has parsed, a card that arrived
 * carrying an `image_uris` has already lost it and there is nothing left to
 * reject. A wire is exactly where that matters.
 */
export function serverMessageIssues(raw: unknown): ValidationFailure[] {
  const out: ValidationFailure[] = [];
  if (!isRecord(raw)) return out;

  const cursor = raw.cursor;
  const view = raw.view;

  if (raw.type === 'state' || raw.type === 'update') {
    if (isRecord(cursor) && isRecord(view)) {
      if (cursor.epoch !== view.epoch) {
        out.push({
          path: formatPath(['cursor', 'epoch']),
          message: `envelope epoch ${JSON.stringify(cursor.epoch)} disagrees with the payload's ${JSON.stringify(view.epoch)} — there is one cursor, not two`,
        });
      }
      if (cursor.seq !== view.seq) {
        out.push({
          path: formatPath(['cursor', 'seq']),
          message: `envelope seq ${JSON.stringify(cursor.seq)} disagrees with the payload's ${JSON.stringify(view.seq)} — there is one cursor, not two`,
        });
      }
    }
    for (const issue of semanticIssues(view)) {
      out.push({ path: issue.path.replace(/^\$/, '$.view'), message: issue.message });
    }
  }

  return out;
}

/* ── Parse helpers, one per direction ────────────────────────────────── */

type ParseOutcome<T> = { ok: true; value: T } | { ok: false; errors: ValidationFailure[] };

function collect<T>(
  schema: z.ZodType<T>,
  raw: unknown,
  extra: (raw: unknown) => ValidationFailure[],
): ParseOutcome<T> {
  const structural = schema.safeParse(raw);
  const errors: ValidationFailure[] = [];
  if (!structural.success) {
    for (const issue of structural.error.issues) {
      errors.push({
        path: formatPath(issue.path as Array<string | number>),
        message: issue.message,
      });
    }
  }
  errors.push(...extra(raw));
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: (structural as { data: T }).data };
}

/**
 * Validate something a browser sent. Non-throwing; reports every failure.
 *
 * This is what stands between the server and a cast. `safeParseClientMessage`
 * then `switch (msg.type)` is the whole inbound path; there is no branch where
 * an unparsed object reaches the engine.
 */
export function safeParseClientMessage(raw: unknown): ParseOutcome<ClientMessage> {
  return collect(ClientMessageSchema, raw, clientMessageIssues);
}

/** Validate or throw, naming what was being parsed. */
export function parseClientMessage(raw: unknown, label = 'client message'): ClientMessage {
  const result = safeParseClientMessage(raw);
  if (result.ok) return result.value;
  const detail = result.errors.map((e) => `  ${e.path}: ${e.message}`).join('\n');
  throw new Error(`${label} is not a valid ClientMessage:\n${detail}`);
}

/**
 * Validate something the server sent.
 *
 * A client validating its own server sounds redundant and is not: the payload
 * is the only place a hidden-information or D13 regression could arrive, and
 * this is the last place before it reaches a component. It is also how the
 * socket driver is testable at all — a stub transport hands it arbitrary
 * objects and the driver has to behave.
 */
export function safeParseServerMessage(raw: unknown): ParseOutcome<ServerMessage> {
  return collect(ServerMessageSchema, raw, serverMessageIssues);
}

/** Validate or throw, naming what was being parsed. */
export function parseServerMessage(raw: unknown, label = 'server message'): ServerMessage {
  const result = safeParseServerMessage(raw);
  if (result.ok) return result.value;
  const detail = result.errors.map((e) => `  ${e.path}: ${e.message}`).join('\n');
  throw new Error(`${label} is not a valid ServerMessage:\n${detail}`);
}
