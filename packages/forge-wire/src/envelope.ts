/*
 * The envelope: how a Forge protocol call crosses a WebSocket.
 *
 * `tier-a.ts`, `tier-b.ts` and `tier-c.ts` say what each of the 38 required
 * methods CARRIES. This file says how one travels — the channel names, the
 * three frame kinds, the correlation id that ties a blocking ask to its reply,
 * and the parse helpers that stand between a socket and a cast. The split
 * mirrors `@hadoku/shared`'s: `draft.ts` is the payload, `wire.ts` is the
 * transport, and the two are separable so a payload can be exercised with no
 * socket at all.
 *
 * ## Three kinds, and blocking is a property of the METHOD
 *
 *   `notify` — server→client, no reply. 14 of the 38.
 *   `ask`    — server→client, carries a `callId`, expects exactly one reply. 15.
 *   `act`    — client→server, never a reply. 9.
 *
 * Which methods block is not a runtime choice: lane F derived the 15 by
 * extracting `sendAndWait` / `syncAndSendAndWait` call sites from
 * `RemoteClientGuiGame.java` and got the same 15 Wave 3 measured from the enum
 * (`docs/spikes/itoclient.md`, item 3). So `kind` is a literal inside each
 * method's own frame rather than a field a sender picks, and the top-level
 * union discriminates on `method`. A `notify` for `confirm` does not parse.
 *
 * There is no client→server ask, and that is Forge's rule rather than ours:
 * "these should all return void, to avoid awkward situations in which client
 * and server wait for one another's response and block the threads that're
 * supposed to give that response" (ProtocolMethod.java:84-86).
 *
 * ## `abort` is ours, and it exists because of a Forge hazard
 *
 * `ReplyPool.get(index)` is an UNTIMED `get()` on a `CompletableFuture`
 * (`ReplyPool.java:29-37`; lane F's note calls it a `FutureTask`, which is the
 * only detail of its hazard write-up this lane found to differ — the untimed
 * part, which is the part that matters, is exactly as reported).
 *
 * A blocking ask to a browser that closes its tab parks a Forge game thread
 * forever; the only unblock is `cancelAll()`, called
 * from exactly two places, both in `FServerManager` (`:463` on the AFK timeout,
 * `:1231` on convert-to-AI). Lane F's conclusion: "A WebSocket bridge must arm
 * one of those, or its own timeout, on every one of the 15 blocking methods."
 *
 * A wire that can only carry answers forces the bridge to invent a way to say
 * "no answer is coming", so the contract carries one. `abort` is NOT a
 * `ProtocolMethod`; it is this envelope's own frame and is marked as such.
 *
 * ## What this contract deliberately does not do
 *
 * - It does not validate a reply against the ask it answers. A schema sees one
 *   message; `showOptionDialog`'s reply being a valid index into the options
 *   that were sent is a correlation check, and correlation is the bridge's job
 *   (`@hadoku/room-ask` already solves ask/reply-with-timeout, and lane F noted
 *   that this is its first real consumer).
 * - It does not model the 20 `ProtocolMethod`s outside the required 38, nor the
 *   2 dead ones (`setRememberedActions`, `nextRememberedAction`, resolved to
 *   nothing by Wave 3's reflection dump).
 * - It does not model Tier C. See `tier-c.ts`, which refuses rather than
 *   pretends.
 */

import { z } from 'zod';

import {
  TIER_A_CLIENT_FRAMES,
  TIER_A_METHODS,
  TIER_A_REPLIES,
  TIER_A_SERVER_FRAMES,
} from './tier-a.ts';
import {
  TIER_B_CLIENT_FRAMES,
  TIER_B_METHODS,
  TIER_B_REPLIES,
  TIER_B_SERVER_FRAMES,
} from './tier-b.ts';
import { TIER_C_METHODS, TIER_C_SERVER_FRAMES, tierCRefusal, type TierCMethod } from './tier-c.ts';

/* ── Channel ─────────────────────────────────────────────────────────── */

/**
 * One event name per DIRECTION, not per method.
 *
 * Same reasoning as `@hadoku/shared`'s `DRAFT_CHANNEL`: a name per method is 38
 * `socket.on` registrations, and the first one somebody adds without routing
 * through the parse helper is an unvalidated entry point. It also keeps
 * ordering total — a socket guarantees order within a connection, and
 * interleaving several event names makes "the frame after this one" a question
 * with no answer. That matters more here than it did for the draft, because
 * Forge's state channel is a delta stream.
 */
export const FORGE_CHANNEL = {
  /** Server → client. Payload: `ServerFrame`. */
  serverToClient: 'forge:s2c',
  /** Client → server. Payload: `ClientFrame`. */
  clientToServer: 'forge:c2s',
} as const;

/** Correlates an `ask` with its `reply`. Opaque; the server mints it. */
export const CallIdSchema = z.string().min(1);

/* ── The method census ───────────────────────────────────────────────── */

/** The 38 `ProtocolMethod`s a browser client needs, by tier. */
export const REQUIRED_METHODS = [
  ...TIER_A_METHODS,
  ...TIER_B_METHODS,
  ...TIER_C_METHODS,
] as const;

export type RequiredMethod = (typeof REQUIRED_METHODS)[number];

/**
 * The 15 that block, in `ProtocolMethod` declaration order.
 *
 * Lane F derived these twice, independently, and both derivations agree with
 * Wave 3's: 15 blocking, 28 fire-and-forget, 2 dead = 45 `Mode.SERVER`. Every
 * one of them needs a timeout armed — see the module header on `ReplyPool`.
 */
export const BLOCKING_METHODS = [
  'tempShowZones',
  'getAbilityToPlay',
  'assignCombatDamage',
  'assignGenericAmount',
  'showConfirmDialog',
  'showOptionDialog',
  'showInputDialog',
  'confirm',
  'getChoices',
  'order',
  'sideboard',
  'chooseSingleEntityForEffect',
  'chooseEntitiesForEffect',
  'manipulateCardList',
  'openZones',
] as const;

export type BlockingMethod = (typeof BLOCKING_METHODS)[number];

/** Reply payload per blocking method. One entry per `BLOCKING_METHODS` name. */
export const REPLY_SCHEMAS = {
  ...TIER_A_REPLIES,
  ...TIER_B_REPLIES,
} as const;

/* ── Server → client ─────────────────────────────────────────────────── */

/**
 * Every frame the bridge may send a browser: 29 arms, discriminated on
 * `method`. Three of them (Tier C) are present and refuse to parse.
 */
export const ServerFrameSchema = z.discriminatedUnion('method', [
  ...TIER_A_SERVER_FRAMES,
  ...TIER_B_SERVER_FRAMES,
  ...TIER_C_SERVER_FRAMES,
]);

export type ServerFrame = z.infer<typeof ServerFrameSchema>;

/* ── Client → server ─────────────────────────────────────────────────── */

/** The 9 client→server `ProtocolMethod`s, discriminated on `method`. */
export const ClientActionSchema = z.discriminatedUnion('method', [
  ...TIER_A_CLIENT_FRAMES,
  ...TIER_B_CLIENT_FRAMES,
]);

/**
 * The answer to one `ask`.
 *
 * `method` is carried alongside `callId` so the reply can be parsed without
 * first consulting the pending-ask table — a reply that arrives for a callId
 * the bridge has forgotten is then still a typed value in the log rather than
 * an opaque blob. `result` is validated per method by `parseClientFrame`.
 */
export const ClientReplySchema = z.strictObject({
  kind: z.literal('reply'),
  callId: CallIdSchema,
  method: z.enum(BLOCKING_METHODS),
  result: z.unknown(),
});

/** Why a browser will never answer an ask. */
export const ABORT_REASONS = ['disconnected', 'timeout', 'cancelled', 'unsupported'] as const;

export const AbortReasonSchema = z.enum(ABORT_REASONS);

/**
 * "No answer is coming for this ask."
 *
 * Not a `ProtocolMethod` — this envelope's own frame, for the `ReplyPool`
 * hazard in the module header. `unsupported` is the one a client sends when it
 * is asked something it cannot render, which today includes anything that
 * depends on Tier C.
 */
export const ClientAbortSchema = z.strictObject({
  kind: z.literal('abort'),
  callId: CallIdSchema,
  reason: AbortReasonSchema,
  detail: z.string().optional(),
});

export const ClientFrameSchema = z.discriminatedUnion('kind', [
  ClientActionSchema,
  ClientReplySchema,
  ClientAbortSchema,
]);

export type ClientAction = z.infer<typeof ClientActionSchema>;
export type ClientReply = z.infer<typeof ClientReplySchema>;
export type ClientAbort = z.infer<typeof ClientAbortSchema>;
export type ClientFrame = z.infer<typeof ClientFrameSchema>;

/* ── Parse helpers ───────────────────────────────────────────────────── */

/** One failure, with the path it happened at. Same shape `@hadoku/shared` reports. */
export interface WireIssue {
  readonly path: string;
  readonly message: string;
}

export type ParseOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: WireIssue[] };

/** `$`, `$.foo`, `$.foo[2].bar` — `@hadoku/shared`'s `formatPath` spelling. */
function formatPath(path: ReadonlyArray<string | number | symbol>): string {
  let out = '$';
  for (const segment of path) {
    out += typeof segment === 'number' ? `[${segment}]` : `.${String(segment)}`;
  }
  return out;
}

function issuesOf(error: z.ZodError): WireIssue[] {
  return error.issues.map((issue) => ({
    path: formatPath(issue.path),
    message: issue.message,
  }));
}

/**
 * Validate a frame the bridge sent. Non-throwing; reports every failure.
 *
 * A Tier C method fails here with `tierCRefusal`'s sentence rather than with a
 * bare type error, which is the difference between a consumer that knows what
 * to do next and one that files a bug against Zod.
 */
export function safeParseServerFrame(raw: unknown): ParseOutcome<ServerFrame> {
  const result = ServerFrameSchema.safeParse(raw);
  if (result.success) return { ok: true, value: result.data };
  return { ok: false, errors: issuesOf(result.error) };
}

/** Validate or throw, naming what was being parsed. */
export function parseServerFrame(raw: unknown, label = 'server frame'): ServerFrame {
  const result = safeParseServerFrame(raw);
  if (result.ok) return result.value;
  const detail = result.errors.map((e) => `  ${e.path}: ${e.message}`).join('\n');
  throw new Error(`${label} is not a valid ServerFrame:\n${detail}`);
}

/**
 * Validate a frame a browser sent, INCLUDING a reply's `result`.
 *
 * `ClientReplySchema` leaves `result` as `unknown` because its type depends on
 * `method`, which the schema cannot branch on and keep a flat discriminated
 * union. This is the second pass that closes that hole: a `confirm` reply
 * carrying a string is rejected here, not accepted and cast downstream.
 */
export function safeParseClientFrame(raw: unknown): ParseOutcome<ClientFrame> {
  const result = ClientFrameSchema.safeParse(raw);
  if (!result.success) return { ok: false, errors: issuesOf(result.error) };

  const frame = result.data;
  if (frame.kind !== 'reply') return { ok: true, value: frame };

  const payload = REPLY_SCHEMAS[frame.method].safeParse(frame.result);
  if (payload.success) {
    return { ok: true, value: { ...frame, result: payload.data } };
  }
  return {
    ok: false,
    errors: payload.error.issues.map((issue) => ({
      path: formatPath(['result', ...issue.path]),
      message: `reply to ${frame.method}: ${issue.message}`,
    })),
  };
}

/** Validate or throw, naming what was being parsed. */
export function parseClientFrame(raw: unknown, label = 'client frame'): ClientFrame {
  const result = safeParseClientFrame(raw);
  if (result.ok) return result.value;
  const detail = result.errors.map((e) => `  ${e.path}: ${e.message}`).join('\n');
  throw new Error(`${label} is not a valid ClientFrame:\n${detail}`);
}

/* ── Predicates ──────────────────────────────────────────────────────── */

const BLOCKING_SET: ReadonlySet<string> = new Set(BLOCKING_METHODS);
const TIER_C_SET: ReadonlySet<string> = new Set(TIER_C_METHODS);

/** Whether this method parks a Forge game thread until the browser answers. */
export function isBlocking(method: string): method is BlockingMethod {
  return BLOCKING_SET.has(method);
}

/** Whether this method is in the unresolved state channel. */
export function isTierC(method: string): method is TierCMethod {
  return TIER_C_SET.has(method);
}

/**
 * The refusal for an unresolved method, or null when the method is modelled.
 *
 * A bridge calls this before it tries to send, so "we do not do state yet"
 * surfaces as a sentence at the seam rather than as a parse failure in the
 * browser.
 */
export function unresolvedReason(method: string): string | null {
  return isTierC(method) ? tierCRefusal(method) : null;
}
