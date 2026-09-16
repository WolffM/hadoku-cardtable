/**
 * SPDX-License-Identifier: MIT
 *
 * Part of `@hadoku/room-ask`, which is MIT — the single carve-out in a repo
 * that is otherwise GPL-3.0-or-later. Written clean-room from the requirement
 * in `docs/requests/P4_ASK_REGISTRY.md` and from nothing else.
 */

import type { ParticipantId, SeatId } from '@wolffm/rooms-protocol';

import type { AskCancelReason, AskId } from './types.ts';

/** Thrown into the caller's promise only when `onTimeout.mode === 'throw'`. */
export class AskTimeoutError extends Error {
  readonly askId: AskId;
  readonly timeoutMs: number;

  constructor(askId: AskId, timeoutMs: number) {
    super(`ask ${askId} timed out after ${timeoutMs}ms`);
    this.name = 'AskTimeoutError';
    this.askId = askId;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Cancellation ALWAYS rejects. There is no cancel-with-value mode, by symmetry
 * with the fact that a cancelled question has no answer to stand in for.
 */
export class AskCancelledError extends Error {
  readonly askId: AskId;
  readonly reason: AskCancelReason;

  constructor(askId: AskId, reason: AskCancelReason) {
    super(`ask ${askId} cancelled (${reason})`);
    this.name = 'AskCancelledError';
    this.askId = askId;
    this.reason = reason;
  }
}

/**
 * The target holds no seat — or names a seat that is empty, out of range, or
 * occupied by a bot. Rejected at issue: no `askId` is allocated, no counter
 * moves, and in particular `droppedUnknownReplies` is untouched.
 */
export class AskNotSeatedError extends Error {
  readonly target: ParticipantId | SeatId;

  constructor(target: ParticipantId | SeatId) {
    super(`ask target ${String(target)} is not a seated participant`);
    this.name = 'AskNotSeatedError';
    this.target = target;
  }
}
