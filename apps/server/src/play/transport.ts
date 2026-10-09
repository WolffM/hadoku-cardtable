/**
 * The A↔B transport contract, server side — a thin re-export.
 *
 * **Wave 64 §S (S1/S8): the schemas moved to `packages/shared/src/match-wire.ts`,
 * once.** This file and its UI mirror (`apps/ui/src/play/live/transport.ts`)
 * used to each define the same nine (really ten — see that module's own
 * header) schemas side by side, both saying "the duplication is the
 * manager's call … and is recorded as a follow-up: the schemas belong in one
 * shared package. Until then a change here is a change there." That follow-up
 * is this file now: it imports and re-exports no schema of its own — every
 * name below is `@hadoku/shared`'s, so a change to the contract is a change
 * in exactly one place, and the two apps importing the SAME schema instance is
 * what makes "a drift is impossible" literally true rather than a hope.
 *
 * `fullControlEcho` is gone — the UI mirror's `fullControlFrame` is the one
 * name now (S1): the same one-line builder had two names for no reason beyond
 * which lane wrote it. `Parsed<T>` stays as a local alias of
 * `@hadoku/shared`'s `MatchWireParse<T>`, because `browser/protocol.ts` (not
 * this lane's file) still imports it by that name.
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
 *   client → server  `forge:auto-yield`  `{ matchId, on }`, no ack
 *
 * The cursor rule, the "no direct `zod` import" rule and every per-schema
 * rationale now live on `@hadoku/shared/match-wire.ts` — read it there; this
 * file states the wire shape once, as a pointer, and does not restate the why.
 */

export {
	MATCH_EVENTS,
	MatchRequestSchema,
	type MatchRequest,
	ClientEnvelopeSchema,
	type ClientEnvelope,
	FullControlSchema,
	type FullControlRequest,
	fullControlFrame,
	AutoYieldSchema,
	type AutoYieldRequest,
	StopPreferenceSchema,
	type StopPreferenceRequest,
	ServerEnvelopeSchema,
	type ServerEnvelope,
	MatchSnapshotSchema,
	type MatchSnapshot,
	MatchErrorSchema,
	type MatchError,
	type MatchWireParse as Parsed,
	parseMatchRequest,
	parseFullControl,
	parseAutoYield,
	parseStopPreference,
	parseClientEnvelope,
} from '@hadoku/shared';
export type { WireCursor } from '@hadoku/shared';
