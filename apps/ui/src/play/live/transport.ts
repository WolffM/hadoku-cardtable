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
 * `forge:seats` and `forge:role` are shared too: the server builds their
 * payloads as the shared types and this client parses them with the shared
 * schemas. What stays HERE is the ack union (`MatchAckSchema` /
 * `parseMatchAck`), which combines the shared `MatchSnapshotSchema` and
 * `MatchErrorSchema` for the one side that ever receives either.
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
 *                    stopAtEndStep }` — the settings panel's End step
 *                    checkbox (on by default). Client → server
 *                    only, same as full control's own no-ack shape.
 *   client → server  `forge:auto-yield`  `{ matchId, on }` — the Auto
 *                    Yield / Cancel Yield toggle. Client → server only, no ack.
 *   server → client  `forge:s2c`     `{ matchId, cursor, frame: ServerFrame }`
 *   server → client  `forge:seats`   one entry per seat — see the shared `SeatIdentitySchema`.
 *   server → client  `forge:role`    `{ matchId, role: 'player' | 'spectator' | 'watcher' }`.
 *                    `watcher` (2026-10-12): a socket with NO seat, sent the
 *                    public projection — every hand and library a count.
 *
 * `POST <base>/api/play/matches` starts a match; its body is the server's,
 * and nothing in this client needs it.
 */

import {
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
  parseMatchRole,
  parseMatchSeats,
  parseWith,
  PhaseStopSchema,
  phaseStopFrame,
  StopPhaseSchema,
  stopStep,
  parseServerEnvelope as sharedParseServerEnvelope,
  ServerEnvelopeSchema,
  StopPreferenceSchema,
  stopPreferenceFrame,
  TriggerDecisionRequestSchema,
  triggerDecisionFrame,
  TriggerDecisionsSchema,
  type ClientEnvelope,
  type MatchError,
  type MatchRequest,
  type MatchRole,
  type MatchSeats,
  type MatchSnapshot,
  type SeatIdentity,
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
  stopStep,
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
  parseMatchRole,
  parseMatchSeats,
};
export type { WireCursor, MatchRequest, ClientEnvelope, ServerEnvelope, MatchSnapshot, MatchRole, MatchSeats, SeatIdentity };

export const MatchAckSchema = MatchSnapshotSchema.or(MatchErrorSchema);

export type MatchAck = MatchSnapshot | MatchError;

/* ── Parsing, with paths — kept under this file's own long-standing names ── */

export type TransportIssue = MatchWireIssue;
export type TransportParse<T> = MatchWireParse<T>;

export function parseServerEnvelope(raw: unknown): TransportParse<ServerEnvelope> {
  return sharedParseServerEnvelope(raw);
}

/**
 * Branches on `error` rather than parsing the union: a union's failure is one
 * issue at `$`, and a snapshot that fails should say WHICH frame, at which
 * path, is wrong.
 */
export function parseMatchAck(raw: unknown): TransportParse<MatchAck> {
  const isError = typeof raw === 'object' && raw !== null && 'error' in raw;
  return isError ? parseWith(MatchErrorSchema, raw) : parseWith(MatchSnapshotSchema, raw);
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
