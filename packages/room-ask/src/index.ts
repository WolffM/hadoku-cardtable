/**
 * SPDX-License-Identifier: MIT
 *
 * `@hadoku/room-ask` — a durable, seat-scoped request/response over a room.
 *
 * MIT: the single carve-out in a repo that is otherwise GPL-3.0-or-later.
 * Written clean-room from the requirement in `docs/requests/P4_ASK_REGISTRY.md`
 * and from nothing else. See `packages/room-ask/LICENSE`.
 */

export { createAskRegistry, type AskRegistry, type AskRegistryOptions } from './registry.ts';
export { AskCancelledError, AskNotSeatedError, AskTimeoutError } from './errors.ts';
export {
  createManualClock,
  createSystemClock,
  type AskClock,
  type AskTimer,
  type ManualClock,
} from './clock.ts';
export type {
  AskCancelReason,
  AskDeliverFn,
  AskEnvelope,
  AskId,
  AskOptions,
  AskReply,
  AskState,
  AskStats,
  AskTimeoutPolicy,
  PendingAskView,
} from './types.ts';
