/**
 * SPDX-License-Identifier: MIT
 *
 * Part of `@hadoku/room-ask`, which is MIT — the single carve-out in a repo
 * that is otherwise GPL-3.0-or-later. Written clean-room from the requirement
 * in `docs/requests/P4_ASK_REGISTRY.md` and from nothing else.
 */

import type { ParticipantId, SeatId } from '@wolffm/rooms-protocol';

/**
 * Correlation id. Allocated from a per-registry counter starting at 1 and
 * incrementing by exactly 1 — strictly increasing over the registry's life,
 * never reused, never reset by a reconnect. Branded so an arbitrary number
 * cannot be passed where a real id is expected.
 */
export type AskId = number & { readonly __brand: 'AskId' };

/** server → the target participant's sockets. `askId` is the only join key. */
export interface AskEnvelope {
  readonly askId: AskId;
  readonly kind: string;
  readonly payload: unknown;
}

/** any of that participant's sockets → server. */
export interface AskReply {
  readonly askId: AskId;
  readonly value: unknown;
}

/**
 * What a timeout does. There is no implicit default: `value` resolves the
 * caller's promise with exactly the value they supplied up front, `throw`
 * rejects it with an {@link AskTimeoutError}.
 */
export type AskTimeoutPolicy<T> = { mode: 'value'; value: T } | { mode: 'throw' };

export interface AskOptions<T> {
  /** Wall-clock from issue. It does NOT pause while the ask is queued. */
  timeoutMs: number;
  onTimeout: AskTimeoutPolicy<T>;
  signal?: AbortSignal;
}

/** The two non-terminal states. `issued` never rests, so it is not observable here. */
export type AskState = 'queued' | 'delivered';

/** Why a pending ask was cancelled. Cancellation always rejects. */
export type AskCancelReason = 'signal' | 'seat-exit' | 'room-closed' | (string & {});

/** One row of {@link AskRegistry.pending}. */
export interface PendingAskView {
  readonly askId: AskId;
  readonly kind: string;
  readonly target: ParticipantId;
  readonly seat: SeatId | null;
  readonly state: AskState;
  /** epoch ms */
  readonly issuedAt: number;
  /** epoch ms */
  readonly deadlineAt: number;
  /** How many times the envelope has been written to a socket. */
  readonly emitCount: number;
}

/**
 * Counters and one gauge. Never reset.
 *
 * `delivered` counts EMITS, not asks — a replay advances it. `queued` is the
 * odd one out: a gauge of how many asks are in `queued` right now. Mixing the
 * two in one object is a small wart, documented rather than hidden.
 */
export interface AskStats {
  readonly issued: number;
  readonly delivered: number;
  readonly queued: number;
  readonly replied: number;
  readonly timedOut: number;
  readonly cancelled: number;
  /** Requirement 8. Moves in lockstep with `submitReply` returning `'dropped'`. */
  readonly droppedUnknownReplies: number;
}

/**
 * How an envelope reaches one socket. The registry owns no transport: it hands
 * the host a participant, a socket key it was told about via
 * {@link AskRegistry.attach}, and the envelope. What happens next is the host's
 * business.
 *
 * Called once per live socket per emit, so a participant holding two sockets
 * sees two calls with the same (identical, frozen) envelope object.
 */
export type AskDeliverFn = (
  target: ParticipantId,
  socketKey: string,
  envelope: AskEnvelope,
) => void;
