/*
 * The wire form of a room, and the two pure functions that get in and out of it.
 *
 * This is the hard half of P6 (`docs/requests/P6_PERSISTENCE.md` §3). Not the
 * storage — storage is `store.ts` and it is twenty lines per tier. The hard part
 * is that `JSON.stringify` renders a `Map` and a `Set` as `{}`, so a room
 * written out naively comes back with an empty roster and nobody notices until
 * the restore.
 *
 * ## What actually needs flattening
 *
 * Three containers, and only three. Verified against the shipped
 * `@wolffm/rooms-server@0.38.111` `dist/state.d.ts`, not against the spec's
 * transcription of it: `clients` (a `Map`), `usedAvatars` (a `Set`) and
 * `clientNames` (a `Map`). Every other field on `CoreRoomState` is a scalar,
 * and `seats` is a `SeatTable`, which `@wolffm/rooms-protocol`'s `seats.ts`
 * made plain JSON-safe arrays and records *specifically so this would be a
 * matter of writing it out* — its header says so and asks that it be kept that
 * way. So `SeatTable` goes into the snapshot verbatim.
 *
 * ## Three fields are deliberately absent
 *
 * `SerializedMember` carries neither `clientId` nor `socketId` nor `friendKey`,
 * and each absence is load-bearing rather than an oversight:
 *
 *   - `clientId` and `socketId` are transport identifiers (`state.d.ts`'s own
 *     comment: *"Ephemeral per-connection id. In practice the socket id."*).
 *     Neither survives a restart, so persisting one would restore a room whose
 *     roster names sockets that certainly do not exist. The stable identity IS
 *     `participantId` — the whole point of the tiered id scheme.
 *   - `friendKey` is **auth material**. `ClientMeta.friendKey`'s own doc comment
 *     says *"Server-internal: it IS the auth material, so it must never reach a
 *     payload"*, and a snapshot on disk is a payload — a longer-lived one than
 *     anything on a socket. Writing it out would put every friend's credential
 *     in a file, looking entirely normal.
 *
 * `leaderId` is absent too, for a different reason; see `decodeSnapshot`.
 */

import {
  isDurableParticipantId,
  type ParticipantId,
  type SeatTable,
} from '@wolffm/rooms-protocol';
import type { ClientMeta, CoreRoomState } from '@wolffm/rooms-server';

/**
 * Bumped when the shape in THIS file changes.
 *
 * A snapshot whose `storeVersion` this build does not recognise is quarantined,
 * never guessed at (§4.5). The host's own blob versions independently through
 * `appVersion`, so a host migrating its app state does not need us to bump.
 */
export const STORE_VERSION = 1;

/** One durable participant, flattened out of `CoreRoomState.clients`. */
export interface SerializedMember {
  /** Durable tiers only — see §4.2 and `pruneNonDurable`. */
  participantId: ParticipantId;
  joinedAt: number;
  lastSeen: number;
  name?: string;
  avatarId?: string;
  /** `ClientMeta<TClient>.app`, through the host's client codec. */
  app: unknown;
  // NOTE: `clientId`, `socketId` and `friendKey` are deliberately absent. See
  // this module's header; all three absences are correctness, not economy.
}

/** Wire form. Maps and Sets are not JSON; this is the flattened room. */
export interface RoomSnapshot {
  storeVersion: number;
  roomId: string;
  roomKey: string;
  lastEventSeq: number;
  createdAt: number;
  updatedAt: number;

  members: SerializedMember[];
  usedAvatars: string[];
  clientNames: Record<ParticipantId, string>;
  seats: SeatTable;

  /** Opaque to the store. Goes through `AppCodec`. */
  app: unknown;
  /** The host's own schema version, echoed back to its `deserialize`. */
  appVersion?: number;
}

/**
 * Context handed to a codec on the way back in.
 *
 * `restoreId` is the reason this exists. `@wolffm/rooms-protocol`'s `SeqCursor`
 * says an epoch is *"any value … as long as it changes when the room is rebuilt
 * and not otherwise"*, and a restore rebuilds the room. A host whose app state
 * carries an epoch (ours does — `DraftState.epoch`) stamps this one on it
 * during `deserialize`, so a client holding a pre-restart cursor gets
 * `epoch-change` from `classifySeq` and refetches, instead of reading a room
 * counting from a restored `seq` as a flood of duplicates and discarding live
 * events forever.
 */
export interface RestoreContext {
  roomId: string;
  /** Unique to this restore. Never equal to the value the room had before. */
  restoreId: string;
  /** The clock's time at restore, for a host that stamps its own timestamps. */
  restoredAt: number;
}

/** How the host's `TApp` (and `TClient`) go in and out. P6 §3. */
export interface AppCodec<T> {
  version: number;
  serialize(value: T): unknown;
  /**
   * `raw` is whatever `serialize` produced, and `version` is the `appVersion`
   * it was written under — so a host migrates its own blob without the store
   * bumping `STORE_VERSION`. Throwing here is a quarantine (§4.5), not a crash.
   */
  deserialize(raw: unknown, version: number, ctx: RestoreContext): T;
}

export interface RoomCodec<TApp, TClient = unknown> {
  app: AppCodec<TApp>;
  /** For `ClientMeta.app`. Omitted means the per-client blob is plain JSON. */
  client?: AppCodec<TClient>;
}

/** A codec for state that is already plain JSON. Round-trips by structure. */
export function jsonCodec<T>(version = 1): AppCodec<T> {
  return {
    version,
    serialize: (value: T) => clone(value) as unknown,
    deserialize: (raw: unknown) => clone(raw) as T,
  };
}

/** Why a snapshot could not be read. Each arm is a quarantine reason (§4.5). */
export type UnreadableReason =
  /** `storeVersion` is not one this build understands. */
  | 'store-version'
  /** The record is not shaped like a snapshot at all. */
  | 'malformed'
  /** The host's `deserialize` threw. */
  | 'codec';

/**
 * A snapshot that must be set aside rather than applied.
 *
 * Thrown by `decodeSnapshot` *before* anything touches a room, which is what
 * makes §4.5's "never half-applied" a structural property rather than a promise:
 * the decode either produces a complete set of fields or it produces nothing.
 * Half-restoring is the worse failure — a draft back with seats but not picks
 * looks fine and is unrecoverable, where one that does not come back at all is
 * obvious in the first second.
 */
export class SnapshotUnreadableError extends Error {
  readonly reason: UnreadableReason;
  readonly roomId: string;
  constructor(reason: UnreadableReason, roomId: string, detail: string) {
    super(`snapshot for room ${roomId} is unreadable (${reason}): ${detail}`);
    this.name = 'SnapshotUnreadableError';
    this.reason = reason;
    this.roomId = roomId;
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/**
 * Drop everything a non-durable participant held, in place, on a CLONE.
 *
 * §4.2. `isDurableParticipantId` is the predicate and its own doc comment names
 * this as its purpose — *"the check for 'may hold a seat / may have a pending
 * request replayed'"*. An `eph:` id **is** a socket id, so restoring one would
 * hold a seat that no future connection can ever claim. The roster comes back
 * smaller than it went in, and the seat comes back claimable. That is correct,
 * not lossy.
 *
 * Applied on the way out (nothing ephemeral reaches disk) and again on the way
 * in (a snapshot written by another build is not trusted to have done it).
 */
export function pruneNonDurable(table: SeatTable): SeatTable {
  for (const seat of table.seats) {
    const occ = seat.occupant;
    if (occ && occ.kind === 'human' && !isDurableParticipantId(occ.participantId)) {
      seat.occupant = null;
    }
  }
  for (const pid of Object.keys(table.remembered)) {
    if (!isDurableParticipantId(pid)) delete table.remembered[pid];
  }
  for (const [seatId, reservation] of Object.entries(table.reservations)) {
    if (!isDurableParticipantId(reservation.participantId)) {
      delete table.reservations[Number(seatId)];
    }
  }
  return table;
}

/**
 * Flatten a live room into its wire form.
 *
 * Pure: the room is read, never written. Everything that comes out is a clone,
 * so a caller holding the snapshot cannot reach back into room state — and, more
 * to the point, a debounced save that is serialised now and written later cannot
 * be changed out from under itself by the next pick.
 *
 * `clients` is keyed by the ephemeral `clientId`, so two live sockets for one
 * refreshing participant appear as two entries. They collapse to one member,
 * keeping the most recently seen — a snapshot describes people, not connections.
 */
export function snapshotRoom<TApp, TClient>(
  room: CoreRoomState<TApp, TClient>,
  codec: RoomCodec<TApp, TClient>,
): RoomSnapshot {
  const byParticipant = new Map<ParticipantId, ClientMeta<TClient>>();
  for (const meta of room.clients.values()) {
    if (!isDurableParticipantId(meta.participantId)) continue;
    const existing = byParticipant.get(meta.participantId);
    if (existing === undefined || meta.lastSeen >= existing.lastSeen) {
      byParticipant.set(meta.participantId, meta);
    }
  }

  const members: SerializedMember[] = [];
  for (const meta of byParticipant.values()) {
    const member: SerializedMember = {
      participantId: meta.participantId,
      joinedAt: meta.joinedAt,
      lastSeen: meta.lastSeen,
      app: codec.client ? codec.client.serialize(meta.app) : clone(meta.app),
    };
    if (meta.name !== undefined) member.name = meta.name;
    if (meta.avatarId !== undefined) member.avatarId = meta.avatarId;
    members.push(member);
  }
  members.sort((a, b) => (a.participantId < b.participantId ? -1 : 1));

  const clientNames: Record<ParticipantId, string> = {};
  for (const [pid, name] of room.clientNames) {
    if (isDurableParticipantId(pid)) clientNames[pid] = name;
  }

  return {
    storeVersion: STORE_VERSION,
    roomId: room.roomId,
    roomKey: room.roomKey,
    lastEventSeq: room.lastEventSeq,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    members,
    usedAvatars: [...room.usedAvatars].sort(),
    clientNames,
    seats: pruneNonDurable(clone(room.seats)),
    app: codec.app.serialize(room.app),
    appVersion: codec.app.version,
  };
}

/** A durable member, back from the snapshot. Not a `ClientMeta`: it has no socket. */
export interface RestoredMember<TClient> {
  participantId: ParticipantId;
  joinedAt: number;
  lastSeen: number;
  name?: string;
  avatarId?: string;
  app: TClient;
}

/** Everything a restore produces, assembled before any of it is applied. */
export interface DecodedSnapshot<TApp, TClient> {
  roomId: string;
  roomKey: string;
  lastEventSeq: number;
  createdAt: number;
  usedAvatars: Set<string>;
  clientNames: Map<ParticipantId, string>;
  seats: SeatTable;
  app: TApp;
  members: Array<RestoredMember<TClient>>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function looksLikeSeatTable(v: unknown): v is SeatTable {
  if (!isRecord(v)) return false;
  if (!Array.isArray(v.seats)) return false;
  if (!isRecord(v.remembered) || !isRecord(v.reservations)) return false;
  if (typeof v.reservationTtlMs !== 'number') return false;
  return v.capacity === null || typeof v.capacity === 'number';
}

/**
 * Turn a snapshot back into room fields, or throw.
 *
 * Nothing in here touches a room. That is the §4.5 guarantee in one sentence:
 * every way this can fail — an unknown `storeVersion`, a record that is not
 * shaped like a snapshot, a host codec that throws — fails before a single field
 * has been assigned anywhere, so there is no state to be left half-applied.
 *
 * **`leaderId` is not restored, and nothing here produces one.**
 * `CoreRoomState.leaderId` is documented as *"The room's authority, by
 * clientId"*, and `clientId` is the ephemeral per-connection id — so a persisted
 * `leaderId` names a socket that certainly does not exist after a restart. P6 §2
 * offered three ways out and this package takes (b): persist nothing, and let
 * leadership be re-established on the first qualifying join after restore. It is
 * the least surprising behaviour for a host that has not asked for any of this,
 * it is roughly what an unpersisted server already does when a leader
 * disconnects, and a draft has no leader concept at all.
 */
export function decodeSnapshot<TApp, TClient>(
  snapshot: RoomSnapshot,
  codec: RoomCodec<TApp, TClient>,
  ctx: RestoreContext,
): DecodedSnapshot<TApp, TClient> {
  const roomId = ctx.roomId;

  if (!isRecord(snapshot)) {
    throw new SnapshotUnreadableError('malformed', roomId, 'record is not an object');
  }
  if (snapshot.storeVersion !== STORE_VERSION) {
    throw new SnapshotUnreadableError(
      'store-version',
      roomId,
      `have ${STORE_VERSION}, found ${String(snapshot.storeVersion)}`,
    );
  }
  if (typeof snapshot.roomId !== 'string' || typeof snapshot.roomKey !== 'string') {
    throw new SnapshotUnreadableError('malformed', roomId, 'roomId/roomKey missing');
  }
  if (typeof snapshot.lastEventSeq !== 'number' || typeof snapshot.createdAt !== 'number') {
    throw new SnapshotUnreadableError('malformed', roomId, 'lastEventSeq/createdAt missing');
  }
  if (!Array.isArray(snapshot.members) || !Array.isArray(snapshot.usedAvatars)) {
    throw new SnapshotUnreadableError('malformed', roomId, 'members/usedAvatars missing');
  }
  if (!isRecord(snapshot.clientNames)) {
    throw new SnapshotUnreadableError('malformed', roomId, 'clientNames missing');
  }
  if (!looksLikeSeatTable(snapshot.seats)) {
    throw new SnapshotUnreadableError('malformed', roomId, 'seats is not a SeatTable');
  }

  const appVersion = snapshot.appVersion ?? codec.app.version;
  let app: TApp;
  try {
    app = codec.app.deserialize(snapshot.app, appVersion, ctx);
  } catch (err) {
    throw new SnapshotUnreadableError('codec', roomId, `app codec threw: ${String(err)}`);
  }

  const members: Array<RestoredMember<TClient>> = [];
  for (const raw of snapshot.members) {
    if (!isRecord(raw) || typeof raw.participantId !== 'string') {
      throw new SnapshotUnreadableError('malformed', roomId, 'member without a participantId');
    }
    // §4.2 again, on the way in. A snapshot written by another build is not
    // trusted to have pruned; restoring an `eph:` member would hand a seat to an
    // id that is a dead socket.
    if (!isDurableParticipantId(raw.participantId)) continue;
    let clientApp: TClient;
    try {
      clientApp = codec.client
        ? codec.client.deserialize(raw.app, appVersion, ctx)
        : (clone(raw.app) as TClient);
    } catch (err) {
      throw new SnapshotUnreadableError('codec', roomId, `client codec threw: ${String(err)}`);
    }
    const member: RestoredMember<TClient> = {
      participantId: raw.participantId,
      joinedAt: typeof raw.joinedAt === 'number' ? raw.joinedAt : ctx.restoredAt,
      lastSeen: typeof raw.lastSeen === 'number' ? raw.lastSeen : ctx.restoredAt,
      app: clientApp,
    };
    if (typeof raw.name === 'string') member.name = raw.name;
    if (typeof raw.avatarId === 'string') member.avatarId = raw.avatarId;
    members.push(member);
  }

  const clientNames = new Map<ParticipantId, string>();
  for (const [pid, name] of Object.entries(snapshot.clientNames)) {
    if (typeof name === 'string' && isDurableParticipantId(pid)) clientNames.set(pid, name);
  }

  return {
    roomId: snapshot.roomId,
    roomKey: snapshot.roomKey,
    lastEventSeq: snapshot.lastEventSeq,
    createdAt: snapshot.createdAt,
    usedAvatars: new Set(snapshot.usedAvatars.filter((a): a is string => typeof a === 'string')),
    clientNames,
    seats: pruneNonDurable(clone(snapshot.seats)),
    app,
    members,
  };
}

/**
 * Write a decoded snapshot onto a freshly seeded room, all at once.
 *
 * Separate from `decodeSnapshot` on purpose: everything that can fail has
 * already happened by the time this runs, so this function cannot leave a room
 * half-restored.
 *
 * Two fields come from `now` rather than from the snapshot:
 *
 *   - **`updatedAt`** — §4.6. `evaluateRoom` computes `now - room.updatedAt` and
 *     destroys an empty room once that exceeds `emptyGraceMs`. Inheriting the
 *     snapshot's `updatedAt` would make a room restored after a long outage
 *     instantly reap-eligible, before anybody has had a chance to reconnect. A
 *     restore stamps a FRESH emptiness clock. (`gc.ts`'s own comment concedes
 *     that `updatedAt` "stands in for last emptied — coarse but conservative",
 *     which is true while rooms are born empty and false the moment one is born
 *     45 minutes old.)
 *   - **`leaderId`** — null. See `decodeSnapshot`.
 *
 * `clients` stays empty: §4.3. The restored participants have no sockets at all
 * and their seats are still theirs. Seat tenure is a function of participant
 * identity and time, never of socket liveness.
 */
export function applySnapshot<TApp, TClient>(
  room: CoreRoomState<TApp, TClient>,
  decoded: DecodedSnapshot<TApp, TClient>,
  now: number,
): void {
  room.leaderId = null;
  room.lastEventSeq = decoded.lastEventSeq;
  room.createdAt = decoded.createdAt;
  room.updatedAt = now;
  room.clients.clear();
  room.usedAvatars = decoded.usedAvatars;
  room.clientNames = decoded.clientNames;
  room.seats = decoded.seats;
  room.app = decoded.app;
}
