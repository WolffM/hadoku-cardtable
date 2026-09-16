/*
 * Helpers the tests share.
 *
 * Not exported from `index.ts`: this is scaffolding, not surface. It lives in
 * `src/` rather than a `test/` directory so it typechecks under the same
 * `tsconfig.json` as everything else — a helper that builds a `CoreRoomState`
 * by hand is exactly the thing that should break loudly when the shipped type
 * changes shape.
 */

import { createSeatTable } from '@wolffm/rooms-protocol';
import type { ClientMeta, CoreRoomState } from '@wolffm/rooms-server';
import type { ServicePeer } from './service.ts';

/** A room built directly, with no registry, for tests that only need the shape. */
export function makeRoom<TApp, TClient = unknown>(
  roomId: string,
  app: TApp,
  opts: { capacity?: number | null; now?: number; reservationTtlMs?: number } = {},
): CoreRoomState<TApp, TClient> {
  const now = opts.now ?? 0;
  return {
    roomId,
    roomKey: `${roomId}-key`,
    leaderId: null,
    lastEventSeq: 0,
    createdAt: now,
    updatedAt: now,
    clients: new Map<string, ClientMeta<TClient>>(),
    usedAvatars: new Set<string>(),
    clientNames: new Map<string, string>(),
    seats: createSeatTable(opts.capacity ?? null, {
      reservationTtlMs: opts.reservationTtlMs ?? 0,
    }),
    app,
  };
}

/** A `ClientMeta` with the transport fields filled in so absences are visible. */
export function makeClient<TClient>(
  participantId: string,
  app: TClient,
  extra: Partial<ClientMeta<TClient>> = {},
): ClientMeta<TClient> {
  return {
    clientId: `socket-${participantId}`,
    socketId: `socket-${participantId}`,
    participantId,
    joinedAt: 0,
    lastSeen: 0,
    app,
    ...extra,
  };
}

/** A peer that records everything sent to it, instead of holding a socket. */
export class RecordingPeer implements ServicePeer {
  readonly id: string;
  readonly sent: unknown[] = [];
  readonly closed: string[] = [];

  constructor(id: string) {
    this.id = id;
  }

  send(envelope: unknown): void {
    this.sent.push(envelope);
  }

  close(reason: string): void {
    this.closed.push(reason);
  }

  /** Envelopes of one `type`, for counting. */
  ofType(type: string): unknown[] {
    return this.sent.filter(
      (e) => typeof e === 'object' && e !== null && (e as { type?: unknown }).type === type,
    );
  }
}
