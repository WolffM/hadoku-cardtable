/*
 * The match transport contract: how a Forge frame travels between the play
 * server (`apps/server/src/play/transport.ts`) and the browser
 * (`apps/ui/src/play/live/transport.ts`), on top of `@hadoku/forge-wire`'s
 * envelope.
 *
 * ## Wave 64 §S (S1/S8) — one copy, not two
 *
 * Both apps wrote this contract in parallel against one fixed design (wave 9)
 * and each kept its own mirror, "until the schemas belong in one shared
 * package" — which is the whole of what this file is. The nine schemas that
 * were byte-identical in both mirrors live here once: `MATCH_EVENTS`,
 * `WireCursorSchema`, `MatchRequestSchema`, `ClientEnvelopeSchema`,
 * `FullControlSchema`, `StopPreferenceSchema`, `ServerEnvelopeSchema`,
 * `MatchSnapshotSchema` and `MatchErrorSchema` — plus a tenth,
 * `AutoYieldSchema`, which the wave-64 inventory's own count missed (it was
 * added after that inventory was taken, by the same fork commit as the other
 * nine) but is the identical duplicate the other nine are. Both apps' own
 * `transport.ts` import and re-export NONE of these as their own — see each
 * file's header.
 *
 * `fullControlEcho` (the server's name) and `fullControlFrame` (the client's)
 * were the same one-line builder under two names; this file keeps one,
 * `fullControlFrame`, since it already named the one direction-agnostic idea
 * ("build this payload"), where "echo" implied only the server→client half.
 *
 * ## `ServerEnvelopeSchema` stays eager; `parseServerEnvelope` does not
 *
 * The two mirrors disagreed here before this fold, in a way that mattered:
 * the server's `ServerEnvelopeSchema` validated `frame` eagerly, inline, as a
 * full `ServerFrameSchema` (every `apps/server/src/play/browser/*.test.ts`
 * and `match.test.ts` call relies on `.parse(...)` handing back a FRAME,
 * typed, not `unknown`); the client's left `frame` as `unknown` on the
 * SCHEMA and `parseServerEnvelope` does NOT check it at all — it is the
 * ENVELOPE's own parse, nothing more.
 *
 * **The frame's own validation is the CALLER's second stage, not this
 * function's.** `apps/ui/src/play/live/match.ts`'s `ingest()` calls
 * `parseServerEnvelope` first, reads `cursor` off the result, decides
 * duplicate/gap/resync from it, and only THEN calls `safeParseServerFrame`
 * on the frame itself — because a frame that fails to parse is exactly the
 * one whose CURSOR the client needs, to know it has missed state and must
 * resync. Folding frame validation into `parseServerEnvelope` would make it
 * fail the WHOLE envelope the instant the frame was the problem, and
 * `ingest()` would have no cursor left to resync from — which is a real
 * regression this file shipped once and a real-browser-shaped unit test
 * (`match.test.ts`'s "an ask that does not parse is still aborted, and the
 * client resyncs") caught: a resync and an `unsupported` abort both depend
 * on `ingest()` getting a cursor back from an envelope whose FRAME is
 * garbage.
 *
 * So: `ServerEnvelopeSchema` itself is the server's eager shape (one schema,
 * used directly by both apps' own `.parse`/`.safeParse` tests), and
 * `parseServerEnvelope` derives its own more lenient variant from it
 * (`.extend({ frame: z.unknown() })`) rather than hand-duplicating a second
 * schema — but it stops there. It never calls `safeParseServerFrame`. The
 * `ServerEnvelope` interface's `frame: ServerFrame` field is therefore a
 * TYPE the caller is trusted to re-check, exactly as it was before this
 * fold's UI mirror.
 *
 * ## No direct `zod` import — from the OTHER two packages' point of view
 *
 * `@hadoku/server` and `@hadoku/ui` do not depend on `zod` directly; their
 * manifests are the manager's. That is still true after this fold — they
 * import compiled schema INSTANCES from here, never `zod` itself. This
 * package already depends on `zod` directly (see `wire.ts`), so the schemas
 * below are built with it plainly, rather than through the "borrowed
 * primitives" device both mirrors used to dodge a dependency they are not
 * the one holding any more.
 */

import { z } from 'zod';
import {
  FORGE_CHANNEL,
  PHASE_TYPES,
  PhaseTypeSchema,
  ServerFrameSchema,
  TriggerDecisionSchema,
  safeParseClientFrame,
  type ClientFrame,
  type PhaseType,
  type ServerFrame,
} from '@hadoku/forge-wire';

import { SeqCursorSchema, type WireCursor } from './wire.ts';
import { PlacementSchema, type Placement } from './placement.ts';
import { formatPath } from './semantics.ts';

/* ── Event names ─────────────────────────────────────────────────────── */

/** Every socket.io event the match transport uses, both directions. */
export const MATCH_EVENTS = {
  join: 'forge:join',
  resync: 'forge:resync',
  serverToClient: FORGE_CHANNEL.serverToClient,
  clientToServer: FORGE_CHANNEL.clientToServer,
  /** Wave 19 lane C: the full-control escape hatch, per seat, off by default. */
  fullControl: 'forge:full-control',
  /**
   * The opponent's-turn yield toggle. Client → server only, no ack: the
   * override's own lifetime is one turn, so a reload simply draws the
   * button off. See {@link AutoYieldSchema}.
   */
  autoYield: 'forge:auto-yield',
  /**
   * The seat's one-shot stop at a phase, both ways like `forge:full-control`:
   * client → server sets or clears it, server → client is the seat's current
   * stop, after every snapshot and whenever it changes. See {@link PhaseStopSchema}.
   */
  phaseStop: 'forge:phase-stop',
  /**
   * Wave 30 §B item 2/6: *"always stop at end step — default off"*. Client →
   * server only, same no-ack shape as `forge:full-control`. See
   * {@link StopPreferenceSchema}.
   */
  stopPreference: 'forge:stop-preference',
  /**
   * Wave 29 §B item 4: every seat's `{ seat, claimed, playerId, avatarId?,
   * name?, waitingOn? }`, sent on this event right after the full-control
   * echo, on every join AND every resync. The payload schema
   * (`SeatIdentitySchema`/`MatchSeatsSchema`) stays in `apps/ui`'s own
   * `transport.ts`: nothing on the server parses it, only builds and sends
   * it (`Match.seatIdentities()`), so there is no second copy to fold — only
   * the event NAME was duplicated (the server used to spell it as a bare
   * string specifically because this map did not carry it; wave 64 §S closed
   * that gap).
   */
  seats: 'forge:seats',
  /**
   * Wave 31 §S: which kind of connection THIS socket is for its seat — the
   * one that controls it, or a spectator of it. Server → client only, to the
   * one socket, after every join and resync and again on promotion. The
   * server enforces (it refuses a spectator's inputs); the client only
   * explains. The payload schema (`MatchRoleSchema`) stays in `apps/ui`'s own
   * `transport.ts` for the same reason `seats`' does.
   */
  role: 'forge:role',
  /**
   * An optional trigger's remembered answer — "Always" on its confirm, or a
   * clear in the settings. Client → server, see {@link TriggerDecisionRequestSchema}.
   */
  triggerDecision: 'forge:trigger-decision',
  /**
   * The seat's remembered trigger answers, all of them. Server → client, to the
   * seat's own socket, on every change and every join and resync. See
   * {@link TriggerDecisionsSchema}.
   */
  triggerDecisions: 'forge:trigger-decisions',
} as const;

/* ── Cursor ──────────────────────────────────────────────────────────── */

/** `{ epoch: string, seq: positive int }` — the draft's cursor, unchanged. */
export const WireCursorSchema = SeqCursorSchema;
export type { WireCursor };

/* ── Client → server ─────────────────────────────────────────────────── */

/** `forge:join` and `forge:resync` carry the same payload. */
export const MatchRequestSchema = z.object({ matchId: z.string().min(1) }).strict();
export type MatchRequest = z.infer<typeof MatchRequestSchema>;

/** `forge:c2s`. `frame` is checked second, by forge-wire's `safeParseClientFrame`. */
export const ClientEnvelopeSchema = z
  .object({ matchId: z.string().min(1), frame: z.unknown(), placement: PlacementSchema.optional() })
  .strict();

export interface ClientEnvelope {
  matchId: string;
  frame: ClientFrame;
  /** Where the card a `selectCard` act plays goes (`placement.ts`); only with a `selectCard` act. */
  placement?: Placement;
}

/**
 * `forge:full-control` — this seat wants every question and every stop, or
 * wants the shortcuts back (`apps/server/src/play/auto.ts`). Nothing about
 * the game crosses here: it is a preference of the person sitting in the
 * seat, and the server binds it to the seat the socket claimed, never to a
 * payload field.
 *
 * **It travels both ways, on one event and one schema.** Client → server it
 * is a request; server → client it is the seat's CURRENT state, sent to a
 * socket that has just been answered a snapshot — a refresh needs it told
 * again, the same reason the prompt and the bar are (`resendAfterSnapshot`).
 * The payload is identical in both directions, so neither side needs a
 * second schema and a drift is impossible.
 */
export const FullControlSchema = z.object({ matchId: z.string().min(1), on: z.boolean() }).strict();
export type FullControlRequest = z.infer<typeof FullControlSchema>;

/** The payload of a `forge:full-control` message, built THROUGH the schema so a malformed one cannot be sent. */
export function fullControlFrame(matchId: string, on: boolean): FullControlRequest {
  return FullControlSchema.parse({ matchId, on });
}

/**
 * `forge:auto-yield` — a preference of the seat, the same shape as
 * `forge:full-control`'s own schema; nothing about the game crosses here.
 * Client → server only: the override's own lifetime is one turn, so a reload
 * simply draws the button off, same as a turn that already moved on would.
 */
export const AutoYieldSchema = z.object({ matchId: z.string().min(1), on: z.boolean() }).strict();
export type AutoYieldRequest = z.infer<typeof AutoYieldSchema>;

/** The payload of a `forge:auto-yield` emit, parsed through its own schema. */
export function autoYieldFrame(matchId: string, on: boolean): AutoYieldRequest {
  return AutoYieldSchema.parse({ matchId, on });
}

/**
 * What a stop can be put on: every phase Forge opens a priority window in, and
 * `COMBAT`, the rail's one row for the six combat steps outside combat — a stop
 * on the next combat as a whole, held at the step {@link stopStep} names.
 * Untap never gives priority, and Cleanup only does when something triggers
 * in it (`PhaseHandler.onPhaseBegin`), so a stop on either would wait for a
 * window Forge does not open.
 */
export const StopPhaseSchema = z.enum([...PhaseTypeSchema.exclude(['UNTAP', 'CLEANUP']).options, 'COMBAT']);
export type StopPhase = z.infer<typeof StopPhaseSchema>;

const COMBAT_STEPS: readonly string[] = PHASE_TYPES.filter((p) => p.startsWith('COMBAT_'));

/**
 * The step a stop holds the seat's priority in, on a turn that is (`myTurn`) or
 * is not the seat's own. A phase stop is its own phase. `COMBAT` on the seat's
 * own turn is Beginning of combat, before it declares; on the opponent's it is
 * Declare attackers, once the attackers are known and before blocks — the
 * defender's window for a combat trick (the operator, 2026-10-12: a trick cast
 * at the opponent's Beginning of combat has no attackers to affect).
 */
export function stopStep(stop: StopPhase, myTurn: boolean): PhaseType {
  if (stop !== 'COMBAT') return stop;
  return myTurn ? 'COMBAT_BEGIN' : 'COMBAT_DECLARE_ATTACKERS';
}

/** Whether `phase` (a `PhaseType` name) is part of the stop's occurrence: the phase itself, or any combat step for `COMBAT`. */
export function stopCovers(stop: StopPhase, phase: string): boolean {
  return stop === 'COMBAT' ? COMBAT_STEPS.includes(phase) : stop === phase;
}

/**
 * What a priority window in `phase` does to a pending stop: `hold` it is the
 * stop's step; `missed` it is a later step of the stop's own occurrence, so the
 * step went by with no window — Forge gives none in Declare attackers when
 * nobody attacks (`PhaseHandler.onPhaseBegin`), and the stop is spent with that
 * combat rather than carried to a later turn; `wait` anything else.
 */
export function stopAt(stop: StopPhase, myTurn: boolean, phase: PhaseType): 'hold' | 'missed' | 'wait' {
  const step = stopStep(stop, myTurn);
  if (phase === step) return 'hold';
  return stopCovers(stop, phase) && PHASE_TYPES.indexOf(phase) > PHASE_TYPES.indexOf(step) ? 'missed' : 'wait';
}

/**
 * `forge:phase-stop` — this seat's stop at the next occurrence of one phase, on
 * either player's turn; `null` is none. One-shot: the server clears it once it
 * has held the seat's priority there. The same payload both ways, the server's
 * word after every snapshot and every change, so a reload still draws it.
 */
export const PhaseStopSchema = z.object({ matchId: z.string().min(1), phase: StopPhaseSchema.nullable() }).strict();
export type PhaseStopRequest = z.infer<typeof PhaseStopSchema>;

/** The payload of a `forge:phase-stop` message, parsed through its own schema. */
export function phaseStopFrame(matchId: string, phase: StopPhase | null): PhaseStopRequest {
  return PhaseStopSchema.parse({ matchId, phase });
}

/**
 * `forge:stop-preference` — wave 30 §B item 6: *"a settings surface, holding
 * at least two preferences… always stop at end step — default off."* This is
 * that one preference, travelling from the settings panel to the seat's own
 * `StopPolicy` (`apps/server/src/play/auto.ts`) through the ALREADY-EXISTING
 * per-seat setter, `Match.setStopPolicy` (wave 26 §E) — nothing here is a
 * second mechanism.
 *
 * `type` rides on the PAYLOAD even though the event name alone already
 * disambiguates it, so a client that logs the raw payload can tell what it
 * sent without cross-referencing the event name. **Client → server only**:
 * unlike `forge:full-control` there is no echo — nothing server-side changes
 * the MEANING of "sent it", so a fresh page reads the last value it itself
 * persisted (`@wolffm/prefs-client`) rather than anything the server answers.
 */
export const StopPreferenceSchema = z
  .object({
    matchId: z.string().min(1),
    type: z.string().min(1).refine((v) => v === 'stopPreference', { message: "must be 'stopPreference'" }),
    stopAtEndStep: z.boolean(),
  })
  .strict();

export interface StopPreferenceRequest {
  matchId: string;
  type: 'stopPreference';
  stopAtEndStep: boolean;
}

/** The payload of a `forge:stop-preference` emit, parsed through its own schema. */
export function stopPreferenceFrame(matchId: string, stopAtEndStep: boolean): StopPreferenceRequest {
  return StopPreferenceSchema.parse({ matchId, type: 'stopPreference', stopAtEndStep }) as StopPreferenceRequest;
}

/**
 * `forge:trigger-decision` — Forge's own `AutoYieldStore.TriggerDecision` for
 * one optional trigger of this seat's: `ACCEPT`/`DECLINE` and Forge answers
 * that trigger itself from then on, `ASK` and it asks again. `key` is the
 * storage key the trigger's confirm named (`ShowPromptMessage.confirmAbility.trigger`);
 * the server takes only a key it showed this seat.
 */
export const TriggerDecisionRequestSchema = z
  .object({ matchId: z.string().min(1), key: z.string().min(1), decision: TriggerDecisionSchema })
  .strict();
export type TriggerDecisionRequest = z.infer<typeof TriggerDecisionRequestSchema>;

/** The payload of a `forge:trigger-decision` emit, parsed through its own schema. */
export function triggerDecisionFrame(matchId: string, key: string, decision: TriggerDecisionRequest['decision']): TriggerDecisionRequest {
  return TriggerDecisionRequestSchema.parse({ matchId, key, decision });
}

/** One remembered answer: the trigger's storage key, its host card's name, and the answer. */
export const RememberedTriggerSchema = z
  .object({ key: z.string().min(1), name: z.string(), decision: z.enum(['ACCEPT', 'DECLINE']) })
  .strict();
export type RememberedTrigger = z.infer<typeof RememberedTriggerSchema>;

/** `forge:trigger-decisions` — every answer the seat has Forge remembering, oldest first. */
export const TriggerDecisionsSchema = z
  .object({ matchId: z.string().min(1), decisions: z.array(RememberedTriggerSchema) })
  .strict();
export type TriggerDecisions = z.infer<typeof TriggerDecisionsSchema>;

/* ── Server → client ─────────────────────────────────────────────────── */

/**
 * `forge:s2c`. `frame` is validated eagerly here, as a full
 * `ServerFrameSchema` — the server's own original shape, kept because both
 * apps' tests call `.parse`/`.safeParse` on this schema directly and expect a
 * typed frame back. `parseServerEnvelope` below does NOT use this schema
 * as-is: see this file's own header ("`ServerEnvelopeSchema` stays eager;
 * `parseServerEnvelope` does not").
 */
export const ServerEnvelopeSchema = z
  .object({ matchId: z.string().min(1), cursor: WireCursorSchema, frame: ServerFrameSchema, displayOnly: z.literal(true).optional() })
  .strict();

/** `ServerEnvelopeSchema`, with `frame` loosened to `unknown` — `parseServerEnvelope`'s own first stage. */
const ServerEnvelopeShapeSchema = ServerEnvelopeSchema.extend({ frame: z.unknown() });

export interface ServerEnvelope {
  matchId: string;
  cursor: WireCursor;
  frame: ServerFrame;
  /**
   * The frame is a reveal Forge has ALREADY been answered for (`apps/server/src/play/match.ts`'s
   * `showReveal`): something to show, never a question. Nothing replies to it. On the envelope, not
   * the frame, because the frame is Forge's own and stays byte-for-byte what Forge sent; whether
   * anyone still waits on it is the server's fact. Absent on every other frame.
   */
  displayOnly?: true;
}

/**
 * The answer to `forge:join` and `forge:resync`. `frames` is this seat's
 * whole state-channel history (`setGameView` / `openView` / `applyDelta`,
 * already projected for the seat); a pending ask is re-sent after it as an
 * ordinary `forge:s2c` frame.
 *
 * `MatchSnapshot.cursor` is that seat's LATEST cursor, of any kind — not the
 * cursor of the last STATE frame in `frames`: with the literal reading, a
 * prompt sent after the last state frame leaves the snapshot's cursor behind
 * the stream, the pending ask re-sent after the snapshot then arrives as a
 * `gap`, and the client resyncs forever.
 */
export const MatchSnapshotSchema = z
  .object({
    matchId: z.string().min(1),
    /** 0-based. */
    seat: z.number().int().min(0),
    /** This seat's Forge `PlayerView` id — who "me" is on the board. */
    playerId: z.number().int(),
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
 * `error` is the machine code every refusal carries, and it is unchanged.
 * `outcome` and `message` are optional because **exactly one refusal sends
 * them**: a match that is gone answers `{ error: 'unknown-match', outcome:
 * 'match-gone', message: '<a sentence>' }` (wave 22 lane E — `matchGone` /
 * `MATCH_GONE_WORDS` in `apps/server/src/play/socket.ts`), while
 * `match-full`, `not-joined`, `match-starting` and `malformed: …` keep the
 * bare `{ error }` they always had. Requiring the two fields would make every
 * OTHER refusal malformed.
 *
 * `outcome` is a non-empty string rather than the literal `'match-gone'`: a
 * PARSE schema that pins the literal refuses the next outcome the system
 * learns to send, which is this class of bug again. The object stays
 * `.strict()`, so a misspelled `outcom` or `mesage` is still an error and not
 * quietly dropped.
 *
 * **Nothing on the server parses through this schema** — the shape is BUILT
 * by `socket.ts`'s `MatchRefusal`, which pins `outcome` to `'match-gone'`; a
 * builder is narrow where a parser is wide. Widening this is not fixing a
 * live bug: it keeps the one contract so that the day something validates an
 * outbound refusal against it, a `match-gone` passes.
 */
export const MatchErrorSchema = z
  .object({
    error: z.string().min(1),
    outcome: z.string().min(1).optional(),
    message: z.string().min(1).optional(),
  })
  .strict();

export interface MatchError {
  error: string;
}

/* ── Parsing, with paths — the one adapter both mirrors re-wrote ─────── */

export interface WireIssue {
  path: string;
  message: string;
}

export type MatchWireParse<T> = { ok: true; value: T } | { ok: false; errors: WireIssue[] };

/** Any schema's `safeParse` result, turned into {@link MatchWireParse}, path and all. */
export function parseWith<T>(schema: { safeParse(raw: unknown): z.ZodSafeParseResult<T> }, raw: unknown): MatchWireParse<T> {
  const result = schema.safeParse(raw);
  if (result.success) return { ok: true, value: result.data };
  return { ok: false, errors: result.error.issues.map((i) => ({ path: formatPath(i.path as (string | number)[]), message: i.message })) };
}

export function parseMatchRequest(raw: unknown): MatchWireParse<MatchRequest> {
  return parseWith(MatchRequestSchema, raw);
}

export function parseFullControl(raw: unknown): MatchWireParse<FullControlRequest> {
  return parseWith(FullControlSchema, raw);
}

export function parseAutoYield(raw: unknown): MatchWireParse<AutoYieldRequest> {
  return parseWith(AutoYieldSchema, raw);
}

export function parsePhaseStop(raw: unknown): MatchWireParse<PhaseStopRequest> {
  return parseWith(PhaseStopSchema, raw);
}

export function parseStopPreference(raw: unknown): MatchWireParse<StopPreferenceRequest> {
  return parseWith(StopPreferenceSchema, raw) as MatchWireParse<StopPreferenceRequest>;
}

export function parseTriggerDecision(raw: unknown): MatchWireParse<TriggerDecisionRequest> {
  return parseWith(TriggerDecisionRequestSchema, raw);
}

export function parseTriggerDecisions(raw: unknown): MatchWireParse<TriggerDecisions> {
  return parseWith(TriggerDecisionsSchema, raw);
}

/** Envelope first, then the frame — a reply's `result` is checked against its method here. */
export function parseClientEnvelope(raw: unknown): MatchWireParse<ClientEnvelope> {
  const envelope = parseWith(ClientEnvelopeSchema, raw);
  if (!envelope.ok) return envelope;
  const frame = safeParseClientFrame(envelope.value.frame);
  if (!frame.ok) {
    return { ok: false, errors: frame.errors.map((e) => ({ path: `$.frame${e.path.slice(1)}`, message: e.message })) };
  }
  return {
    ok: true,
    value: {
      matchId: envelope.value.matchId,
      frame: frame.value,
      ...(envelope.value.placement === undefined ? {} : { placement: envelope.value.placement as Placement }),
    },
  };
}

/**
 * The envelope's own parse ONLY — `frame` is handed back unchecked (typed as
 * `ServerFrame`, not actually verified as one). See this file's own header
 * ("`ServerEnvelopeSchema` stays eager; `parseServerEnvelope` does not") for
 * why: `apps/ui/src/play/live/match.ts`'s `ingest()` is the caller that
 * validates the frame, in its own second step, once it already has the
 * cursor this function returned.
 */
export function parseServerEnvelope(raw: unknown): MatchWireParse<ServerEnvelope> {
  return parseWith(ServerEnvelopeShapeSchema, raw) as MatchWireParse<ServerEnvelope>;
}
