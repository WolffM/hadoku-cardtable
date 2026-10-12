/*
 * The A↔B transport contract, client side.
 *
 * **Wave 64 §S (S1/S8): the schemas moved to `packages/shared/src/match-wire.ts`,
 * once.** This file and its server mirror (`apps/server/src/play/transport.ts`)
 * used to each define the same nine (really ten — see that module's own
 * header) schemas side by side; both said "the duplication is deliberate …
 * and is recorded as a follow-up: the schemas belong in a shared package.
 * Until then a change here is a change there." That follow-up is this file
 * now: every match-wire schema below is imported and re-exported, never
 * redefined, so the two apps share the SAME schema instance and a drift is
 * impossible rather than merely discouraged.
 *
 * What stays HERE, because nothing on the server parses it (it only builds
 * and sends it): `SeatIdentitySchema` / `MatchSeatsSchema` (`forge:seats`),
 * `MatchRoleSchema` (`forge:role`), and the ack union (`MatchAckSchema` /
 * `parseMatchAck`) that combines the shared `MatchSnapshotSchema` and
 * `MatchErrorSchema` for the one side that ever receives either. `MATCH_EVENTS`
 * (from `@hadoku/shared`) already carries `seats` and `role`'s event names —
 * only their payload schemas were ever at risk of a second copy, and they
 * never got one: the server builds and sends both ad hoc, it never parses
 * them.
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
 *                    only, same as full control's own no-ack shape.
 *   client → server  `forge:auto-yield`  `{ matchId, on }` — the Auto
 *                    Yield / Cancel Yield toggle. Client → server only, no ack.
 *   server → client  `forge:s2c`     `{ matchId, cursor, frame: ServerFrame }`
 *   server → client  `forge:seats`   one entry per seat — see `SeatIdentitySchema`.
 *   server → client  `forge:role`    `{ matchId, role: 'player' | 'spectator' }`.
 *
 * `POST <base>/api/play/matches` starts a match; its body is the server's,
 * and nothing in this client needs it.
 *
 * ## No direct `zod` import — read before "fixing" the two local schemas
 *
 * `@hadoku/ui` does not depend on `zod` (its manifest is the manager's), and
 * pnpm's strict layout means it cannot resolve it. `SeatIdentitySchema` and
 * `MatchRoleSchema` (the two schemas with no server-side copy to fold into
 * `@hadoku/shared`) are therefore still BUILT FROM schema instances the UI's
 * existing dependencies export, same device as before this fold.
 */

import {
  CallIdSchema,
  ClientReplySchema,
  ShowConfirmDialogReplySchema,
  TrackableIdSchema,
  type BlockingMethod,
  type ClientAbort,
  type ClientReply,
} from '@hadoku/forge-wire';
import {
  AutoYieldSchema,
  autoYieldFrame,
  ClientEnvelopeSchema,
  FullControlSchema,
  fullControlFrame,
  MATCH_EVENTS,
  MatchErrorSchema,
  MatchRequestSchema,
  MatchSnapshotSchema,
  parseClientEnvelope,
  PhaseStopSchema,
  phaseStopFrame,
  StopPhaseSchema,
  parseServerEnvelope as sharedParseServerEnvelope,
  SeqCursorSchema,
  ServerEnvelopeSchema,
  StopPreferenceSchema,
  stopPreferenceFrame,
  TriggerDecisionRequestSchema,
  triggerDecisionFrame,
  TriggerDecisionsSchema,
  type ClientEnvelope,
  type MatchError,
  type MatchRequest,
  type MatchSnapshot,
  type MatchWireIssue,
  type MatchWireParse,
  type ServerEnvelope,
  type StopPhase,
  type WireCursor,
} from '@hadoku/shared';

export {
  MATCH_EVENTS,
  MatchRequestSchema,
  ClientEnvelopeSchema,
  FullControlSchema,
  fullControlFrame,
  AutoYieldSchema,
  autoYieldFrame,
  PhaseStopSchema,
  phaseStopFrame,
  StopPhaseSchema,
  type StopPhase,
  StopPreferenceSchema,
  stopPreferenceFrame,
  TriggerDecisionRequestSchema,
  triggerDecisionFrame,
  TriggerDecisionsSchema,
  ServerEnvelopeSchema,
  MatchSnapshotSchema,
  MatchErrorSchema,
  parseClientEnvelope,
};
export type { WireCursor, MatchRequest, ClientEnvelope, ServerEnvelope, MatchSnapshot };

/* ── Borrowed primitives, for the two schemas that stay local to this file ── */

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

/* ── `forge:seats` / `forge:role` — nothing on the server PARSES these (it
 * only builds and sends them), so there was never a second copy here to
 * fold into `@hadoku/shared`; only the event NAME was ever duplicated, and
 * `MATCH_EVENTS` now carries that once. ───────────────────────────────── */

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
    /** Wave 31 §S: the name Forge shows for this seat. Absent when the server was not told one. */
    name: borrowed.nonEmptyString.optional(),
    /**
     * This seat's own open ask or mana payment —
     * `apps/server/src/play/match.ts`'s `waitingOnFor`. Absent whenever this
     * seat has neither (the same two-state rule `avatarId` already follows).
     * `method` is the ask's wire method, or the synthetic `'pay'`; `match.ts`'s
     * `adoptSeats` carries both straight onto `LiveMatch.waitingOn`, and
     * `LiveBoard.tsx` owns turning `method` into a verb.
     */
    waitingOn: borrowed.emptyObject
      .extend({ method: borrowed.nonEmptyString, hostCard: borrowed.nonEmptyString.nullable() })
      .strict()
      .optional(),
    /**
     * The coin toss — `apps/server/src/play/match.ts`'s `SeatIdentity.coinToss`:
     * the same row on every seat's entry while the winner's Play/Draw bar is
     * live, so BOTH screens draw the flip landing on the winner (`CoinToss.tsx`).
     */
    coinToss: borrowed.emptyObject.extend({ winner: borrowed.forgeId.min(0), at: borrowed.unknown }).strict().optional(),
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

/** `forge:role` — see {@link MATCH_EVENTS}. */
export const MatchRoleSchema = borrowed.emptyObject
  .extend({ matchId: borrowed.nonEmptyString, role: borrowed.nonEmptyString.refine((r) => r === 'player' || r === 'spectator', 'role is player or spectator') })
  .strict();

export type MatchRole = { matchId: string; role: 'player' | 'spectator' };

export const MatchAckSchema = MatchSnapshotSchema.or(MatchErrorSchema);

export type MatchAck = MatchSnapshot | MatchError;

/* ── Parsing, with paths — kept under this file's own long-standing names ── */

export type TransportIssue = MatchWireIssue;
export type TransportParse<T> = MatchWireParse<T>;

export function parseServerEnvelope(raw: unknown): TransportParse<ServerEnvelope> {
  return sharedParseServerEnvelope(raw);
}

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

/**
 * Branches on `error` rather than parsing the union: a union's failure is one
 * issue at `$`, and a snapshot that fails should say WHICH frame, at which
 * path, is wrong.
 */
export function parseMatchAck(raw: unknown): TransportParse<MatchAck> {
  const isError = typeof raw === 'object' && raw !== null && 'error' in raw;
  return isError ? outcome(MatchErrorSchema.safeParse(raw)) : outcome(MatchSnapshotSchema.safeParse(raw));
}

export function parseMatchRole(raw: unknown): TransportParse<MatchRole> {
  return outcome(MatchRoleSchema.safeParse(raw)) as TransportParse<MatchRole>;
}

export function parseMatchSeats(raw: unknown): TransportParse<MatchSeats> {
  return outcome(MatchSeatsSchema.safeParse(raw));
}

/* ── Frame builders, server events this client alone defines ─────────── */

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
